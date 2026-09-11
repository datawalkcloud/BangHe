/**
 * Mock 层的 DTO，字段名与 docs/design/03 §9 表结构逐字对齐。
 *
 * 这样做的目的：将来把 `src/mock/api.ts` 换成 `invoke()` 实现时，
 * 页面与组件代码一行都不用改（见 05 文档 §8「lib/api.ts 是唯一出口」）。
 *
 * 数值一律为定点整数（03 §3.1）：`_01kg` / `_fen` / `_fen_per_ton` / `_001pct`。
 */
import type {
  DeviceKind,
  DeviceStatus,
  Grade,
  OrderStatus,
  PartyType,
  PaymentMethod,
  PaymentStatus,
  PrintChannel,
  PaperKind,
  QcDecision,
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
  /** 明文只在 mock 层存在；真实实现为密文 + fp，界面永远走 maskIdCard */
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
  variety_id: ID;
  variety_code: string;
  variety_name: string;
  grade: Grade | null;
  warehouse_id: ID | null;
  warehouse_name: string | null;
  slot_id: ID | null;
  slot_label: string | null;
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
  tare_override_by: ID | null;
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

export interface CapturePhoto {
  id: ID;
  biz_type: "scale_capture" | "id_card_photo" | "signature" | "sample_photo";
  label: string;
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
  doc_type: "weigh_order" | "quality_report" | "settlement_voucher" | "ledger" | "daily_report";
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
  group: "doc" | "weigh" | "settle" | "print" | "retain" | "other";
  kind: "text" | "number" | "bool" | "select";
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
  today: {
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
