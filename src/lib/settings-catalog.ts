/**
 * 站点参数的展示字典（03 §9.3 与 §9.3.1）。
 *
 * 拆出来是因为一次对键：库里 22 个参数键与 `src/mock/masters.ts` 那份 mock 字典
 * 有 5 个是「同一个参数两个名字」（`tare_tolerance_ratio` / `tare_tolerance_pct`、
 * `payment_due_days` / `payment_due_warn_hours`、`capture_keep_days` /
 * `attachment_keep_days`、`print_copies` / `print_default_copies`、
 * `allow_credit` / `settlement_allow_part_pay`），还有 8 个纯界面参数库里根本没有。
 * 谁的口径都不许在前端再拼一层映射表——那是把对不上的键名长期养在代码里。
 * 所以定死：**键名与单位一律向 §9.3.1 靠**（缺的键由 `0006_settings_parity.sql` 补进库），
 * 这份目录只留「界面怎么显示」，值全部来自库里。
 *
 * 单位约定沿用库里的定点写法，界面上必须写出来，否则站长填 3 还是 300 全靠猜：
 * `_pct` 是 0.01%（300 = 3.00%）、`_01kg` 是 0.1kg（100 = 10kg）、时效用小时、
 * 留存与留样用自然日、判稳窗口用毫秒。
 */
import type { AppSetting } from "@/mock/types";

/** 目录里的一项 = `AppSetting` 去掉值，再加一份演示值 */
type CatalogEntry = Omit<AppSetting, "value"> & {
  /** 只在浏览器演示模式用；桌面端一律被库里的真值顶掉。
   *  数值刻意与 `0002_seed.sql` / `0006_settings_parity.sql` 抄同一份，
   *  免得演示看熟的数和上线后看到的数对不上。 */
  demo: string;
};

/** `master_settings` 返回的一行：库里就只有这四列 */
export type SettingRow = {
  key: string;
  value: string;
  value_type: string;
  description: string;
};

export const SETTINGS_GROUP: Record<AppSetting["group"], string> = {
  doc: "单证与编号",
  weigh: "过磅计量",
  settle: "结算与付款",
  print: "打印与联次",
  retain: "留样与数据保留",
  session: "登录与锁屏",
  other: "库里新增、目录还没补",
};

