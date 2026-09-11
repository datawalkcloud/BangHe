/**
 * 重量展示（05 §4 ③ 称重区、§1 强光下远距离可读）。
 *
 * 不稳定时细体 + "不稳定"文字；稳定后加粗 + 捕获提示。
 * 刻意不做数字滚动动画——抖动动画在磅房只会让人误读成"还在变化"。
 */
import { weight } from "@/lib/format";
import { cn } from "cn";

export function WeightDisplay({
  value01kg,
  stable,
  connected,
  size = "xl",
  unit = "kg",
  className,
}: {
  value01kg: number | null;
  stable: boolean;
  connected: boolean;
  size?: "xl" | "lg" | "md";
  unit?: "kg" | "t";
  className?: string;
}) {
  const text = unit === "t" ? weightNumberToTon(value01kg) : weightNumberToKg(value01kg);
  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "tnum leading-none tracking-tight tabular-nums",
            size === "xl" && "text-[clamp(56px,7vw,128px)]",
            size === "lg" && "text-[clamp(36px,4.5vw,64px)]",
            size === "md" && "text-[clamp(24px,3vw,40px)]",
            !connected ? "font-light text-muted-foreground/50" : stable ? "font-bold text-foreground" : "font-light text-muted-foreground",
          )}
        >
          {connected ? text : "— — — —"}
        </span>
        <span className={cn("font-medium text-muted-foreground", size === "xl" ? "text-3xl" : "text-lg")}>{unit}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs">
        {!connected ? (
          <span className="text-destructive">仪表离线 · 无法读数，可改为手录</span>
        ) : stable ? (
          <span className="text-success">● 读数稳定，可捕获</span>
        ) : (
          <span className="text-warning">○ 读数不稳定，请等车辆停稳</span>
        )}
      </div>
    </div>
  );
}

/** 展示换算只走 lib/format，这里为了分位空格排版单独处理 */
function weightNumberToKg(v: number | null): string {
  if (v == null) return "—";
  const kg = v / 10;
  const [i, d] = kg.toFixed(1).split(".");
  return `${groupThousands(i)}.${d}`;
}

function weightNumberToTon(v: number | null): string {
  if (v == null) return "—";
  const t = v / 10000;
  const [i, d] = t.toFixed(3).split(".");
  return `${groupThousands(i)}.${d}`;
}

function groupThousands(intStr: string): string {
  const neg = intStr.startsWith("-");
  const body = neg ? intStr.slice(1) : intStr;
  const out = body.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `-${out}` : out;
}

/** 次要重量行：毛重/皮重/净重/结算重并列 */
export function WeightStat({
  label,
  value01kg,
  hint,
  tone = "default",
}: {
  label: string;
  value01kg: number | null | undefined;
  hint?: string;
  tone?: "default" | "muted" | "danger";
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "tnum text-lg font-semibold",
          tone === "muted" && "text-muted-foreground font-normal",
          tone === "danger" && "text-destructive",
        )}
      >
        {value01kg == null ? "—" : weight(value01kg)}
      </span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}
