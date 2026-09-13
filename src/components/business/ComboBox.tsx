/**
 * 事由/原因/结论类「自由文本 + 常用下拉」输入（ReasonChips 的下拉版）。
 *
 * 之前是一行常驻的快捷按钮：占地方，中栏一挤就得缩。这里换成一个可打字的选择框——
 * 框本身就是普通文本框（单行 Input 或多行 Textarea），照常手打；点开或聚焦时
 * 才在下方浮出常用结论清单，选一条即回填、仍可继续改。落库始终是自由文本，
 * 清单只是常量提示，不做枚举锁死（迎检要看得懂的那句人话由操作员最终确认）。
 *
 * 键盘优先（磅房"不用鼠标也能开单"）：↑↓ 选、Enter 认、Esc 收；点右侧箭头也能开合。
 * 单行按已输入内容过滤清单，多行（长句事由）不过滤、整单列出。
 */
import * as React from "react";
import { useMemo, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "cn";

export interface ComboPreset {
  label: string;
  value: string;
}

export function ComboBox({
  value,
  onChange,
  presets,
  multiline,
  rows = 3,
  placeholder,
  id,
  className,
  emptyHint = "没有匹配的常用项，直接输入即可",
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  presets: readonly ComboPreset[];
  /** 多行长句事由（如拒收/作废原因）；此时清单不按文本过滤 */
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  id?: string;
  /** 透传给文本框本身的样式（高度/边框色等各处略有不同） */
  className?: string;
  /** 单行过滤后无命中时清单里的提示 */
  emptyHint?: string;
  "aria-label"?: string;
}) {
  const fieldRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const list = useMemo(() => {
    if (multiline) return [...presets];
    const q = value.trim().toLowerCase();
    if (!q) return [...presets];
    return presets.filter((p) => p.label.toLowerCase().includes(q) || p.value.toLowerCase().includes(q));
  }, [presets, value, multiline]);

  function pick(p: ComboPreset) {
    onChange(p.value);
    setOpen(false);
    setActive(-1);
    // 点按钮会把焦点抢走，回填后把光标送回文本框，方便接着改
    fieldRef.current?.focus();
  }

  function onFieldKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      if (!open) {
        setOpen(true);
        return;
      }
      e.preventDefault();
      setActive((i) => (list.length ? (i + 1) % list.length : -1));
    } else if (e.key === "ArrowUp") {
      if (!open || !list.length) return;
      e.preventDefault();
      setActive((i) => (i <= 0 ? list.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      // 多行长句里回车是换行，绝不劫持；单行才用来确认高选项
      if (multiline || !open || active < 0 || !list[active]) return;
      e.preventDefault();
      pick(list[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  }

  const chevron =
    "absolute z-10 flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground";

  return (
    <div
      className="relative"
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        // 焦点跑到本控件外面才收起；点清单/箭头都做了 preventDefault，不会误收
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setActive(-1);
        }
      }}
    >
      {multiline ? (
        <Textarea
          ref={fieldRef as React.Ref<HTMLTextAreaElement>}
          id={id}
          rows={rows}
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onFieldKeyDown}
          placeholder={placeholder}
          className={cn("min-h-0 pr-7", className)}
        />
      ) : (
        <Input
          ref={fieldRef as React.Ref<HTMLInputElement>}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setActive(-1);
          }}
          onKeyDown={onFieldKeyDown}
          placeholder={placeholder}
          className={cn("pr-7", className)}
        />
      )}

      <button
        type="button"
        tabIndex={-1}
        aria-label="展开常用选项"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setOpen((o) => !o);
          fieldRef.current?.focus();
        }}
        className={cn(chevron, multiline ? "right-1 top-1.5" : "right-1 top-1/2 -translate-y-1/2")}
      >
        <ChevronDownIcon className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className="absolute left-0 top-full z-50 mt-1 max-h-60 w-max min-w-full max-w-[min(28rem,90vw)] overflow-y-auto rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/5"
          onMouseDown={(e) => e.preventDefault()}
        >
          {list.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-muted-foreground">{emptyHint}</p>
          ) : (
            list.map((p, i) => (
              <button
                key={p.label}
                type="button"
                role="option"
                aria-selected={value === p.value}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(p)}
                className={cn(
                  "block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-sm",
                  active === i ? "bg-muted text-foreground" : "text-foreground",
                  value === p.value && "font-medium",
                )}
              >
                {p.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
