/**
 * 「净重刚定 → 结算」这一段的两样共用件（02 §F1.4、06 §2.2）。
 *
 * 为什么单独成文件：净重定下来之后有**两条路**能走到结算——
 *  ① 工作台在那一捕之后自动挂账结算（磅单上已经有价，不必等人）；
 *  ② 结算框（`SettleForm`）人工算钱。
 * 两条路必须算出**同一笔钱**，否则同一张单会出现两个应付——那正是红冲要处理的现场事故
 * （与 `calc.ts` 的试算同一条纪律：算钱的规则只写一份）。
 *
 * 所以这里收的是：
 *  - `lookupPrice`：价目表取现行价（品种 + 等级两个锚，缺一不可）；
 *  - `settleDefaults`：开框/自动结算时那一组默认值（等级、单价、四项扣重、费用扣款）；
 *  - `postWeighAction`：净重刚定之后到底走哪条路（纯函数，只有结论，话术归调用方）。
 *
 * 注意 `settleDefaults` 里的**默认值一律不是判定**：自动结算照它落库、人工结算框照它铺屏，
 * 人在框里改过的值以人为准（自动那一支没有"人改过"这回事）。
 */
import { previewSettlement, roundHalfUp } from "@/lib/calc";
import type { GrainVariety, PriceList, QcReport, WeighOrder } from "@/mock/types";

/**
 * 从价目表取现行价：先按品种+等级精确命中，命不中退回同品种最近生效的一条。
 *
 * 品种为 `null` 一律回 `null`：价目表唯一的锚就是品种——没有品种就没有"现价"可言，
 * 界面据此走「价目表无现行价」那一支，绝不拿别的品种的价凑数。
 */
export function lookupPrice(prices: PriceList[], varietyId: number | null, grade: string | null, date: string): PriceList | null {
  if (varietyId == null) return null;
  const live = prices.filter((p) => p.variety_id === varietyId && p.effective_from <= date && p.effective_to >= date);
  if (live.length === 0) return null;
  if (grade) {
    const exact = live.find((p) => p.grade === grade);
    if (exact) return exact;
  }
  return live.slice().sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0] ?? null;
}

/** 结算要落库/要铺屏的那一组默认值。字段名与 `SettleInput` 对齐，省得调用方再翻一遍 */
export interface SettleDefaults {
  /** 本单按几等结钱：磅单上的业务定级优先，其次化验判定；都没有就是未定级 */
  grade: string;
  /** 单价（分/吨）。磅单上已落库的价优先，否则看价目表；仍无则是 null（等人手填） */
  price_fen_per_ton: number | null;
  package_deduct_01kg: number;
  moisture_deduct_01kg: number;
  impurity_deduct_01kg: number;
  other_deduct_01kg: number;
  deduction_fee_fen: number;
  /** 磅单上已经留过一句的改价事由（空串＝没写过）。偏离价目时的追溯就靠它 */
  price_override_reason: string;
  /** 单价是不是"原样取自价目表"——决定结算时要不要记 `price_list_id`、要不要提示改价事由 */
  listed: PriceList | null;
}

/**
 * 品种默认扣包折算成 0.1kg。**比例与固定公斤的取舍只判这一处**：档案里
 * `default_package_deduct_001pct` 非空且 > 0 就按比例扣净重，否则用固定公斤数。
 * 两列谁赢不设开关列——"模式是比例、比例却是空"这种自相矛盾的行判不出来，
 * 也不该由磅房猜。
 *
 * 净重还没定（`null`）时比例算不出数，退回固定公斤：铺进结算框的必须是一个能用的公斤数，
 * 而不是"等有了净重再算"的第二种状态。
 *
 * 折算只发生在**铺默认值**这一刻。磅单上落的、`orders.rs::settle` 校验的、票面印的
 * 仍是 `package_deduct_01kg` 那个公斤数：比例不进结算公式，也不进票面。
 */
export function varietyPackageDeduct01kg(v: GrainVariety | null | undefined, netWeight01kg: number | null): number {
  if (!v) return 0;
  const pct = v.default_package_deduct_001pct ?? 0;
  if (pct > 0 && netWeight01kg != null) return roundHalfUp((netWeight01kg * pct) / 10000);
  return v.default_package_deduct_01kg ?? 0;
}

