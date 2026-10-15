/**
 * Mock 层的 DTO，字段名与 docs/design/03 §9 表结构逐字对齐。
 *
 * 这样做的目的：将来把 `src/mock/api.ts` 换成 `invoke()` 实现时，
 * 页面与组件代码一行都不用改（见 05 文档 §8「lib/api.ts 是唯一出口」）。
 *
 * 数值一律为定点整数（03 §3.1）：`_01kg` / `_fen` / `_fen_per_ton` / `_001pct`。
 */
import type {
  CardStatus,
  DeviceKind,
  DeviceStatus,
  Grade,
  OrderStatus,
  OutboundKind,
  OutboundStatus,
  PartyType,
  PaymentMethod,
  PaymentStatus,
  PrintChannel,
  PaperKind,
  QcDecision,
  QuickOptionKind,
  Role,
  TestMethod,
  Tone,
  WeightSource,
} from "@/lib/constants";

export type ID = number;

export interface Station {
  id: ID;
  code: string;
  name: string;
  address: string;
  phone: string;
}

export interface UserAccount {
  id: ID;
  username: string;
  display_name: string;
  role: Role;
  phone: string;
  is_active: 0 | 1;
  last_login_at: string | null;
}

export interface Party {
  id: ID;
  code: string;
  name: string;
  party_type: PartyType;
  /** 明文只在 mock 层存在；真实实现为密文 + fp，界面上那一格默认掩码、点开走 `party_id_card`（04 §3.3） */
  id_card_no: string;
  id_card_verified: 0 | 1;
  phone: string;
  address: string;
  bank_name: string | null;
  bank_account: string | null;
  credit_limit_fen: number;
  default_warehouse_id: ID | null;
  default_slot_id: ID | null;
  default_vehicle_no: string | null;
  last_tare_01kg: number | null;
  remark: string | null;
  status: "active" | "disabled";
  created_at: string;
  /** 人像照片所挂的附件 id（03 §9.6）。**选填**：null 就是"这张档案没有照片"，不是缺数据 */
  photo_attachment_id: number | null;
}

export interface GrainVariety {
  id: ID;
  code: string;
  name: string;
  category: string;
  /** 五项国标基准在库里可空：种子刻意留 NULL 等现场按标准填（0002_seed 的口径）。
   *  界面一律走 `percent()` / `density()`，没填显示"—"，不能显示成"规定就是 0.00%"。 */
  std_moisture_001pct: number | null;
  std_impurity_001pct: number | null;
  std_unsound_001pct: number | null;
  std_bulk_density: number | null;
  reject_moisture_001pct: number | null;
  enabled_indicators: string[];
  default_package_deduct_01kg: number;
  sort_order: number;
  is_active: 0 | 1;
}

export interface Warehouse {
  id: ID;
  code: string;
  name: string;
  /** 类型与容量都可为 NULL（历史/手工建行），界面显示"—"，合计按 0 计 */
  kind: "house" | "barn" | "shed" | "silo" | null;
  capacity_ton: number | null;
  // ------------------------------------------------ 库存那一格（读自流水，不是 warehouse 列）
  // 判据与 `masters.rs::Warehouse` / `stock::warehouse_totals` 逐字对齐：期初是 §9.23 那笔
  // `is_opening` 入库流水，结存含期初，待入账不并进结存但真实占容积。
  /** 期初建账量（0.1kg）。null＝从没申报过；0 是一句明确的「空仓起账」 */
  opening_01kg: number | null;
  /** 期初登记到哪个品种；null＝没细分（仓房总量照计，按品种的出库账面看不见它） */
  opening_variety_id: number | null;
  /** 账面结存（0.1kg）＝ Σ入 − Σ出，含期初 */
  balance_01kg: number;
  /** 已上磅未结算入账的部分：不计入 balance_01kg */
  pending_in_01kg: number;
  /** 剩余容量（0.1kg）＝ 核定容量 − 结存 − 待入账；容量未核定为 null。负数只是「超容」提示，不拦单 */
  remain_01kg: number | null;
  is_active: 0 | 1;
  slots: StorageSlot[];
}

export interface StorageSlot {
  id: ID;
  warehouse_id: ID;
  code: string;
  /** 库里 label 为空时后端回落成货位编码，界面拿到的永远是可显示的串 */
  label: string;
  is_active: 0 | 1;
}

