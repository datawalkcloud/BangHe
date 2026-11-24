/**
 * 屏幕小键盘（软键盘）。
 *
 * 为什么要有它：磅房操作员普遍四五十岁以上，会认字不等于会用中文输入法，
 * 18 位证号、车牌省简称、金额这些字段一旦必须敲键盘，现场就只能停下来找人。
 * 这里给的是"点一下就出一个字符"的通用键阵，字段自己决定摆哪些键。
 *
 * 四条约束：
 *  - 只做键阵与回调，**不含任何业务语义**（省份字、证号 X 这些由调用方传进来）；
 *  - 按键不能抢走输入框焦点，否则操作员在软键盘与真键盘之间来回时游标会丢，
 *    所以 pointerdown 一律 preventDefault；
 *  - 键要够大（触屏手指尺寸），字号走 tnum 与全站数字口径一致；
 *  - 键阵一律浮在字段旁边（[`KeypadFloat`]），不占版面：工作台一屏挤着称重、化验、
 *    身份三块，内联展开会把下面的字段整个顶走。
 */
import { useRef } from "react";
import type * as React from "react";
import type { ReactNode, RefObject } from "react";
import { DeleteIcon, KeyboardIcon, XIcon } from "lucide-react";
import { useSoftKeyboardVisible } from "@/hooks/useSoftKeyboard";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "cn";

export type KeypadAction = "backspace" | "clear" | "close";

export interface KeypadKey {
  label: ReactNode;
  /** 按这个键要插入的字符；与 action 二选一 */
  insert?: string;
  action?: KeypadAction;
  /** 占几列，默认 1 */
  span?: number;
  className?: string;
  /** 键的标题提示（如「只允许数字」） */
  title?: string;
}

export interface KeypadProps {
  keys: readonly KeypadKey[];
  onInsert: (char: string) => void;
  onAction: (action: KeypadAction) => void;
  /** 每行几个键。车牌盘、数字盘列数不同，交给调用方定 */
  columns?: number;
  className?: string;
  "aria-label"?: string;
}

export function Keypad({ keys, onInsert, onAction, columns = 5, className, "aria-label": ariaLabel }: KeypadProps) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn("grid gap-1", className)}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {keys.map((k, i) => {
        const key = `${k.insert ?? k.action ?? "k"}-${i}`;
        return (
          <Button
            key={key}
            type="button"
            variant="outline"
            title={k.title}
            style={k.span ? { gridColumn: `span ${k.span}` } : undefined}
            // 抢焦点会让输入框游标跳走：真键盘与软键盘混用时这正是最难受的地方
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => (k.action ? onAction(k.action) : k.insert != null && onInsert(k.insert))}
            className={cn(
              "h-9 min-w-8 rounded-md px-1 text-base font-medium tnum tabular-nums shadow-none",
              k.action && "text-muted-foreground",
              k.className,
            )}
          >
            {k.action === "backspace" ? <DeleteIcon className="size-4" /> : k.action === "clear" ? <XIcon className="size-4" /> : k.label}
          </Button>
        );
      })}
    </div>
  );
}

/**
 * 键阵浮层 + 它的展开按钮，必须成对挂在同一棵 Popover 下。
 *
 * 用 Popover 是因为工作台与结算页那些区块套着 `overflow-y-auto`，就地渲染会被裁掉半截；
 * 锚点就是输入框容器，浮层贴着它摆，不占字段下方的版面。
 *
 * **open 交给 base-ui 自己管（非受控）**。早先做过两份受控版本：一是按钮留在 Popover
 * 外、只挂 `<Popover open>`，base-ui 把展开按钮判成 outside press；二是补上
 * `PopoverTrigger` + `triggerId`、再用 `requestAnimationFrame` 把焦点抢回输入框。
 * 两份都在工作台的高频重渲染下出过事（「有时点不出来」/「现在完全不出来」）。
 * 非受控是 base-ui 的常规用法，trigger 点击与 outside press 全由它自己收口，
 * 字段不再持 open 状态，也就不存在我们这边 state 与它内部时序打架的余地。
 *
 * 焦点：展开按钮是 `tabIndex={-1}` 的 span，点它不抢焦点、不进 Tab 序——
 * 输入框在点按钮前有焦点的话，物理键盘的数字/字母直接继续落进去；再在
 * `onOpenChange(true)` 里补一次聚焦，兜住「焦点本在页面别处」的情况。
 * 键阵按键 `pointerdown` 上 `preventDefault`，同样是同一条不抢焦点的规矩。
 */
