/**
 * ② 皮重参考的唯一口径（05 §4 ②、03 §4.2）。
 *
 * 「近 5 次」「均值」「超容差」这三件事有四个用处：磅房工作台的皮重参考卡片、卡片里那五行
 * 皮重明细、捕获那一捕的偏差提示（`WeighPanel`）、农户档案页的皮重档案。判定只有一份
 * （同 `weigh-gate.ts` 的规矩）：各算一次就会打架——磅员在卡片上看到的「当前偏差」与档案页的
 * 「与均值偏差」不是同一个数时，"这一车到底该不该怀疑"就没有准绳了。
 *
 * `TareRefRow.source` 走的是 `weigh_order.weight_source` 的**枚举值**（`0001_init.sql` 的 CHECK
 * 锁死 `scale` / `manual`），不是中文标签；要认它用 `lib/constants` 的 `isManualWeightSource`，
 * 要写给人看用 `weightSourceLabel`。以前档案页那两处是拿枚举值去比中文标签，判据恒假：
 * 手录皮重照样进均值、来源列每行还都染成警示色，而屏幕上一句解释都没有。
 */
import { isManualWeightSource } from "@/lib/constants";

/** 与 Rust `orders::TareRow`（`party` 详情的 `tareHistory`）逐字一致 */
export interface TareRefRow {
  date: string;
  tare_01kg: number;
  source: string;
}

/** 参考窗口：近 5 次。卡片明细与均值吃的是同一个窗口，别再各写一遍 `slice(0, 5)` */
export const TARE_REF_WINDOW = 5;

/** 参与参考的那几条（调用方给的是按 `registered_at DESC` 排好的全量历史） */
export function tareRefRows(rows: readonly TareRefRow[], n = TARE_REF_WINDOW): TareRefRow[] {
  return rows.slice(0, n);
}

/**
 * 近 5 次均值（0.1kg）；没有记录回 `null`。
 *
 * 均值刻意**不含手录**（05 §4 ②、`PartyDetailPage` 篇首那条）：手录皮重来源不可信，
 * 拿它当基准会把后面几车的净重一起带偏。但这一窗全是手录时（新档案 + 地磅正好坏了）
 * 退回全量——宁可有个粗糙的基准，也好过屏幕上写"没有参考"，让人误当生面孔。
 *
 * 所以返回值有可能来自手录：界面上不额外标"此均值含手录"，磅员看明细行里那个「手录」即可。
 */
export function tareMean01kg(rows: readonly TareRefRow[]): number | null {
  const win = tareRefRows(rows);
  const trusted = win.filter((r) => !isManualWeightSource(r.source));
  const list = trusted.length > 0 ? trusted : win;
  if (list.length === 0) return null;
  return Math.round(list.reduce((s, r) => s + r.tare_01kg, 0) / list.length);
}

/** 某次皮重与均值的偏差（0.1kg，带符号）；缺任何一头都回 `null`，不拿 0 冒充"不多不少" */
export function tareDev01kg(tare01kg: number | null | undefined, mean01kg: number | null): number | null {
  if (tare01kg == null || mean01kg == null) return null;
  return tare01kg - mean01kg;
}

/** 容差的绝对值（0.1kg）。`tolerancePct` 是"百分之"（站点参数存 0.01%，调用方已除以 100） */
export function tareTolerance01kg(mean01kg: number, tolerancePct: number): number {
  return Math.round((mean01kg * tolerancePct) / 100);
}

/**
 * 是否超出皮重容差。`tolerancePct <= 0` 是参数关掉的合法值 → 永不超差（闸门默认不拦人）。
 *
 * 阈值与 Rust `orders.rs::capture` 同一条：那边 `pct` 用 0.01% 计，
 * `(m * pct + 5000) / 10000` 即 `round(m * pct / 10000)`，与这里逐字等价。
 *
 * **基准不一致这条还没解**：那边比的是 `party.last_tare_01kg`（最近一次历史皮重），
 * 这里比的是近 5 次均值——05 §4 ② 写的是均值，服务端与票面那句"较最近历史皮重"走的是最近一次。
 * 界面这一侧先统一成"卡片、明细、捕获提示同一个数"；两端要不要合成一个，是要拍板的业务口径。
 */
export function tareOverTolerance(tare01kg: number | null | undefined, mean01kg: number | null, tolerancePct: number): boolean {
  if (tare01kg == null || mean01kg == null || mean01kg <= 0 || tolerancePct <= 0) return false;
  return Math.abs(tare01kg - mean01kg) > tareTolerance01kg(mean01kg, tolerancePct);
}
