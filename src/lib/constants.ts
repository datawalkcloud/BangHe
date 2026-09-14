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
  paid: { label: "已付清", tone: "success", desc: "粮款全部付清" },
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

/* ---------------------------------------------------------------- 粮食出库单 */

/**
 * 出库性质。与 `domain/enums.rs::OutboundKind` 逐字同源。
 * `sale`＝销售出库（有领出方与单价、产生货款）；`record`＝登记出库
 * （领用/自用/损耗，粮出仓但不产生钱）。
 */
export type OutboundKind = "sale" | "record";

export const OUTBOUND_KIND: Record<OutboundKind, { label: string; desc: string }> = {
  sale: { label: "销售出库", desc: "卖给下游买家，过磅后按单价计粮款、挂应收" },
  record: { label: "登记出库", desc: "领用、自用、损耗等，只出仓不计价不收款" },
};

/** 出库单状态。与 `domain/enums.rs::OutboundStatus` 逐字同源。 */
export type OutboundStatus = "draft" | "done" | "voided" | "reversed";

export const OUTBOUND_STATUS: Record<
  OutboundStatus,
  { label: string; tone: Tone; desc: string }
> = {
  draft: { label: "草稿", tone: "neutral", desc: "已制单未过账，可改可废" },
  done: { label: "已出库", tone: "success", desc: "已扣库存，销售单已挂应收" },
  voided: { label: "已作废", tone: "danger", desc: "过账前作废，不动库存" },
  reversed: { label: "已红冲", tone: "warning", desc: "过账后红冲，补一条对称入库流水" },
};

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

/* ------------------------------------------------- 其余事由的快捷选项（同 VOID_REASONS 口径）
   磅房里这些话来去就那么几句，且多为闸门必填项；让不会打字的操作员现敲，
   只会得到"便宜点""质量差"这种迎检看不懂的话。点一下即填一句完整的人话，仍可手改。 */

/** 事由最短字数，与 `SettleForm` / `QcPanel` 前端闸门同源（后端只要求非空） */
export const REASON_MIN = 4;

/** 改价事由快捷选项：偏离价目表或无生效价时出现，选填（写了留痕，`orders.rs::settle` 不再强制） */
export const PRICE_REASONS: { label: string; value: string }[] = [
  { label: "水分超扣价", value: "水分超基准，按本站扣价下调" },
  { label: "杂质超扣价", value: "杂质超基准，按本站扣价下调" },
  { label: "等级下调", value: "化验等级下调，按低一等计价" },
  { label: "外观欠佳", value: "外观色差霉粒偏多，现场议价下调" },
  { label: "无生效价目", value: "该品种该等级暂无生效价目，手工定价" },
  { label: "随行就市议价", value: "与售粮人现场议价，价格与价目表不同" },
];

/** 拒收原因：判定拒收时必填（`QcPanel`） */
export const REJECT_REASONS: { label: string; value: string }[] = [
  { label: "水分超高", value: "水分超过拒收上限，现场退粮" },
  { label: "霉变超标", value: "霉变粒超标，现场退粮" },
  { label: "气味异常", value: "气味异常有异味，现场退粮" },
  { label: "杂质太多", value: "杂质过多含土含秆，现场退粮" },
  { label: "掺假掺杂", value: "疑似掺假掺杂，现场退粮并报站长" },
  { label: "品种不符", value: "实物与登记品种不符，现场退粮" },
];

/** 流转卡注销原因（`CardsPage`，服务端要求 ≥4 字） */
export const CARD_RETIRE_REASONS: { label: string; value: string }[] = [
  { label: "农户领走遗失", value: "农户领走后遗失，已挂失停用" },
  { label: "卡面损坏", value: "流转卡破损，感应失灵无法使用" },
  { label: "升级换发新卡", value: "卡面信息过期，注销后换发新卡" },
  { label: "卡池清点回收", value: "日结账卡卡数不符，注销留存根" },
];

/** 制单备注常用语（可空，纯省手） */
export const ORDER_REMARK_PRESETS: { label: string; value: string }[] = [
  { label: "带皮带", value: "带皮带过磅" },
  { label: "需复检", value: "需复检" },
  { label: "自带编织袋", value: "自带编织袋装粮" },
  { label: "换车再来", value: "本车未卸完，换车继续售粮" },
  { label: "司机代售", value: "农户未到场，司机代售" },
];

/** 气味等文本型化验指标的常用结论（仍可手改补细节） */
export const ODOR_PRESETS: { label: string; value: string }[] = [
  { label: "正常", value: "正常" },
  { label: "无异味", value: "无异味" },
  { label: "轻微异味", value: "轻微异味" },
  { label: "有霉味", value: "有霉味" },
  { label: "异味明显", value: "异味明显" },
];

/* ------------------------------------------------ 常用语快捷选项（可后台自定义维护）
   上面那几组 presets 是「首版种子」：装库时由 0015 迁移灌进 `quick_option` 表，
   之后由站长在「基础档案 › 常用语/快捷选项」里增删改（03 §9.27、05 §3）。
   这里同时是浏览器预览 mock 的种子源，两边共用这一份默认话术。 */

/** 一句常用语归哪一类；与 Rust `masters::QUICK_OPTION_KINDS`、§9.27 的 kind 值域逐字一致 */
export type QuickOptionKind =
  | "void"
  | "price"
  | "reject"
  | "card_retire"
  | "remark"
  | "odor";

/** 后台分区里的分组名，与展示顺序（按此数组序，不按字母序） */
export const QUICK_OPTION_KINDS: { kind: QuickOptionKind; label: string; where: string }[] = [
  { kind: "void", label: "作废事由", where: "工作台 / 磅单详情作废弹窗" },
  { kind: "price", label: "改价·改判事由", where: "结算改价、磅单改判等级" },
  { kind: "reject", label: "拒收原因", where: "化验区判定拒收" },
  { kind: "card_retire", label: "流转卡注销原因", where: "流转卡页注销" },
  { kind: "remark", label: "制单备注常用语", where: "工作台登记表备注" },
  { kind: "odor", label: "气味化验结论", where: "化验区气味指标" },
];

/**
 * 车牌省份简称（民用车口径）。
 *
 * 车牌栏看着短，对不会中文输入法的人却是全场最难的一格：第一位必须是汉字。
 * 给一排点选键，剩下的字母数字用软键盘，整格就不必碰输入法。
 */
export const PLATE_PROVINCES = [
  "豫", "冀", "鲁", "皖", "苏", "京", "津", "沪", "浙", "闽", "赣", "鄂", "湘",
  "粤", "桂", "琼", "渝", "川", "贵", "云", "藏", "陕", "甘", "青", "宁", "新",
  "蒙", "辽", "吉", "黑",
];

/** 发牌机关代号字母 + 数字：按 GB 917 口径不含易混的 I、O */
export const PLATE_ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789".split("");

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
