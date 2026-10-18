/**
 * 场景目录：每种小票「能打印哪些数据」与「怎么取数」都在这里登记。
 *
 * 这是整个自定义模板功能的单一事实来源——
 *  - 编辑器读 `fields` / `tables` 渲染「可选数据」面板（即动态挑选字段）；
 *  - 渲染器读 `resolveField` / `tableRows` 把上下文变成票面文字；
 *  - 预览读 `sampleContext` 给出不依赖接口的样例。
 *
 * 新增一种票据 = 在这里加一个 ScenarioSpec，渲染器与编辑器零改动。
 */
import type { ReactNode } from "react";
import {
  GRADES,
  ORDER_STATUS,
  OUTBOUND_KIND,
  OUTBOUND_STATUS,
  PARTY_TYPE,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  QC_DECISION,
  TEST_METHOD,
} from "@/lib/constants";
import {
  dateTime,
  maskIdCard,
  money,
  percent,
  price,
  rmbUpper,
  ton,
  varietyLabel,
  weight,
} from "@/lib/format";
import { encodeOrderCode, encodeTicketCode } from "@/lib/ticket-code";
import { settlePreview, type SettlePreview } from "@/lib/settle-defaults";
import type {
  DailyReport,
  LedgerRow,
  OutboundDetail,
  PaymentRecord,
  QcReport,
  Settlement,
  Station,
  WeighOrder,
} from "@/mock/types";
import type { FieldDef, NameResolver, ReceiptScenario, ScenarioSpec } from "./types";

/* ----------------------------------------------------------------- 样例数据 */

const SAMPLE_STATION: Station = {
  id: 1,
  code: "BH2026",
  name: "滨河粮食收购站",
  address: "向阳路 18 号",
  phone: "0571-8800 1234",
};

const NAME_MAP: Record<number, string> = {
  1: "张伟（站长）",
  2: "李红（登记）",
  3: "王强（磅员）",
  4: "陈敏（化验）",
  5: "赵磊（出纳）",
};
const sampleNames: NameResolver = (id) => (id == null ? "—" : (NAME_MAP[id] ?? `员工${id}`));

const SAMPLE_ORDER: WeighOrder = {
  id: 1024,
  order_no: "01202609000317",
  business_date: "2026-09-12",
  status: "paid",
  party_id: 88,
  party_name: "周建国",
  party_type: "farmer",
  id_card_no: "330104197203054419",
  variety_id: 1,
  variety_code: "YG",
  variety_name: "晚粳稻",
  grade: "二等",
  warehouse_id: 2,
  warehouse_name: "3 号平房仓",
  slot_id: 5,
  slot_label: "A 区 2 垛",
  vehicle_no: "浙A·8F2K6",
  driver_name: "周建国",
  gross_weight_01kg: 61234,
  tare_weight_01kg: 15820,
  net_weight_01kg: 45414,
  package_deduct_01kg: 0,
  package_count: 0,
  moisture_deduct_01kg: 1816,
  impurity_deduct_01kg: 908,
  other_deduct_01kg: 0,
  deduct_total_01kg: 2724,
  settlement_weight_01kg: 42690,
  price_fen_per_ton: 286000,
  price_list_id: 12,
  price_override_reason: null,
  goods_amount_fen: 12213340,
  deduction_fee_fen: 0,
  advance_fee_fen: 0,
  payable_amount_fen: 12213340,
  paid_amount_fen: 12213340,
  payment_status: "paid",
  payment_method: "cash",
  weight_source: "scale",
  tare_override_by: null,
  tare_override_reason: "实测皮重 1582.0kg，较最近历史皮重 1450.0kg 偏差 +9.1%，超出容差 3.00%",
  is_manual_pricing: 0,
  reversed_order_id: null,
  reverse_of_id: null,
  qc_report_id: 551,
  registered_by: 2,
  registered_at: "2026-09-12T08:42:10+08:00",
  gross_at: "2026-09-12T08:40:02+08:00",
  tare_at: "2026-09-12T08:51:33+08:00",
  qc_at: "2026-09-12T08:47:15+08:00",
  settled_at: "2026-09-12T09:02:41+08:00",
  paid_at: "2026-09-12T09:03:05+08:00",
  voided_at: null,
  void_reason: null,
  weigher_id: 3,
  inspector_id: 4,
  keeper_id: null,
  remark: "农户自带编织袋，已当面点清。",
  created_at: "2026-09-12T08:42:10+08:00",
};

const SAMPLE_QC: QcReport = {
  id: 551,
  report_no: "01202609000402",
  order_id: 1024,
  order_no: "01202609000317",
  party_name: "周建国",
  sample_no: "YP0120260912000001",
  variety_id: 1,
  grade: "二等",
  decision: "accept",
  reject_reason: null,
  moisture_deduct_01kg: 1816,
  impurity_deduct_01kg: 908,
  test_method: "nir",
  is_recheck: 0,
  first_report_id: null,
  is_effective: 1,
  inspector_id: 4,
  inspected_at: "2026-09-12T08:47:15+08:00",
  retention_no: "LY0120260912000001",
  retention_until: "2027-03-12",
  indicators: [
    { code: "moisture", name: "水分", value_num: 1400, value_text: null, unit: "0.01pct", std_value: 1400, over_std: 0, sort_order: 1 },
    { code: "impurity", name: "杂质", value_num: 100, value_text: null, unit: "0.01pct", std_value: 100, over_std: 0, sort_order: 2 },
    { code: "unsound", name: "不完善粒", value_num: 320, value_text: null, unit: "0.01pct", std_value: 500, over_std: 0, sort_order: 3 },
    { code: "bulk_density", name: "容重", value_num: 760, value_text: null, unit: "gL", std_value: 720, over_std: 0, sort_order: 4 },
    { code: "odor", name: "气味", value_num: null, value_text: "正常无异味", unit: "text", std_value: null, over_std: 0, sort_order: 5 },
  ],
  remark: null,
};