export function KeypadFloat({
  anchor,
  minWidth = 240,
  triggerLabel,
  title,
  disabled,
  triggerClassName,
  children,
}: {
  /** 输入框所在的容器：浮层以它的位置为准 */
  anchor: RefObject<HTMLElement | null>;
  /** 至少多宽。列数多的键阵（车牌 10 列）挤在窄框下面一行放不下 */
  minWidth?: number;
  /** 展开按钮上的文字：车牌 / 键盘 */
  triggerLabel: string;
  title?: string;
  disabled?: boolean;
  /** 按钮在字段里的定位（车牌框内右侧、数字字段标题行等） */
  triggerClassName?: string;
  children: ReactNode;
}) {
  /**
   * 展开时把焦点交还给锚点里的输入框。
   *
   * 展开按钮是 `tabIndex={-1}` 的 span，点它不抢焦点——所以如果点按钮前输入框
   * 本来就有焦点，物理键盘自然继续落进去；但如果焦点在页面别处（比如刚切过来
   * 直接点「车牌」），span 同样不会把焦点带进来，物理键盘就没有落点。所以在
   * `onOpenChange(true)` 里主动聚焦一次。`initialFocus={false}` 下 base-ui 打开时
   * 不会自己聚焦任何东西，这里不会跟它抢；`finalFocus={false}` 保证关闭时焦点
   * 不会被拽回触发元素。
   */
  return (
    <Popover modal={false} onOpenChange={(open) => {
      if (open) {
        anchor.current?.querySelector("input")?.focus();
      }
    }}>
      <PopoverTrigger
        nativeButton={false}
        disabled={disabled}
        title={title}
        render={
          <span
            tabIndex={-1}
            className={cn(
              buttonVariants({ variant: "ghost", size: "xs" }),
              "cursor-pointer select-none",
              // PopoverTrigger 自带 aria-expanded，展开态的高亮走它，字段不必再持 open
              "aria-expanded:bg-secondary aria-expanded:text-foreground",
              triggerClassName,
            )}
          />
        }
      >
        <KeyboardIcon className="size-3.5" />
        {triggerLabel}
      </PopoverTrigger>
      <PopoverContent
        anchor={anchor}
        initialFocus={false}
        finalFocus={false}
        align="start"
        sideOffset={4}
        style={{ minWidth }}
        className="flex w-max flex-col gap-1.5 rounded-lg bg-card p-2 shadow-lg ring-foreground/10"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** 0~9（+ 可选小数点与任意附加字符）的标准数字键阵；末尾固定带退格与清空 */
export function digitKeys(opts: { decimalPoint?: boolean; extra?: readonly string[] } = {}): KeypadKey[] {
  const keys: KeypadKey[] = [];
  for (const d of "1234567890") keys.push({ label: d, insert: d });
  if (opts.decimalPoint) keys.push({ label: ".", insert: "." });
  for (const x of opts.extra ?? []) keys.push({ label: x, insert: x });
  keys.push({ action: "backspace", label: "退格", title: "删掉最后一位" });
  keys.push({ action: "clear", label: "清空", title: "全部重来" });
  return keys;
}

/** 字母 + 数字：卡号、贴签、编码这类"大写英文数字串"的键阵 */
export function alnumKeys(opts: { extra?: readonly string[] } = {}): KeypadKey[] {
  const keys: KeypadKey[] = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", ..."0123456789"].map((c) => ({ label: c, insert: c }));
  for (const x of opts.extra ?? []) keys.push({ label: x, insert: x });
  keys.push({ action: "backspace", label: "退格", title: "删掉最后一位" });
  keys.push({ action: "clear", label: "清空", title: "全部重来" });
  return keys;
}

/** 往文本末尾追加一个字符（软键盘的通用落点：这类短码字段都在末尾续写） */
export function appendChar(current: string, char: string, maxLength?: number): string {
  if (maxLength != null && current.length >= maxLength) return current;
  return current + char;
}

/**
 * 文本框 + 可展开的软键盘。
 *
 * 键盘默认收起：磅房屏幕要放的东西很多，常驻一块键阵会把主视线挤掉。
 * 需要时才点右上角的键盘图标展开——展开的是贴着这一格的浮层（[`KeypadFloat`]），
 * 不把下面的字段顶走，且仍然可以直接用真键盘改中间的字符。
 *
 * `keys` 由调用方按当前值算出来（例如车牌第一格只给省份汉字、之后给字母数字），
 * 这里只负责把点键结果落到值上：插入落在末尾、退格删最后一位、清空归零。
 */
export function KeypadInput({
  value,
  onChangeValue,
  keys,
  columns = 5,
  maxLength,
  toggleLabel = "键盘",
  className,
  inputClassName,
  ...inputProps
}: {
  value: string;
  onChangeValue: (next: string) => void;
  keys: readonly KeypadKey[] | ((value: string) => readonly KeypadKey[]);
  columns?: number;
  maxLength?: number;
  /** 展开按钮上的文字 */
  toggleLabel?: string;
  className?: string;
  inputClassName?: string;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "className">) {
  /** 键阵浮层的锚点：输入框这一格 */
  const host = useRef<HTMLDivElement>(null);
  /** 全局「屏幕软键盘」关掉时，这里连展开按钮都不摆——输入框与逐字键入不受影响 */
  const showPad = useSoftKeyboardVisible();
  /**
   * 连点会落在同一次渲染之前：只认闭包里的 `value` 的话，后一下会把前一下覆盖掉，
   * 操作员看到的就是"我明明点了三个数字，怎么只剩一个"。所以自己追一份最新值。
   */
  const live = useRef(value);
  if (live.current !== value) live.current = value;
  const set = (next: string) => {
    const capped = maxLength != null ? next.slice(0, maxLength) : next;
    live.current = capped;
    onChangeValue(capped);
  };
  const keyList = typeof keys === "function" ? keys(value) : keys;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div ref={host} className="relative">
        <Input
          {...inputProps}
          value={value}
          onChange={(e) => set(e.target.value)}
          className={cn(inputClassName, showPad && toggleLabel && "pr-16")}
        />
        {showPad && (
          <KeypadFloat
            anchor={host}
            minWidth={columns * 38}
            triggerLabel={toggleLabel}
            title={`展开${toggleLabel}：点一下出一个字符，也可用真键盘输入`}
            triggerClassName={cn(
              "absolute top-1/2 right-1 -translate-y-1/2 h-6 gap-0.5 rounded px-1.5 text-[11px]",
              "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Keypad
              aria-label={toggleLabel}
              keys={keyList}
              columns={columns}
              onInsert={(c) => set(appendChar(live.current, c, maxLength))}
              onAction={(a) => {
                if (a === "backspace") set(live.current.slice(0, -1));
                else if (a === "clear") set("");
              }}
            />
          </KeypadFloat>
        )}
      </div>
    </div>
  );
}
