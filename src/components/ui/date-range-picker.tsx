import * as React from "react"
import dayjs from "dayjs"
import { CalendarIcon, XIcon } from "lucide-react"
import type { DateRange as RdpRange } from "react-day-picker"
import { zhCN } from "react-day-picker/locale"
import { Button, buttonVariants } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { RANGE_PRESETS, resolveRange } from "@/lib/date-range"
import { cn } from "cn"

const FMT = "YYYY-MM-DD"

/** ISO → Date，空串/非法值一律按「未选」处理（本地时区解析，不用 UTC） */
function toDate(iso?: string): Date | undefined {
  const d = iso ? dayjs(iso) : null
  return d?.isValid() ? d.toDate() : undefined
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

/**
 * 区间选择：shadcn Popover + Calendar（range 模式），对外仍是两个 `YYYY-MM-DD` 字符串。
 *
 * 半程选择（只点了起始日）只留在组件内部的 `draft`，不回写外部 value——
 * 否则筛选条件会被一个还没选完的区间触发刷新。
 */
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
  const [draft, setDraft] = React.useState<RdpRange | undefined>(undefined)

  function openPanel() {
    const f = toDate(from)
    const t = toDate(to)
    setDraft(f || t ? { from: f, to: t } : undefined)
    setOpen(true)
  }

  function commit(nextFrom: string, nextTo: string) {
    onChange(nextFrom, nextTo)
    setOpen(false)
  }

  function handleSelect(range: RdpRange | undefined, triggerDate: Date) {
    // min=1 下「再点一次起始日」RDP 给的是 undefined；这里按单日区间理解，
    // 不然想选同一天就得点三次，且第二次点击看起来像被清掉了。
    if (!range?.from) {
      const sameDayAgain =
        !range && draft?.from && !draft.to && dayjs(triggerDate).isSame(draft.from, "day")
      if (sameDayAgain && draft?.from) {
        const iso = dayjs(draft.from).format(FMT)
        setDraft(undefined)
        commit(iso, iso)
        return
      }
      setDraft(undefined)
      return
    }
    setDraft(range)
    if (!range.to) return // 半程：等第二个端点
    const a = dayjs(range.from)
    const b = dayjs(range.to)
    const [lo, hi] = a.isAfter(b) ? [b, a] : [a, b]
    commit(lo.format(FMT), hi.format(FMT))
  }

  const filled = !!(from && to)
  const label = !filled ? placeholder : from === to ? from : `${from} ~ ${to}`

  return (
    <Popover open={open} onOpenChange={(next) => (next ? openPanel() : setOpen(false))}>
      <PopoverTrigger
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
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <div className="flex">
          {presets && (
            <div className="flex w-24 shrink-0 flex-col gap-1 border-r p-3">
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
                    onClick={() => commit(r.from, r.to)}
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
                    setDraft(undefined)
                    commit("", "")
                  }}
                >
                  <XIcon className="size-3" />
                  清除
                </Button>
              )}
            </div>
          )}
          <Calendar
            mode="range"
            locale={zhCN}
            // 起止大多跨月，并排展示两个月份面板，省掉一次翻页（窄屏下 Calendar 自身会竖排）
            numberOfMonths={2}
            // 上/下月一次翻两个月，不分页的话左右面板会错位成同一个月的相邻两页
            pagedNavigation
            // 沿用仓库一贯的日历口径：周日打头（zhCN 默认是周一起）
            weekStartsOn={0}
            // 让第一次点击只定起始日；不加 min 的话 RDP 会当场补上 to=同一天并立刻收敛
            min={1}
            // 不带这个时，面板里残留完整区间（打开即回填 from~to）会让每次点击走
            // 「延长旧区间」分支、当场提交——等于只能点一下，选不了起止两段
            resetOnSelect
            selected={draft}
            defaultMonth={toDate(from) ?? toDate(to)}
            autoFocus
            className="shrink-0"
            onSelect={handleSelect}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