const SAMPLE_SETTLEMENT: Settlement = {
  id: 77,
  settle_no: "01202609000009",
  party_id: 88,
  party_name: "周建国",
  business_date: "2026-09-12",
  period_from: "2026-09-12",
  period_to: "2026-09-12",
  order_count: 2,
  total_net_01kg: 90120,
  total_deduct_01kg: 5240,
  total_settle_01kg: 84880,
  total_goods_fen: 24270120,
  total_deduction_fen: 0,
  total_advance_fen: 0,
  payable_fen: 24270120,
  paid_fen: 24270120,
  payment_status: "paid",
  main_method: "cash",
  payee_name: "周建国",
  signed_by_party: 1,
  status: "normal",
  settled_at: "2026-09-12T17:20:09+08:00",
  settler_id: 5,
  orders: [
    { order_id: 1024, order_no: "01202609000317", goods_amount_fen: 12213340, price_fen_per_ton: 286000, settlement_weight_01kg: 42690, seq: 1 },
    { order_id: 1025, order_no: "01202609000335", goods_amount_fen: 12056780, price_fen_per_ton: 284000, settlement_weight_01kg: 42190, seq: 2 },
  ],
  remark: null,
};

const SAMPLE_PAYMENT: PaymentRecord = {
  id: 905,
  pay_no: "01202609000121",
  settlement_id: 77,
  settle_no: "01202609000009",
  order_id: null,
  order_no: null,
  party_id: 88,
  party_name: "周建国",
  amount_fen: 24270120,
  method: "cash",
  trade_no: null,
  payee_name: "周建国",
  paid_at: "2026-09-12T17:21:33+08:00",
  operator_id: 5,
  voucher_no: "PZ-20260912-121",
  reversed: 0,
  remark: "当日两单合并付清",
};

const SAMPLE_OUTBOUND: OutboundDetail = {
  id: 906,
  order_no: "01202609000003",
  business_date: "2026-09-12",
  kind: "sale",
  status: "done",
  party_id: 61,
  party_name: "宏达面粉厂",
  counterparty_label: null,
  variety_id: 2,
  variety_name: "小麦",
  grade: "二等",
  warehouse_id: 3,
  warehouse_name: "2号平房仓",
  slot_id: 7,
  slot_label: "C01-02",
  vehicle_no: "豫PA2317",
  net_weight_01kg: 184000,
  weight_source: "scale",
  gross_weight_01kg: 250000,
  tare_weight_01kg: 66000,
  price_fen_per_ton: 268000,
  goods_amount_fen: 4931200,
  payment_status: "unpaid",
  stock_warning: null,
  void_reason: null,
  remark: "凭本单出大门",
  created_at: "2026-09-12T09:12:00+08:00",
  created_by: 2,
  created_name: "李红（登记）",
  completed_at: "2026-09-12T10:41:00+08:00",
  completed_by: 1,
  completed_name: "张伟（站长）",
  updated_at: "2026-09-12T10:41:00+08:00",
  movements: [],
  records: [],
  prints: [],
};

const SAMPLE_LEDGER: LedgerRow[] = [
  {
    seq: 1, business_date: "2026-09-12", order_no: "01202609000317", party_name: "周建国", party_type: "farmer",
    id_card_no: "330104197203054419", party_id: 1, address: "城东村 3 组", variety_name: "晚粳稻", grade: "二等", vehicle_no: "浙A·8F2K6",
    warehouse_name: "3 号平房仓", gross_weight_01kg: 61234, tare_weight_01kg: 15820, net_weight_01kg: 45414,
    deduct_total_01kg: 2724, settlement_weight_01kg: 42690, moisture_001pct: 1400, impurity_001pct: 100,
    price_fen_per_ton: 286000, goods_amount_fen: 12213340, deduction_fee_fen: 0, payable_amount_fen: 12213340,
    paid_amount_fen: 12213340, credit_amount_fen: 0, payment_method: "cash", weight_source: "scale",
    weigher_name: "王强", inspector_name: "陈敏", settled: true,
  },
  {
    seq: 2, business_date: "2026-09-12", order_no: "01202609000335", party_name: "周建国", party_type: "farmer",
    id_card_no: "330104197203054419", party_id: 1, address: "城东村 3 组", variety_name: "晚粳稻", grade: "二等", vehicle_no: "浙A·8F2K6",
    warehouse_name: "3 号平房仓", gross_weight_01kg: 60410, tare_weight_01kg: 15820, net_weight_01kg: 44590,
    deduct_total_01kg: 2510, settlement_weight_01kg: 42190, moisture_001pct: 1410, impurity_001pct: 100,
    price_fen_per_ton: 284000, goods_amount_fen: 12056780, deduction_fee_fen: 0, payable_amount_fen: 12056780,
    paid_amount_fen: 12056780, credit_amount_fen: 0, payment_method: "cash", weight_source: "scale",
    weigher_name: "王强", inspector_name: "陈敏", settled: true,
  },
  {
    seq: 3, business_date: "2026-09-12", order_no: "01202609000340", party_name: "绿源合作社", party_type: "cooperative",
    id_card_no: "91330100MA2XXXXXX4", party_id: 2, address: "工业园 9 号", variety_name: "小麦", grade: "一等", vehicle_no: "浙B·6T9L1",
    warehouse_name: "立筒仓", gross_weight_01kg: 48900, tare_weight_01kg: 17200, net_weight_01kg: 31700,
    deduct_total_01kg: 1200, settlement_weight_01kg: 30500, moisture_001pct: 1250, impurity_001pct: 80,
    price_fen_per_ton: 272000, goods_amount_fen: 8296000, deduction_fee_fen: 0, payable_amount_fen: 8296000,
    paid_amount_fen: 5000000, credit_amount_fen: 3296000, payment_method: "transfer", weight_source: "scale",
    weigher_name: "王强", inspector_name: "陈敏", settled: true,
  },
];

