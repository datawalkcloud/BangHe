/**
 * 数值录入字段（05 §6.4）：一律文本框 + 掩码，禁止 `type=number`。
 *
 * 理由：number 输入框的滚轮误改、小数点/locale 逗号行为、以及中英文输入法
 * 全角数字，在磅房都是能把几千块货款打错的真实隐患。
 *
 * 内部保存字符串缓冲，边输边回传定点整数值，让结算区能"即时重算"（05 §4 ⑤）。
 *
 * 本文件同时导出 `InlineNumField`：同一套掩码、但没有标题行的紧凑版，供"读数那一格原地变成
 * 输入框"的场合使用（称重区毛重/皮重行）。两种形态共用一份 `sanitize`，不允许第二个文件再写
 * 一遍清洗规则——那正是"这里能敲小数点、那里敲不上"的来源。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, Ref } from "react";
import { KeyboardIcon } from "lucide-react";
import { fromKg, fromPercent, fromYuanPerKg, money, priceNumber, toKg, weight } from "@/lib/format";
import { useSoftKeyboardVisible } from "@/hooks/useSoftKeyboard";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Keypad, KeypadFloat, digitKeys } from "@/components/ui/keypad";
import { cn } from "cn";

export interface NumFieldProps {
  label: string;
  /** 显示用的十进制字符串（受控） */
  text: string;
  onText: (t: string) => void;
  /** 单位后缀，如 kg / 元 / % / g/L */
  unit?: string;
  /** 允许的小数位数，用于截断输入 */
  decimals?: number;
  disabled?: boolean;
  hint?: string;
  invalid?: boolean;
  className?: string;
  id?: string;
  inputRef?: Ref<HTMLInputElement>;
  placeholder?: string;
  align?: "right" | "left";
  size?: "sm" | "default";
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** 展开按钮：给不会用物理小键盘的操作员一块屏幕数字键阵（点一下出一个数） */
  keypad?: boolean;
}

/** 只允许数字 + 一个小数点 + 可选负号（红冲手录用） */
function sanitize(raw: string, decimals: number): string {
  let s = raw.replace(/[。，,\s]/g, "").replace(/[^\d.-]/g, "");
  const neg = s.startsWith("-");
  s = s.replace(/-/g, "");
  const dot = s.indexOf(".");
  if (dot >= 0) {
    s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "");
  }
  if (decimals === 0) s = s.replace(/\..*$/, "");
  else if (dot >= 0) {
    const head = s.slice(0, dot);
    const tail = s.slice(dot + 1, dot + 1 + decimals);
    s = `${head}.${tail}`;
  }
  return (neg ? "-" : "") + s;
}

