/**
 * 当前操作员入口（05 §2 侧栏底部、02 §11 M10"在岗切换而不退出程序"）。
 *
 * 单一来源：署名文案、换人动作、锁屏动作、演示模式的降级行为都只写在这一个文件里。
 * 侧栏折叠态与「系统 → 登录与权限」面板只是两种排布，判定与动作共用同一份。
 *
 * 两种世界，界面必须说清楚自己在哪个：
 *  - 桌面端（有原生通道）：换人 = 登出后重新输口令。点一下就能换人的做法只留在演示模式。
 *  - 浏览器预览：没有可校验的口令，沿用 mock 在职名单切换，并显式标注"演示"。
 */
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { LogOutIcon, UserCogIcon } from "lucide-react";
import { api } from "@/lib/api";
import { ROLE } from "@/lib/constants";
import type { AuthProfile } from "@/lib/auth";
import { useSession } from "@/store/session";
import { Button } from "@/components/ui/button";
import { SidebarFooter, useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Choose } from "@/components/business/Choose";
import { SectionTitle } from "@/components/business/layout";

/** 署名的唯一写法。之前侧栏写「姓名·岗位」、系统页写「姓名 · 岗位」，两处各抄一遍就分叉了 */
export function operatorLabel(actor: AuthProfile): string {
  return `${actor.displayName} · ${ROLE[actor.role]}`;
}

/** 真机上的"换人/锁屏"：都会登出，区别只是要不要马上说明原因 */
function useSignOut() {
  const navigate = useNavigate();
  const signOut = useSession((s) => s.signOut);
  return async () => {
    await signOut();
    // 未登录进不去任何业务页（router.tsx 的守卫），这里显式跳一次，省得停在原地
    void navigate({ to: "/login" });
  };
}

/** 演示模式下的身份切换：认 mock 在职名单，不校验口令 */
function DemoPicker({ value, size = "sm" }: { value: string; size?: "sm" | "default" }) {
  const { data: staff = [] } = useQuery({ queryKey: ["staff"], queryFn: () => api.staff(), staleTime: Infinity });
  const setSession = useSession.setState;
  const active = staff.filter((u) => u.is_active === 1);
  return (
    <Choose
      aria-label="当前操作员"
      size={size}
      value={value}
      className="text-xs"
      onChange={(v) => {
        const hit = active.find((u) => String(u.id) === v);
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
          },
        });
      }}
      options={active.map((u) => ({ value: String(u.id), label: `${u.display_name} · ${ROLE[u.role]}` }))}
    />
  );
}

export function useCurrentActor(): AuthProfile | null {
  return useSession((s) => s.session?.actor ?? null);
}

/** 侧栏底部（展开态 240px / 折叠态 56px，05 §7.3） */
export function OperatorFooter() {
  const actor = useCurrentActor();
  const demo = useSession((s) => s.demo);
  const { state } = useSidebar();
  const signOut = useSignOut();
  const collapsed = state === "collapsed";

  if (!actor) return null;

  if (collapsed) {
    return (
      <SidebarFooter className="p-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-sm" onClick={() => void signOut()} aria-label="锁屏并退出">
                {actor.displayName.slice(0, 1)}
              </Button>
            }
          />
          <TooltipContent side="right">
            <p className="font-medium">{operatorLabel(actor)}</p>
            <p className="text-muted-foreground">{demo ? "浏览器演示模式，口令不校验" : "点击锁屏并退出（换人需重新输口令）"}</p>
          </TooltipContent>
        </Tooltip>
      </SidebarFooter>
    );
  }

  return (
    <SidebarFooter className="gap-1.5 border-t">
      <p className="text-xs text-muted-foreground">当前操作员</p>
      {demo ? (
        <DemoPicker value={String(actor.id)} />
      ) : (
        <>
          <p className="truncate text-sm font-medium">{operatorLabel(actor)}</p>
          <div className="flex gap-1.5">
            <Button size="xs" variant="outline" className="flex-1" onClick={() => void signOut()}>
              <UserCogIcon data-slot="icon" />
              换人
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button size="xs" variant="ghost" onClick={() => void signOut()} aria-label="锁屏">
                    <LogOutIcon data-slot="icon" />
                  </Button>
                }
              />
              <TooltipContent side="top">锁屏（离开磅房机前先点这个）</TooltipContent>
            </Tooltip>
          </div>
        </>
      )}
    </SidebarFooter>
  );
}

/** 「系统 → 登录与权限」里的面板版 */
export function OperatorPanel() {
  const actor = useCurrentActor();
  const demo = useSession((s) => s.demo);
  const signOut = useSignOut();
  if (!actor) return null;
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>当前操作员</SectionTitle>
      <p className="text-sm">{operatorLabel(actor)}</p>
      {demo ? (
        <>
          <DemoPicker value={String(actor.id)} size="default" />
          <p className="text-xs text-muted-foreground">浏览器演示模式：换人只改名单，不校验口令。</p>
        </>
      ) : (
        <Button size="sm" variant="outline" className="self-start" onClick={() => void signOut()}>
          <UserCogIcon data-slot="icon" />
          换人 / 锁屏（需重新输口令）
        </Button>
      )}
    </div>
  );
}
