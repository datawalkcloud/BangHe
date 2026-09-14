import * as React from "react"
import dayjs, { type Dayjs } from "dayjs"
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react"
import { Popover } from "@base-ui/react/popover"
import { Button, buttonVariants } from "@/components/ui/button"
import { RANGE_PRESETS, resolveRange } from "@/lib/date-range"
import { cn } from "cn"

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"]

function toISO(d: Dayjs): string {
  return d.format("YYYY-MM-DD")
}

/** 以周日为起点生成 6×7 的日期网格 */
function buildMonthGrid(viewMonth: Dayjs): Dayjs[] {
  const first = viewMonth.startOf("month")
  const start = first.subtract(first.day(), "day") // 回退到所在周的周日
  return Array.from({ length: 42 }, (_, i) => start.add(i, "day"))
}

export interface DateRangeValue {
  from: string
  to: string
}

export interface DateRangePickerProps {
  /** 闭区间起止，ISO `YYYY-MM-DD`；空串表示该端未选 */
  value: DateRangeValue
  onChange: (from: string, to: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
  "aria-label"?: string
  /** 面板底部展示常用快捷预设（今天 / 近 7 天…），默认展示 */
  presets?: boolean
  /** 允许清空区间（起止都可为空 = 不限），面板底部出现「清除」，供留痕等可留空筛选用 */
  allowClear?: boolean
  /** 校验不通过：触发器红框，错误文案由调用方挂在字段上 */
  invalid?: boolean
}

export function DateRangePicker({
  value,
  onChange,
  placeholder = "选择区间",
  className,
  disabled,
  presets = true,
  allowClear = false,
  invalid,
  ...rest
}: DateRangePickerProps) {
  const { from, to } = value
  const [open, setOpen] = React.useState(false)
  // 面板内的“半程选择”：已点下起始日、还没点结束日时暂存，避免中途回写外部 value
  const [anchor, setAnchor] = React.useState<Dayjs | null>(null)
  const [hover, setHover] = React.useState<Dayjs | null>(null)
  const [viewMonth, setViewMonth] = React.useState<Dayjs>(() =>
    (dayjs(from || to).isValid() ? dayjs(from || to) : dayjs()).startOf("month")
  )

  function openPanel() {
    const seed = from || to
    if (dayjs(seed).isValid()) setViewMonth(dayjs(seed).startOf("month"))
    setAnchor(null)
    setHover(null)
    setOpen(true)
  }

  // 面板高亮区间：优先展示半程选择（anchor ~ hover），否则展示已提交的 from~to
  const lo = anchor ? (hover && hover.isBefore(anchor) ? hover : anchor) : from ? dayjs(from) : null
  const hi = anchor ? (hover && hover.isAfter(anchor) ? hover : anchor) : to ? dayjs(to) : null
  const loISO = lo?.isValid() ? toISO(lo) : ""
  const hiISO = hi?.isValid() ? toISO(hi) : ""

  function pickDay(d: Dayjs) {
    if (!anchor) {
      setAnchor(d)
      setHover(null)
      return
    }
    const a = toISO(anchor)
    const b = toISO(d)
    onChange(a <= b ? a : b, a <= b ? b : a)
    setAnchor(null)
    setOpen(false)
  }

  function applyPreset(key: (typeof RANGE_PRESETS)[number]["key"]) {
    const r = resolveRange(key)
    onChange(r.from, r.to)
    setViewMonth(dayjs(r.from).startOf("month"))
    setAnchor(null)
    setOpen(false)
  }

  const filled = !!(from && to)
  const label = !filled
    ? placeholder
    : from === to
      ? from
      : `${from} ~ ${to}`

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? openPanel() : setOpen(false))}>
      <Popover.Trigger
        type="button"
        disabled={disabled}
        aria-label={rest["aria-label"]}
        aria-invalid={invalid || undefined}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          // min-w-0 + overflow-hidden：让触发器像 native input 一样能在网格列内收缩，
          // 否则 min-width:auto 会把日期文字撑破列宽、溢出到相邻表单字段上
          "min-w-0 justify-start gap-2 overflow-hidden text-left font-normal tnum",
          // 未选区间时的占位文案跟输入框共用 --input-placeholder，不用 muted-foreground
          !filled && "text-input-placeholder",
          invalid && "border-destructive ring-1 ring-destructive/40",
          className
        )}
      >
        <CalendarIcon className="size-4 shrink-0 opacity-70" />
        <span className="truncate">{label}</span>
      </Popover.Trigger>
      <Popover.Portal>
        {/* z 必须在 Positioner 上：它是 position:fixed，自成层叠上下文，
            只给内层 Popup 写 z-50 出不去，会被同样 z-50 的 Dialog 整块盖住 */}
        <Popover.Positioner className="isolate z-50" side="bottom" align="start" sideOffset={4}>
          <Popover.Popup className="z-50 flex w-auto rounded-2xl border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none">
            {presets && (
              <div className="mr-3 flex w-20 shrink-0 flex-col gap-1 border-r pr-3">
                <span className="mb-0.5 text-xs text-muted-foreground">快捷</span>
                {RANGE_PRESETS.map((preset) => {
                  const r = resolveRange(preset.key)
                  const active = from === r.from && to === r.to
                  return (
                    <Button
                      key={preset.key}
                      type="button"
                      size="xs"
                      variant={active ? "secondary" : "ghost"}
                      className="justify-start"
                      onClick={() => applyPreset(preset.key)}
                    >
                      {preset.label}
                    </Button>
                  )
                })}
                {allowClear && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="justify-start text-muted-foreground"
                    onClick={() => {
                      onChange("", "")
                      setAnchor(null)
                      setOpen(false)
                    }}
                  >
                    <XIcon className="size-3" />
                    清除
                  </Button>
                )}
              </div>
            )}
            <div className="w-[280px]">
              <div className="mb-2 flex items-center justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  onClick={() => setViewMonth((m) => m.subtract(1, "month"))}
                  aria-label="上个月"
                >
                  <ChevronLeftIcon className="size-4" />
                </Button>
                <span className="tnum text-sm font-medium">{viewMonth.format("YYYY 年 M 月")}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  onClick={() => setViewMonth((m) => m.add(1, "month"))}
                  aria-label="下个月"
                >
                  <ChevronRightIcon className="size-4" />
                </Button>
              </div>
              <div className="mb-1 grid grid-cols-7 text-center text-xs text-muted-foreground">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="py-1">
                    {w}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-0.5" onMouseLeave={() => setHover(null)}>
                {buildMonthGrid(viewMonth).map((d) => {
                  const iso = toISO(d)
                  const inMonth = d.month() === viewMonth.month()
                  const isToday = d.isSame(dayjs().startOf("day"), "day")
                  const isEdge = (loISO && iso === loISO) || (hiISO && iso === hiISO)
                  const inMiddle = !!loISO && !!hiISO && iso > loISO && iso < hiISO
                  return (
                    <button
                      key={iso}
                      type="button"
                      onClick={() => pickDay(d)}
                      onMouseEnter={() => anchor && setHover(d)}
                      className={cn(
                        "tnum flex h-8 items-center justify-center rounded-lg text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        !inMonth && "text-muted-foreground/40",
                        inMonth && !isEdge && !inMiddle && "hover:bg-accent hover:text-accent-foreground",
                        inMiddle && "bg-primary/10",
                        isToday && !isEdge && "font-semibold text-primary",
                        isEdge && "bg-primary font-medium text-primary-foreground"
                      )}
                    >
                      {d.date()}
                    </button>
                  )
                })}
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
