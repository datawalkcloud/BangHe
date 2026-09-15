/**
 * 扫码枪输入捕获（键盘模拟式扫码枪 = 每秒几十下按键、以 Enter 结尾的键盘）。
 *
 * 为什么不直接把焦点钉在扫码框上：窗口里全是输入框——单价、改价事由、本次实付。
 * "永远聚焦扫码框"意味着枪一响，那串字符落进当时正聚焦的那个框里，
 * 结果是**把单号当成改价事由存进去**，钱算错了票面还看不出异常。
 * 所以这里反过来做：谁在打字就不抢谁的键，只有在没有任何输入框聚焦时，
 * 才把这串按键当作一次扫码收走。这与 `useHotkey` 用同一条 `isTypingTarget` 规则，
 * 两处对"什么叫在输入"的判断必须一致，否则同一个动作在两个地方行为不同。
 *
 * 弹出的打印预览、对话框打开时调用方要把 `enabled` 关掉：那时焦点在弹层里，
 * 扫进来的码不该把底下的单子换掉。
 */
import { useEffect, useRef } from "react";
import { isTypingTarget } from "@/hooks/useHotkey";

/** 条码最长长度：超过它基本是有人用键盘在乱按，不是枪在扫 */
const MAX_LEN = 64;
/** 两次按键间隔超过此值说明是人在一个字一个字敲，不算一次扫码（毫秒） */
const MAX_GAP_MS = 80;

export function useScannerCapture(
  onScan: (raw: string) => void,
  opts: { enabled?: boolean } = {},
): { capturing: boolean } {
  const enabled = opts.enabled !== false;
  const buf = useRef("");
  const last = useRef(0);
  const cb = useRef(onScan);
  cb.current = onScan;

  useEffect(() => {
    if (!enabled) {
      buf.current = "";
      return;
    }
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) {
        buf.current = "";
        return;
      }
      const now = Date.now();
      // 按键间隔拉太开就是人在敲键盘，不是枪：清空缓冲，免得半截条码被当成一单
      if (now - last.current > MAX_GAP_MS) buf.current = "";
      last.current = now;

      if (e.key === "Enter") {
        const raw = buf.current;
        buf.current = "";
        if (raw.trim()) {
          e.preventDefault();
          cb.current(raw);
        }
        return;
      }
      // 方向键、功能键、Tab 之类：这一串已经不是条码了
      if (e.key.length !== 1) {
        buf.current = "";
        return;
      }
      buf.current += e.key;
      if (buf.current.length > MAX_LEN) buf.current = "";
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  return { capturing: enabled };
}