const SAMPLE_DAILY: DailyReport = {
  date: "2026-09-12",
  rows: [
    {
      variety_name: "晚粳稻", variety_code: "YG", orders: 42, parties: 31, gross_01kg: 2560000, tare_01kg: 680000,
      net_01kg: 1880000, deduct_01kg: 112000, settle_01kg: 1768000, goods_fen: 505920000, deduction_fee_fen: 0,
      payable_fen: 505920000, paid_fen: 498200000, credit_fen: 7720000, avg_moisture_001pct: 1380, manual_count: 2, reject_count: 1,
    },
    {
      variety_name: "小麦", variety_code: "XM", orders: 18, parties: 12, gross_01kg: 980000, tare_01kg: 312000,
      net_01kg: 668000, deduct_01kg: 26000, settle_01kg: 642000, goods_fen: 174624000, deduction_fee_fen: 0,
      payable_fen: 174624000, paid_fen: 174624000, credit_fen: 0, avg_moisture_001pct: 1260, manual_count: 0, reject_count: 0,
    },
  ],
  total: {
    orders: 60, parties: 43, net_01kg: 2548000, settle_01kg: 2410000, goods_fen: 680544000, payable_fen: 680544000,
    paid_fen: 672824000, credit_fen: 7720000,
  },
  prevDayNet_01kg: 2390000,
  lastWeekNet_01kg: 2610000,
};

/* ----------------------------------------------------------------- 工具函数 */

function mk(key: string, label: string, group: string, kind: FieldDef["kind"]): FieldDef {
  return { key, label, group, kind };
}

function indicatorValue(qc: QcReport | null | undefined, code: string): number | null {
  return qc?.indicators.find((i) => i.code === code)?.value_num ?? null;
}

/* ----------------------------------------------------------- 场景 1：过磅单 */

/**
 * 票面「结算前 / 结算后」两种读法：结算后印磅单上落定的值，结算前印预估值并**一律挂上「（预估）」**。
 *
 * 02 §F1.4 允许码单印预估应付，但明写"必须标明是预估"——票是给客户看的，不标清楚就是拿一个
 * 还没算定的数当承诺。后缀挂在**值本身**上而不是靠票面某处的一句说明：说明可以被模板编辑器删掉，
 * 后缀删不掉，客户手里的那张纸永远自证。
 *
 * 判据用 `payable_amount_fen` 是否为 null（结算那一条 UPDATE 会连它一起写），与
 * `settlePreview` 里"磅单还没记＝未结算"读的是同一件事。
 */
const EST_SUFFIX = "（预估）";
function settledOrPreview(o: WeighOrder, qc: QcReport | null | undefined, settled: string, preview: (p: SettlePreview) => string): string {
  if (o.payable_amount_fen != null) return settled;
  const p = settlePreview(o, qc);
  return p == null ? settled : `${preview(p)}${EST_SUFFIX}`;
}

const WEIGH_FIELDS: FieldDef[] = [
  mk("party_name", "售粮人", "售粮人", "text"),
  mk("id_card_masked", "身份证号(脱敏)", "售粮人", "text"),
  mk("party_type_label", "身份", "售粮人", "enum"),
  mk("vehicle_no", "车牌", "车辆", "text"),
  mk("driver_name", "驾驶员", "车辆", "text"),
  mk("variety_name", "品种", "品种等级", "text"),
  mk("grade", "等级(业务)", "品种等级", "enum"),
  mk("grade_from_qc", "等级(化验)", "品种等级", "enum"),
  mk("moisture_pct", "水分", "品种等级", "percent"),
  mk("impurity_pct", "杂质", "品种等级", "percent"),
  mk("warehouse", "仓房/货位", "仓储状态", "text"),
  mk("status_label", "状态", "仓储状态", "enum"),
  mk("weight_source_label", "称重方式", "仓储状态", "enum"),
  mk("gross_weight", "毛重", "重量明细", "weight"),
  mk("tare_weight", "皮重", "重量明细", "weight"),
  mk("net_weight", "净重", "重量明细", "weight"),
  mk("package_deduct", "袋重扣量", "重量明细", "weight"),
  mk("moisture_deduct", "扣水", "重量明细", "weight"),
  mk("impurity_deduct", "扣杂", "重量明细", "weight"),
  mk("other_deduct", "其他扣", "重量明细", "weight"),
  mk("deduct_total", "扣重合计", "重量明细", "weight"),
  mk("settlement_weight", "结算重量", "重量明细", "weight"),
  mk("settlement_weight_ton", "结算重量(吨)", "重量明细", "ton"),
  // 皮重偏差超容差的醒目提醒：捕获不被拦下，但票面必须印得出来（迎检与事后核对都看这一栏）
  mk("tare_warning", "皮重警示", "重量明细", "text"),
  mk("price_per_kg", "单价(元/公斤)", "金额", "money"),
  mk("goods_amount", "粮款", "金额", "money"),
  mk("deduction_fee", "扣款", "金额", "money"),
  mk("advance_fee", "预付款", "金额", "money"),
  mk("payable_amount", "应付", "金额", "money"),
  mk("paid_amount", "已付", "金额", "money"),
  mk("payable_upper", "应付大写", "金额", "text"),
  mk("payment_status_label", "付款状态", "金额", "enum"),
  mk("payment_method_label", "付款方式", "金额", "enum"),
  mk("price_override_reason", "改价原因", "金额", "text"),
  mk("registered_at", "制单时间", "时间线", "datetime"),
  mk("gross_at", "毛重时间", "时间线", "datetime"),
  mk("tare_at", "皮重时间", "时间线", "datetime"),
  mk("qc_at", "化验时间", "时间线", "datetime"),
  mk("settled_at", "结算时间", "时间线", "datetime"),
  mk("paid_at", "付款时间", "时间线", "datetime"),
  mk("weigher", "磅员", "署名", "text"),
  mk("inspector", "化验员", "署名", "text"),
  mk("registered_by_label", "登记/结算员", "署名", "text"),
  mk("remark", "备注", "署名", "text"),
  // 不是给人读的一栏：码单右下角那个码的内容，结算窗口扫它定位本单（02 §F1.4 先打票后集中结算）。
  // 本版的载荷就是票面那行单号本体，一位前缀都不加——所以这串与票面「单号」逐字相同，
  // 码磨花了照字敲也进得了窗口（字段键仍叫 ticket_code：存量自定义模板按它取值，改名等于让那些票打空码）
  mk("ticket_code", "凭票码载荷（＝单号）", "凭据", "text"),
];

