/**
 * 业务枚举的中文标签与语义色，与 docs/design/03 §3.6、§4.1 同源。
 * SQLite 用 TEXT + CHECK 存枚举原文，因此这里的 value 必须与库中字符串完全一致。
 *
 * 色板规范见 05 文档 §6.2：颜色之外必须同时有中文文字，黑白打印与色弱场景要能判读。
 */

/* ------------------------------------------------------------------ 磅单状态 */

export type OrderStatus =
  | "draft"
  | "registered"
  | "qc_done"
  | "gross_weighed"
  | "tare_weighed"
  | "reweigh"
  | "to_settle"
  | "settled"
  | "paid"
  | "archived"
  | "voided"
  | "reversed"
  | "rejected";

/** tone 只描述语义，具体样式由 OrderStatusBadge 决定 */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export const ORDER_STATUS: Record<
  OrderStatus,
  { label: string; tone: Tone; desc: string }
> = {
  draft: { label: "草稿", tone: "neutral", desc: "已取号未补全信息" },
  registered: { label: "已登记", tone: "neutral", desc: "农户、品种、车辆齐备，等待化验或过磅" },
  qc_done: { label: "已化验", tone: "info", desc: "化验完成，尚无重量" },
  gross_weighed: { label: "待皮重", tone: "info", desc: "已取毛重，缺皮重" },
  tare_weighed: { label: "待毛重", tone: "info", desc: "已取皮重，缺毛重" },
  reweigh: { label: "复称中", tone: "warning", desc: "净重已定但正在复称调整" },
  to_settle: { label: "待结算", tone: "info", desc: "净重与结算重量确定，待结算" },
  settled: { label: "已结算", tone: "info", desc: "已生成结算单，未必付清" },
  paid: { label: "已付清", tone: "success", desc: "货款全部付清" },
  archived: { label: "已归档", tone: "neutral", desc: "日结后终态" },
  voided: { label: "已作废", tone: "danger", desc: "作业中途作废，保留留痕" },
  reversed: { label: "已红冲", tone: "danger", desc: "被红冲单抵消的原单" },
  rejected: { label: "拒收退粮", tone: "danger", desc: "目测或化验判定拒收" },
};

/** 在途状态：看板与底栏"未完成作业"用 */
export const OPEN_STATUSES: OrderStatus[] = [
  "draft",
  "registered",
  "qc_done",
  "gross_weighed",
  "tare_weighed",
  "reweigh",
  "to_settle",
];

/** 参与汇总统计的状态（红冲单在内，其负值抵消原单；作废剔除）——03 §4.3 不变式 4 */
export const STAT_STATUSES: OrderStatus[] = [
  "to_settle",
  "settled",
  "paid",
  "archived",
  "reversed",
];

/* -------------------------------------------------------------- 磅单作废事由 */

/** 事由最短字数，与真库闸门同源（`orders.rs::void_order` 的 6 个字） */
export const VOID_REASON_MIN = 6;

/**
 * 常用作废事由的快捷选项：磅房现场一只手扶卡一只手敲字，废单来去就那么几句，
 * 先点按钮填一句完整的话，仍可手改补细节。落库的是自由文本，不是枚举码。
 * label 只给按钮上看，reason 才是进审计日志的那句话——每条都必须够
 * [`VOID_REASON_MIN`] 字，点一下就能直接提交。
 */
export const VOID_REASONS: { label: string; reason: string }[] = [
  { label: "农户取消售粮", reason: "农户临时取消售粮，车辆已卸离磅面" },
  { label: "登记信息有误", reason: "售粮人或车牌登记错误，需重新制单" },
  { label: "品种选错", reason: "粮食品种选错，需重新制单" },
  { label: "同一车重复制单", reason: "同一车辆重复制单，本单作废" },
  { label: "误触发称重", reason: "车辆未实际过磅，误触发称重" },
  { label: "读数异常", reason: "磅面读数异常，需重新过磅" },
  { label: "流转卡绑错", reason: "流转卡绑定错误，需重新发单" },
  { label: "取样与本单不符", reason: "化验取样与本单不符，需重采重检" },
];

/* --------------------------------------------------------------- 售粮人类型 */

