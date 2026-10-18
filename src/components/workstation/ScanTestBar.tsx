/**
 * 工作台底部的「测试扫码框」——站点参数 `scan_test_input` 控制，**默认关**。
 *
 * 为什么要有它：结算从"扫一下票面码"起步，可三类场合手上没有枪——
 * 装机后台还没接上、枪坏了排在配件路上、以及拿浏览器给粮站演示流程。
 * 这时窗口那一框永远弹不出来，验收就卡在这一步。
 *
 * 一条硬规矩：**它不另开业务入口，只替代"枪把字符敲进电脑"那一段**。提交走的是
 * 扫码枪用的同一个 `handleScan`（同一套闸门与话术、同样弹结算框或补付框），载荷契约
 * 也没另写一份——测试框走的路和真枪不一样，测出来的结论就不能信了。本版的码就是票面
 * 那行单号（02 §F1.4：磅房只认磅单码），所以贴一串单号进去＝扫一张码单；手上还有老纸的
 * 站点贴老载荷（带版本位 + 票种位，或 `BH1:` 头）也照样认，认出来不是磅单就按扫码那条
 * 话术打发走。
 *
 * 替代不了的两件事，界面上就写明：① 键盘模拟枪的判据（两次按键间隔 80ms 内才算枪、
 * 光标在输入框里时不抢键）仍然只有真枪能验；② 出纸。测试框不会替你打票。
 */
import { useState } from "react";
import { ScanLineIcon } from "lucide-react";
import { CODE_EXAMPLES } from "@/lib/ticket-code";
import { ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ScanTestBar({ onScan, disabled }: { onScan: (raw: string) => void; disabled?: boolean }) {
  const [raw, setRaw] = useState("");

  /** 提交后不清空：现场常要拿同一张票连扫两次验"重复扫码不得二次结算" */
  function fire() {
    if (!raw.trim()) return;
    onScan(raw);
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-dashed bg-muted/20 px-2 py-1">
      <ToneBadge tone="neutral">测试</ToneBadge>
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <ScanLineIcon className="size-3.5" />
        模拟扫码
      </span>
      <Input
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onKeyDown={(e) => {
          // 回车即一次扫码：与键盘枪的回车后缀同一条收尾（本框不判 80ms 连打，那条只有真枪能验）
          if (e.key === "Enter") {
            e.preventDefault();
            fire();
          }
        }}
        disabled={disabled}
        aria-label="测试扫码框：贴入票面码"
        placeholder={`贴入票面单号，例 ${CODE_EXAMPLES.order}`}
        className="h-7 max-w-[26rem] flex-1 border-dashed text-xs"
        autoComplete="off"
        spellCheck={false}
      />
      <Button size="xs" variant="outline" className="h-6 text-[11px]" disabled={disabled || !raw.trim()} onClick={fire}>
        扫一次
      </Button>
      <span className="text-[11px] text-muted-foreground">
        光标在本框时，扫码枪的字会打到这里，按回车同样等于扫码；不需要时到「基础档案 · 参数」关掉「工作台测试扫码框」
      </span>
    </div>
  );
}
