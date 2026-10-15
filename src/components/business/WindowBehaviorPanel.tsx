/**
 * 主窗口的关闭行为（系统 → 窗口）。
 *
 * 只有两件事要在这里说清楚，其余判定全在 Rust（`src-tauri/src/window.rs`）：
 *  - 改的是**窗口右上角那个 ✕**（含 Alt+F4）的去向，不是"退出登录"；
 *  - 选了「隐藏到系统托盘」之后 ✕ 就退不出程序了，所以侧栏与托盘菜单各留一个真能退出的
 *    入口——这台机器一开一整天，收工总得有人把它关掉。
 */
import { runningInTauri } from "@/lib/native";
import { useCloseBehavior } from "@/hooks/useCloseBehavior";
import { ChoiceCard, ChoiceCardGroup } from "@/components/business/ChoiceCard";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function WindowBehaviorPanel() {
  const desktop = runningInTauri();
  const { behavior, loading, saving, set } = useCloseBehavior();
  const busy = !desktop || loading || saving;

  return (
    <div className="flex flex-col gap-3">
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">关闭窗口时</CardTitle>
          <CardAction><span className="text-xs text-muted-foreground">只影响主窗口，按登录账号各存一份</span></CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <ChoiceCardGroup
            className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3"
            value={behavior}
            onChange={(v) => set(v as typeof behavior)}
            disabled={busy}
          >
            <ChoiceCard
              value="exit"
              label="退出程序"
              hint="关掉程序：地磅线程停掉，下次进来要重新登录"
            />
            <ChoiceCard
              value="hide"
              label="隐藏到系统托盘"
              hint="窗口与任务栏按钮一起收起来，只在右下角托盘留个图标；点图标（或右键→显示主窗口）就回来"
            />
          </ChoiceCardGroup>
          <p className="text-xs text-muted-foreground">
            从没设过时默认是「隐藏到系统托盘」；没有登录、或读不到这项偏好时，一律按「退出程序」处理——
            宁可让人退得掉，也不留一个看不见的进程。
            {behavior === "hide" && " 当前已设为隐藏：程序不会退出，收工请用托盘右键菜单里的「退出程序」。"}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