/**
 * 事由/原因/结论类「自由文本 + 常用下拉」的一条候选（03 §9.27）。
 *
 * 落库仍是自由文本，本表只是给下拉框备一句现成的人话：`label` 是按钮/清单上看的短词，
 * `value` 是点一下真正填进文本框、最终进单据与审计的那句完整话。`kind` 归哪一类由
 * `QuickOptionKind` 白名单约束（不加 CHECK，扩一类只改代码不改表）。
 */
export interface QuickOption {
  id: ID;
  kind: QuickOptionKind;
  label: string;
  value: string;
  sort_order: number;
  is_active: 0 | 1;
}

export interface PriceList {
  id: ID;
  variety_id: ID;
  grade: Grade;
  price_fen_per_ton: number;
  effective_from: string;
  effective_to: string;
  basis: string;
  /** NULL 只可能是直接翻库留下的脏行 */
  made_by: ID | null;
  approved_by: ID | null;
  remark: string | null;
}

export interface WeighRecord {
  id: ID;
  seq: number;
  weigh_type: "gross" | "tare";
  weight_01kg: number;
  aligned_weight_01kg: number;
  is_adopted: 0 | 1;
  adopt_reason: string | null;
  source: WeightSource;
  device_code: string;
  raw_frame: string | null;
  stable: 0 | 1;
  captured_at: string;
  operator_id: ID;
  has_photo: boolean;
}

export interface QcIndicatorRow {
  code: string;
  name: string;
  value_num: number | null;
  value_text: string | null;
  unit: "0.01pct" | "gL" | "text";
  std_value: number | null;
  over_std: 0 | 1;
  sort_order: number;
}

export interface QcReport {
  id: ID;
  report_no: string;
  order_id: ID;
  order_no: string;
  party_name: string;
  sample_no: string;
  variety_id: ID;
  grade: Grade | null;
  decision: QcDecision;
  reject_reason: string | null;
  moisture_deduct_01kg: number;
  impurity_deduct_01kg: number;
  test_method: TestMethod;
  is_recheck: 0 | 1;
  first_report_id: ID | null;
  is_effective: 0 | 1;
  inspector_id: ID;
  inspected_at: string;
  retention_no: string | null;
  retention_until: string | null;
  indicators: QcIndicatorRow[];
  remark: string | null;
}

export interface WeighOrder {
  id: ID;
  order_no: string;
  business_date: string;
  status: OrderStatus;
  party_id: ID;
  party_name: string;
  party_type: PartyType;
  id_card_no: string;
  /**
   * 收购品种：制单起必填（2026-09-14），这一列本身仍可空——存量单、以及事后被
   * `setOrderVariety` 清空的那类都在库里，空值界面一律显「未定品种」。
   * 结算与录化验前必填这两道闸也一条没撤。
   */
  variety_id: ID | null;
  variety_code: string | null;
  variety_name: string | null;
  grade: Grade | null;
  warehouse_id: ID | null;
  warehouse_name: string | null;
  slot_id: ID | null;
  slot_label: string | null;
  /** 当前绑定的流转卡号快照（06 篇）：发卡写、换卡改；占用真相以 card 表为准，可选以免强制后端 DTO 同批改 */
  card_no?: string | null;
  vehicle_no: string | null;
  driver_name: string | null;

  gross_weight_01kg: number | null;
  tare_weight_01kg: number | null;
  net_weight_01kg: number | null;
  package_deduct_01kg: number;
  package_count: number;
  moisture_deduct_01kg: number;
  impurity_deduct_01kg: number;
  other_deduct_01kg: number;
  deduct_total_01kg: number;
  settlement_weight_01kg: number | null;

  price_fen_per_ton: number | null;
  price_list_id: ID | null;
  price_override_reason: string | null;
  goods_amount_fen: number | null;
  deduction_fee_fen: number;
  advance_fee_fen: number;
  payable_amount_fen: number | null;
  paid_amount_fen: number;
  payment_status: PaymentStatus;
  payment_method: PaymentMethod | null;

  weight_source: WeightSource;
  /** 旧「站长授权放行」遗留字段：授权路径移除后恒为 null，仅为兼容老数据保留 */
  tare_override_by: ID | null;
  /** 皮重偏差超容差的警示文案（捕获时自动生成）；null = 未超差 */
  tare_override_reason: string | null;
  is_manual_pricing: 0 | 1;
  reversed_order_id: ID | null;
  reverse_of_id: ID | null;
  qc_report_id: ID | null;