/**
 * 结算那一格袋重该铺什么。**这里不能照抄上面的 `??` 范式**，它是本文件最容易踩空的一处：
 * `weigh_order.package_deduct_01kg` 是非空列（0001 建表 `NOT NULL DEFAULT 0`），而全库只有
 * `orders.rs::settle` 会写它——未结算单上那个 0 是建表默认，不是"磅员说了不扣"。
 * 从前写的正是 `order.package_deduct_01kg ?? 品种默认`，左边永不为 null，
 * 于是档案里的「默认扣包」在桌面端一次都没生效过；issue #3 要加的比例档会被同一句话挡住。
 *
 * 所以按"结没结算过"分两支：
 *  - 没结算过：0 就是还没人填，铺品种默认（比例优先，见 `varietyPackageDeduct01kg`）；
 *  - 已结算：那一格是当场填进账的数，填 0＝不用袋子也照原样读回来，品种插不上手。
 */
export function packageDeduct01kg(order: WeighOrder, variety: GrainVariety | null): number {
  if (order.settled_at != null || order.package_deduct_01kg !== 0) return order.package_deduct_01kg;
  return varietyPackageDeduct01kg(variety, order.net_weight_01kg);
}

/**
 * 铺一格结算要用的默认值。**两个调用方共用这一份**（见文件头）。
 *
 * 每一条的兜底顺序都是照现场来的：
 *  - 等级：磅单上改判过的（`order.grade`）覆盖化验判定（化验单本身永不改写）；
 *  - 单价：磅单上已落库的价优先——它可能是磅房提前定的，比"此刻的价目表"更权威；
 *  - 扣水/扣杂：磅单上有就用磅单的，没有才拿化验单的（`||` 而不是 `??`：0 在这里就是"没扣"）；
 *  - 袋重：见 `packageDeduct01kg` 那一段，判据与上面几条不同；
 *  - 费用扣款（卸车费、袋钱）没有来源，一律从 0 起。
 */
export function settleDefaults(
  order: WeighOrder,
  variety: GrainVariety | null,
  qc: QcReport | null,
  prices: PriceList[],
): SettleDefaults {
  const grade = order.grade ?? qc?.grade ?? "";
  const listed = lookupPrice(prices, order.variety_id, grade || null, order.business_date);
  return {
    grade,
    price_fen_per_ton: order.price_fen_per_ton ?? listed?.price_fen_per_ton ?? null,
    package_deduct_01kg: packageDeduct01kg(order, variety),
    moisture_deduct_01kg: order.moisture_deduct_01kg || qc?.moisture_deduct_01kg || 0,
    impurity_deduct_01kg: order.impurity_deduct_01kg || qc?.impurity_deduct_01kg || 0,
    other_deduct_01kg: order.other_deduct_01kg ?? 0,
    deduction_fee_fen: order.deduction_fee_fen ?? 0,
    price_override_reason: order.price_override_reason ?? "",
    listed,
  };
}

/**
 * 结算前的票面预估值。**只用于票面展示，绝不参与写库**（落库一律以 `api.settle` 返回为准）。
 *
 * 为什么需要它：票是净重刚定那一刻就打给客户的，而扣项要到结算才算定。票面金额栏一片空白，
 * 客户不知道自己这车能拿多少，出了事手里也什么都没有——所以 02 §F1.4 明说码单上"可印预估应付
 * （化验扣重 + 价目表现价），但**必须标明是预估**"。这里算的就是那个数。
 *
 * 预估值只用"此刻已经知道的东西"，每一条都对着 `settleDefaults` 的兜底顺序：
 *  - 单价：磅单上已定的价（制单带的挂牌价、或磅房事后改的价）。没有价就没有预估可言，回 null；
 *  - 扣水 / 扣杂：磅单还没记（未结算就是没记）→ 拿**化验建议**；
 *  - 袋重 / 其他扣 / 扣款：磅单现值（未结算时那一列还是建表默认的那个 0）。**品种默认扣包
 *    不在这一支里**：它由 `settleDefaults` 在结算那一刻才铺进框，而票面渲染拿不到品种档案。
 *    所以配了默认扣包的站点，票面预估会比结算框少扣那一笔——既有口径，不是本次改动带来的。
 *
 * 公式走 `previewSettlement`——与结算框的即时试算**同一份**，绝不另写一套：票面那个预估值与
 * 结算框铺出来的数必须是同一个，否则客户拿着两张纸对不上，比不印更糟。
 */
