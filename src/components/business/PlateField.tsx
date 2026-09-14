/**
 * 车牌号录入框（省简称 + 发牌机关字母 + 序号）。
 *
 * 现场最扎手的一格：第一位必须是汉字。会认字不等于会用中文输入法，磅房里
 * 「新来的车 / 借的车 / 第一次售粮」都没档案可带出，只能现敲，于是这一格常常空着。
 * 这里给两条点选通路：点省份字改首位、点字母数字往后续写，全程不碰输入法；
 * 真键盘照旧可用（要改中间某位时用光标改）。
 *
 * 点选只是新增通路，原来怎么敲还怎么敲；落库口径不变：仍是 `vehicle.vehicle_no`
 * 那串文本，字母自动转大写。
 */
import { useRef, useState } from "react";
import { KeyboardIcon } from "lucide-react";
import { PLATE_ALNUM, PLATE_PROVINCES } from "@/lib/constants";
import { useSoftKeyboardVisible } from "@/hooks/useSoftKeyboard";
import { Input } from "@/components/ui/input";
import { Keypad, KeypadFloat, type KeypadKey } from "@/components/ui/keypad";
import { cn } from "cn";

/**
 * 键阵续写与手输共用一个上限。民用车牌最长 8 位（新能源），但这格也常被拿来
 * 记农用车自编号等更长的串（落库是无约束 TEXT），所以不能按 8 位截手工输入，
 * 更不能让键阵比键盘还严——那会出现点了没反应的死键。
 */
const PLATE_LIMIT = 16;

const PROVINCE_KEYS: KeypadKey[] = PLATE_PROVINCES.map((p) => ({ label: p, insert: p }));
const ALNUM_KEYS: KeypadKey[] = [
  ...PLATE_ALNUM.map((c) => ({ label: c, insert: c })),
  { action: "backspace", label: "退格", span: 2, title: "删掉最后一位" },
  { action: "clear", label: "清空", span: 2, title: "全部重来" },
];

export function PlateField({
  value,
  onChange,
  label,
  id,
  placeholder = "如 豫A12345，农用车可留空",
  className,
  inputClassName,
  invalid,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  /** 一格里要带标题时用（档案表单）；工作台那一栏由外层 Label 提供标题 */
  label?: string;
  id?: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  /** 校验不通过：红框标在输入框本身 */
  invalid?: boolean;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  /** 键阵浮层的锚点：车牌这一格 */
  const host = useRef<HTMLDivElement>(null);
  /** 全局「屏幕软键盘」偏好：关了连展开按钮都不摆，手输照旧 */
  const showPad = useSoftKeyboardVisible();
  const padOpen = open && showPad;
  /** 连点落在同一次渲染之前：只认闭包里的 `value` 会被后一下覆盖，本地再记一份 */
  const live = useRef(value);
  if (live.current !== value) live.current = value;

  function commit(next: string) {
    live.current = next;
    onChange(next);
  }

  function insert(char: string) {
    const cur = live.current;
    // 省份字改首位，其余续写：车牌只有开头是汉字，不必管游标在哪
    if (char.length === 1 && /\p{Script=Han}/u.test(char)) {
      commit(char + cur.replace(/^\p{Script=Han}/u, ""));
      return;
    }
    if (cur.length >= PLATE_LIMIT) return;
    commit(cur + char.toUpperCase());
  }

  function onAction(a: "backspace" | "clear" | "close") {
    if (a === "backspace") commit(live.current.slice(0, -1));
    else if (a === "clear") commit("");
    else setOpen(false);
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div ref={host} className="relative">
        {label && (
          <span className="text-xs text-muted-foreground">{label}</span>
        )}
        <Input
          id={id}
          aria-label={ariaLabel ?? label}
          aria-invalid={invalid || undefined}
          value={value}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value.toUpperCase().slice(0, PLATE_LIMIT))}
          className={cn(showPad && "pr-14", inputClassName)}
        />
        {showPad && (
        <button
          type="button"
          aria-pressed={open}
          title={open ? "收起车牌键盘" : "展开车牌键盘：点省份字定开头，再点字母数字"}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "absolute top-1/2 right-1 -translate-y-1/2 flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px]",
            open ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <KeyboardIcon className="size-3.5" />
          车牌
        </button>
        )}
      </div>
      {padOpen && (
        <KeypadFloat anchor={host} minWidth={380} onClose={() => setOpen(false)}>
          <Keypad
            aria-label="车牌省份简称"
            keys={PROVINCE_KEYS}
            columns={10}
            onInsert={(c) => insert(c)}
            onAction={onAction}
          />
          <Keypad
            aria-label="车牌字母与数字"
            keys={ALNUM_KEYS}
            columns={9}
            onInsert={(c) => insert(c)}
            onAction={onAction}
          />
        </KeypadFloat>
      )}
    </div>
  );
}
