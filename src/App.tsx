import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { router } from "@/router";
import { DEFAULT_MODE, THEME_MODE_KEY } from "@/lib/theme";
import "./App.css";

/**
 * 全局只配一次查询策略：
 *  - staleTime 20s：磅房数据不是秒级实时，避免点回来就闪 loading
 *  - refetchOnWindowFocus false：Tauri 窗口频繁失焦重绘会打断录入
 *  - retry 0：单机 SQLite 失败要立刻暴露给操作员，不悄悄重试
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 20_000, refetchOnWindowFocus: false, retry: 0 },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* 模式（light/dark/system）交给 next-themes：它管 <html> 上的 .dark 类，sonner 也读同一个上下文。
          色板覆盖不在这里，见 src/store/theme.ts。storageKey 与 bootstrapTheme 共用，首帧不会二次跳变。 */}
      <ThemeProvider
        attribute="class"
        defaultTheme={DEFAULT_MODE}
        storageKey={THEME_MODE_KEY}
        enableSystem
        disableTransitionOnChange
      >
        <TooltipProvider delay={400}>
          <RouterProvider router={router} />
          <Toaster position="bottom-right" richColors closeButton />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