export interface SettlePreview {
  package_deduct_01kg: number;
  moisture_deduct_01kg: number;
  impurity_deduct_01kg: number;
  other_deduct_01kg: number;
  deduct_total_01kg: number;
  settlement_weight_01kg: number;
  goods_amount_fen: number;
  payable_amount_fen: number;
}

export function settlePreview(order: WeighOrder, qc: QcReport | null | undefined): SettlePreview | null {
  if (order.price_fen_per_ton == null || order.net_weight_01kg == null) return null;
  const package_deduct_01kg = order.package_deduct_01kg ?? 0;
  const moisture_deduct_01kg = order.moisture_deduct_01kg || qc?.moisture_deduct_01kg || 0;
  const impurity_deduct_01kg = order.impurity_deduct_01kg || qc?.impurity_deduct_01kg || 0;
  const other_deduct_01kg = order.other_deduct_01kg ?? 0;
  const p = previewSettlement({
    net_weight_01kg: order.net_weight_01kg,
    package_deduct_01kg,
    moisture_deduct_01kg,
    impurity_deduct_01kg,
    other_deduct_01kg,
    price_fen_per_ton: order.price_fen_per_ton,
    deduction_fee_fen: order.deduction_fee_fen ?? 0,
    advance_fee_fen: order.advance_fee_fen ?? 0,
  });
  // 扣重把净重吃光、或算不出金额（缺净重）时不硬印一个数：票面回落到「—」，让人在结算框里看
  if (p.settlementWeight01kg == null || p.settlementWeight01kg <= 0) return null;
  if (p.goodsAmountFen == null || p.payableAmountFen == null) return null;
  return {
    package_deduct_01kg,
    moisture_deduct_01kg,
    impurity_deduct_01kg,
    other_deduct_01kg,
    deduct_total_01kg: p.deductTotal01kg,
    settlement_weight_01kg: p.settlementWeight01kg,
    goods_amount_fen: p.goodsAmountFen,
    payable_amount_fen: p.payableAmountFen,
  };
}

/**
 * 净重刚定的那一捕之后，这一单该走哪条路。**纯结论**，一句话都不说。
 *
 * 三条路的取舍（现场口径见 02 §F1.4）：
 *  - `auto`：磅单上已经有单价 → 直接按**未付款（挂账）**结掉，钱回头再算。
 *    "过完磅就走"的站点靠这一支把第三刷省掉。
 *  - `dialog`：还差东西 → 弹结算框，由人在框里把价与付款定下来（默认未支付）。
 *  - `none`：这张单已经结过/已作废拒收红冲/净重还没齐——什么都不该发生。
 *
 * 单价为空**不是**错误路径：现场常态是过完磅票先给客户、钱当时不算，价在窗口一单一议。
 */
export type PostWeighAction =
  | { kind: "auto"; price_fen_per_ton: number }
  | { kind: "dialog"; reason: "no-permission" | "no-price" | "credit-off" }
  | { kind: "none"; reason: "settled" | "terminated" | "no-net" };

/** 判定要用的两条外部事实：岗位能不能结算、站点允不允许挂账 */
export interface PostWeighContext {
  /** `settle.create` 或 `settle.credit`（磅员只有后者：能挂账、不动现金） */
  canSettle: boolean;
  /** 站点参数 `settlement_allow_part_pay`：关掉就只能当场付清，未付款那一支走不通 */
  allowCredit: boolean;
}

export function postWeighAction(order: WeighOrder, ctx: PostWeighContext): PostWeighAction {
  // 终态与结算过的一律不动：卡还挂在单上、操作员又刷了一次，不该冒出第二笔结算来
  if (order.settled_at != null || order.status === "settled" || order.status === "paid" || order.status === "archived") {
    return { kind: "none", reason: "settled" };
  }
  if (order.status === "voided" || order.status === "rejected" || order.status === "reversed") {
    return { kind: "none", reason: "terminated" };
  }
  if (order.net_weight_01kg == null) return { kind: "none", reason: "no-net" };
  // 岗位不够时仍然开框：框里那句「当前岗位无权结算」比屏上闪一下的提示更留得住人
  if (!ctx.canSettle) return { kind: "dialog", reason: "no-permission" };
  if (order.price_fen_per_ton == null) return { kind: "dialog", reason: "no-price" };
  // 站点关着挂账：未付款这一支根本落不了库，别自动结，交给框里当场付清
  if (!ctx.allowCredit) return { kind: "dialog", reason: "credit-off" };
  return { kind: "auto", price_fen_per_ton: order.price_fen_per_ton };
}
