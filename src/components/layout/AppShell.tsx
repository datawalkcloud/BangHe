/**
 * 应用骨架（05 §2）：顶栏工具条 + Sidebar 左（展开宽度可拖、折叠固定 56）+ 页面区 + 底部设备状态条。
 *
 * 桌面端的"拖宽 / 拖到底收起"走官方 Resizable（react-resizable-panels）：侧栏与内容区是
 * PanelGroup 里的两个 Panel，中间一根 ResizableHandle——面板拖不满 minSize 会自动进
 * 折叠档（collapsedSize 56），点一下把手则折叠/展开。移动端没有面板，退回官方 Sidebar
 * 自带的 Sheet。
 *
 * 三条硬约束在代码里的落点：
 *  1. 设备状态条常驻不可隐藏——它挂在 SidebarProvider 之外，侧栏折叠不影响它
 *  2. 全局快捷键集中在本文件注册，权限校验在命令层另做（05 §5 要求）
 *  3. 对外大屏（F2）：桌面端一律另起独立窗口，多屏整屏贴外屏、单屏开浮动窗，
 *     主窗口始终留给操作员；本文件内的覆盖层只服务浏览器预览，见 `lib/display-window.ts`
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { usePanelRef } from "react-resizable-panels";
import { PanelLeftCloseIcon } from "lucide-react";
import { api } from "@/lib/api";
import { useScaleTick } from "@/store/device";
import { useSession } from "@/store/session";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useSidebarWidth,
} from "@/hooks/useSidebarWidth";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
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
  useSidebar,
} from "@/components/ui/sidebar";
import { OperatorFooter } from "@/components/business/OperatorSwitch";
import { DeviceStatusBar } from "@/components/business/DeviceStatusBar";
import { GlobalSearch } from "@/components/business/GlobalSearch";
import { QuickDetailSheet } from "@/components/business/QuickDetailSheet";
import { AppTopbar } from "@/components/layout/AppTopbar";
import { LockScreen } from "@/components/layout/LockScreen";
import { NAV_FLAT, NAV_GROUPS, isNavActive } from "@/components/layout/app-nav";
import { cn } from "cn";
import { DisplayView } from "@/components/business/DisplayView";
import { toggleDisplayWindow } from "@/lib/display-window";
import { runningInTauri } from "@/lib/native";
import { toast } from "sonner";

/**
 * 侧栏折叠档固定 56（05 §7.3）。展开档不再钉死 240：握把可以拖，
 * 出厂 208、边界见 `hooks/useSidebarWidth.ts`。
 */
const SIDEBAR_ICON_WIDTH = 56;
const SIDEBAR_STYLE = { "--sidebar-width-icon": `${SIDEBAR_ICON_WIDTH}px` } as CSSProperties;

/** 窄到这个宽度以下就收掉"Alt+N"角标和品牌副标题，把横向空间让给导航文字本身 */
const SIDEBAR_ROOMY_WIDTH = 200;
/** 把手按下与抬起的水平位移小于这个值算"点了一下"（折叠/展开），不算拖动 */
const HANDLE_CLICK_SLOP = 4;

