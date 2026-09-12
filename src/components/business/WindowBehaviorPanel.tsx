/**
 * 主窗口的关闭行为（系统 → 窗口）。
 *
 * 只有两件事要在这里说清楚，其余判定全在 Rust（`src-tauri/src/window.rs`）：
 *  - 改的是**窗口右上角那个 ✕**（含 Alt+F4）的去向，不是"退出登录"；
 *  - 选了「隐藏到系统托盘」之后 ✕ 就退不出程序了，所以侧栏与托盘菜单各留一个真能退出的
 *    入口——这台机器一开一整天，收工总得有人把它关掉。
 */
import { PowerIcon } from "lucide-react";
import { toast } from "sonner";
import { runningInTauri } from "@/lib/native";
import { systemApi } from "@/lib/system-native";
import { useCloseBehavior } from "@/hooks/useCloseBehavior";
import { SectionTitle } from "@/components/business/layout";
import { ChoiceCard } from "@/components/business/ChoiceCard";
import { Button } from "@/components/ui/button";

export function WindowBehaviorPanel() {
  const desktop = runningInTauri();
  const { behavior, loading, saving, set } = useCloseBehavior();
  const busy = !desktop || loading || saving;

  function doExit() {
    systemApi
      .exit()
      .catch((e: unknown) => toast.error(`退出失败：${e instanceof Error ? e.message : String(e)}`));
  }

  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-2 border bg-card p-3">
        <SectionTitle extra={<span className="text-xs text-muted-foreground">只影响主窗口，按登录账号各存一份</span>}>
          关闭窗口时
        </SectionTitle>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <ChoiceCard
            name="close-behavior"
            value="exit"
            label="退出程序"
            hint="关掉程序：地磅线程停掉，下次进来要重新登录"
            active={behavior === "exit"}
            disabled={busy}
            onSelect={() => set("exit")}
          />
          <ChoiceCard
            name="close-behavior"
            value="hide"
            label="隐藏到系统托盘"
            hint="窗口与任务栏按钮一起收起来，只在右下角托盘留个图标；点图标（或右键→显示主窗口）就回来"
            active={behavior === "hide"}
            disabled={busy}
            onSelect={() => set("hide")}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          从没设过时默认是「隐藏到系统托盘」；没有登录、或读不到这项偏好时，一律按「退出程序」处理——
          宁可让人退得掉，也不留一个看不见的进程。
          {behavior === "hide" && " 当前已设为隐藏：程序不会退出，收工请用下面的按钮或托盘右键菜单退出。"}
        </p>
      </section>

      {desktop ? (
        <section className="flex flex-col gap-2 border bg-card p-3">
          <SectionTitle>退出程序</SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={doExit}>
              <PowerIcon />
              退出程序
            </Button>
            <span className="text-xs text-muted-foreground">
              走 <span className="font-mono">app_exit</span>：串口先归还、WAL 收尾照常跑，不是直接杀进程。
              窗口藏在托盘里时，用托盘右键菜单里的「退出程序」。
            </span>
          </div>
        </section>
      ) : (
        <p className="text-xs text-muted-foreground">
          浏览器预览里没有窗口，这一页的设置与「退出程序」都不可用；请用 <span className="font-mono">npm run tauri dev</span> 启动桌面端。
        </p>
      )}
    </div>
  );
}
