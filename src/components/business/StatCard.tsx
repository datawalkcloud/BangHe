/**
 * 指标卡与"能打印的图表"（05 §7.2）。
 *
 * 刻意不引入图表库：磅房机不能依赖联网字体，且报表打印后是黑白的。
 * 这里全部用条形 + 数据标签实现，屏幕可读、打印可读，不靠颜色区分。
 */
import type { ReactNode } from "react";
import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from "lucide-react";
import type { Tone } from "@/lib/constants";
import { TONE_DOT } from "@/lib/constants";
import { cn } from "cn";

export function StatCard({
  label,
  value,
  unit,
  hint,
  tone = "neutral",
  delta,
  onClick,
  children,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  tone?: Tone;
  /** 同比/环比，正负都显示箭头与文字 */
  delta?: { text: string; dir: "up" | "down" | "flat"; tone?: Tone };
  onClick?: () => void;
  children?: ReactNode;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={cn(
        "relative flex min-w-0 flex-col gap-1 border bg-card p-3 text-left",
        onClick && "hover:border-ring focus-visible:outline-2 focus-visible:outline-ring",
      )}
    >
      {tone !== "neutral" && (
        <span className={cn("absolute top-0 left-0 h-full w-[3px]", TONE_DOT[tone])} aria-hidden />
      )}
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-1">
        <span className="tnum text-xl leading-none font-semibold tabular-nums">{value}</span>
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        {delta && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-xs",
              delta.tone === "danger" || delta.tone === "warning"
                ? "text-destructive"
                : delta.tone === "success"
                  ? "text-success"
                  : "text-muted-foreground",
            )}
          >
            {delta.dir === "up" ? (
              <ArrowUpRightIcon className="size-3" />
            ) : delta.dir === "down" ? (
              <ArrowDownRightIcon className="size-3" />
            ) : (
              <MinusIcon className="size-3" />
            )}
            {delta.text}
          </span>
        )}
        {hint && <span className="min-w-0 truncate text-xs text-muted-foreground">{hint}</span>}
      </span>
      {children}
    </Comp>
  );
}

/**
 * 横向条形列表：条形只表量级，数值标签始终在右侧，
 * 因此黑白打印与色弱场景下依然可读（05 §7.2 要求同时给数据标签）。
 */
export function BarList({
  items,
  formatter,
  max,
}: {
  items: { label: ReactNode; value: number; colorClass?: string; tone?: Tone }[];
  formatter: (v: number) => string;
  max?: number;
}) {
  const top = max ?? Math.max(1, ...items.map((i) => Math.abs(i.value)));
  return (
    <ul className="flex flex-col gap-2">
      {items.map((it, idx) => (
        <li key={idx} className="grid grid-cols-[minmax(4rem,7rem)_1fr_auto] items-center gap-2 text-sm">
          <span className="truncate text-muted-foreground">{it.label}</span>
          <span className="h-4 min-w-0 bg-muted">
            <span
              className={cn("block h-full", it.colorClass ?? TONE_DOT[it.tone ?? "info"])}
              style={{ width: `${Math.min(100, (Math.abs(it.value) / top) * 100)}%` }}
              aria-hidden
            />
          </span>
          <span className="tnum w-28 text-right tabular-nums">{formatter(it.value)}</span>
        </li>
      ))}
      {items.length === 0 && <li className="text-sm text-muted-foreground">无数据</li>}
    </ul>
  );
}

/** 竖向柱状：小时曲线、日趋势用 */
export function MiniBars({
  items,
  formatter,
  colorClass = "bg-info",
  height = 96,
  labelEvery = 1,
}: {
  items: { label: string; value: number; tone?: Tone }[];
  formatter: (v: number) => string;
  colorClass?: string;
  height?: number;
  labelEvery?: number;
}) {
  const top = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="flex min-w-0 items-end gap-1" style={{ height }}>
      {items.map((it, idx) => (
        <div key={idx} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1 self-stretch">
          {/* 两个标签必须固定行高：空字符串的 span 高度为 0，
              会让有标签的列柱高被压短，labelEvery > 1 时柱与柱就不可比了 */}
          <span className="tnum h-3.5 shrink-0 text-[10px] leading-[14px] text-muted-foreground">{it.value > 0 ? formatter(it.value) : ""}</span>
          <div className="flex w-full flex-1 items-end">
            <div
              className={cn("w-full", it.tone ? TONE_DOT[it.tone] : colorClass)}
              style={{ height: `${(it.value / top) * 100}%` }}
              title={`${it.label}：${formatter(it.value)}`}
            />
          </div>
          <span className="tnum h-3.5 shrink-0 text-[10px] leading-[14px] text-muted-foreground">
            {idx % labelEvery === 0 ? it.label : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 占比条：一条分段带图例，替代饼图（打印友好） */
export function SplitBar({
  segments,
  formatter,
}: {
  segments: { label: string; value: number; colorClass: string }[];
  formatter: (v: number) => string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return <p className="text-sm text-muted-foreground">无数据</p>;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex h-5 w-full overflow-hidden border">
        {segments.map((s) => (
          <div
            key={s.label}
            className={s.colorClass}
            style={{ width: `${(s.value / total) * 100}%` }}
            title={`${s.label} ${formatter(s.value)}`}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5">
            <span className={cn("size-2.5 shrink-0 border border-border", s.colorClass)} aria-hidden />
            <span>{s.label}</span>
            <span className="tnum text-muted-foreground tabular-nums">
              {formatter(s.value)}（{((s.value / total) * 100).toFixed(1)}%）
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 简单进度条：达标率、占用率用 */
export function RatioBar({ value, tone = "info" }: { value: number; tone?: Tone }) {
  return (
    <div className="h-2 w-full bg-muted">
      <div
        className={cn("h-full", TONE_DOT[tone])}
        style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }}
      />
    </div>
  );
}