const WEIGH_GROUPS = ["售粮人", "车辆", "品种等级", "仓储状态", "重量明细", "金额", "时间线", "署名", "凭据"];

/* ----------------------------------------------------------- 场景 2：质检单 */

const QC_FIELDS: FieldDef[] = [
  mk("order_no", "对应磅单", "基本信息", "text"),
  mk("party_name", "售粮人", "基本信息", "text"),
  mk("sample_no", "样品号", "基本信息", "text"),
  mk("test_method_label", "检测方法", "基本信息", "enum"),
  mk("grade", "等级", "判定", "enum"),
  mk("decision_label", "判定", "判定", "enum"),
  mk("moisture_deduct", "扣水", "判定", "weight"),
  mk("impurity_deduct", "扣杂", "判定", "weight"),
  mk("reject_reason", "拒收原因", "判定", "text"),
  mk("retention_no", "留样号", "留样", "text"),
  mk("retention_until", "留样至", "留样", "text"),
  mk("is_recheck", "是否复检", "留样", "enum"),
  mk("inspector", "化验员", "署名", "text"),
  mk("weigher", "司磅员确认", "署名", "text"),
];

const QC_TABLES: ScenarioSpec["tables"] = [
  {
    dataset: "indicators",
    label: "质检指标",
    columns: [
      { key: "name", label: "指标", kind: "text" },
      { key: "value", label: "实测", kind: "text" },
      { key: "std", label: "国标基准", kind: "text" },
      { key: "over", label: "比较", kind: "enum" },
      { key: "note", label: "说明", kind: "text" },
    ],
  },
];

/* ------------------------------------------------------- 场景 3：结算凭证 */

const SETTLE_FIELDS: FieldDef[] = [
  mk("payee_name", "收款人", "基本信息", "text"),
  mk("period", "覆盖期间", "基本信息", "text"),
  mk("order_count", "磅单数", "基本信息", "enum"),
  mk("status_label", "状态", "基本信息", "enum"),
  // 本版的结算凭证**不打码**（02 §F1.4：磅房作业只认磅单码）。顶栏这里从前是 `settle_code`
  // （凭单二维码载荷），撤它不是嫌它难看：扫结算凭证核销那条入口已经没了，这张纸上的码没有
  // 任何东西会去扫，而它装的又是与磅单同形的纯数字号——留着就是"扫错一张纸、结错一笔钱"的口子。
  // 号照旧要印，而且要明文一行：财务入账、客户回头对账、窗口按号查都靠它。
  mk("settle_no", "结算单号", "基本信息", "text"),
  mk("total_goods", "粮款合计", "金额", "money"),
  mk("total_deduction", "扣款合计", "金额", "money"),
  mk("payable", "应付合计", "金额", "money"),
  mk("paid", "已付合计", "金额", "money"),
  mk("unpaid", "未付合计", "金额", "money"),
  mk("payable_upper", "应付大写", "金额", "text"),
  mk("main_method_label", "付款方式", "金额", "enum"),
  mk("settler", "结算员", "署名", "text"),
  mk("settled_at", "结算时间", "时间线", "datetime"),
];

const SETTLE_TABLES: ScenarioSpec["tables"] = [
  {
    dataset: "orders",
    label: "结算磅单明细",
    columns: [
      { key: "order_no", label: "磅单号", kind: "text" },
      { key: "settlement_weight", label: "结算重量", kind: "weight" },
      { key: "price", label: "单价", kind: "money" },
      { key: "goods_amount", label: "金额", kind: "money" },
    ],
  },
];

/* ------------------------------------------------------- 场景 4：付款小票 */

const PAY_FIELDS: FieldDef[] = [
  mk("pay_no", "付款流水号", "基本信息", "text"),
  mk("paid_at", "付款时间", "基本信息", "datetime"),
  mk("party_name", "收款人", "基本信息", "text"),
  mk("method_label", "付款方式", "基本信息", "enum"),
  mk("trade_no", "交易流水", "关联", "text"),
  mk("voucher_no", "凭证号", "关联", "text"),
  mk("settle_no", "结算单号", "关联", "text"),
  mk("order_no", "磅单号", "关联", "text"),
  mk("amount", "金额", "金额", "money"),
  mk("amount_upper", "金额大写", "金额", "text"),
  mk("operator", "经手人", "署名", "text"),
  mk("reversed_label", "状态", "署名", "enum"),
];

/* ----------------------------------------------------------- 场景 5：台账 */

const LEDGER_TABLES: ScenarioSpec["tables"] = [
  {
    dataset: "ledgerRows",
    label: "台账明细行",
    columns: [
      { key: "business_date", label: "业务日期", kind: "text" },
      { key: "order_no", label: "磅单号", kind: "text" },
      { key: "party_name", label: "售粮人", kind: "text" },
      { key: "variety_name", label: "品种", kind: "text" },
      { key: "net", label: "净重", kind: "weight" },
      { key: "payable", label: "应付", kind: "money" },
      { key: "paid", label: "已付", kind: "money" },
      { key: "weigher", label: "磅员", kind: "text" },
    ],
  },
];

