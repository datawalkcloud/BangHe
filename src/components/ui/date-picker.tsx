import * as React from "react"
import dayjs from "dayjs"
import { CalendarIcon } from "lucide-react"
import { zhCN } from "react-day-picker/locale"
import { buttonVariants } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "cn"

export interface DatePickerProps {
  /** ISO 日期字符串 YYYY-MM-DD；空串或 undefined 表示未选 */
  value?: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
  "aria-label"?: string
}

/**
 * 单日选择：shadcn Popover + Calendar，对外仍是 `YYYY-MM-DD` 字符串。
 *
 * 日期字符串一律按**本地时区**解析（`dayjs(iso)` 得到本地零点），不碰 `toISOString()`
 * ——那是 UTC，东八区会把当天算成前一天，业务日期就差了一天。
 */
export function DatePicker({
  value,
  onChange,
  placeholder = "选择日期",
  className,
  disabled,
  ...rest
}: DatePickerProps) {
  const iso = value ?? ""
  const selected = React.useMemo(() => {
    const d = iso ? dayjs(iso) : null
    return d?.isValid() ? d.toDate() : undefined
  }, [iso])
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={rest["aria-label"]}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          // min-w-0 + overflow-hidden：让触发器像 native input 一样能在网格列内收缩，
          // 否则 min-width:auto 会把日期文字撑破列宽、溢出到相邻表单字段上
          "min-w-0 justify-start gap-2 overflow-hidden text-left font-normal tnum",
          // 未选日期时的"选择日期"就是本字段的占位符：跟输入框共用 --input-placeholder，
          // 不用 muted-foreground——那是标签/提示文字的颜色，和已填的正文太接近，看不出还没选。
          !selected && "text-input-placeholder",
          className
        )}
      >
        <CalendarIcon className="size-4 shrink-0 opacity-70" />
        <span className="truncate">{selected ? dayjs(selected).format("YYYY-MM-DD") : placeholder}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          locale={zhCN}
          // 沿用仓库一贯的日历口径：周日打头（zhCN 默认是周一起）
          weekStartsOn={0}
          selected={selected}
          defaultMonth={selected}
          autoFocus
          onSelect={(d) => {
            onChange(d ? dayjs(d).format("YYYY-MM-DD") : "")
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