  registered_by: ID;
  registered_at: string;
  gross_at: string | null;
  tare_at: string | null;
  qc_at: string | null;
  settled_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  weigher_id: ID | null;
  inspector_id: ID | null;
  keeper_id: ID | null;
  remark: string | null;
  created_at: string;
  updated_at?: string;

  /** 详情用聚合，列表接口不返回以模拟"按需取" */
  records?: WeighRecord[];
  photos?: CapturePhoto[];
  prints?: PrintLog[];
  timeline?: TimelineEvent[];
}

/** 卡池一行 / 单据侧展示（与 Rust `cards::CardPoolRow` 逐字一致） */
export interface CardPoolRow {
  card_no: string;
  label: string | null;
  status: CardStatus;
  order_no: string | null;
  issued_at: string | null;
  issued_by_name: string | null;
  remark: string | null;
}

export interface CardIssueResult {
  card: CardPoolRow;
  order_no: string;
}

/** 只读定位结果：编排器据此决定这一刷干什么（发卡 / 推进 / 拦下） */
export interface CardLocateResult {
  found: boolean;
  status: CardStatus | "unknown";
  order_no: string | null;
  party_name: string | null;
  order_status: OrderStatus | null;
}

export interface CapturePhoto {
  /** 有图＝attachment.id（读原图按它取）；缺图占位格＝ -称重记录 id（负数，与真实附件 id 不撞号） */
  id: ID;
  biz_type: "scale_capture" | "id_card_photo" | "signature" | "sample_photo";
  label: string;
  /** 这张是哪台相机拍的（相机台账名）；缺图占位格为 null */
  device_label: string | null;
  /** mock 用占位渐变，真实为 attachment.file_path */
  tone: Tone;
  captured_at: string;
  missing?: boolean;
}

export interface TimelineEvent {
  at: string;
  action: string;
  label: string;
  actor: string;
  tone: Tone;
  detail?: string;
}

export interface SettlementOrderRow {
  order_id: ID;
  order_no: string;
  goods_amount_fen: number;
  price_fen_per_ton: number;
  settlement_weight_01kg: number;
  seq: number;
}

export interface Settlement {
  id: ID;
  settle_no: string;
  party_id: ID;
  party_name: string;
  business_date: string;
  period_from: string;
  period_to: string;
  order_count: number;
  total_net_01kg: number;
  total_deduct_01kg: number;
  total_settle_01kg: number;
  total_goods_fen: number;
  total_deduction_fen: number;
  total_advance_fen: number;
  payable_fen: number;
  paid_fen: number;
  payment_status: Exclude<PaymentStatus, "not_required">;
  main_method: PaymentMethod | null;
  payee_name: string;
  signed_by_party: 0 | 1;
  status: "normal" | "revoked";
  settled_at: string;
  settler_id: ID;
  orders: SettlementOrderRow[];
  remark: string | null;
}

export interface PaymentRecord {
  id: ID;
  pay_no: string;
  settlement_id: ID | null;
  settle_no: string | null;
  order_id: ID | null;
  order_no: string | null;
  party_id: ID;
  party_name: string;
  amount_fen: number;
  method: PaymentMethod;
  trade_no: string | null;
  payee_name: string;
  paid_at: string;
  operator_id: ID;
  voucher_no: string | null;
  reversed: 0 | 1;
  remark: string | null;
}

export interface PrintLog {
  id: ID;
  /**
   * 打印的单据种类。**值域就是 `print_log.doc_type` 那一列的 CHECK**（03 §9.19），
   * 也与前端场景 id `ReceiptScenario` 逐字相同——`silent.ts` 把 scenario 原样写进这一列，
   * 中间没有第二份映射，所以三处必须一起改（钉它的是 receipt-code 自检 N 段）。
   */
  doc_type: "weigh_order" | "quality_report" | "settlement_voucher" | "payment_receipt" | "outbound_order" | "ledger" | "daily_report";
  doc_no: string;
  copies: number;
  paper: PaperKind;
  printer_name: string;
  channel: PrintChannel;
  is_reprint: 0 | 1;
  authorized_by: ID | null;
  result: "success" | "failed";
  error_msg: string | null;
  printed_at: string;
  operator_id: ID;
}

export interface DeviceConfig {
  id: ID;
  code: string;
  name: string;
  kind: DeviceKind;
  driver: string;
  /** 已解析的展示用配置（真实实现是 config_json 文本） */
  config: Record<string, string | number | boolean>;
  is_enabled: 0 | 1;
  is_mock: 0 | 1;
  is_default: 0 | 1;
  last_status: DeviceStatus;
  last_ok_at: string | null;
  last_error: string | null;
  err_count: number;
}