const LEDGER_FIELDS: FieldDef[] = [
  mk("period", "统计期间", "汇总", "text"),
  mk("row_count", "台账行数", "汇总", "enum"),
  mk("sum_net", "净重合计", "汇总", "weight"),
  mk("sum_settle", "结算重量合计", "汇总", "weight"),
  mk("sum_goods", "粮款合计", "汇总", "money"),
  mk("sum_payable", "应付合计", "汇总", "money"),
  mk("sum_paid", "已付合计", "汇总", "money"),
  mk("sum_credit", "未付合计", "汇总", "money"),
];

/* ----------------------------------------------------------- 场景 6：日报 */

const DAILY_TABLES: ScenarioSpec["tables"] = [
  {
    dataset: "dailyVariety",
    label: "分品种日报",
    columns: [
      { key: "variety_name", label: "品种", kind: "text" },
      { key: "orders", label: "单数", kind: "enum" },
      { key: "net", label: "净重", kind: "weight" },
      { key: "goods", label: "粮款", kind: "money" },
      { key: "payable", label: "应付", kind: "money" },
      { key: "paid", label: "已付", kind: "money" },
      { key: "credit", label: "挂账", kind: "money" },
      { key: "manual", label: "手录", kind: "enum" },
      { key: "reject", label: "拒收", kind: "enum" },
    ],
  },
];

const DAILY_FIELDS: FieldDef[] = [
  mk("date", "业务日期", "汇总", "text"),
  mk("orders", "单数", "汇总", "enum"),
  mk("parties", "售粮人数", "汇总", "enum"),
  mk("net", "净重合计", "汇总", "weight"),
  mk("settle", "结算重量合计", "汇总", "weight"),
  mk("goods", "粮款合计", "汇总", "money"),
  mk("payable", "应付合计", "汇总", "money"),
  mk("paid", "已付合计", "汇总", "money"),
  mk("credit", "挂账合计", "汇总", "money"),
];

/* ------------------------------------------------------ 场景 7：出库码单 */

const OUTBOUND_FIELDS: FieldDef[] = [
  mk("order_no", "出库单号", "基本信息", "text"),
  mk("business_date", "业务日期", "基本信息", "text"),
  mk("kind_label", "出库性质", "基本信息", "enum"),
  mk("status_label", "单据状态", "基本信息", "enum"),
  mk("party_name", "领出方", "基本信息", "text"),
  mk("counterparty_label", "领用方 / 用途", "基本信息", "text"),
  mk("variety_name", "品种", "基本信息", "text"),
  mk("grade", "等级", "基本信息", "text"),
  mk("warehouse", "出仓仓房 / 货位", "基本信息", "text"),
  mk("vehicle_no", "车牌", "基本信息", "text"),
  mk("stock_warning", "超库存警示", "基本信息", "text"),
  mk("gross_weight", "毛重", "重量", "weight"),
  mk("tare_weight", "皮重", "重量", "weight"),
  mk("net_weight", "出库净重", "重量", "weight"),
  mk("net_weight_ton", "出库净重（吨）", "重量", "ton"),
  mk("weight_source_label", "重量来源", "重量", "enum"),
  mk("weigh_note", "称重说明", "重量", "text"),
  mk("price_per_kg", "单价", "金额", "money"),
  mk("goods_amount", "货款", "金额", "money"),
  mk("goods_amount_upper", "货款大写", "金额", "text"),
  mk("payment_status_label", "付款状态", "金额", "enum"),
  mk("created_name", "制单人", "署名", "text"),
  mk("created_at", "制单时间", "署名", "datetime"),
  mk("completed_name", "值仓确认", "署名", "text"),
  mk("completed_at", "完成出库时间", "署名", "datetime"),
  mk("remark", "备注", "署名", "text"),
  mk("ticket_code", "票面码（= 单号）", "基本信息", "text"),
];

/* ----------------------------------------------------------- 解析器实现 */

