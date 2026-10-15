/**
 * 快捷键注册。
 *
 * 全局键（F2 / Ctrl+K / Ctrl+B / Alt+1..9）在 AppShell 里统一处理；
 * 业务键（空格捕获、F5 保存化验、F6 带价、F10 结算…）与它作用的表单状态同处一个组件，
 * 就近注册比把每个动作都提到页面顶层更好维护。
 *
 * 一条硬规则：光标在输入框里时空格和字母键必须照常输入文字，不能被当成命令键，
 * 否则磅员一边打字一边触发捕获，这张单就废了（05 §5）。
 */
import { useEffect, useRef } from "react";

/** 焦点是否落在可输入元素上 */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

interface Needed {
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  shift: boolean;
}

function parse(key: string): { base: string; need: Needed } {
  const need: Needed = { ctrl: false, alt: false, meta: false, shift: false };
  const parts = key.split("+");
  const base = (parts.length > 1 ? parts[parts.length - 1] : key) ?? "";
  for (const p of parts.slice(0, -1)) {
    const k = p.toLowerCase();
    if (k === "ctrl" || k === "mod") need.ctrl = true;
    else if (k === "alt") need.alt = true;
    else if (k === "meta" || k === "cmd") need.meta = true;
    else if (k === "shift") need.shift = true;
  }
  return { base: base.toLowerCase(), need };
}

export function useHotkey(
  key: string,
  handler: (e: KeyboardEvent) => void,
  opts: { allowInInput?: boolean; enabled?: boolean; preventDefault?: boolean } = {},
): void {
  const { allowInInput = false, enabled = true, preventDefault = true } = opts;
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const { base, need } = parse(key);
    if (!base) return;
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== base) return;
      if (e.ctrlKey !== need.ctrl || e.metaKey !== need.meta) return;
      // Alt 在部分键盘上会伴随 ctrl/shift 状态，这里只要求 altKey 为真
      if (need.alt !== e.altKey) return;
      if (need.shift && !e.shiftKey) return;
      if (!allowInInput && isTypingTarget(e.target)) return;
      if (preventDefault) e.preventDefault();
      ref.current(e);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, allowInInput, enabled, preventDefault]);
}