/** 顺序即界面顺序：同组内按这里排，不按库里的字母序（键名首字母没有业务含义） */
export const SETTINGS_CATALOG: CatalogEntry[] = [
  {
    key: "station_name", demo: "", label: "站点名称", group: "doc", kind: "text",
    hint: "打印抬头与磅单第一行；存在站点档案里，不占参数键",
  },
  { key: "doc_no_prefix_BD", demo: "BD", label: "磅单前缀", group: "doc", kind: "text" },
  { key: "doc_no_prefix_ZJ", demo: "ZJ", label: "质检单前缀", group: "doc", kind: "text" },
  { key: "doc_no_prefix_JS", demo: "JS", label: "结算单前缀", group: "doc", kind: "text" },
  { key: "doc_no_prefix_FK", demo: "FK", label: "付款单前缀", group: "doc", kind: "text" },
  {
    key: "doc_no_seq_len", demo: "6", label: "流水号位数", group: "doc", kind: "number",
    hint: "按站点+前缀+年月归零重排",
  },

  {
    key: "scale_division_01kg", demo: "100", label: "地磅分度值（0.1kg）", group: "weigh", kind: "number",
    hint: "100 即 10 kg",
  },
  {
    key: "weight_rounding_mode", demo: "nearest_div", label: "读数对齐方式", group: "weigh", kind: "select",
    options: [
      { value: "floor", label: "向下取整" },
      { value: "half_up", label: "四舍五入" },
      { value: "nearest_div", label: "就近分度" },
    ],
  },
  { key: "stable_window_ms", demo: "1500", label: "判稳窗口（毫秒）", group: "weigh", kind: "number" },
  {
    key: "stable_tolerance_01kg", demo: "50", label: "判稳波动容差（0.1kg）", group: "weigh", kind: "number",
    hint: "50 即 5 kg",
  },
  {
    key: "tare_tolerance_pct", demo: "300", label: "皮重偏差容差（0.01%）", group: "weigh", kind: "number",
    hint: "300 即 ±3.00%，超出仍正常捕获，只在磅单上醒目警示",
  },
  { key: "open_order_alert_minutes", demo: "30", label: "在途停留提醒（分钟）", group: "weigh", kind: "number" },
  { key: "capture_on_gross", demo: "true", label: "毛重抓拍", group: "weigh", kind: "bool" },
  { key: "capture_on_tare", demo: "true", label: "皮重抓拍", group: "weigh", kind: "bool" },
  {
    key: "card_flow_mode", demo: "auto", label: "流转卡模式（06 篇）", group: "weigh", kind: "select",
    options: [
      { value: "auto", label: "启用：后台听 IC、刷卡推进" },
      { value: "off", label: "不启用：工作台一律手点" },
    ],
    hint: "auto＝制单发卡后靠刷 IC 卡推进毛重/皮重/结算；off＝该站不用流转卡，读卡器故障时的退路",
  },
  {
    key: "card_pool_warn_free", demo: "5", label: "空闲卡预警阈值（张）", group: "weigh", kind: "number",
    hint: "空闲卡低于此值时看板与卡池页黄色提示",
  },
  {
    key: "card_release_on_terminal", demo: "true", label: "终态自动回收卡", group: "weigh", kind: "bool",
    hint: "置 false 则结算/作废后仍需人工刷卡退卡才回池（要逐张点收卡的站点）",
  },
  {
    key: "card_swipe_debounce_ms", demo: "1500", label: "刷卡去抖窗口（毫秒）", group: "weigh", kind: "number",
    hint: "同一张卡重复命中只算一刷，防止卡不动被循环读到把单推到结算",
  },
  // 演示值取 false 是例外（库里默认 true）：浏览器预览压根没有 IC 通道，
  // 按库里的强制口径演示里连单都制不出来。桌面端读库里真值，不受这行影响。
  {
    key: "card_required_on_create", demo: "false", label: "制单必须绑卡", group: "weigh", kind: "bool",
    hint: "点「取号并制单」先弹框刷 IC 卡，读不到卡这张单制不成；关掉才允许无卡制单、事后靠监听发卡",
  },
  {
    key: "reader_prompt_voice", demo: "true", label: "磅房语音提示", group: "weigh", kind: "bool",
    hint: "两类出声：① 读卡类弹窗（读卡建档 / 制单读卡 / 制单绑卡 / 流转卡登记）弹出时念一句「请将卡放到感应区」；② 工作台每道闸门拦下与每步落成都回话——读数没稳、这张卡用不了、档案已停用、毛重皮重已捕获、结算完成、码单没出纸，让不盯屏幕的操作员也听得见。关掉只是这台机不出声，读卡、称重、结算、绑卡闸门一律照旧；这台机没装中文语音包时自动改播提示音",
  },

  { key: "settlement_allow_part_pay", demo: "true", label: "允许挂账（部分付款）", group: "settle", kind: "bool" },
  {
    key: "payment_due_warn_hours", demo: "72", label: "付款时效预警（小时）", group: "settle", kind: "number",
    hint: "72 即 3 天，超期进入看板告警",
  },
  { key: "settle_merge_by_day", demo: "true", label: "同人同日合并结算", group: "settle", kind: "bool" },
  {
    key: "moisture_deduct_manual", demo: "true", label: "扣水按人工录入", group: "settle", kind: "bool",
    hint: "计价规则引擎未启用，关掉也不会自动扣",
  },
  { key: "impurity_deduct_manual", demo: "true", label: "扣杂按人工录入", group: "settle", kind: "bool" },

  {
    key: "print_paper", demo: "A4", label: "码单纸型", group: "print", kind: "select",
    options: [
      { value: "A4", label: "A4 激光" },
      { value: "dot241", label: "241 针式" },
      { value: "thermal58", label: "58 热敏" },
      { value: "thermal80", label: "80 热敏" },
    ],
    hint: "工作台不弹预览：热敏走 ESC/POS 直连，A4/针式直接进打印队列，纸张等按打印机自身配置",
  },
  { key: "print_default_copies", demo: "3", label: "联数（存根/财务/客户）", group: "print", kind: "number" },
  { key: "reprint_need_auth", demo: "true", label: "补打需站长授权", group: "print", kind: "bool" },

  { key: "attachment_max_kb", demo: "500", label: "抓拍压缩上限（KB）", group: "retain", kind: "number" },
  {
    key: "attachment_keep_days", demo: "3650", label: "抓拍留存（天）", group: "retain", kind: "number",
    hint: "3650 即 10 年，与保管期限同口径",
  },
  { key: "retention_sample_days", demo: "30", label: "留样保存（天）", group: "retain", kind: "number" },
  {
    key: "pii_mask_id_card", demo: "true", label: "界面掩码身份证号", group: "retain", kind: "bool",
    hint: "只管屏幕上显不显示全号，与下面的存储加密是两回事",
  },
  { key: "pii_encrypt_enabled", demo: "true", label: "证号与照片加密存储", group: "retain", kind: "bool" },
  {
    key: "backup_dir", demo: "", label: "备份目录", group: "retain", kind: "text",
    hint: "留空即应用数据目录下的 backup",
  },
  { key: "backup_keep_count", demo: "30", label: "备份保留份数", group: "retain", kind: "number" },
  {
    key: "backup_auto_interval_days", demo: "1", label: "自动备份间隔（天）", group: "retain", kind: "number",
    hint: "程序每小时醒一次比对上次副本的时间，够数才补一份；填 0 按 1 天处理",
  },
  {
    key: "idle_lock_minutes", demo: "60", label: "无操作自动锁屏（分钟）", group: "session", kind: "select",
    options: [
      { value: "5", label: "5 分钟" },
      { value: "10", label: "10 分钟" },
      { value: "30", label: "30 分钟" },
      { value: "60", label: "1 小时" },
      { value: "120", label: "2 小时" },
      { value: "180", label: "3 小时" },
      { value: "0", label: "从不" },
    ],
    hint: "到点只是锁屏：输本人密码即原地解锁，不退出登录、正在录的单据不丢；选「从不」则不自动锁屏，左下角仍可手动锁。改动最迟一分钟内对在线会话生效",
  },
];

