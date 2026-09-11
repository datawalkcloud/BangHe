/**
 * 顶部菜单（桌面软件气质，05 §2）。
 *
 * 菜单项只做两件事：跳转与触发全局动作。所有真正会改数据的动作
 * 在命令层还有二次权限校验，菜单这里不做唯一防线（05 §5 末尾要求）。
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Menubar, MenubarContent, MenubarGroup, MenubarItem, MenubarLabel, MenubarMenu, MenubarRadioGroup, MenubarRadioItem, MenubarSeparator, MenubarShortcut, MenubarSub, MenubarSubContent, MenubarSubTrigger, MenubarTrigger } from "@/components/ui/menubar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Kbd } from "@/components/business/layout";
import { useDeviceStore } from "@/store/device";
import { useThemeConfig } from "@/hooks/useThemeConfig";
import { THEME_MODES, type ThemeMode } from "@/lib/theme";
import { PanelLeftIcon, SearchIcon } from "lucide-react";
import { cn } from "cn";

const SHORTCUTS: { keys: string[]; act: string; scope: string }[] = [
  { keys: ["空格"], act: "捕获当前稳定读数（毛/皮自动判定）", scope: "工作台" },
  { keys: ["F7"], act: "新建下一单", scope: "工作台" },
  { keys: ["F8"], act: "读卡", scope: "工作台" },
  { keys: ["F5"], act: "保存化验", scope: "工作台 / 化验" },
  { keys: ["F6"], act: "从价目表带出单价", scope: "工作台" },
  { keys: ["F9"], act: "打印当前单据", scope: "工作台 / 详情" },
  { keys: ["F10"], act: "结算并打印码单", scope: "工作台" },
  { keys: ["F2"], act: "展示模式切换", scope: "全局" },
  { keys: ["Alt", "1…9"], act: "跳转侧栏第 N 项", scope: "全局" },
  { keys: ["Ctrl", "K"], act: "全局检索", scope: "全局" },
  { keys: ["Ctrl", "B"], act: "折叠 / 展开侧栏", scope: "全局" },
  { keys: ["Ctrl", "E"], act: "导出当前列表为 xlsx", scope: "列表页" },
  { keys: ["Ctrl", "Alt", "D"], act: "打开设备中心", scope: "全局" },
  { keys: ["Esc"], act: "关闭弹层 / 退出展示模式", scope: "全局" },
];

export function AppMenubar({
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
  const mockOff = useDeviceStore((s) => s.mockOff);
  const setMockOff = useDeviceStore((s) => s.setMockOff);
  const { mode, setMode } = useThemeConfig();

  /** 菜单里的路由用字面量，统一在此收敛一次跳转 */
  const go = (to: string) => {
    void navigate({ to: to as never });
  };

  return (
    <>
      <Menubar className="h-9 shrink-0 rounded-none border-x-0 border-t-0 px-1">
        <MenubarMenu>
          <MenubarTrigger>文件</MenubarTrigger>
          <MenubarContent className="w-60">
            <MenubarGroup>
              <MenubarItem onClick={() => go("/workstation")}>
                新建过磅单 <MenubarShortcut>F7</MenubarShortcut>
              </MenubarItem>
              <MenubarItem onClick={onOpenSearch}>
                全局检索 <MenubarShortcut>Ctrl+K</MenubarShortcut>
              </MenubarItem>
              <MenubarItem disabled>导出当前列表（需先选中列表页）</MenubarItem>
            </MenubarGroup>
            <MenubarSeparator />
            <MenubarGroup>
              <MenubarLabel>视图</MenubarLabel>
              <MenubarItem onClick={onToggleSidebar}>
                <PanelLeftIcon />
                折叠侧栏 <MenubarShortcut>Ctrl+B</MenubarShortcut>
              </MenubarItem>
              <MenubarItem onClick={onToggleDisplay}>
                展示模式 <MenubarShortcut>F2</MenubarShortcut>
              </MenubarItem>
              {/* 夜班与白班的光照不是一套：模式放在菜单里常驻，不必每次进设置页 */}
              <MenubarSub>
                <MenubarSubTrigger>显示模式</MenubarSubTrigger>
                <MenubarSubContent className="w-44">
                  <MenubarRadioGroup value={mode} onValueChange={(v) => setMode(v as ThemeMode)}>
                    {THEME_MODES.map((m) => (
                      <MenubarRadioItem key={m.value} value={m.value}>
                        {m.label}
                      </MenubarRadioItem>
                    ))}
                  </MenubarRadioGroup>
                </MenubarSubContent>
              </MenubarSub>
              <MenubarItem onClick={() => go("/system/appearance")}>外观与主题</MenubarItem>
            </MenubarGroup>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>业务</MenubarTrigger>
          <MenubarContent className="w-60">
            <MenubarGroup>
              <MenubarItem onClick={() => go("/workstation")}>磅房工作台</MenubarItem>
              <MenubarItem onClick={() => go("/orders")}>磅单中心</MenubarItem>
              <MenubarItem onClick={() => go("/qc")}>
                化验工作台 <MenubarShortcut>F5</MenubarShortcut>
              </MenubarItem>
              <MenubarItem onClick={() => go("/settlements")}>结算中心</MenubarItem>
              <MenubarItem onClick={() => go("/payments")}>付款与挂账</MenubarItem>
            </MenubarGroup>
            <MenubarSeparator />
            <MenubarGroup>
              <MenubarItem onClick={() => go("/parties")}>农户与往来单位</MenubarItem>
            </MenubarGroup>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>报表</MenubarTrigger>
          <MenubarContent className="w-60">
            <MenubarGroup>
              <MenubarItem onClick={() => go("/reports/ledger")}>收购明细台账</MenubarItem>
              <MenubarItem onClick={() => go("/reports/daily")}>日报 / 月报</MenubarItem>
              <MenubarItem onClick={() => go("/reports/quality")}>质量分析</MenubarItem>
              <MenubarItem onClick={() => go("/reports/parties")}>农户排行与对账</MenubarItem>
              <MenubarItem onClick={() => go("/reports/staff")}>作业量与异常统计</MenubarItem>
            </MenubarGroup>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>档案</MenubarTrigger>
          <MenubarContent className="w-60">
            <MenubarGroup>
              <MenubarItem onClick={() => go("/masters/varieties")}>品种与指标</MenubarItem>
              <MenubarItem onClick={() => go("/masters/warehouses")}>仓房与货位</MenubarItem>
              <MenubarItem onClick={() => go("/masters/prices")}>收购价目表</MenubarItem>
              <MenubarItem onClick={() => go("/masters/settings")}>站点参数</MenubarItem>
              <MenubarItem onClick={() => go("/masters/staff")}>员工与岗位</MenubarItem>
            </MenubarGroup>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>设备</MenubarTrigger>
          <MenubarContent className="w-64">
            <MenubarGroup>
              <MenubarItem onClick={() => go("/devices")}>
                设备中心 <MenubarShortcut>Ctrl+Alt+D</MenubarShortcut>
              </MenubarItem>
            </MenubarGroup>
            <MenubarSeparator />
            <MenubarGroup>
              <MenubarItem onClick={() => setMockOff(!mockOff)}>
                {mockOff ? "恢复外设 Mock 数据" : "关闭外设 Mock（验收手录闭环）"}
              </MenubarItem>
            </MenubarGroup>
            <MenubarSeparator />
            <MenubarSub>
              <MenubarSubTrigger>打印通道</MenubarSubTrigger>
              <MenubarSubContent className="w-48">
                <MenubarGroup>
                  <MenubarItem>窗口预览（默认）</MenubarItem>
                  <MenubarItem>PDF 静默</MenubarItem>
                  <MenubarItem>RAW 直连针式</MenubarItem>
                </MenubarGroup>
              </MenubarSubContent>
            </MenubarSub>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>帮助</MenubarTrigger>
          <MenubarContent className="w-60">
            <MenubarGroup>
              <MenubarItem onClick={() => setHelpOpen(true)}>
                快捷键一览 <MenubarShortcut>F1</MenubarShortcut>
              </MenubarItem>
              <MenubarItem onClick={() => go("/system/audit")}>操作审计</MenubarItem>
            </MenubarGroup>
            <MenubarSeparator />
            {/* 版本号是脚注说明，不属于任何分组，Label 在组外会降级为普通文本行 */}
            <MenubarLabel>磅禾 · 粮站收粮系统 0.1.0（Mock 数据）</MenubarLabel>
          </MenubarContent>
        </MenubarMenu>

        <span className="ml-auto hidden items-center gap-1 pr-1 text-xs text-muted-foreground lg:flex">
          <SearchIcon className="size-3.5" />
          Ctrl+K 检索
        </span>
      </Menubar>

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
