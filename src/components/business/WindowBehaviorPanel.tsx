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
              hint="关掉程序，下次进来要重新登录"
            />
            <ChoiceCard
              value="hide"
              label="隐藏到系统托盘"
              hint="窗口收进右下角托盘，点托盘图标就回来"
            />
          </ChoiceCardGroup>
          <p className="text-xs text-muted-foreground">
            没设置过时默认按「隐藏到系统托盘」；未登录时按「退出程序」处理。
            {behavior === "hide" && " 已设为隐藏：程序不会退出，收工请用托盘右键菜单里的「退出程序」。"}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
