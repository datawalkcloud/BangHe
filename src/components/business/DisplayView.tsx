import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "@/lib/api";
import { runningInTauri } from "@/lib/native";
import { DEFAULT_MODE, THEME_MODE_KEY } from "@/lib/theme";
import { money, ton, weight } from "@/lib/format";
import { resolveRange } from "@/lib/date-range";
import { useDeviceStore, useScaleTick } from "@/store/device";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Kbd } from "@/components/business/layout";
import { cn } from "cn";

export function DisplayView({ onExit }: { onExit: () => void }) {
  const scale = useDeviceStore((s) => s.scale);
  useScaleTick();
  /** 只有独立大屏窗能整屏；浏览器预览里这层是主窗口的覆盖层，没有窗口可全屏 */
  const inWindow = runningInTauri();
  const [fullscreen, setFullscreen] = useState(false);
  // 大屏固定看"今天"：不暴露区间选择器，站长挂墙上的就是当天气势。
  const { from, to } = resolveRange("today");
  const { data } = useQuery({
    queryKey: ["dashboard", from, to],
    queryFn: () => api.dashboard(from, to),
    staleTime: 30_000,
  });

  /**
   * 只切 `setFullscreen`：无边框全屏在 Windows 上是 tao 按窗口 flag 重算样式，
   * 退出时标题栏自己回来，不需要也不该再调 `setDecorations`。
   */
  const toggleFullscreen = useCallback(async () => {
    const win = getCurrentWindow();
    const next = !(await win.isFullscreen());
    await win.setFullscreen(next);
    setFullscreen(next);
  }, []);

  useEffect(() => {
    if (!inWindow) return;
    void getCurrentWindow()
      .isFullscreen()
      .then(setFullscreen)
      .catch(() => {});
  }, [inWindow]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExit();
      // 整屏之后没有标题栏可拖，F11 是不用摸黑找按钮的退路
      if (event.key === "F11" && inWindow) {
        event.preventDefault();
        void toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onExit, inWindow, toggleFullscreen]);

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-6 bg-background px-8">
      <p className="text-2xl font-medium text-muted-foreground">{data?.summary ? "今日收购合计" : "加载中…"}</p>
      <p className="tnum text-center text-[clamp(72px,14vw,220px)] leading-none font-bold tabular-nums">
        {weight(scale.weight01kg)}
      </p>
      <p className={cn("text-lg", scale.stable ? "text-success" : "text-warning")}>
        {scale.connected ? (scale.stable ? "● 读数稳定" : "○ 读数变动中，请等车辆停稳") : "— 仪表离线 —"}
      </p>
      <Separator className="w-1/3" />
      <div className="flex flex-wrap items-baseline justify-center gap-x-10 gap-y-2 text-center">
        <p className="text-lg text-muted-foreground">
          今日 <span className="tnum text-3xl font-semibold text-foreground">{data?.summary.orders ?? 0}</span> 车次
        </p>
        <p className="text-lg text-muted-foreground">
          <span className="tnum text-3xl font-semibold text-foreground">{ton(data?.summary.net_01kg ?? 0)}</span>
        </p>
        <p className="text-lg text-muted-foreground">
          金额 <span className="tnum text-3xl font-semibold text-foreground">{money(data?.summary.goods_fen ?? 0)}</span>
        </p>
      </div>
      <p className="mt-6 flex items-center gap-6 text-sm text-muted-foreground">
        {inWindow && (
          <span className="flex items-center gap-1.5">
            <Kbd>F11</Kbd> 全屏 / 退出全屏
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <Kbd>Esc</Kbd> 退出对外大屏
        </span>
      </p>
      <div className="absolute top-4 right-4 flex items-center gap-2">
        {inWindow && (
          <Button variant="outline" size="sm" onClick={() => void toggleFullscreen()}>
            {fullscreen ? "退出全屏" : "全屏"}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onExit}>
          退出
        </Button>
      </div>
    </div>
  );
}

export function DisplayWindowApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 20_000, refetchOnWindowFocus: false, retry: 0 } },
  });
  const close = () => void getCurrentWindow().close();

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme={DEFAULT_MODE} storageKey={THEME_MODE_KEY} enableSystem>
        <DisplayView onExit={close} />
      </ThemeProvider>
    </QueryClientProvider>
  );
}