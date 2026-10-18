/**
 * 时间区间预设（首页看板 / 报表共用的一份口径，05 §3）。
 *
 * 只放"常用时间段"的纯计算：把「今天/昨天/近 7 天……」这类语义解析成一对
 * `business_date`（闭区间 `from`~`to`，`YYYY-MM-DD`）。看板与报表都按业务日期归期，
 * 因此这里产出的字符串直接进后端 `BETWEEN ?1 AND ?2`，两端（mock 与 SQLite）同口径。
 *
 * 为什么放前端算而不是让后端认枚举：
 *  - 后端 `Local::now()` 与前端 `todayISO()` 是同一台机器的同一挂钟，锚点一致；
 *  - 报表侧本来就是「手改起止 + 快捷预设」，`from/to` 已是它的通用入参形态，
 *    看板复用同一份预设即可，不再各写一套月份加减（旧「上月」写成 13 天的坑就在这里）。
 */
import { shiftDay, todayISO } from "@/lib/format";

export type RangeKey = "today" | "yesterday" | "last7" | "last30" | "thisMonth" | "lastMonth";

/** 解析后的闭区间：`from`/`to` 为 `YYYY-MM-DD`（含端点），`label` 用于展示。 */
export interface DateRange {
  from: string;
  to: string;
  label: string;
}

/** 展示顺序即按钮组顺序；看板与报表都从这里取，避免两处漂移。 */
export const RANGE_PRESETS: { key: RangeKey; label: string }[] = [
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "last7", label: "近 7 天" },
  { key: "last30", label: "近 30 天" },
  { key: "thisMonth", label: "本月" },
  { key: "lastMonth", label: "上月" },
];

/** 当月 1 号（依赖定长的 `YYYY-MM-` 前缀，无需解析 Date）。 */
function firstOfMonth(isoDate: string): string {
  return `${isoDate.slice(0, 8)}01`;
}

/**
 * 把一个预设语义解析成闭区间。`base` 默认今日，测试或"以某天为基准"时传入。
 * 近 N 天含当天（近 7 天 = 今天往前 6 天 ~ 今天），与报表 RangeBar 原口径一致。
 */
export function resolveRange(key: RangeKey, base: string = todayISO()): DateRange {
  switch (key) {
    case "today":
      return { from: base, to: base, label: "今天" };
    case "yesterday": {
      const y = shiftDay(base, -1);
      return { from: y, to: y, label: "昨天" };
    }
    case "last7":
      return { from: shiftDay(base, -6), to: base, label: "近 7 天" };
    case "last30":
      return { from: shiftDay(base, -29), to: base, label: "近 30 天" };
    case "thisMonth":
      return { from: firstOfMonth(base), to: base, label: "本月" };
    case "lastMonth": {
      // 上月末日 = 本月 1 号前一天；上月首日 = 该末日所在月的 1 号
      const lastEnd = shiftDay(firstOfMonth(base), -1);
      return { from: firstOfMonth(lastEnd), to: lastEnd, label: "上月" };
    }
  }
}

/**
 * 反查一段区间对应哪个预设口径的文案，用作看板卡片的标题前缀。
 * 命中预设（今天/近 7 天…）就用它的语义；手改的任意区间统一叫「本期」，
 * 免得把一长串日期塞进「XX车次」这类标签里。
 */
export function rangeLabel(from: string, to: string, base: string = todayISO()): string {
  for (const preset of RANGE_PRESETS) {
    const r = resolveRange(preset.key, base);
    if (r.from === from && r.to === to) return preset.label;
  }
  return "本期";
}

/** 当前区间落在哪一天之外都不画：返回 [from..to] 逐日枚举，用于趋势柱。 */
export function enumerateDays(range: DateRange): string[] {
  const days: string[] = [];
  let cursor = range.from;
  // 闭区间，最多兜底 370 天防御 from>to 或异常跨度造成死循环
  for (let i = 0; i < 370; i++) {
    days.push(cursor);
    if (cursor >= range.to) break;
    cursor = shiftDay(cursor, 1);
  }
  return days;
}