export type PartyType = "farmer" | "large_grower" | "broker" | "cooperative" | "company";

export const PARTY_TYPE: Record<PartyType, string> = {
  farmer: "农户",
  large_grower: "种粮大户",
  broker: "经纪人",
  cooperative: "合作社",
  company: "企业",
};

/* ------------------------------------------------------------------ 岗位角色 */

export type Role =
  | "station_master"
  | "registrar"
  | "weigher"
  | "inspector"
  | "keeper"
  | "cashier"
  | "viewer";

export const ROLE: Record<Role, string> = {
  station_master: "站长",
  registrar: "登记员",
  weigher: "磅员",
  inspector: "化验员",
  keeper: "保管员",
  cashier: "出纳",
  viewer: "查询审计",
};

/* -------------------------------------------------------------------- 付款 */

export type PaymentMethod =
  | "cash"
  | "bank"
  | "wechat"
  | "alipay"
  | "transfer"
  | "credit_writeoff";

export const PAYMENT_METHOD: Record<PaymentMethod, string> = {
  cash: "现金",
  bank: "银行转账",
  wechat: "微信",
  alipay: "支付宝",
  transfer: "社保卡/一卡通",
  credit_writeoff: "挂账核销",
};

export type PaymentStatus = "unpaid" | "partial" | "paid" | "not_required";

export const PAYMENT_STATUS: Record<PaymentStatus, { label: string; tone: Tone }> = {
  unpaid: { label: "未付款", tone: "danger" },
  partial: { label: "部分付款", tone: "warning" },
  paid: { label: "已付清", tone: "success" },
  not_required: { label: "无需付款", tone: "neutral" },
};

/* ------------------------------------------------------------------ 等级/判定 */

export const GRADES = ["一等", "二等", "三等", "四等", "等外"] as const;
export type Grade = (typeof GRADES)[number];

export type QcDecision = "accept" | "conditional" | "reject";

export const QC_DECISION: Record<QcDecision, { label: string; tone: Tone }> = {
  accept: { label: "接收", tone: "success" },
  conditional: { label: "条件接收", tone: "warning" },
  reject: { label: "拒收", tone: "danger" },
};

export type TestMethod = "nir" | "lab" | "visual";

export const TEST_METHOD: Record<TestMethod, string> = {
  nir: "近红外",
  lab: "化验室",
  visual: "目测",
};

/* -------------------------------------------------------------------- 化验指标 */

export type IndicatorUnit = "0.01pct" | "gL" | "text";

export type IndicatorMeta = {
  code: string;
  name: string;
  unit: IndicatorUnit;
  /** 国标基准限量（0.01% 或 g/L），仅用于提示色，不参与扣量计算 */
  std?: number;
  /** true = 越低越好（超基准为 ↑）；false = 越高越好 */
  lowerBetter: boolean;
};

/**
 * 指标字典。计价引擎首版不做（02 文档 F4.4），因此这里只驱动"超标提示"，
 * 绝对不允许在此处或任何前端代码里算扣量。
 */
export const INDICATORS: Record<string, IndicatorMeta> = {
  moisture: { code: "moisture", name: "水分", unit: "0.01pct", std: 1400, lowerBetter: true },
  impurity: { code: "impurity", name: "杂质", unit: "0.01pct", std: 100, lowerBetter: true },
  unsound: { code: "unsound", name: "不完善粒", unit: "0.01pct", std: 500, lowerBetter: true },
  bulk_density: { code: "bulk_density", name: "容重", unit: "gL", std: 720, lowerBetter: false },
  mold: { code: "mold", name: "霉变粒", unit: "0.01pct", std: 200, lowerBetter: true },
  yellow_grain: { code: "yellow_grain", name: "黄粒米", unit: "0.01pct", std: 200, lowerBetter: true },
  head_rice: { code: "head_rice", name: "整精米率", unit: "0.01pct", std: 3800, lowerBetter: false },
  odor: { code: "odor", name: "气味", unit: "text", lowerBetter: true },
};

export const INDICATOR_ORDER = [
  "moisture",
  "impurity",
  "unsound",
  "bulk_density",
  "mold",
  "yellow_grain",
  "head_rice",
  "odor",
];

