/**
 * 快捷键一览（F1）：顶栏「帮助」菜单与底栏键盘图标点开的都是这一张。
 *
 * 键位表只留这一份。原先 `SHORTCUTS` 是 `AppTopbar` 的局部常量，底栏想复用就只剩"再抄一遍"，
 * 抄完两边各改各的（顶栏补了 Ctrl+E 导出，底栏那两行提示不会跟着长）——正是这仓库最常踩的坑。
 * 弹窗本体也一起搬出来：两个入口开的是同一份文案、同一份排版，不各写一遍 `<Dialog>`。
 */
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/business/layout";
import { cn } from "cn";

export const SHORTCUTS: { keys: string[]; act: string; scope: string }[] = [
  { keys: ["空格"], act: "捕获当前稳定读数（毛/皮自动判定）", scope: "工作台" },
  { keys: ["F7"], act: "新建下一单", scope: "工作台" },
  { keys: ["F8"], act: "读卡", scope: "工作台" },
  { keys: ["F5"], act: "保存化验", scope: "工作台 / 化验" },
  { keys: ["F6"], act: "从价目表带出单价", scope: "扫码结算" },
  { keys: ["F9"], act: "打印当前单据（工作台=码单）", scope: "工作台 / 详情" },
  { keys: ["F10"], act: "提交结算（计价与付款）", scope: "扫码结算" },
  { keys: ["扫码枪"], act: "直接扫，不必先点进输入框", scope: "扫码结算" },
  { keys: ["F2"], act: "对外大屏开关", scope: "全局" },
  { keys: ["Alt", "1…9"], act: "跳转侧栏第 N 项", scope: "全局" },
  { keys: ["Ctrl", "K"], act: "全局检索", scope: "全局" },
  { keys: ["Ctrl", "B"], act: "折叠 / 展开侧栏", scope: "全局" },
  { keys: ["Ctrl", "E"], act: "导出当前列表为 xlsx", scope: "列表页" },
  { keys: ["Ctrl", "Alt", "D"], act: "打开设备中心", scope: "全局" },
  { keys: ["Alt", "←"], act: "返回上一页", scope: "全局" },
  { keys: ["F1"], act: "快捷键一览", scope: "全局" },
  { keys: ["Esc"], act: "关闭弹层 / 退出对外大屏", scope: "全局" },
];

export function ShortcutHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>快捷键一览</DialogTitle>
          <DialogDescription>
            磅房要求不用鼠标也能开单到打印（05 §10-2），以下是当前生效的键位。
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-[60vh] overflow-y-auto">
          {SHORTCUTS.map((s) => (
            <li key={s.act} className="flex items-center gap-3 border-b py-2 last:border-b-0">
              <span className="flex w-40 shrink-0 flex-wrap gap-1">
                {s.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
              <span className={cn("min-w-0 flex-1 text-sm")}>{s.act}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{s.scope}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