export interface AuditLog {
  id: ID;
  at: string;
  actor_id: ID;
  actor_name: string;
  action: string;
  entity: string;
  entity_no: string | null;
  reason: string | null;
  authorized_by: string | null;
  result: "ok" | "denied" | "error";
}

export interface AppSetting {
  key: string;
  value: string;
  label: string;
  group: "doc" | "weigh" | "settle" | "print" | "retain" | "session" | "other";
  /** 纯展示层控件类型（与库里 value_type 是两回事）；warehouse＝候选取自仓房档案，参数页现取现列 */
  kind: "text" | "number" | "bool" | "select" | "warehouse";
  options?: { value: string; label: string }[];
  hint?: string;
}

/* ---------------------------------------------------------------------- 查询 */

export interface PageResult<T> {
  rows: T[];
  total: number;
  /** 合计行，来自与列表同一趟扫描（真实实现为窗口函数） */
  summary: {
    count: number;
    net_01kg: number;
    settle_01kg: number;
    goods_fen: number;
    payable_fen: number;
  };
}

export interface OrderFilters {
  dateFrom?: string;
  dateTo?: string;
  status?: OrderStatus | "all";
  varietyId?: ID | "all";
  paymentStatus?: PaymentStatus | "all";
  weightSource?: WeightSource | "all";
  partyId?: ID | "all";
  keyword?: string;
  page?: number;
  pageSize?: number;
  sort?: "registered_at" | "payable_amount_fen" | "settlement_weight_01kg" | "order_no";
  order?: "asc" | "desc";
}

export interface Dashboard {
  /**
   * 选定区间（business_date 闭区间 from~to）的汇总。字段名不叫 `today`：
   * 看板已支持今天/昨天/近 7 天/近 30 天/本月/上月，这里始终是"当前所选区间"的值，
   * 区间文案由页面的时间选择器承载，不写死在字段名里（05 §3）。
   */
  summary: {
    orders: number;
    net_01kg: number;
    settle_01kg: number;
    goods_fen: number;
    payable_fen: number;
    paid_fen: number;
    credit_fen: number;
    manualCount: number;
    rejectCount: number;
  };
  openOrders: {
    order_no: string;
    party_name: string;
    status: OrderStatus;
    variety_name: string;
    since_minutes: number;
    overdue: boolean;
  }[];
  alerts: {
    level: Tone;
    title: string;
    detail: string;
    action: string;
    href: string;
  }[];
  trend: { date: string; net_01kg: number; goods_fen: number; orders: number }[];
  byVariety: { variety_code: string; variety_name: string; net_01kg: number; goods_fen: number }[];
  byPartyType: { type: PartyType; label: string; orders: number; net_01kg: number }[];
  hourCurve: { hour: number; orders: number }[];
  /**
   * 看板设备面板：桌面端来自真库 `device_config`（启用设备），与上方告警同源。
   * 设备中心整模块换真库前，页面不再借道 `listDevices`（mock），
   * 避免出现"面板一套设备、告警另一套"的分裂口径。
   */
  devices: {
    code: string;
    name: string;
    kind: DeviceKind;
    is_enabled: 0 | 1;
    last_status: DeviceStatus;
    last_error: string | null;
  }[];
}

export interface DailyReport {
  date: string;
  rows: {
    variety_name: string;
    variety_code: string;
    orders: number;
    parties: number;
    gross_01kg: number;
    tare_01kg: number;
    net_01kg: number;
    deduct_01kg: number;
    settle_01kg: number;
    goods_fen: number;
    deduction_fee_fen: number;
    payable_fen: number;
    paid_fen: number;
    credit_fen: number;
    avg_moisture_001pct: number | null;
    manual_count: number;
    reject_count: number;
  }[];
  total: {
    orders: number;
    parties: number;
    net_01kg: number;
    settle_01kg: number;
    goods_fen: number;
    payable_fen: number;
    paid_fen: number;
    credit_fen: number;
  };
  prevDayNet_01kg: number;
  lastWeekNet_01kg: number;
}

