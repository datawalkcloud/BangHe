/**
 * 应用骨架（05 §2）：Menubar 顶 + Sidebar 左（240/56）+ 页面区 + 底部设备状态条。
 *
 * 三条硬约束在代码里的落点：
 *  1. 设备状态条常驻不可隐藏——它挂在 SidebarProvider 之外，侧栏折叠不影响它
 *  2. 全局快捷键集中在本文件注册，权限校验在命令层另做（05 §5 要求）
 *  3. 展示模式（F2）为覆盖层，真实实现是独立 Tauri 窗口，这里等价演示给农户核对
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  PanelLeftCloseIcon,
  ScanLineIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { useDeviceStore, useScaleTick } from "@/store/device";
import { useSession } from "@/store/session";
import { money, ton, weight } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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
import { Kbd } from "@/components/business/layout";
import { AppMenubar } from "@/components/layout/AppMenubar";
import { NAV_FLAT, NAV_GROUPS, isNavActive } from "@/components/layout/app-nav";
import { cn } from "cn";

/** 侧栏展开 240 / 折叠 56（05 §7.3），覆盖 shadcn 默认的 256/68 */
const SIDEBAR_STYLE = { "--sidebar-width": "240px", "--sidebar-width-icon": "56px" } as CSSProperties;

function Brand() {
  const { data: st } = useQuery({ queryKey: ["station"], queryFn: () => api.station() });
  const { state } = useSidebar();
  return (
    <SidebarHeader className="gap-0">
      <div className="flex h-12 items-center gap-2 px-3">
        <span className="flex size-8 shrink-0 items-center justify-center border bg-primary text-primary-foreground">
          <ScanLineIcon className="size-4" />
        </span>
        {state === "expanded" && (
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-semibold">{st?.name ?? "邦禾粮站"}</span>
            <span className="truncate text-xs text-muted-foreground">收粮计量结算系统</span>
          </span>
        )}
      </div>
    </SidebarHeader>
  );
}

function Nav() {
  const pathname = useLocation({ select: (l) => l.pathname });
  const navigate = useNavigate();
  const { state } = useSidebar();
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
                      {state === "expanded" && idx >= 0 && idx < 9 && (
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

/** F2 展示模式：超大字号重量 + 今日金额，供农户在窗口外核对（05 §4） */
function DisplayOverlay({ onExit }: { onExit: () => void }) {
  const scale = useDeviceStore((s) => s.scale);
  const { data } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.dashboard(),
    staleTime: 30_000,
  });
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-background px-8">
      <p className="text-2xl font-medium text-muted-foreground">{data?.today ? "今日收购合计" : "加载中…"}</p>
      <p className="tnum text-center text-[clamp(72px,14vw,220px)] leading-none font-bold tabular-nums">
        {weight(scale.weight01kg)}
      </p>
      <p className={cn("text-lg", scale.stable ? "text-success" : "text-warning")}>
        {scale.connected ? (scale.stable ? "● 读数稳定" : "○ 读数变动中，请等车辆停稳") : "— 仪表离线 —"}
      </p>
      <Separator className="w-1/3" />
      <div className="flex flex-wrap items-baseline justify-center gap-x-10 gap-y-2 text-center">
        <p className="text-lg text-muted-foreground">
          今日 <span className="tnum text-3xl font-semibold text-foreground">{data?.today.orders ?? 0}</span> 车次
        </p>
        <p className="text-lg text-muted-foreground">
          <span className="tnum text-3xl font-semibold text-foreground">{ton(data?.today.net_01kg ?? 0)}</span>
        </p>
        <p className="text-lg text-muted-foreground">
          金额 <span className="tnum text-3xl font-semibold text-foreground">{money(data?.today.goods_fen ?? 0)}</span>
        </p>
      </div>
      <p className="mt-6 text-sm text-muted-foreground">
        <Kbd>Esc</Kbd> 退出展示模式
      </p>
      <Button variant="outline" size="sm" className="absolute top-4 right-4" onClick={onExit}>
        退出
      </Button>
    </div>
  );
}

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [display, setDisplay] = useState(false);
  const navigate = useNavigate();
  const demo = useSession((s) => s.demo);
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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // F 区与 Ctrl 组合键必须 preventDefault，否则 WebView 抢去做浏览器默认行为
      if (e.key === "F2") {
        e.preventDefault();
        setDisplay((d) => !d);
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
  }, [navigate, toggleSidebar]);

  return (
    <SidebarProvider
      open={!collapsed}
      onOpenChange={setCollapsed}
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
        <AppMenubar
          onToggleSidebar={toggleSidebar}
          onOpenSearch={() => setSearchOpen(true)}
          onToggleDisplay={() => setDisplay((d) => !d)}
        />
        {demo && (
          <div className="border-b bg-warning/10 px-4 py-1.5 text-xs text-warning">
            浏览器演示模式：没有原生通道，<b>口令不做校验</b>，数据全是模拟。真实登录、真库与外设都要用桌面版（
            <span className="font-mono">npm run tauri dev</span>）。
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </div>
        <DeviceStatusBar />
      </SidebarInset>
      {display && <DisplayOverlay onExit={() => setDisplay(false)} />}
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
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
