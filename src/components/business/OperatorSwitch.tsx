/**
 * 当前操作员入口（05 §2 侧栏底部、02 §11 M10"在岗切换而不退出程序"）。
 *
 * 单一来源：署名文案、换人动作、锁屏动作、演示模式的降级行为都只写在这一个文件里。
 * 侧栏折叠态与「系统 → 登录与权限」面板只是两种排布，判定与动作共用同一份。
 *
 * 两种世界，界面必须说清楚自己在哪个：
 *  - 桌面端（有原生通道）：换人 = 登出后重新输密码。点一下就能换人的做法只留在演示模式。
 *    锁屏 = 不登出，输入本人密码即解除（后端 idle_lock_minutes 会按同样的规则自动锁）。
 *  - 浏览器预览：没有可校验的密码，沿用 mock 在职名单切换，并显式标注"演示"。
 */
import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { LockKeyholeIcon, LogOutIcon, PowerIcon, UserCogIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { ROLE } from "@/lib/constants";
import type { AuthProfile } from "@/lib/auth";
import { runningInTauri } from "@/lib/native";
import { systemApi } from "@/lib/system-native";
import { useSession } from "@/store/session";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarFooter, useSidebar } from "@/components/ui/sidebar";
import { Choose } from "@/components/business/Choose";
import { SectionTitle } from "@/components/business/layout";

/** 署名的唯一写法。之前侧栏写「姓名·岗位」、系统页写「姓名 · 岗位」，两处各抄一遍就分叉了 */
export function operatorLabel(actor: AuthProfile): string {
  return `${actor.displayName} · ${ROLE[actor.role]}`;
}

/** 中文名取名字部分（王建国 → 建国），拉丁名取前两个字母 */
function avatarInitials(name: string): string {
  return /[\u4e00-\u9fff]/.test(name) ? name.slice(-2) : name.slice(0, 2).toUpperCase();
}

function OperatorAvatar({ actor }: { actor: AuthProfile }) {
  return (
    <Avatar size="sm">
      <AvatarFallback className="bg-primary/15 text-xs font-medium text-primary">
        {avatarInitials(actor.displayName)}
      </AvatarFallback>
    </Avatar>
  );
}

/** 真机上的"换人"：登出后回到登录页，由下一个人重新输密码 */
function useSignOut() {
  const navigate = useNavigate();
  const signOut = useSession((s) => s.signOut);
  return async () => {
    await signOut();
    // 未登录进不去任何业务页（router.tsx 的守卫），这里显式跳一次，省得停在原地
    void navigate({ to: "/login" });
  };
}

/** 主动锁屏：会话留着，只盖上浮层。点完不做跳转——解锁或换人在浮层里选 */
function useLockScreen() {
  const lockScreen = useSession((s) => s.lockScreen);
  return () => void lockScreen();
}

/**
 * 真机上的"退出程序"：走 `app_exit`，串口归还与 WAL 收尾照常跑（不是直接杀进程）。
 *
 * 这个入口不能省：主窗口的 ✕ 可以被设成"隐藏到系统托盘"（系统 → 窗口），设了之后点 ✕
 * 就退不掉，而侧栏是唯一一处不用先去托盘找菜单的地方。
 */
function exitApp() {
  systemApi.exit().catch((e: unknown) => toast.error(`退出失败：${e instanceof Error ? e.message : String(e)}`));
}

/** 演示模式的换人：认 mock 在职名单，不校验密码。下拉与下拉框两种排布共用这一份 */
function useDemoStaff(enabled = true) {
  const { data: staff = [] } = useQuery({ queryKey: ["staff"], queryFn: () => api.staff(), staleTime: Infinity, enabled });
  const setSession = useSession.setState;
  const active = staff.filter((u) => u.is_active === 1);

  const pick = useCallback(
    (id: string) => {
      const hit = active.find((u) => String(u.id) === id);
      if (!hit) {
        setSession({ phase: "out", session: null });
        return;
      }
      setSession({
        phase: "in",
        session: {
          actor: { id: hit.id, username: hit.username, displayName: hit.display_name, role: hit.role, mustChangePwd: false },
          sessionId: "demo",
          issuedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          idleTtlSecs: 0,
          locked: false,
        },
      });
    },
    [active, setSession],
  );

  return { active, pick };
}

