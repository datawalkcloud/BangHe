/**
 * 应用骨架（05 §2）：顶栏工具条 + Sidebar 左（展开宽度可拖、折叠固定 56）+ 页面区 + 底部设备状态条。
 *
 * 三条硬约束在代码里的落点：
 *  1. 设备状态条常驻不可隐藏——它挂在 SidebarProvider 之外，侧栏折叠不影响它
 *  2. 全局快捷键集中在本文件注册，权限校验在命令层另做（05 §5 要求）
 *  3. 展示模式（F2）：桌面端一律另起独立窗口，多屏整屏贴外屏、单屏开浮动窗，
 *     主窗口始终留给操作员；本文件内的覆盖层只服务浏览器预览，见 `lib/display-window.ts`
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PanelLeftCloseIcon } from "lucide-react";
import { api } from "@/lib/api";
import { useScaleTick } from "@/store/device";
import { useSession } from "@/store/session";
import { Button } from "@/components/ui/button";
import { useSidebarWidth } from "@/hooks/useSidebarWidth";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { OperatorFooter } from "@/components/business/OperatorSwitch";
import { DeviceStatusBar } from "@/components/business/DeviceStatusBar";
import { GlobalSearch } from "@/components/business/GlobalSearch";
import { QuickDetailSheet } from "@/components/business/QuickDetailSheet";
import { AppTopbar } from "@/components/layout/AppTopbar";
import { NAV_FLAT, NAV_GROUPS, isNavActive } from "@/components/layout/app-nav";
import { cn } from "cn";
import { DisplayView } from "@/components/business/DisplayView";
import { toggleDisplayWindow } from "@/lib/display-window";
import { runningInTauri } from "@/lib/native";
import { toast } from "sonner";

/**
 * 侧栏折叠档固定 56（05 §7.3）。展开档不再钉死 240：握把可以拖，
 * 初值与上下限见 `hooks/useSidebarWidth.ts` 与 `ui/sidebar.tsx`。
 */
const SIDEBAR_STYLE = { "--sidebar-width-icon": "56px" } as CSSProperties;

/** 窄到这个宽度以下就收掉"Alt+N"角标和品牌副标题，把横向空间让给导航文字本身 */
const SIDEBAR_ROOMY_WIDTH = 216;

function Brand() {
  const { data: st } = useQuery({ queryKey: ["station"], queryFn: () => api.station() });
  const { state, resize } = useSidebar();
  const roomy = resize.width >= SIDEBAR_ROOMY_WIDTH;
  return (
    <SidebarHeader className="gap-0">
      {/* 折叠态栏宽 56，logo 放大到 40 并居中，避免 32px 在窄栏里显得过小 */}
      <div className={cn("flex h-12 items-center gap-2", state === "expanded" ? "px-3" : "justify-center")}>
        <img src="/logo.png" alt="磅禾" className={cn("shrink-0 object-contain", state === "expanded" ? "size-8" : "size-10")} />
        {state === "expanded" && (
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-semibold">{st?.name ?? "磅禾粮站"}</span>
            {roomy && <span className="truncate text-xs text-muted-foreground">收粮计量结算系统</span>}
          </span>
        )}
      </div>
    </SidebarHeader>
  );
}