/** 浏览器演示模式：目录 + 演示值，字段形状与桌面端返回的 `AppSetting` 完全一致 */
export function demoSettings(): AppSetting[] {
  return SETTINGS_CATALOG.map(({ demo, ...meta }) => ({ ...meta, value: demo }));
}

/**
 * 库里的行与目录合并成页面要的 `AppSetting`。
 *
 * 目录里没有的键**不丢掉**：迁移新加一个键而忘了补目录时，宁可让它带着库里的
 * `description` 出现在最后一组里，也不要让站长以为库里根本没有这个参数。
 * 反过来目录里有、库里没有的键照旧渲染但值为空，并在提示里点破——静默少一项
 * 比多一项难查得多。
 */
export function mergeSettings(rows: SettingRow[]): AppSetting[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const known = SETTINGS_CATALOG.map(({ demo: _demo, ...meta }) => {
    const row = byKey.get(meta.key);
    byKey.delete(meta.key);
    if (row) return { ...meta, value: row.value } as AppSetting;
    return { ...meta, value: "", hint: `${meta.hint ? `${meta.hint}；` : ""}库里没有这个键，改了也不生效` } as AppSetting;
  });
  const extras: AppSetting[] = Array.from(byKey.values()).map((r) => ({
    key: r.key,
    value: r.value,
    label: r.description || r.key,
    group: "other",
    kind: r.value_type === "bool" ? "bool" : r.value_type === "int" ? "number" : "text",
    hint: `参数目录未收录（值类型 ${r.value_type}），到 src/lib/settings-catalog.ts 补一项`,
  }));
  return [...known, ...extras];
}