const WEIGH_SPEC: ScenarioSpec = {
  id: "weigh_order",
  label: "收购过磅单",
  entry: "工作台过磅完成 / 磅单详情 / 快捷详情",
  fields: WEIGH_FIELDS,
  groups: WEIGH_GROUPS,
  sampleContext: () => ({ station: SAMPLE_STATION, names: sampleNames, order: SAMPLE_ORDER, qc: SAMPLE_QC }),
  resolveField: (key, ctx) => {
    const o = ctx.order;
    if (!o) return "—";
    const qc = ctx.qc;
    switch (key) {
      case "party_name": return o.party_name;
      case "id_card_masked": return maskIdCard(o.id_card_no);
      case "party_type_label": return PARTY_TYPE[o.party_type];
      case "vehicle_no": return o.vehicle_no ?? "—";
      case "driver_name": return o.driver_name ?? "—";
      case "variety_name": return varietyLabel(o.variety_name);
      case "grade": return o.grade ?? "未定级";
      case "grade_from_qc": return qc?.grade ?? "未化验";
      case "moisture_pct": return percent(indicatorValue(qc, "moisture"));
      case "impurity_pct": return percent(indicatorValue(qc, "impurity"));
      case "warehouse": return `${o.warehouse_name ?? "—"}${o.slot_label ? ` / ${o.slot_label}` : ""}`;
      case "status_label": return ORDER_STATUS[o.status].label;
      case "weight_source_label": return o.weight_source === "scale" ? "地磅读数" : "人工手录";
      // 超容差皮重：捕获仍有效，但票面必须把提醒印出来（与详情页醒目条同源，读 tare_override_reason）
      case "tare_warning": return o.tare_override_reason ?? "—";
      case "gross_weight": return weight(o.gross_weight_01kg);
      case "tare_weight": return weight(o.tare_weight_01kg);
      case "net_weight": return weight(o.net_weight_01kg);
      // 袋重与其他扣没有第二个来源（结算那一刻由人当场填），票面照磅单现值印，不标预估
      case "package_deduct": return weight(o.package_deduct_01kg);
      // 扣水/扣杂在未结算时磅单那两列还是 0，而真实会扣的是**化验建议**（`settleDefaults` 的
      // 兜底顺序就是"磅单值优先、化验建议其次"）。若不印化验建议，票面会出现"扣水 0.0kg
      // 却按 12.5kg 扣了钱"——预估应付与扣重栏当场自相矛盾，所以整组一起走预估。
      case "moisture_deduct": return settledOrPreview(o, qc, weight(o.moisture_deduct_01kg), (p) => weight(p.moisture_deduct_01kg));
      case "impurity_deduct": return settledOrPreview(o, qc, weight(o.impurity_deduct_01kg), (p) => weight(p.impurity_deduct_01kg));
      case "other_deduct": return weight(o.other_deduct_01kg);
      case "deduct_total": return settledOrPreview(o, qc, weight(o.deduct_total_01kg), (p) => weight(p.deduct_total_01kg));
      case "settlement_weight": return settledOrPreview(o, qc, weight(o.settlement_weight_01kg), (p) => weight(p.settlement_weight_01kg));
      case "settlement_weight_ton": return settledOrPreview(o, qc, ton(o.settlement_weight_01kg), (p) => ton(p.settlement_weight_01kg));
      // 单价是**确定值**：制单那一刻就按价目表落过价，磅房事后改的也落在这同一列上
      // （见 `orders.rs::create_order` / `set_price`）。所以票面这一栏不再是"—"。
      case "price_per_kg": return price(o.price_fen_per_ton);
      case "goods_amount": return settledOrPreview(o, qc, money(o.goods_amount_fen), (p) => money(p.goods_amount_fen));
      case "deduction_fee": return money(o.deduction_fee_fen);
      case "advance_fee": return money(o.advance_fee_fen);
      case "payable_amount": return settledOrPreview(o, qc, money(o.payable_amount_fen), (p) => money(p.payable_amount_fen));
      case "paid_amount": return money(o.paid_amount_fen);
      case "payable_upper": return settledOrPreview(o, qc, rmbUpper(o.payable_amount_fen), (p) => rmbUpper(p.payable_amount_fen));
      // 未结算的单印"无需付款"是错的（客户正是要来领钱）；它此刻的真实状态就是"待结算"
      case "payment_status_label": return o.payable_amount_fen == null ? "待结算" : PAYMENT_STATUS[o.payment_status].label;
      case "payment_method_label": return o.payment_method ? PAYMENT_METHOD[o.payment_method] : "—";
      case "price_override_reason": return o.price_override_reason ?? "—";
      case "registered_at": return dateTime(o.registered_at);
      case "gross_at": return dateTime(o.gross_at);
      case "tare_at": return dateTime(o.tare_at);
      case "qc_at": return dateTime(o.qc_at);
      case "settled_at": return dateTime(o.settled_at);
      case "paid_at": return dateTime(o.paid_at);
      case "weigher": return ctx.names(o.weigher_id);
      case "inspector": return ctx.names(o.inspector_id);
      case "registered_by_label": return ctx.names(o.registered_by);
      case "remark": return o.remark ?? "—";
      // 载荷就是本单的单号，一字不加（02 §F1.4 本版契约）：票面那行「单号」与右下角的码是同一串。
      // 金额、扣量、证号照旧不进码——票先打、价后算，金额进码等于允许客户自己改价
      case "ticket_code": return encodeOrderCode(o.order_no);
      default: return "—";
    }
  },
};

const QC_SPEC: ScenarioSpec = {
  id: "quality_report",
  label: "质检单",
  entry: "化验完成 / 质检详情 / 快捷详情",
  fields: QC_FIELDS,
  groups: ["基本信息", "判定", "留样", "署名"],
  tables: QC_TABLES,
  sampleContext: () => ({ station: SAMPLE_STATION, names: sampleNames, qc: SAMPLE_QC, order: SAMPLE_ORDER }),
  resolveField: (key, ctx) => {
    const r = ctx.qc;
    if (!r) return "—";
    switch (key) {
      case "order_no": return r.order_no;
      case "party_name": return r.party_name;
      case "sample_no": return r.sample_no;
      case "test_method_label": return TEST_METHOD[r.test_method];
      case "grade": return r.grade ? (GRADES.includes(r.grade) ? r.grade : "—") : "未定级";
      case "decision_label": return QC_DECISION[r.decision].label;
      case "moisture_deduct": return weight(r.moisture_deduct_01kg);
      case "impurity_deduct": return weight(r.impurity_deduct_01kg);
      case "reject_reason": return r.reject_reason ?? "—";
      case "retention_no": return r.retention_no ?? "—";
      case "retention_until": return r.retention_until ?? "—";
      case "is_recheck": return r.is_recheck ? "复检单" : "首检";
      case "inspector": return ctx.names(r.inspector_id);
      case "weigher": return ctx.names(r.order_id ? ctx.order?.weigher_id : null);
      default: return "—";
    }
  },
  tableRows: (dataset, ctx) => {
    if (dataset !== "indicators" || !ctx.qc) return [];
    return ctx.qc.indicators.map((it) => {
      const meta = it.std_value;
      return {
        name: it.name,
        value: it.unit === "text" ? (it.value_text ?? "—") : percent(it.value_num),
        std: meta == null ? "—" : percent(meta),
        over: it.over_std === 1 ? (it.unit === "gL" ? "↓ 低" : "↑ 超") : "合格",
        note: it.code === "odor" ? (it.value_text ?? "—") : "按 GB 2715 限量",
      } satisfies Record<string, ReactNode>;
    });
  },
};