export interface QualityReport {
  dateFrom: string;
  dateTo: string;
  byVariety: {
    variety_name: string;
    variety_code: string;
    /** 期间内该品种全部磅单数（含拒收），拒收率的分母 */
    orders: number;
    /** 有生效质检单的样本数，超基准率的分母 */
    samples: number;
    avg_moisture: number | null;
    avg_impurity: number | null;
    avg_unsound: number | null;
    over_moisture: number;
    over_impurity: number;
    /** 水分/杂质/不完善粒任一超国标的样本数（已去重，≤ samples） */
    over_any: number;
    reject: number;
    /** 以下两项仅统计参与汇总的完成单，扣量率 = deduct / net */
    net_01kg: number;
    deduct_01kg: number;
  }[];
  gradeDist: { variety_name: string; grades: { grade: Grade; count: number }[] }[];
  moistureBuckets: { label: string; count: number }[];
}

export interface PartyRankRow {
  party_id: ID;
  name: string;
  party_type: PartyType;
  orders: number;
  net_01kg: number;
  goods_fen: number;
  paid_fen: number;
  credit_fen: number;
  last_date: string;
  avg_tare_01kg: number | null;
}

export interface StaffLoadRow {
  user_id: ID;
  name: string;
  role: Role;
  orders: number;
  manual_count: number;
  manual_ratio: number;
  void_count: number;
  override_count: number;
  reprint_count: number;
}

export interface LedgerRow {
  seq: number;
  business_date: string;
  order_no: string;
  party_name: string;
  party_type: PartyType;
  id_card_no: string;
  /** 台账那一格证号点开看全号走的就是这条键（`party_id_card`），与 Rust `LedgerRow.party_id` 同序 */
  party_id: number;
  address: string;
  variety_name: string;
  grade: Grade | null;
  vehicle_no: string | null;
  warehouse_name: string | null;
  gross_weight_01kg: number | null;
  tare_weight_01kg: number | null;
  net_weight_01kg: number | null;
  deduct_total_01kg: number;
  settlement_weight_01kg: number | null;
  moisture_001pct: number | null;
  impurity_001pct: number | null;
  price_fen_per_ton: number | null;
  goods_amount_fen: number | null;
  deduction_fee_fen: number;
  payable_amount_fen: number | null;
  paid_amount_fen: number;
  credit_amount_fen: number;
  payment_method: PaymentMethod | null;
  weight_source: WeightSource;
  weigher_name: string;
  inspector_name: string;
  settled: boolean;
}

/* =============================================================== 粮食出库（02 §M11） */

/** 出库单行。字段与 `src-tauri/src/outbound.rs::OutboundOrder` 逐字一致。 */
export interface OutboundOrder {
  id: number;
  order_no: string;
  business_date: string;
  kind: OutboundKind;
  status: OutboundStatus;
  party_id: number | null;
  party_name: string | null;
  /** 非档案领出方（部门/用途对象），登记出库可只填这一栏 */
  counterparty_label: string | null;
  variety_id: number | null;
  variety_name: string | null;
  grade: Grade | null;
  warehouse_id: number;
  warehouse_name: string;
  slot_id: number | null;
  slot_label: string | null;
  vehicle_no: string | null;
  net_weight_01kg: number | null;
  /** 手填那格写 manual；上过磅之后看「当前采用的那一捕是不是手录」——被复称换掉的手录行不再决定性质 */
  weight_source: WeightSource;
  price_fen_per_ton: number | null;
  goods_amount_fen: number | null;
  payment_status: PaymentStatus;
  /** 超库存出库时服务端复算后自动写入的那句警示；null＝账面够用 */
  stock_warning: string | null;
  void_reason: string | null;
  remark: string | null;
  created_at: string;
  created_by: number;
  created_name: string;
  completed_at: string | null;
  completed_by: number | null;
  completed_name: string | null;
  /** 最后一次改动时间；作废单的时间轴节点取它（表里没有单独的作废时间列） */
  updated_at: string | null;
  /**
   * 毛重 / 皮重（0.1kg，当前采用值）。与 §9.11 磅单同名同单位。
   * 两者都在＝这一单上过磅，净重由 毛 − 皮 得出、`weight_source` 标「地磅」；
   * 都为空＝纯手填那一条老路。挂在末尾与 Rust `OutboundOrder` 的字段序一致。
   */
  gross_weight_01kg: number | null;
  tare_weight_01kg: number | null;
}