/* -------------------------------------------------------------------- 称重来源 */

export type WeightSource = "scale" | "manual";

export const WEIGHT_SOURCE: Record<WeightSource, { label: string; tone: Tone }> = {
  scale: { label: "地磅读数", tone: "neutral" },
  manual: { label: "手录", tone: "warning" },
};

/* -------------------------------------------------------------------- 设备 */

export type DeviceKind = "scale" | "idcard" | "camera" | "printer" | "led" | "cashbox" | "signpad";

export const DEVICE_KIND: Record<DeviceKind, string> = {
  scale: "称重仪表",
  // 枚举值是数据库 CHECK 约束里的 'idcard'，改它要重建 device_config；精伦这台机兼读
  // 身份证与 IC 卡，所以文案按能力说，具体能读哪几种由 lib/card-reader 的登记表决定
  idcard: "证卡阅读器",
  camera: "抓拍摄像机",
  printer: "打印机",
  // 户外显示屏、钱箱、签名板：库里 CHECK 仍留着这三个值，但站点没装，设备页不再提供（见 DevicesPage 的 KIND_ORDER）
  led: "户外显示屏",
  cashbox: "钱箱",
  signpad: "电子签名板",
};

export type DeviceStatus = "unknown" | "online" | "offline" | "error";

export const DEVICE_STATUS: Record<DeviceStatus, { label: string; tone: Tone }> = {
  unknown: { label: "未检测", tone: "neutral" },
  online: { label: "在线", tone: "success" },
  offline: { label: "离线", tone: "danger" },
  error: { label: "故障", tone: "danger" },
};

/* ---------------------------------------------------------------- 流转卡（06 篇） */

/** 卡占用态：与后端 enums.rs `CardStatus`、§9.26 CHECK 逐字一致 */
export type CardStatus = "in_pool" | "in_use" | "retired";

export const CARD_STATUS: Record<CardStatus, { label: string; tone: Tone }> = {
  in_pool: { label: "空闲在册", tone: "neutral" },
  in_use: { label: "挂在途单", tone: "info" },
  retired: { label: "已注销", tone: "danger" },
};

export type PrintChannel = "preview" | "pdf_silent" | "raw";

export const PRINT_CHANNEL: Record<PrintChannel, string> = {
  preview: "窗口预览",
  // 值键沿用 pdf_silent（print_log 的 CHECK 锁死了三个值）；实现已从"导出 PDF"改为
  // GDI 直打 Windows 打印队列——通道选择器上说的是行为（无预览直打），不是实现细节
  pdf_silent: "静默直打",
  raw: "RAW 直连",
};

export type PaperKind = "A4" | "dot241" | "thermal58" | "thermal80";

export const PAPER: Record<PaperKind, string> = {
  A4: "A4 激光",
  dot241: "241 针式连续纸",
  thermal58: "58 热敏小票",
  // 现场实机（斯普瑞特 SPRT 80mm）：ESC/POS Font A 实测一行 48 列不折行
  thermal80: "80 热敏小票",
};

/* -------------------------------------------------------------------- 通用 */

export const TONE_BADGE: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground ring-border",
  info: "bg-info-bg text-info ring-info/30",
  success: "bg-success-bg text-success ring-success/30",
  warning: "bg-warning-bg text-warning ring-warning/30",
  danger: "bg-destructive/10 text-destructive ring-destructive/30",
};

/** 状态在图表/进度条里的填充色（与 TONE_BADGE 同语义） */
export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

/** 状态结果卡的边框 + 底色（与 TONE_BADGE 同语义，只是铺在整块面板上） */
export const TONE_BOX: Record<Tone, string> = {
  neutral: "border-border bg-muted/30",
  info: "border-info/40 bg-info-bg",
  success: "border-success/40 bg-success-bg",
  warning: "border-warning/40 bg-warning-bg",
  danger: "border-destructive/40 bg-destructive/10",
};

/** 状态结论标题的前景色（与 TONE_BOX 配对使用） */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
};

export const VARIETY_COLOR: Record<string, string> = {
  YM: "bg-chart-1",
  XM: "bg-chart-2",
  DG: "bg-chart-3",
  DD: "bg-chart-4",
};