const SETTLE_SPEC: ScenarioSpec = {
  id: "settlement_voucher",
  label: "结算凭证",
  entry: "结算单生成 / 结算单详情",
  fields: SETTLE_FIELDS,
  groups: ["基本信息", "金额", "署名", "时间线"],
  tables: SETTLE_TABLES,
  sampleContext: () => ({ station: SAMPLE_STATION, names: sampleNames, settlement: SAMPLE_SETTLEMENT }),
  resolveField: (key, ctx) => {
    const s = ctx.settlement;
    if (!s) return "—";
    switch (key) {
      case "payee_name": return s.payee_name;
      case "period": return `${s.period_from} 至 ${s.period_to}`;
      case "order_count": return `${s.order_count} 张`;
      case "status_label": return s.payment_status === "paid" ? "已付清" : s.payment_status === "partial" ? "部分付款" : "未付款";
      // 结算凭证不再打码（02 §F1.4：磅房只认磅单码），号本体照旧由票头明文印一行。
      // 从前这里是 `settle_code`：把种类写进载荷第 2 位给窗口分"来结算的"与"来付尾款的"——
      // 那条扫码核销的路撤了，载荷里就没有种类可写，留着只会打出一串与磅单同形的废码
      case "settle_no": return s.settle_no;
      case "total_goods": return money(s.total_goods_fen);
      case "total_deduction": return money(s.total_deduction_fen);
      case "payable": return money(s.payable_fen);
      case "paid": return money(s.paid_fen);
      case "unpaid": return money(s.payable_fen - s.paid_fen);
      case "payable_upper": return rmbUpper(s.payable_fen);
      case "main_method_label": return s.main_method ? PAYMENT_METHOD[s.main_method] : "挂账";
      case "settler": return ctx.names(s.settler_id);
      case "settled_at": return dateTime(s.settled_at);
      default: return "—";
    }
  },
  tableRows: (dataset, ctx) => {
    if (dataset !== "orders" || !ctx.settlement) return [];
    return ctx.settlement.orders.map((o) => ({
      order_no: o.order_no,
      settlement_weight: weight(o.settlement_weight_01kg),
      price: price(o.price_fen_per_ton),
      goods_amount: money(o.goods_amount_fen),
    }));
  },
};

const PAY_SPEC: ScenarioSpec = {
  id: "payment_receipt",
  label: "付款小票",
  entry: "出纳登记付款 / 付款与挂账页",
  fields: PAY_FIELDS,
  groups: ["基本信息", "关联", "金额", "署名"],
  sampleContext: () => ({ station: SAMPLE_STATION, names: sampleNames, payment: SAMPLE_PAYMENT, settlement: SAMPLE_SETTLEMENT }),
  resolveField: (key, ctx) => {
    const p = ctx.payment;
    if (!p) return "—";
    switch (key) {
      case "pay_no": return p.pay_no;
      case "paid_at": return dateTime(p.paid_at);
      case "party_name": return p.party_name;
      case "method_label": return PAYMENT_METHOD[p.method];
      case "trade_no": return p.trade_no ?? "—";
      case "voucher_no": return p.voucher_no ?? "—";
      case "settle_no": return p.settle_no ?? "—";
      case "order_no": return p.order_no ?? "—";
      case "amount": return money(p.amount_fen);
      case "amount_upper": return rmbUpper(p.amount_fen);
      case "operator": return ctx.names(p.operator_id);
      case "reversed_label": return p.reversed === 1 ? "已冲销" : "有效";
      default: return "—";
    }
  },
};

const OUTBOUND_SPEC: ScenarioSpec = {
  id: "outbound_order",
  label: "出库码单",
  entry: "出库单详情「打印码单」/ 完成出库后补打",
  fields: OUTBOUND_FIELDS,
  groups: ["基本信息", "重量", "金额", "署名"],
  sampleContext: () => ({ station: SAMPLE_STATION, names: sampleNames, outbound: SAMPLE_OUTBOUND }),
  resolveField: (key, ctx) => {
    const o = ctx.outbound;
    if (!o) return "—";
    switch (key) {
      case "order_no": return o.order_no;
      case "business_date": return o.business_date;
      case "kind_label": return OUTBOUND_KIND[o.kind].label;
      case "status_label": return OUTBOUND_STATUS[o.status].label;
      case "party_name": return o.party_name ?? "—";
      case "counterparty_label": return o.counterparty_label ?? "—";
      case "variety_name": return varietyLabel(o.variety_name);
      case "grade": return o.grade ?? "未定级";
      case "warehouse": return `${o.warehouse_name}${o.slot_label ? ` / ${o.slot_label}` : ""}`;
      case "vehicle_no": return o.vehicle_no ?? "—";
      // 超库存不拦车（03 §9.28），但这句话必须跟着粮出门：账面不够这一格是服务端复算写进去的，
      // 票上印出来，事后对账的人才知道这一车出的是"未结算入仓量不算数"的那部分
      case "stock_warning": return o.stock_warning ?? "—";
      case "gross_weight": return o.gross_weight_01kg == null ? "—" : weight(o.gross_weight_01kg);
      case "tare_weight": return o.tare_weight_01kg == null ? "—" : weight(o.tare_weight_01kg);
      case "net_weight": return o.net_weight_01kg == null ? "—" : weight(o.net_weight_01kg);
      case "net_weight_ton": return o.net_weight_01kg == null ? "—" : ton(o.net_weight_01kg);
      case "weight_source_label": return o.weight_source === "scale" ? "地磅读数" : "人工手录";
      // 「这重量怎么来的」整句给迎检看：两次称重 / 只称了一项 / 压根没上磅，三种情形分开说
      case "weigh_note": {
        const n = (o.records ?? []).length;
        if (o.gross_weight_01kg != null && o.tare_weight_01kg != null) {
          return `净重 = 毛重 − 皮重，来源${o.weight_source === "scale" ? "地磅" : "手录"}${n > 2 ? `；共称重 ${n} 次（含复称）` : ""}`;
        }
        if (o.gross_weight_01kg != null || o.tare_weight_01kg != null) return "只称了一项，净重仍是先前填写的数";
        return n ? `共称重 ${n} 次` : "未过磅，净重为人工填写";
      }
      case "price_per_kg": return price(o.price_fen_per_ton);
      case "goods_amount": return o.goods_amount_fen == null ? "—" : money(o.goods_amount_fen);
      // 登记出库不计价（票面就该空着，不是 0 元）；销售出库的大写与磅单同一份实现
      case "goods_amount_upper": return o.goods_amount_fen == null ? "—" : rmbUpper(o.goods_amount_fen);
      case "payment_status_label": return PAYMENT_STATUS[o.payment_status].label;
      case "created_name": return o.created_name;
      case "created_at": return dateTime(o.created_at);
      case "completed_name": return o.completed_name ?? "—";
      case "completed_at": return o.completed_at ? dateTime(o.completed_at) : "—";
      case "remark": return o.remark ?? "—";
      // 载荷就是本单的单号，一字不加——与磅单那枚码同一条契约（本文件顶部那份）。
      // 出库这张纸的码只用来**定位这张单**（扫进任意检索框查到它），不进结算窗口那条路：
      // 结算框只认磅单（`settleable()`），出库的收款核销是波 3 的事。
      case "ticket_code": return encodeTicketCode(o.order_no);
      default: return "—";
    }
  },
};

