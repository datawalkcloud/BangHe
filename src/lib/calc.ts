/**
 * 结算试算（仅用于界面即时反馈，权威结果一律以 `api.settle()` 返回为准）。
 *
 * 为什么允许前端算：05 §4 ⑤ 要求"所有金额变化即时重算"，
 * 每次按键都问后端不现实。但三条红线在这里守得住：
 *  1. 只算 `净重 → 结算重量 → 货款 → 应付` 这一条展示链，不含任何计价规则
 *  2. 全程定点整数中间量，除 last 一步 round 外不引入浮点误差
 *  3. 落库时后端用同一组公式重算，界面值与库值不一致以库为准（本函数不参与写）
 *
 * 水分/杂质增扣量与等级加减价的规则引擎首版不做（02 文档 F4.4），
 * 所以这里**绝不**根据化验指标推导扣重，扣重一律人工录入。
 */
/** 四舍五入（正向数值），与 SQL 的 ROUND、Rust 的 round_half_up 同义 */
export function roundHalfUp(n: number): number {
  return Math.floor(n + 0.5);
}

/**
 * 货款公式，与服务端唯一同构（03 §3.1 规则 3）：
 * 0.1kg × 分/吨 ÷ 10000 = 分，只在最终金额处取整。
 * a*b 在 Number 安全整数范围内（结算重量 ≤ 千万级、单价 ≤ 百万级）。
 */
export function amountFen(settlementWeight01kg: number, priceFenPerTon: number): number {
  return roundHalfUp((settlementWeight01kg * priceFenPerTon) / 10000);
}

export interface DeductInput {
  net_weight_01kg: number | null;
  package_deduct_01kg: number;
  moisture_deduct_01kg: number;
  impurity_deduct_01kg: number;
  other_deduct_01kg: number;
}

/** 扣重合计，0.1kg */
export function deductTotal01kg(d: DeductInput): number {
  return d.package_deduct_01kg + d.moisture_deduct_01kg + d.impurity_deduct_01kg + d.other_deduct_01kg;
}

/** 结算重量 = 净重 − 全部扣重；不足零按 0 处理并交给界面报错 */
export function settlementWeight01kg(d: DeductInput): number | null {
  if (d.net_weight_01kg == null) return null;
  return d.net_weight_01kg - deductTotal01kg(d);
}

/**
 * 货款（分）= 结算重量(0.1kg) × 单价(分/吨) ÷ 10000，四舍五入。
 * 与 03 §3.1 的 `amount_fen = round_half_up(settlement_weight_01kg × price_fen_per_ton ÷ 10000)` 同式。
 */
export function goodsAmountFen(settle01kg: number | null, priceFenPerTon: number | null): number | null {
  if (settle01kg == null || priceFenPerTon == null || settle01kg <= 0) return null;
  return amountFen(settle01kg, priceFenPerTon);
}

/** 应付 = 货款 − 其他费用扣款 + 代垫扣回（首版只有扣款） */
export function payableFen(goods: number | null, deductionFeeFen = 0, advanceFeeFen = 0): number | null {
  if (goods == null) return null;
  return goods - deductionFeeFen + advanceFeeFen;
}

/** 试算汇总，页面一次取全部 */
export function previewSettlement(input: DeductInput & {
  price_fen_per_ton: number | null;
  deduction_fee_fen?: number;
  advance_fee_fen?: number;
}) {
  const settle = settlementWeight01kg(input);
  const goods = goodsAmountFen(settle, input.price_fen_per_ton);
  const payable = payableFen(goods, input.deduction_fee_fen ?? 0, input.advance_fee_fen ?? 0);
  return {
    deductTotal01kg: deductTotal01kg(input),
    settlementWeight01kg: settle,
    goodsAmountFen: goods,
    payableAmountFen: payable,
    /** 禁用结算按钮时必须给原因（05 §4 ⑤），这里把原因一次算清 */
    blocked: blockReason(input, settle),
  };
}

function blockReason(input: DeductInput, settle: number | null): string | null {
  if (input.net_weight_01kg == null) return "缺少毛重或皮重，无法结算";
  if (settle != null && settle <= 0) return "扣重后结算重量不大于 0，请核对扣项";
  return null;
}
