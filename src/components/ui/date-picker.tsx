import * as React from "react"
import dayjs, { type Dayjs } from "dayjs"
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { Popover } from "@base-ui/react/popover"
import { Button, buttonVariants } from "@/components/ui/button"
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

export interface DatePickerProps {
  /** ISO 日期字符串 YYYY-MM-DD；空串或 undefined 表示未选 */
  value?: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
  "aria-label"?: string
}

export function DatePicker({
  value,
  onChange,
  placeholder = "选择日期",
  className,
  disabled,
  ...rest
}: DatePickerProps) {
  const iso = value ?? ""
  const selected = iso ? dayjs(iso) : null
  const [open, setOpen] = React.useState(false)
  const [viewMonth, setViewMonth] = React.useState<Dayjs>(() =>
    (selected?.isValid() ? selected : dayjs()).startOf("month")
  )

  React.useEffect(() => {
    const d = iso ? dayjs(iso) : null
    if (d?.isValid()) setViewMonth(d.startOf("month"))
    // 仅在外部 value 变化时同步视图月份
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iso])

  const grid = React.useMemo(() => buildMonthGrid(viewMonth), [viewMonth])
  const today = dayjs().startOf("day")

  function pick(d: Dayjs) {
    onChange(toISO(d))
    setOpen(false)
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        type="button"
        disabled={disabled}
        aria-label={rest["aria-label"]}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          // min-w-0 + overflow-hidden：让触发器像 native input 一样能在网格列内收缩，
          // 否则 min-width:auto 会把日期文字撑破列宽、溢出到相邻表单字段上
          "min-w-0 justify-start gap-2 overflow-hidden text-left font-normal tnum",
          !selected && "text-muted-foreground",
          className
        )}
      >
        <CalendarIcon className="size-4 shrink-0 opacity-70" />
        <span className="truncate">{selected?.isValid() ? selected.format("YYYY-MM-DD") : placeholder}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4}>
          <Popover.Popup className="z-50 w-[280px] rounded-2xl border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none">
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
            <div className="grid grid-cols-7 gap-0.5">
              {grid.map((d) => {
                const inMonth = d.month() === viewMonth.month()
                const isSelected = !!selected?.isValid() && d.isSame(selected, "day")
                const isToday = d.isSame(today, "day")
                return (
                  <button
                    key={d.format("YYYY-MM-DD")}
                    type="button"
                    onClick={() => pick(d)}
                    className={cn(
                      "tnum flex h-8 items-center justify-center rounded-lg text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      !inMonth && "text-muted-foreground/40",
                      inMonth && "hover:bg-accent hover:text-accent-foreground",
                      isToday && !isSelected && "font-semibold text-primary",
                      isSelected && "bg-primary font-medium text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                    )}
                  >
                    {d.date()}
                  </button>
                )
              })}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