function Nav() {
  const pathname = useLocation({ select: (l) => l.pathname });
  const navigate = useNavigate();
  const { state, resize } = useSidebar();
  const showShortcut = state === "expanded" && resize.width >= SIDEBAR_ROOMY_WIDTH;
  const go = (href: string) => void navigate({ to: href as never });
  return (
    <SidebarContent className="gap-0">
      {NAV_GROUPS.map((g, gi) => (
        <SidebarGroup key={g.label} className={cn(gi > 0 && "border-t")}>
          <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {g.items.map((item) => {
                const idx = NAV_FLAT.findIndex((n) => n.href === item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      isActive={isNavActive(item, pathname)}
                      tooltip={`${item.label}${idx >= 0 && idx < 9 ? ` (Alt+${idx + 1})` : ""}`}
                      onClick={() => go(item.href)}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                      {showShortcut && idx >= 0 && idx < 9 && (
                        <span className="tnum ml-auto text-[10px] text-muted-foreground">Alt+{idx + 1}</span>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </SidebarContent>
  );
}

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [display, setDisplay] = useState(false);
  const navigate = useNavigate();
  const demo = useSession((s) => s.demo);
  // 展开宽度拖到哪就记到哪（跟着账号走），拖完刷新还在原处
  const sidebarWidth = useSidebarWidth();
  useScaleTick(220);

  /**
   * 空闲失效（02 §11 M10，具体时长由后端下发）。两条线各管一段：
   *  - 本地时钟：机器睡了一觉回来，第一眼就该是登录页，不等下一次问后端；
   *  - `auth_touch`：真正说了算的是 Rust 里的 last_seen，只有动过键盘/鼠标才算"有人在用"，
   *    所以定时器本身不会把会话续下去。
   */
  const touched = useRef(false);
  const lastBeatAt = useRef(Date.now());
  useEffect(() => {
    const mark = () => {
      touched.current = true;
    };
    window.addEventListener("pointerdown", mark, true);
    window.addEventListener("keydown", mark, true);
    const timer = window.setInterval(() => {
      const s = useSession.getState();
      if (s.phase !== "in" || s.demo) return;
      const ttl = (s.session?.idleTtlSecs ?? 0) * 1000;
      if (ttl > 0 && Date.now() - lastBeatAt.current > ttl) {
        s.expire("已超过约定时长无操作，请重新登录");
        void navigate({ to: "/login" });
        return;
      }
      if (!touched.current) return;
      touched.current = false;
      void s.beat().then((alive) => {
        if (alive) lastBeatAt.current = Date.now();
        else void navigate({ to: "/login" });
      });
    }, 60_000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointerdown", mark, true);
      window.removeEventListener("keydown", mark, true);
    };
  }, [navigate]);

  const toggleSidebar = useCallback(() => setCollapsed((c) => !c), []);
  const toggleDisplay = useCallback(async () => {
    if (!runningInTauri()) {
      setDisplay((d) => !d);
      return;
    }
    try {
      await toggleDisplayWindow();
    } catch (error) {
      toast.error(`无法打开展示窗口：${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // F 区与 Ctrl 组合键必须 preventDefault，否则 WebView 抢去做浏览器默认行为
      if (e.key === "F2") {
        e.preventDefault();
        void toggleDisplay();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }
      if (e.ctrlKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (e.ctrlKey && e.altKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        void navigate({ to: "/devices" });
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
        const item = NAV_FLAT[Number(e.key) - 1];
        if (item) {
          e.preventDefault();
          void navigate({ to: item.href as never });
        }
        return;
      }
      if (e.key === "Escape") setDisplay(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, toggleDisplay, toggleSidebar]);

  return (
    <SidebarProvider
      open={!collapsed}
      onOpenChange={setCollapsed}
      resizable
      width={sidebarWidth.width}
      onWidthChange={sidebarWidth.setWidth}
      onWidthCommit={sidebarWidth.commit}
      style={SIDEBAR_STYLE}
      className="h-svh min-h-0 overflow-hidden"
    >
      <Sidebar collapsible="icon" variant="sidebar">
        <Brand />
        <Nav />
        <OperatorFooter />
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="flex h-svh min-w-0 flex-1 flex-col overflow-hidden">
        <AppTopbar
          onToggleSidebar={toggleSidebar}
          onOpenSearch={() => setSearchOpen(true)}
          onToggleDisplay={() => void toggleDisplay()}
        />
        {demo && (
          <div className="border-b bg-warning/10 px-4 py-1.5 text-xs text-warning">
            浏览器演示模式：没有原生通道，<b>密码不做校验</b>，数据全是模拟。真实登录、真库与外设都要用桌面版（
            <span className="font-mono">npm run tauri dev</span>）。
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </div>
        <DeviceStatusBar />
      </SidebarInset>
      {display && <DisplayView onExit={() => setDisplay(false)} />}
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
      <QuickDetailSheet />
    </SidebarProvider>
  );
}

/** 页面级"折叠侧栏"入口，工作台用 */
export function CollapseHint() {
  const { toggleSidebar } = useSidebar();
  return (
    <Button variant="ghost" size="icon-sm" onClick={toggleSidebar} title="折叠侧栏 (Ctrl+B)">
      <PanelLeftCloseIcon />
    </Button>
  );
}