function Brand({ roomy }: { roomy: boolean }) {
  const { data: st } = useQuery({ queryKey: ["station"], queryFn: () => api.station() });
  const { state } = useSidebar();
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

function Nav({ roomy }: { roomy: boolean }) {
  const pathname = useLocation({ select: (l) => l.pathname });
  const navigate = useNavigate();
  const { state } = useSidebar();
  const showShortcut = state === "expanded" && roomy;
  const go = (href: string) => void navigate({ to: href as never });
  return (
    <SidebarContent className="gap-0">
      {NAV_GROUPS.map((g, gi) => (
        // 展开档去掉右侧留白：按钮直接贴到侧栏边界（折叠档仍居中，不加）
        <SidebarGroup key={g.label} className={cn(gi > 0 && "border-t", state === "expanded" && "pr-0")}>
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
  const isMobile = useIsMobile();
  const panelRef = usePanelRef();
  /** 面板实时宽度：品牌副标题与 Alt+N 角标的"够不够挤"看它 */
  const [liveWidth, setLiveWidth] = useState(sidebarWidth.width);
  /** 把手按下时的指针位置：没位移的抬起按"点了一下折叠/展开"处理 */
  const pressX = useRef<number | null>(null);
  useScaleTick();

  // 外部切换（Ctrl+B、顶栏、点把手）驱动面板收放；面板自己收放时这两个 effect 都是空转
  useEffect(() => {
    const p = panelRef.current;
    if (!p) return;
    if (collapsed) p.collapse();
    else p.expand();
  }, [collapsed, panelRef]);

  // 账号偏好是异步读回来的：defaultSize 用的还是挂载那一刻的值，到货后补一次 resize
  useEffect(() => {
    const p = panelRef.current;
    if (!p) return;
    if (Math.abs(p.getSize().inPixels - sidebarWidth.width) > 2) p.resize(sidebarWidth.width);
  }, [sidebarWidth.width, panelRef]);

  /**
   * 空闲锁屏（02 §11 M10，具体时长由后端下发）。两条线各管一段：
   *  - 本地时钟：机器睡了一觉回来，第一眼就该是锁屏，不等下一次问后端；
   *  - `auth_touch`：真正说了算的是 Rust 里的 last_seen，只有动过键盘/鼠标才算"有人在用"，
   *    所以定时器本身不会把会话续下去。
   * 锁屏只是要一次密码，会话不清、页面不跳，解锁后原地继续。
   */
  const touched = useRef(false);
  const lastBeatAt = useRef(Date.now());
  // 解锁瞬间把本地空闲计时拨回现在：否则锁屏前留到最后一次心跳的时间差
  // 会立刻又超 ttl，下一次 tick 就把刚解开的人再锁回去
  const locked = useSession((s) => s.locked);
  useEffect(() => {
    if (!locked) lastBeatAt.current = Date.now();
  }, [locked]);
  useEffect(() => {
    const mark = () => {
      touched.current = true;
    };
    window.addEventListener("pointerdown", mark, true);
    window.addEventListener("keydown", mark, true);
    const timer = window.setInterval(() => {
      const s = useSession.getState();
      if (s.phase !== "in" || s.demo || s.locked) return;
      const ttl = (s.session?.idleTtlSecs ?? 0) * 1000;
      if (ttl > 0 && Date.now() - lastBeatAt.current > ttl) {
        // 机器睡了一觉回来：第一眼就该是锁屏，不等下一次问后端
        s.lock();
        return;
      }
      if (!touched.current) return;
      touched.current = false;
      // beat() 判定空闲超限时只会就地锁屏，浮层由本组件的 locked 状态渲染
      void s.beat().then((alive) => {
        if (alive) lastBeatAt.current = Date.now();
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
      toast.error(`无法打开对外大屏：${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // 锁屏期间全局快捷键一律失效，浮层里自己的按键不拦
      if (useSession.getState().locked && !(e.target instanceof HTMLElement && e.target.closest("[data-lock-screen]"))) return;
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
      style={SIDEBAR_STYLE}
      className="h-svh min-h-0 overflow-hidden"
    >
      {isMobile ? (
        <>
          <Sidebar collapsible="icon" variant="sidebar">
            <Brand roomy />
            <Nav roomy />
            <OperatorFooter />
          </Sidebar>
          <SidebarInset className="flex h-svh min-w-0 flex-1 flex-col overflow-hidden">
            <ShellContent toggleSidebar={toggleSidebar} onOpenSearch={() => setSearchOpen(true)} onToggleDisplay={() => void toggleDisplay()} demo={demo} />
          </SidebarInset>
        </>
      ) : (
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 w-full flex-1"
          onLayoutChanged={(_layout, meta) => {
            // 松手那一下才落库：拖动中的每帧只走 onResize 更新本地状态
            const p = panelRef.current;
            if (meta.isUserInteraction && p && !p.isCollapsed()) sidebarWidth.commit(p.getSize().inPixels);
          }}
        >
          <ResizablePanel
            id="sidebar"
            panelRef={panelRef}
            defaultSize={sidebarWidth.width}
            minSize={SIDEBAR_MIN_WIDTH}
            maxSize={SIDEBAR_MAX_WIDTH}
            collapsible
            collapsedSize={SIDEBAR_ICON_WIDTH}
            groupResizeBehavior="preserve-pixel-size"
            onResize={(size) => {
              setLiveWidth(size.inPixels);
              const atIcon = size.inPixels <= SIDEBAR_ICON_WIDTH + 1;
              // 停在折叠档时不把 56 记成展开宽度：下次展开还该是刚才那一档
              if (!atIcon) sidebarWidth.setWidth(size.inPixels);
              setCollapsed((c) => (c === atIcon ? c : atIcon));
            }}
          >
            {/* 面板就是布局容器：Sidebar 用官方 collapsible="none" 形态铺满它，不再走 fixed + gap 那套 */}
            <Sidebar collapsible="none" variant="sidebar" className="h-full w-full border-r border-sidebar-border">
              <Brand roomy={liveWidth >= SIDEBAR_ROOMY_WIDTH} />
              <Nav roomy={liveWidth >= SIDEBAR_ROOMY_WIDTH} />
              <OperatorFooter />
            </Sidebar>
          </ResizablePanel>
          {/* 只保留侧栏自身的 1px 边框作分隔；把手保留 4px 拖拽热区但平时透明，不再是一条色带 */}
          <ResizableHandle
            title="拖动调整宽度 · 单击折叠/展开 (Ctrl+B)"
            className="w-1 shrink-0 bg-transparent hover:bg-sidebar-border active:bg-sidebar-accent"
            onPointerDown={(e) => {
              pressX.current = e.clientX;
            }}
            onPointerUp={(e) => {
              const start = pressX.current;
              pressX.current = null;
              if (start != null && Math.abs(e.clientX - start) <= HANDLE_CLICK_SLOP) toggleSidebar();
            }}
          />
          <ResizablePanel id="main" minSize="20rem">
            <SidebarInset className="h-full min-w-0 overflow-hidden">
              <ShellContent toggleSidebar={toggleSidebar} onOpenSearch={() => setSearchOpen(true)} onToggleDisplay={() => void toggleDisplay()} demo={demo} />
            </SidebarInset>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
      {display && <DisplayView onExit={() => setDisplay(false)} />}
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
      <QuickDetailSheet />
      <LockScreen />
    </SidebarProvider>
  );
}

/** 顶栏 + 页面区 + 设备状态条：桌面（面板内）与移动（Sheet 旁）两种布局共用 */
function ShellContent({
  toggleSidebar,
  onOpenSearch,
  onToggleDisplay,
  demo,
}: {
  toggleSidebar: () => void;
  onOpenSearch: () => void;
  onToggleDisplay: () => void;
  demo: boolean;
}) {
  return (
    <>
      <AppTopbar
        onToggleSidebar={toggleSidebar}
        onOpenSearch={onOpenSearch}
        onToggleDisplay={onToggleDisplay}
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
    </>
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
