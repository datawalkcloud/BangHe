/**
 * 顶部工具条（原「文件/业务/报表/档案/设备/帮助」菜单的落点）。
 *
 * 菜单里的跳转类能力侧栏与页内 tab 已经全覆盖，这里只留真正的全局动作：
 * 新建过磅单（弹制单框，与工作台「制单」同一张）、全局检索、折叠侧栏、对外大屏、
 * 显示模式、快捷键一览与版本。会改数据的动作在命令层还有二次权限校验，
 * 工具条不做唯一防线（05 §5 末尾要求）。
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  HelpCircleIcon,
  KeyboardIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SunIcon,
  SunMoonIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { AppBreadcrumb } from "@/components/layout/AppBreadcrumb";
import { Kbd } from "@/components/business/layout";
import { RegistrationDialog } from "@/components/workstation/RegistrationDialog";
import { api } from "@/lib/api";
import { useVarieties, useWarehouses, useSlots } from "@/hooks/useLookups";
import { useDeviceStore } from "@/store/device";
import { useThemeConfig } from "@/hooks/useThemeConfig";
import { useHotkey } from "@/hooks/useHotkey";
import { THEME_MODES, type ThemeMode } from "@/lib/theme";
import { cn } from "cn";

const SHORTCUTS: { keys: string[]; act: string; scope: string }[] = [
  { keys: ["空格"], act: "捕获当前稳定读数（毛/皮自动判定）", scope: "工作台" },
  { keys: ["F7"], act: "新建下一单", scope: "工作台" },
  { keys: ["F8"], act: "读卡", scope: "工作台" },
  { keys: ["F5"], act: "保存化验", scope: "工作台 / 化验" },
  { keys: ["F6"], act: "从价目表带出单价", scope: "扫码结算" },
  { keys: ["F9"], act: "打印当前单据（工作台=码单）", scope: "工作台 / 详情" },
  { keys: ["F10"], act: "提交结算（计价与付款）", scope: "扫码结算" },
  { keys: ["扫码枪"], act: "直接扫，不必先点进输入框", scope: "扫码结算" },
  { keys: ["F2"], act: "对外大屏开关", scope: "全局" },
  { keys: ["Alt", "1…9"], act: "跳转侧栏第 N 项", scope: "全局" },
  { keys: ["Ctrl", "K"], act: "全局检索", scope: "全局" },
  { keys: ["Ctrl", "B"], act: "折叠 / 展开侧栏", scope: "全局" },
  { keys: ["Ctrl", "E"], act: "导出当前列表为 xlsx", scope: "列表页" },
  { keys: ["Ctrl", "Alt", "D"], act: "打开设备中心", scope: "全局" },
  { keys: ["Alt", "←"], act: "返回上一页", scope: "全局" },
  { keys: ["F1"], act: "快捷键一览", scope: "全局" },
  { keys: ["Esc"], act: "关闭弹层 / 退出对外大屏", scope: "全局" },
];

const MODE_ICONS: Record<ThemeMode, typeof SunIcon> = {
  light: SunIcon,
  dark: MoonIcon,
  system: SunMoonIcon,
};

export function AppTopbar({
  onToggleSidebar,
  onOpenSearch,
  onToggleDisplay,
}: {
  onToggleSidebar: () => void;
  onOpenSearch: () => void;
  onToggleDisplay: () => void;
}) {
  const navigate = useNavigate();
  const [helpOpen, setHelpOpen] = useState(false);
  /** 新建过磅单：与工作台「制单」同一张 RegistrationDialog，任何页面都能直接开单 */
  const [regOpen, setRegOpen] = useState(false);
  const { data: parties = [] } = useQuery({ queryKey: ["parties", ""], queryFn: () => api.listParties("") });
  const { data: varieties = [] } = useVarieties();
  const { data: warehouses = [] } = useWarehouses();
  const { data: slots = [] } = useSlots();
  const { mode, setMode } = useThemeConfig();
  const ModeIcon = MODE_ICONS[mode];
  const modeLabel = THEME_MODES.find((m) => m.value === mode)?.label ?? "显示模式";

  // 快捷键一览原先只在菜单里可点，F1 一直没绑上；移到工具条时顺手补绑。
  // F7 原先只绑在工作台页，顶栏按钮既然弹同一张制单框，也收成全局键；
  // 已有弹窗开着（工作台的或本工具条的）就不重开，避免叠出两层。
  useHotkey("f1", () => setHelpOpen(true));
  useHotkey("f7", () => {
    if (!useDeviceStore.getState().regHolding) setRegOpen(true);
  });

  return (
    <>
      <header className="flex h-9 shrink-0 items-center gap-1 border-b bg-background px-2 select-none">
        <Button variant="ghost" size="icon-sm" onClick={onToggleSidebar} title="折叠 / 展开侧栏 (Ctrl+B)" aria-label="折叠 / 展开侧栏">
          <PanelLeftIcon />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => window.history.back()}
          title="返回上一页 (Alt+←)"
          aria-label="返回上一页"
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" />
          <span>返回</span>
        </Button>
        <Separator orientation="vertical" className="mx-1 h-4" />
        <AppBreadcrumb />

        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="xs" onClick={() => setRegOpen(true)}>
            <PlusIcon />
            新建过磅单
            <Kbd>F7</Kbd>
          </Button>
          <Button variant="ghost" size="xs" onClick={onOpenSearch} className="text-muted-foreground">
            <SearchIcon />
            全局检索
            <Kbd>Ctrl+K</Kbd>
          </Button>

          <Button variant="ghost" size="xs" onClick={onToggleDisplay} className="text-muted-foreground">
            <MonitorIcon />
            对外大屏
            <Kbd>F2</Kbd>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="xs" className="text-muted-foreground" />}>
              <ModeIcon />
              {modeLabel}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>显示模式</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={mode} onValueChange={(v) => setMode(v as ThemeMode)}>
                  {THEME_MODES.map((m) => (
                    <DropdownMenuRadioItem key={m.value} value={m.value}>
                      {m.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void navigate({ to: "/system/$section", params: { section: "appearance" } })}>
                外观与主题…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="xs" className="text-muted-foreground" />}>
              <HelpCircleIcon />
              帮助
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => setHelpOpen(true)}>
                  <KeyboardIcon />
                  快捷键一览
                  <DropdownMenuShortcut>F1</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void navigate({ to: "/system/$section", params: { section: "audit" } })}>
                  操作审计
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              {/* 版本号是脚注说明，不属于任何分组，Label 在组外会降级为普通文本行 */}
              <DropdownMenuLabel>磅禾 · 粮站收粮系统 0.1.0</DropdownMenuLabel>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* 新建过磅单：与工作台「制单」同一张弹窗（05 §4.0）；制完单落到工作台那张新单上继续过磅。
          没有工作台的"当前单"上下文，品种默认值带不出上一张，从空开始选 */}
      <RegistrationDialog
        open={regOpen}
        onOpenChange={setRegOpen}
        parties={parties}
        varieties={varieties}
        warehouses={warehouses}
        slots={slots}
        lastVarietyId={null}
        onCreated={(no) => void navigate({ to: "/workstation", search: { orderNo: no } })}
      />

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle>快捷键一览</DialogTitle>
            <DialogDescription>
              磅房要求不用鼠标也能开单到打印（05 §10-2），以下是当前生效的键位。
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-[60vh] overflow-y-auto">
            {SHORTCUTS.map((s) => (
              <li key={s.act} className="flex items-center gap-3 border-b py-2 last:border-b-0">
                <span className="flex w-40 shrink-0 flex-wrap gap-1">
                  {s.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
                <span className={cn("min-w-0 flex-1 text-sm")}>{s.act}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{s.scope}</span>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
