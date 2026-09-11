import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "@/lib/api";
import { DEFAULT_MODE, THEME_MODE_KEY } from "@/lib/theme";
import { money, ton, weight } from "@/lib/format";
import { useDeviceStore, useScaleTick } from "@/store/device";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Kbd } from "@/components/business/layout";
import { cn } from "cn";

export function DisplayView({ onExit }: { onExit: () => void }) {
  const scale = useDeviceStore((s) => s.scale);
  useScaleTick(220);
  const { data } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.dashboard(),
    staleTime: 30_000,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onExit]);

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-6 bg-background px-8">
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