const LEDGER_SPEC: ScenarioSpec = {
  id: "ledger",
  label: "收购明细台账",
  entry: "报表中心 → 收购明细台账打印",
  fields: LEDGER_FIELDS,
  groups: ["汇总"],
  tables: LEDGER_TABLES,
  sampleContext: () => ({ station: SAMPLE_STATION, names: sampleNames, ledgerRows: SAMPLE_LEDGER }),
  resolveField: (key, ctx) => {
    const rows = ctx.ledgerRows ?? [];
    const sum = (f: (r: LedgerRow) => number) => rows.reduce((n, r) => n + f(r), 0);
    switch (key) {
      case "period": return rows.length ? `${rows[0].business_date} 起` : "—";
      case "row_count": return `${rows.length} 行`;
      case "sum_net": return weight(sum((r) => r.net_weight_01kg ?? 0));
      case "sum_settle": return weight(sum((r) => r.settlement_weight_01kg ?? 0));
      case "sum_goods": return money(sum((r) => r.goods_amount_fen ?? 0));
      case "sum_payable": return money(sum((r) => r.payable_amount_fen ?? 0));
      case "sum_paid": return money(sum((r) => r.paid_amount_fen ?? 0));
      case "sum_credit": return money(sum((r) => r.credit_amount_fen ?? 0));
      default: return "—";
    }
  },
  tableRows: (dataset, ctx) => {
    if (dataset !== "ledgerRows") return [];
    return (ctx.ledgerRows ?? []).map((r) => ({
      business_date: r.business_date,
      order_no: r.order_no,
      party_name: r.party_name,
      variety_name: r.variety_name,
      net: weight(r.net_weight_01kg),
      payable: money(r.payable_amount_fen),
      paid: money(r.paid_amount_fen),
      weigher: r.weigher_name,
    }));
  },
};

const DAILY_SPEC: ScenarioSpec = {
  id: "daily_report",
  label: "收购日报表",
  entry: "报表中心 → 日报打印",
  fields: DAILY_FIELDS,
  groups: ["汇总"],
  tables: DAILY_TABLES,
  sampleContext: () => ({ station: SAMPLE_STATION, names: sampleNames, daily: SAMPLE_DAILY }),
  resolveField: (key, ctx) => {
    const d = ctx.daily;
    if (!d) return "—";
    const t = d.total;
    switch (key) {
      case "date": return d.date;
      case "orders": return `${t.orders} 单`;
      case "parties": return `${t.parties} 人`;
      case "net": return weight(t.net_01kg);
      case "settle": return weight(t.settle_01kg);
      case "goods": return money(t.goods_fen);
      case "payable": return money(t.payable_fen);
      case "paid": return money(t.paid_fen);
      case "credit": return money(t.credit_fen);
      default: return "—";
    }
  },
  tableRows: (dataset, ctx) => {
    if (dataset !== "dailyVariety" || !ctx.daily) return [];
    return ctx.daily.rows.map((r) => ({
      variety_name: r.variety_name,
      orders: `${r.orders}`,
      net: weight(r.net_01kg),
      goods: money(r.goods_fen),
      payable: money(r.payable_fen),
      paid: money(r.paid_fen),
      credit: money(r.credit_fen),
      manual: `${r.manual_count}`,
      reject: `${r.reject_count}`,
    }));
  },
};

export const SCENARIOS: Record<ReceiptScenario, ScenarioSpec> = {
  weigh_order: WEIGH_SPEC,
  quality_report: QC_SPEC,
  settlement_voucher: SETTLE_SPEC,
  payment_receipt: PAY_SPEC,
  outbound_order: OUTBOUND_SPEC,
  ledger: LEDGER_SPEC,
  daily_report: DAILY_SPEC,
};

/** 触发点清单（规划用）：场景 → 业务入口 */
export const SCENARIO_ENTRIES: { scenario: ReceiptScenario; label: string; entry: string }[] = (
  Object.values(SCENARIOS) as ScenarioSpec[]
).map((s) => ({ scenario: s.id, label: s.label, entry: s.entry }));

export function getSpec(scenario: ReceiptScenario): ScenarioSpec {
  return SCENARIOS[scenario];
}
