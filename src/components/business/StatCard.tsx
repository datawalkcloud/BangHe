/**
 * 指标卡与图表（05 §7.2）。
 *
 * 图表一律走官方 shadcn Chart（recharts）+ 数据标签：条形/柱顶始终标数值，
 * 因此黑白打印与色弱场景下依然可读，不靠颜色区分。动画关闭（isAnimationActive=false），
 * 截图与打印不会抓到半截柱。
 */
import type { CSSProperties, ReactNode } from "react";
import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from "lucide-react";
import { Bar, BarChart, Cell, LabelList, XAxis, YAxis } from "recharts";
import type { Tone } from "@/lib/constants";
import { TONE_DOT } from "@/lib/constants";
import { cn } from "cn";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";

/** Tailwind 背景色类（bg-info / bg-chart-3 …）→ recharts 认的 CSS 变量色值 */
function fillOf(bgClass: string): string {
  return `var(--color-${bgClass.replace(/^bg-/, "")})`;
}

/** 页面顶部指标卡的统一栅格：窄屏两列、宽屏四列；列数不同的页面用 className 覆盖 */
export function StatCardGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-4", className)}>{children}</div>;
}

export function StatCard({
  label,
  value,
  unit,
  hint,
  tone = "neutral",
  delta,
  children,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  tone?: Tone;
  /** 同比/环比，正负都显示箭头与文字 */
  delta?: { text: string; dir: "up" | "down" | "flat"; tone?: Tone };
  children?: ReactNode;
}) {
  return (
    // p-5 是必须的：Card 根节点只给 py，横向内边距本来靠 CardContent 提供，
    // 而这里的正文是直接挂在根节点下的裸 span。
    <Card size="sm" className="relative min-w-0 gap-1 p-5">
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
    </Card>
  );
}

const TICK = { fontSize: 12, fill: "var(--color-muted-foreground)" } as const;
const VALUE_LABEL = { fontSize: 12, fontVariantNumeric: "tabular-nums", fill: "var(--color-foreground)" } as const;

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
  if (items.length === 0) return <p className="text-sm text-muted-foreground">无数据</p>;
  const top = max ?? Math.max(1, ...items.map((i) => Math.abs(i.value)));
  const data = items.map((it) => ({
    label: typeof it.label === "string" ? it.label : String(it.label),
    value: Math.abs(it.value),
    display: formatter(it.value),
    fill: fillOf(it.colorClass ?? TONE_DOT[it.tone ?? "info"]),
  }));
  const config: ChartConfig = { value: { label: "数量" } };
  return (
    <ChartContainer
      config={config}
      className="aspect-auto w-full"
      style={{ height: items.length * 28 + 4 } as CSSProperties}
    >
      <BarChart layout="vertical" data={data} margin={{ top: 0, right: 112, bottom: 0, left: 0 }} barCategoryGap={8}>
        <YAxis
          type="category"
          dataKey="label"
          width={104}
          tickLine={false}
          axisLine={false}
          tick={TICK}
          tickFormatter={(v) => (String(v).length > 7 ? `${String(v).slice(0, 7)}…` : String(v))}
        />
        <XAxis type="number" domain={[0, top]} hide />
        <Bar dataKey="value" radius={0} isAnimationActive={false} background={{ fill: "var(--color-muted)" }}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.fill} />
          ))}
          <LabelList dataKey="display" position="right" offset={8} style={VALUE_LABEL} />
        </Bar>
      </BarChart>
    </ChartContainer>
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
  if (items.length === 0) return <p className="text-sm text-muted-foreground">无数据</p>;
  const data = items.map((it) => ({
    label: it.label,
    value: it.value,
    display: it.value > 0 ? formatter(it.value) : "",
    fill: fillOf(it.tone ? TONE_DOT[it.tone] : colorClass),
  }));
  const config: ChartConfig = { value: { label: "数量" } };
  return (
    <ChartContainer
      config={config}
      className="aspect-auto min-w-0 w-full"
      style={{ height } as CSSProperties}
    >
      <BarChart data={data} margin={{ top: 16, right: 2, bottom: 0, left: 2 }} barCategoryGap={4}>
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tick={{ ...TICK, fontSize: 10 }}
          height={18}
          interval={Math.max(0, labelEvery - 1)}
        />
        <YAxis hide domain={[0, (maxTick: number) => maxTick * 1.15]} />
        <Bar dataKey="value" radius={0} isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.fill} />
          ))}
          <LabelList dataKey="display" position="top" style={{ ...VALUE_LABEL, fontSize: 10 }} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

/** 占比条：一条分段带（recharts 堆叠条形）+ 图例数据标签，替代饼图（打印友好） */
export function SplitBar({
  segments,
  formatter,
}: {
  segments: { label: string; value: number; colorClass: string }[];
  formatter: (v: number) => string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return <p className="text-sm text-muted-foreground">无数据</p>;
  const data = [{ name: "占比" } as Record<string, number | string>];
  for (const s of segments) data[0][s.label] = s.value;
  const config: ChartConfig = Object.fromEntries(segments.map((s) => [s.label, { label: s.label, color: fillOf(s.colorClass) }]));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ChartContainer config={config} className="aspect-auto h-5 w-full border border-border">
        <BarChart layout="vertical" data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap={0}>
          <YAxis type="category" dataKey="name" hide />
          <XAxis type="number" domain={[0, total]} hide />
          {segments.map((s) => (
            <Bar key={s.label} dataKey={s.label} stackId="a" fill={fillOf(s.colorClass)} isAnimationActive={false} />
          ))}
        </BarChart>
      </ChartContainer>
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

/** 简单进度条：达标率、占用率用（官方 Progress 组合） */
const RATIO_TONE: Record<Tone, string> = {
  neutral: "[&_[data-slot=progress-indicator]]:bg-muted-foreground",
  info: "[&_[data-slot=progress-indicator]]:bg-info",
  success: "[&_[data-slot=progress-indicator]]:bg-success",
  warning: "[&_[data-slot=progress-indicator]]:bg-warning",
  danger: "[&_[data-slot=progress-indicator]]:bg-destructive",
};

export function RatioBar({ value, tone = "info" }: { value: number; tone?: Tone }) {
  return (
    <Progress
      value={Math.max(0, Math.min(100, value * 100))}
      className={cn(
        "w-full [&_[data-slot=progress-track]]:h-2 [&_[data-slot=progress-track]]:rounded-none [&_[data-slot=progress-indicator]]:rounded-none",
        RATIO_TONE[tone],
      )}
    />
  );
}