function DemoPicker({ value, size = "sm" }: { value: string; size?: "sm" | "default" }) {
  const { active, pick } = useDemoStaff();
  return (
    <Choose
      aria-label="当前操作员"
      size={size}
      value={value}
      className="text-xs"
      onChange={pick}
      options={active.map((u) => ({ value: String(u.id), label: `${u.display_name} · ${ROLE[u.role]}` }))}
    />
  );
}

export function useCurrentActor(): AuthProfile | null {
  return useSession((s) => s.session?.actor ?? null);
}

/** 侧栏底部（展开态出厂 208px / 折叠态 56px，见 hooks/useSidebarWidth） */
export function OperatorFooter() {
  const actor = useCurrentActor();
  const demo = useSession((s) => s.demo);
  const { state } = useSidebar();
  const signOut = useSignOut();
  const lockScreen = useLockScreen();
  // 浏览器预览没有窗口，"退出程序"这个动作无从谈起（和备份页同一条口径：不给点不动的假按钮）
  const desktop = runningInTauri();
  // 折叠态的下拉里也要能换人，所以名单在早退之前取（demo 为假时不发请求）
  const { active, pick } = useDemoStaff(demo);
  const collapsed = state === "collapsed";

  if (!actor) return null;

  if (collapsed) {
    return (
      <SidebarFooter className="items-center p-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="px-0"
                aria-label={`当前操作员 ${operatorLabel(actor)}，点开可锁屏、换人或退出`}
              />
            }
          >
            <OperatorAvatar actor={actor} />
          </DropdownMenuTrigger>
          {/* 折叠态宽度只有 56px，退出这类动作必须留文字，不能只靠图标与悬停（05 §1） */}
          <DropdownMenuContent side="right" align="start" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{operatorLabel(actor)}</DropdownMenuLabel>
            </DropdownMenuGroup>
            {demo && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>换人（演示，不校验密码）</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={String(actor.id)} onValueChange={pick}>
                    {active.map((u) => (
                      <DropdownMenuRadioItem key={u.id} value={String(u.id)}>
                        {u.display_name} · {ROLE[u.role]}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={lockScreen}>
              <LockKeyholeIcon />
              锁屏
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void signOut()}>
              <LogOutIcon />
              退出登录
            </DropdownMenuItem>
            {desktop && (
              <DropdownMenuItem onClick={exitApp}>
                <PowerIcon />
                退出程序
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    );
  }

  return (
    <SidebarFooter className="gap-1.5 border-t">
      <div className="flex min-w-0 items-center gap-1.5">
        <OperatorAvatar actor={actor} />
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{operatorLabel(actor)}</p>
        {/* 侧栏窄到 208px，带文字的按钮排不下：三个动作统一成图标 + 悬浮提示 */}
        <Button size="icon-sm" variant="ghost" className="bg-muted/60" aria-label="锁屏" title="锁屏" onClick={lockScreen}>
          <LockKeyholeIcon />
        </Button>
        <Button size="icon-sm" variant="ghost" className="bg-muted/60" aria-label="退出登录" title="退出登录" onClick={() => void signOut()}>
          <LogOutIcon />
        </Button>
        {desktop && (
          <Button size="icon-sm" variant="ghost" className="bg-muted/60" aria-label="退出程序" title="退出程序" onClick={exitApp}>
            <PowerIcon />
          </Button>
        )}
      </div>
      {demo && <DemoPicker value={String(actor.id)} />}
    </SidebarFooter>
  );
}

/** 「系统 → 登录与权限」里的面板版 */
export function OperatorPanel() {
  const actor = useCurrentActor();
  const demo = useSession((s) => s.demo);
  const signOut = useSignOut();
  const lockScreen = useLockScreen();
  if (!actor) return null;
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>当前操作员</SectionTitle>
      <p className="text-sm">{operatorLabel(actor)}</p>
      {demo ? (
        <>
          <DemoPicker value={String(actor.id)} size="default" />
          <p className="text-xs text-muted-foreground">浏览器演示模式：换人不校验密码。</p>
        </>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={lockScreen}>
            <LockKeyholeIcon data-slot="icon" />
            锁屏（输本人密码解锁）
          </Button>
          <Button size="sm" variant="outline" onClick={() => void signOut()}>
            <UserCogIcon data-slot="icon" />
            换人（需重新登录）
          </Button>
        </div>
      )}
    </div>
  );
}