/** 输入框本体（含单位后缀）：`NumField` 与 `InlineNumField` 共用，掩码只有一份 */
function NumInput({
  text,
  onText,
  unit,
  decimals,
  disabled,
  invalid,
  className,
  id,
  inputRef,
  placeholder,
  align = "right",
  size = "default",
  onKeyDown,
}: {
  text: string;
  onText: (t: string) => void;
  unit?: string;
  decimals: number;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  id?: string;
  inputRef?: Ref<HTMLInputElement>;
  placeholder?: string;
  align?: "right" | "left";
  size?: "sm" | "default";
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const apply = (raw: string) => onText(sanitize(raw, decimals));
  return (
    <InputGroup
      className={cn(
        // 圆角不写死 rounded-none：让 InputGroup 基类的 rounded-4xl 生效，随主题圆角档走，
        // 与同屏的 Input / SelectTrigger / ComboBox 一致（写死方角会在换圆角主题时露馅）
        "h-auto border transition-colors",
        size === "default" ? "h-9" : "h-8 text-xs",
        invalid
          ? "border-destructive ring-1 ring-destructive/40"
          : "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40",
        disabled && "pointer-events-none opacity-60",
        className,
      )}
    >
      <InputGroupInput
        id={id}
        ref={inputRef}
        inputMode="decimal"
        autoComplete="off"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        value={text}
        onChange={(e) => apply(e.target.value)}
        onKeyDown={onKeyDown}
        className={cn("border-0 bg-transparent px-2 font-medium tnum tabular-nums", align === "right" ? "text-right" : "text-left")}
      />
      {unit && (
        <InputGroupAddon align="inline-end" className="pr-2 text-xs">
          {unit}
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

/**
 * 行内紧凑数值格：与 `NumField` 同一套掩码（禁 `type=number`、全角/逗号清洗、小数位截断），
 * 但**没有标题行、没有提示行**——宽度由父级给，用来嵌进「毛重 428.0 kg」这种既有的展示行里，
 * 让同一格在"只读读数"与"可改的输入框"两种形态之间原地切换（05 §4 ③）。
 *
 * 文本缓冲留在调用方：这里每敲一下就回传清洗后的字符串，父级怎么解读（何时换算成 0.1kg、
 * 空串算不算"没录"）自己定。别在组件里替父级把 `"42."` 折成 `42`，那会让小数点敲不上去。
 */
export function InlineNumField(props: {
  text: string;
  onText: (t: string) => void;
  unit?: string;
  /** 允许的小数位数，默认 1（公斤） */
  decimals?: number;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  id?: string;
  inputRef?: Ref<HTMLInputElement>;
  placeholder?: string;
  size?: "sm" | "default";
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return <NumInput align="right" {...props} decimals={props.decimals ?? 1} />;
}

export function NumField({
  label,
  text,
  onText,
  unit,
  decimals = 1,
  disabled,
  hint,
  invalid,
  className,
  id,
  inputRef,
  placeholder,
  align = "right",
  size = "default",
  onKeyDown,
  keypad,
}: NumFieldProps) {
  const [padOpen, setPadOpen] = useState(false);
  /** 全局「屏幕软键盘」偏好：关了就不摆展开按钮，输入框本身照旧可逐字键入 */
  const showPad = useSoftKeyboardVisible();
  const padKeys = useMemo(
    () => digitKeys({ decimalPoint: decimals > 0 }),
    [decimals],
  );
  /** 连点落在同一次渲染之前：只认闭包里的 `text` 会被后一下覆盖，所以本地也记一份 */
  const live = useRef(text);
  if (live.current !== text) live.current = text;
  /** 键阵浮层的锚点：整格字段（含标题行上的展开按钮，点它才算收起） */
  const host = useRef<HTMLDivElement>(null);
  const apply = (raw: string) => {
    const next = sanitize(raw, decimals);
    live.current = next;
    onText(next);
  };
  return (
    <div ref={host} className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="flex items-baseline justify-between gap-1">
        <label htmlFor={id} className="text-xs text-muted-foreground">
          {label}
        </label>
        {keypad && showPad && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-pressed={padOpen}
            disabled={disabled}
            title={padOpen ? "收起数字键盘" : "展开数字键盘，点一下出一个数字"}
            onClick={() => setPadOpen((v) => !v)}
            className={cn(
              "h-5 shrink-0 gap-0.5 px-1 text-[11px]",
              padOpen ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <KeyboardIcon className="size-3.5" />
            键盘
          </Button>
        )}
      </div>
      <NumInput
        text={text}
        onText={apply}
        unit={unit}
        decimals={decimals}
        disabled={disabled}
        invalid={invalid}
        id={id}
        inputRef={inputRef}
        placeholder={placeholder}
        align={align}
        size={size}
        onKeyDown={onKeyDown}
      />
      {keypad && showPad && padOpen && (
        <KeypadFloat anchor={host} minWidth={200} onClose={() => setPadOpen(false)}>
          <Keypad
            aria-label={`${label}数字键盘`}
            keys={padKeys}
            onInsert={(c) => apply(live.current + c)}
            onAction={(a) => {
              if (a === "backspace") apply(live.current.slice(0, -1));
              else if (a === "clear") apply("");
              else setPadOpen(false);
            }}
          />
        </KeypadFloat>
      )}
      {hint && (
        <p className={cn("text-xs", invalid ? "text-destructive" : "text-muted-foreground")}>{hint}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 领域封装 */

/** 重量：内部 0.1kg 整数，界面公斤 */
export function WeightField({
  label,
  value01kg,
  onChange,
  ...rest
}: {
  label: string;
  value01kg: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  hint?: string;
  /** 校验不通过：红框 + hint 转红（NumField 范式，透传给 NumField） */
  invalid?: boolean;
  className?: string;
  id?: string;
  size?: "sm" | "default";
  /** 屏幕数字键盘开关，透传给 NumField */
  keypad?: boolean;
}) {
  const [text, setText] = useState(() => (value01kg == null ? "" : String(toKg(value01kg))));
  const lastEmit = useRef<number | null>(value01kg);
  // 外部值变了（读卡带出、捕获成功）才回填，避免打断正在输入
  useEffect(() => {
    if (value01kg !== lastEmit.current) {
      lastEmit.current = value01kg;
      setText(value01kg == null ? "" : String(toKg(value01kg)));
    }
  }, [value01kg]);
  return (
    <NumField
      label={label}
      text={text}
      unit="kg"
      decimals={1}
      onText={(t) => {
        setText(t);
        const v = t === "" || t === "-" ? null : fromKg(t);
        lastEmit.current = v;
        onChange(v);
      }}
      {...rest}
    />
  );
}

/** 金额：内部分，界面元 */
export function MoneyField({
  label,
  valueFen,
  onChange,
  ...rest
}: {
  label: string;
  valueFen: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  hint?: string;
  /** 校验不通过：红框 + hint 转红（NumField 范式，透传给 NumField） */
  invalid?: boolean;
  className?: string;
  id?: string;
  size?: "sm" | "default";
  /** 屏幕数字键盘开关，透传给 NumField */
  keypad?: boolean;
}) {
  const [text, setText] = useState(() => (valueFen === 0 ? "0" : (valueFen / 100).toFixed(2)));
  const lastEmit = useRef(valueFen);
  useEffect(() => {
    if (valueFen !== lastEmit.current) {
      lastEmit.current = valueFen;
      setText(valueFen === 0 ? "0" : (valueFen / 100).toFixed(2));
    }
  }, [valueFen]);
  return (
    <NumField
      label={label}
      text={text}
      unit="元"
      decimals={2}
      onText={(t) => {
        setText(t);
        const v = t === "" || t === "-" ? 0 : Math.round(Number(t) * 100) || 0;
        lastEmit.current = v;
        onChange(v);
      }}
      {...rest}
    />
  );
}

/** 单价：内部分/吨，界面元/公斤 */
export function PriceField({
  label = "单价",
  valueFenPerTon,
  onChange,
  hint,
  ...rest
}: {
  label?: string;
  valueFenPerTon: number | null;
  onChange: (v: number | null) => void;
  hint?: string;
  disabled?: boolean;
  /** 校验不通过：红框 + hint 转红（NumField 范式，透传给 NumField） */
  invalid?: boolean;
  className?: string;
  id?: string;
  size?: "sm" | "default";
  /** 屏幕数字键盘开关，透传给 NumField */
  keypad?: boolean;
}) {
  const [text, setText] = useState(() => (valueFenPerTon == null ? "" : priceNumber(valueFenPerTon)));
  const lastEmit = useRef(valueFenPerTon);
  useEffect(() => {
    if (valueFenPerTon !== lastEmit.current) {
      lastEmit.current = valueFenPerTon;
      setText(valueFenPerTon == null ? "" : priceNumber(valueFenPerTon));
    }
  }, [valueFenPerTon]);
  return (
    <NumField
      label={label}
      text={text}
      unit="元/公斤"
      decimals={3}
      onText={(t) => {
        setText(t);
        const v = t === "" ? null : fromYuanPerKg(t);
        lastEmit.current = v;
        onChange(v);
      }}
      hint={hint}
      {...rest}
    />
  );
}

/** 化验指标：内部 0.01%，界面 % */
export function PercentField({
  label,
  value001pct,
  onChange,
  ...rest
}: {
  label: string;
  value001pct: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  hint?: string;
  /** 校验不通过：红框 + hint 转红（NumField 范式，透传给 NumField） */
  invalid?: boolean;
  className?: string;
  id?: string;
  size?: "sm" | "default";
  /** 屏幕数字键盘开关，透传给 NumField */
  keypad?: boolean;
}) {
  const [text, setText] = useState(() => (value001pct == null ? "" : (value001pct / 100).toFixed(2)));
  const lastEmit = useRef(value001pct);
  useEffect(() => {
    if (value001pct !== lastEmit.current) {
      lastEmit.current = value001pct;
      setText(value001pct == null ? "" : (value001pct / 100).toFixed(2));
    }
  }, [value001pct]);
  return (
    <NumField
      label={label}
      text={text}
      unit="%"
      decimals={2}
      onText={(t) => {
        setText(t);
        const v = t === "" ? null : fromPercent(t);
        lastEmit.current = v;
        onChange(v);
      }}
      {...rest}
    />
  );
}

/** 只读展示用的"金额行"，结算区右侧用 */
export function MoneyLine({
  label,
  valueFen,
  emphasis,
  hint,
}: {
  label: string;
  valueFen: number | null;
  emphasis?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={cn("text-sm", emphasis ? "font-semibold" : "text-muted-foreground")}>{label}</span>
      <span className="flex flex-col items-end">
        <span className={cn("tnum tabular-nums", emphasis ? "text-lg font-bold" : "text-sm")}>{money(valueFen)}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
    </div>
  );
}

/** 只读展示用的"重量行" */
export function WeightLine({
  label,
  value01kg,
  emphasis,
  hint,
}: {
  label: string;
  value01kg: number | null;
  emphasis?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={cn("text-sm", emphasis ? "font-semibold" : "text-muted-foreground")}>{label}</span>
      <span className="flex flex-col items-end">
        <span className={cn("tnum tabular-nums", emphasis ? "text-lg font-bold" : "text-sm")}>{weight(value01kg)}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
    </div>
  );
}
