import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { router } from "@/router";
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
      <TooltipProvider delay={400}>
        <RouterProvider router={router} />
        <Toaster position="bottom-right" richColors closeButton />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