/** 一条库存流水。字段与 `src-tauri/src/stock.rs::MovementRow` 逐字一致。 */
export interface StockMovementRow {
  id: number;
  kind: "in" | "out" | "transfer" | "loss" | "adjust";
  /** 带符号变动量（0.1kg）：入库为正、出库为负 */
  signed_01kg: number;
  weight_01kg: number;
  order_id: number | null;
  order_no: string | null;
  outbound_id: number | null;
  outbound_no: string | null;
  party_id: number | null;
  party_name: string | null;
  variety_id: number | null;
  variety_name: string | null;
  grade: string | null;
  warehouse_id: number | null;
  warehouse_name: string | null;
  from_warehouse_id: number | null;
  from_warehouse_name: string | null;
  to_warehouse_id: number | null;
  to_warehouse_name: string | null;
  amount_fen: number | null;
  business_date: string;
  operated_at: string;
  operator_name: string;
  /** 红冲的对称入库行指回被它冲掉的那条出库行 */
  reversal_of_id: number | null;
  remark: string | null;
}

/** 出库单详情：单据本身 + 它在库存账上留下的流水 + 它的称重轨迹。 */
export interface OutboundDetail extends OutboundOrder {
  movements: StockMovementRow[];
  /**
   * 称重轨迹（0029 起与磅单共用 `weigh_record`，按 `doc_kind` 各取各家）。
   * 空数组＝这一单没上过磅（纯手填净重），不是"读不到"——界面对这两种要分开说。
   */
  records: WeighRecord[];
  /**
   * 这张出库单打过的票（0030 / F11.7 出库码单）。详情页据此显示「已打 N 张」并决定下一次算不算补打。
   * 后端按 `doc_type='outbound_order'` + 单号查，不是只按号——同站同月的磅单与出库单会撞成同一串数字。
   */
  prints: PrintLog[];
}

/** 结存矩阵一行（仓房 × 品种）。与 `stock.rs::BalanceRow` 逐字一致。 */
export interface StockBalanceRow {
  warehouse_id: number;
  warehouse_code: string;
  warehouse_name: string;
  variety_id: number | null;
  variety_code: string | null;
  variety_name: string | null;
  /** 账面结存（0.1kg）= Σ入 − Σ出 */
  balance_01kg: number;
  in_01kg: number;
  out_01kg: number;
  /** 已称完但还没结算入账、去向定到本仓房的部分（不计入 balance_01kg） */
  pending_in_01kg: number;
  last_move_at: string | null;
}

/** 制单/改单入参。order_no 空＝新建，带单号＝改草稿。 */
export interface OutboundSaveInput {
  order_no?: string | null;
  kind: OutboundKind;
  business_date?: string | null;
  party_id?: number | null;
  counterparty_label?: string | null;
  variety_id?: number | null;
  grade?: string | null;
  warehouse_id: number;
  slot_id?: number | null;
  vehicle_no?: string | null;
  net_weight_01kg?: number | null;
  price_fen_per_ton?: number | null;
  remark?: string | null;
  operator_id: number;
}

/** 完成出库入参（净重已在制单/改单时填好）。 */
export interface OutboundCompleteInput {
  order_no: string;
  operator_id: number;
}

/** 作废 / 红冲入参，reason ≥6 字。 */
export interface OutboundCloseInput {
  order_no: string;
  reason: string;
  operator_id: number;
}

/**
 * 出库单称重入参（0029）。与磅单侧 `CaptureInput` 同形但更窄：出库没有过磅抓拍、
 * 没有皮重容差、也没有历史授权放行，那三道闸门一条都不该管出库（理由见 `outbound.rs` 模块头）。
 */
export interface OutboundCaptureInput {
  order_no: string;
  /** gross＝重车（毛重）/ tare＝空车（皮重），值域同 §9.12 `weigh_type` */
  weigh_type: "gross" | "tare";
  weight_01kg: number;
  /** scale＝捕获仪表读数；manual＝人照着装磅显/小票敲的数（永久标记，迎检必查） */
  source: WeightSource;
  /** 仪表原始帧，迎检时对回仪表报文；手录不传 */
  raw_frame?: string | null;
  operator_id: number;
}

export interface OutboundFilters {
  date_from?: string;
  date_to?: string;
  status?: OutboundStatus | "all";
  kind?: OutboundKind | "all";
  warehouse_id?: number | null;
  variety_id?: number | null;
  keyword?: string;
  page?: number;
  page_size?: number;
}

export interface OutboundPage {
  rows: OutboundOrder[];
  total: number;
  summary: { count: number; net_01kg: number; goods_fen: number };
}

export interface MovementFilters {
  warehouse_id?: number | null;
  variety_id?: number | null;
  kind?: StockMovementRow["kind"] | "all";
  date_from?: string;
  date_to?: string;
  page?: number;
  page_size?: number;
}

export interface MovementPage {
  rows: StockMovementRow[];
  total: number;
}
