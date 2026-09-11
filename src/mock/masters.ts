/**
 * 主数据（基础档案）：站点、员工、品种、仓房货位、价目表、售粮人、设备、系统参数。
 * 全部一次性生成并常驻，字段与 docs/design/03 §9 表结构逐字对齐。
 */
import type {
  AppSetting,
  DeviceConfig,
  GrainVariety,
  Party,
  PriceList,
  Station,
  UserAccount,
  Warehouse,
} from "./types";
import type { Grade, PartyType, Role } from "@/lib/constants";
import { addDays, atTime, dateKey, makeIdCard, makePlate, mulberry32, pad, todayBase } from "./rng";

export const TODAY = todayBase();
export const HISTORY_DAYS = 14;

const r = mulberry32(20260910);
export const rand = r;
export function int(min: number, max: number): number {
  return min + Math.floor(r() * (max - min + 1));
}
export function pick<T>(list: readonly T[]): T {
  return list[Math.floor(r() * list.length)];
}
export function chance(p: number): boolean {
  return r() < p;
}

/* ------------------------------------------------------------------- 站点 */

export const station: Station = {
  id: 1,
  code: "01",
  name: "邦禾粮食收储站",
  address: "河南省周口市川汇区邦禾路 8 号",
  phone: "0394-8123456",
};

/* ------------------------------------------------------------------- 员工 */

const STAFF_SEED: { name: string; role: Role; username: string; phone: string }[] = [
  { name: "刘德福", role: "station_master", username: "liudf", phone: "13903945678" },
  { name: "王建国", role: "weigher", username: "wangjg", phone: "13703941122" },
  { name: "李秀英", role: "registrar", username: "lixy", phone: "13503943344" },
  { name: "张志强", role: "inspector", username: "zhangzq", phone: "13603945566" },
  { name: "陈桂兰", role: "keeper", username: "chenglan", phone: "13803947788" },
  { name: "周长江", role: "cashier", username: "zhoucj", phone: "13203949900" },
  { name: "赵淑珍", role: "viewer", username: "zhaosj", phone: "13103942233" },
];

export const users: UserAccount[] = STAFF_SEED.map((s, i) => ({
  id: i + 1,
  username: s.username,
  display_name: s.name,
  role: s.role,
  phone: s.phone,
  is_active: 1,
  // 登录时间必须是完整时刻，只给日期会让详情页的「最后登录」显示成 `2026-09-11 :00:00`
  last_login_at: atTime(TODAY, -(i % 7), 7, 30 + i * 11, 0),
}));

const idsOf = (role: Role) => users.filter((u) => u.role === role).map((u) => u.id);
export const WEIGHERS = idsOf("weigher");
export const REGISTRARS = idsOf("registrar");
export const INSPECTORS = idsOf("inspector");
export const KEEPERS = idsOf("keeper");
export const CASHIERS = idsOf("cashier");
export const STATION_MASTER_ID = users.find((u) => u.role === "station_master")!.id;

export function userName(id: number | null | undefined): string {
  if (id == null) return "—";
  return users.find((u) => u.id === id)?.display_name ?? "—";
}

/* --------------------------------------------------------------- 品种字典 */

export interface VarietySpec {
  code: string;
  name: string;
  category: string;
  std: { moisture: number; impurity: number; unsound: number; bulk: number; headRice: number };
  rejectMoisture: number;
  indicators: string[];
  pkgDeduct: number;
  basePrice: number;
  moistureBand: [number, number];
}

/** std 为国标限量（0.01% / g/L），仅作界面提示色，不参与任何扣量计算 */
export const VARIETY_SPECS: VarietySpec[] = [
  {
    code: "YM", name: "玉米", category: "主粮",
    std: { moisture: 1400, impurity: 100, unsound: 500, bulk: 720, headRice: 0 },
    rejectMoisture: 2500, indicators: ["moisture", "impurity", "unsound", "bulk_density", "mold", "odor"],
    pkgDeduct: 10, basePrice: 228000, moistureBand: [1150, 1950],
  },
  {
    code: "XM", name: "小麦", category: "主粮",
    std: { moisture: 1250, impurity: 100, unsound: 1000, bulk: 750, headRice: 0 },
    rejectMoisture: 1400, indicators: ["moisture", "impurity", "unsound", "bulk_density", "odor"],
    pkgDeduct: 10, basePrice: 246000, moistureBand: [1020, 1480],
  },
  {
    code: "DG", name: "稻谷", category: "主粮",
    std: { moisture: 1450, impurity: 100, unsound: 400, bulk: 0, headRice: 3800 },
    rejectMoisture: 1800, indicators: ["moisture", "impurity", "unsound", "head_rice", "yellow_grain"],
    pkgDeduct: 10, basePrice: 268000, moistureBand: [1200, 1720],
  },
  {
    code: "DD", name: "大豆", category: "油料",
    std: { moisture: 1300, impurity: 100, unsound: 800, bulk: 0, headRice: 0 },
    rejectMoisture: 1500, indicators: ["moisture", "impurity", "unsound", "odor"],
    pkgDeduct: 5, basePrice: 485000, moistureBand: [1050, 1420],
  },
];

export const varieties: GrainVariety[] = VARIETY_SPECS.map((v, i) => ({
  id: i + 1,
  code: v.code,
  name: v.name,
  category: v.category,
  std_moisture_001pct: v.std.moisture,
  std_impurity_001pct: v.std.impurity,
  std_unsound_001pct: v.std.unsound,
  std_bulk_density: v.std.bulk,
  reject_moisture_001pct: v.rejectMoisture,
  enabled_indicators: v.indicators,
  default_package_deduct_01kg: v.pkgDeduct,
  sort_order: (i + 1) * 10,
  is_active: 1,
}));

export const varietySpec = (id: number): VarietySpec => VARIETY_SPECS[id - 1];

/* ------------------------------------------------------------ 仓房与货位 */

const WAREHOUSE_SEED = [
  { code: "C01", name: "1号仓库", kind: "house" as const, capacity: 3000, slots: 6 },
  { code: "C02", name: "2号仓库", kind: "house" as const, capacity: 2500, slots: 5 },
  { code: "B01", name: "露天囤", kind: "barn" as const, capacity: 1200, slots: 4 },
  { code: "J01", name: "接收工作塔", kind: "silo" as const, capacity: 5000, slots: 3 },
];

let slotSeq = 0;
export const warehouses: Warehouse[] = WAREHOUSE_SEED.map((w, wi) => ({
  id: wi + 1,
  code: w.code,
  name: w.name,
  kind: w.kind,
  capacity_ton: w.capacity,
  is_active: 1,
  slots: Array.from({ length: w.slots }, (_, si) => ({
    id: ++slotSeq,
    warehouse_id: wi + 1,
    code: `${w.code}-${pad(si + 1)}`,
    label: `${w.name} ${si + 1}号位`,
    is_active: w.kind === "barn" && si === w.slots - 1 ? 0 : 1,
  })),
}));

export const ALL_SLOTS = warehouses.flatMap((w) => w.slots.map((s) => ({ ...s, warehouse: w })));

/* ---------------------------------------------------------- 收购价目表 */

export const GRADES: Grade[] = ["一等", "二等", "三等", "四等", "等外"];

const GRADE_DELTA: Record<Grade, number> = {
  一等: 4000, 二等: 2000, 三等: 0, 四等: -3000, 等外: -6000,
};

let priceSeq = 0;
export const priceLists: PriceList[] = [];
VARIETY_SPECS.forEach((v, vi) => {
  // 每个品种两段生效期，模拟"调价"，价目表页能看到历史区间与现行区间
  const phases = [
    { from: dateKey(addDays(TODAY, -HISTORY_DAYS - 30)), to: dateKey(addDays(TODAY, -6)), delta: -8000, note: "调价前" },
    { from: dateKey(addDays(TODAY, -5)), to: "9999-12-31", delta: 0, note: "" },
  ];
  for (const ph of phases) {
    for (const g of GRADES) {
      priceLists.push({
        id: ++priceSeq,
        variety_id: vi + 1,
        grade: g,
        price_fen_per_ton: v.basePrice + ph.delta + GRADE_DELTA[g],
        effective_from: ph.from,
        effective_to: ph.to,
        basis: g === "三等" ? "国标三等为计价基础" : "按三等梯度调整",
        made_by: STATION_MASTER_ID,
        approved_by: STATION_MASTER_ID,
        remark: ph.note || null,
      });
    }
  }
});

export function lookupPrice(varietyId: number, grade: Grade, date: string): PriceList | null {
  return (
    priceLists.find(
      (p) => p.variety_id === varietyId && p.grade === grade && p.effective_from <= date && date <= p.effective_to,
    ) ?? null
  );
}

/* ------------------------------------------------------------- 售粮人档案 */

const SURNAMES = "王李张刘陈杨黄赵周吴徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤";
const GIVEN = ["建国", "志强", "秀英", "桂兰", "德福", "长江", "卫东", "淑珍", "春华", "建军", "红梅", "国庆", "艳秋", "维桢", "照民", "玉山", "学礼", "爱华", "书田", "福生", "昌顺", "振邦", "明轩", "宗佑", "秋香", "廷相"];
const VILLAGES = ["李楼村", "大朱庄", "双庙村", "杨湾村", "五里堡", "前张营", "后李台", "砖河村"];
const TOWNS = ["川汇区", "淮阳区", "太康县", "扶沟县", "西华县", "商水县"];

const PARTY_PLAN: { type: PartyType; n: number }[] = [
  { type: "farmer", n: 15 },
  { type: "large_grower", n: 4 },
  { type: "broker", n: 3 },
  { type: "cooperative", n: 3 },
  { type: "company", n: 2 },
];

export const parties: Party[] = [];
{
  let seq = 0;
  for (const plan of PARTY_PLAN) {
    for (let i = 0; i < plan.n; i++) {
      seq += 1;
      const slot = pick(ALL_SLOTS);
      const heavy = plan.type === "company" || plan.type === "cooperative" || plan.type === "broker";
      const baseTare = heavy ? int(140000, 180000) * 10 : plan.type === "large_grower" ? int(90000, 140000) * 10 : int(9000, 16000);
      const name =
        plan.type === "company"
          ? `${pick(["邦禾", "豫东", "中裕", "金穗"])}粮油贸易有限公司`
          : plan.type === "cooperative"
            ? `${pick(VILLAGES)}${pick(["农机", "种植", "丰穗", "沃土"])}专业合作社`
            : `${SURNAMES[int(0, SURNAMES.length - 1)]}${pick(GIVEN)}`;
      const hasBank = chance(0.65);
      const credit = heavy ? int(20, 80) * 1000000 : chance(0.18) ? int(5, 20) * 1000000 : 0;
      parties.push({
        id: seq,
        code: `P${pad(seq, 4)}`,
        name,
        party_type: plan.type,
        id_card_no: makeIdCard(int, pick),
        id_card_verified: chance(0.72) ? 1 : 0,
        phone: `1${pick(["3", "5", "7", "8", "9"])}${int(0, 9)}${pad(int(10000000, 99999999), 8)}`,
        address: `河南省${pick(TOWNS)}${pick(VILLAGES)}`,
        bank_name: hasBank ? pick(["农商行", "邮政储蓄", "农业银行", "村镇银行"]) : null,
        bank_account: hasBank ? `62${pad(int(10, 99))}${pad(int(10000000, 99999999), 8)}${pad(int(1000, 9999), 4)}` : null,
        credit_limit_fen: credit,
        default_warehouse_id: slot.warehouse.id,
        default_slot_id: slot.id,
        default_vehicle_no: heavy ? makePlate(int, pick) : chance(0.5) ? makePlate(int, pick) : null,
        last_tare_01kg: baseTare,
        remark: credit > 0 ? "允许挂账，月底结清" : chance(0.14) ? pick(["常年送粮", "要求当场结清", "自留种", "雨天需加扣水"]) : null,
        status: chance(0.94) ? "active" : "disabled",
        created_at: dateKey(addDays(TODAY, -int(200, 900))),
      });
    }
  }
}

export const ACTIVE_PARTIES = parties.filter((p) => p.status === "active");
export const partyOf = (id: number): Party => parties.find((p) => p.id === id)!;
export const varietyOf = (id: number): GrainVariety => varieties.find((v) => v.id === id)!;
export const slotOf = (id: number | null | undefined) => ALL_SLOTS.find((s) => s.id === id) ?? null;

/* --------------------------------------------------------------- 设备配置 */

export const devices: DeviceConfig[] = [
  {
    id: 1, code: "scale1", name: "1 号汽车衡（耀华 XK3190-A9）", kind: "scale", driver: "yaohua_xk3190",
    config: { port: "COM3", baud: 9600, dataBits: 8, parity: "None", stopBits: 1, division: "10 kg", frameFamily: "A" },
    is_enabled: 1, is_mock: 0, is_default: 1, last_status: "online", last_ok_at: "刚刚", last_error: null, err_count: 0,
  },
  {
    id: 2, code: "scale2", name: "2 号地磅（托利多，备用）", kind: "scale", driver: "toledo",
    config: { port: "COM4", baud: 9600, division: "20 kg", frameFamily: "B" },
    is_enabled: 0, is_mock: 0, is_default: 0, last_status: "offline", last_ok_at: `${HISTORY_DAYS > 5 ? 6 : 3} 天前`, last_error: "串口未连接或线缆松动", err_count: 12,
  },
  {
    id: 3, code: "idcard1", name: "华视 CRB-6101（x86 桥接进程）", kind: "idcard", driver: "bridge_exe",
    config: { exe: "idcard-bridge-x86.exe", portRange: "49152-49252", photo: "true", licenseFile: "C:\\termb.lic" },
    is_enabled: 1, is_mock: 0, is_default: 1, last_status: "online", last_ok_at: "2 分钟前", last_error: null, err_count: 0,
  },
  {
    id: 4, code: "cam1", name: "磅区抓拍（海康 ISAPI）", kind: "camera", driver: "hikvision_isapi",
    config: { host: "192.168.1.64", user: "weigh", snapshotUrl: "/ISAPI/Streaming/channels/101/picture", triggerOn: "capture" },
    is_enabled: 1, is_mock: 0, is_default: 1, last_status: "online", last_ok_at: "1 分钟前", last_error: null, err_count: 0,
  },
  {
    id: 5, code: "cam2", name: "卸粮口（大华 CGI）", kind: "camera", driver: "dahua_cgi",
    config: { host: "192.168.1.65", user: "admin", snapshotUrl: "/cgi-bin/snapshot.cgi?channel=1" },
    is_enabled: 1, is_mock: 0, is_default: 0, last_status: "error", last_ok_at: "昨天 17:20", last_error: "HTTP 401 口令已变更", err_count: 7,
  },
  {
    id: 6, code: "prn_main", name: "码单打印机 HP LaserJet M403d", kind: "printer", driver: "preview",
    config: { paper: "A4", duplex: "long-edge", margins: "12/12/8/8 mm", silent: "false" },
    is_enabled: 1, is_mock: 0, is_default: 1, last_status: "online", last_ok_at: "3 分钟前", last_error: null, err_count: 0,
  },
  {
    id: 7, code: "prn_dot", name: "241 针式（内部流转单）", kind: "printer", driver: "raw_escp",
    config: { paper: "dot241", copies: 3, rawQueue: "EPSON LQ-630K" },
    is_enabled: 1, is_mock: 0, is_default: 0, last_status: "offline", last_ok_at: "3 天前", last_error: "脱机 / 缺纸", err_count: 3,
  },
  {
    id: 8, code: "prn_ticket", name: "58 热敏小票", kind: "printer", driver: "raw_escpos",
    config: { paper: "thermal58", width: 384, rawQueue: "GPP-312" },
    is_enabled: 0, is_mock: 0, is_default: 0, last_status: "unknown", last_ok_at: null, last_error: null, err_count: 0,
  },
  {
    id: 9, code: "led1", name: "户外 LED 显示屏", kind: "led", driver: "mock",
    config: { host: "192.168.1.70", lines: 2 },
    is_enabled: 0, is_mock: 1, is_default: 0, last_status: "unknown", last_ok_at: null, last_error: null, err_count: 0,
  },
  {
    id: 10, code: "signpad1", name: "电子签名板", kind: "signpad", driver: "hidapi",
    config: { vid: "0x056a", pid: "0x00b1" },
    is_enabled: 0, is_mock: 0, is_default: 0, last_status: "unknown", last_ok_at: null, last_error: null, err_count: 0,
  },
];

export const defaultDevice = (kind: DeviceConfig["kind"]) =>
  devices.find((d) => d.kind === kind && d.is_default === 1) ?? devices.find((d) => d.kind === kind) ?? null;

/* ------------------------------------------------------------- 系统参数 */

export const settings: AppSetting[] = [
  { key: "station_name", value: station.name, label: "站点名称", group: "doc", kind: "text", hint: "打印抬头第一行" },
  { key: "doc_no_prefix_BD", value: "BD", label: "磅单前缀", group: "doc", kind: "text" },
  { key: "doc_no_seq_len", value: "6", label: "流水号位数", group: "doc", kind: "number", hint: "按站点+前缀+年月归零重排" },
  { key: "scale_division_01kg", value: "100", label: "地磅分度值（0.1kg）", group: "weigh", kind: "number", hint: "100 即 10 kg" },
  {
    key: "weight_rounding_mode", value: "nearest_div", label: "读数对齐方式", group: "weigh", kind: "select",
    options: [{ value: "floor", label: "向下取整" }, { value: "half_up", label: "四舍五入" }, { value: "nearest_div", label: "就近分度" }],
  },
  { key: "stable_window_ms", value: "1500", label: "判稳窗口（毫秒）", group: "weigh", kind: "number" },
  { key: "stable_tolerance_01kg", value: "50", label: "判稳波动容差（0.1kg）", group: "weigh", kind: "number" },
  { key: "tare_tolerance_ratio", value: "5", label: "皮重偏差容差（%）", group: "weigh", kind: "number", hint: "超出即弹授权框" },
  { key: "open_order_alert_minutes", value: "30", label: "在途停留提醒（分钟）", group: "weigh", kind: "number" },
  { key: "settle_merge_by_day", value: "true", label: "同人同日合并结算", group: "settle", kind: "bool" },
  { key: "payment_due_days", value: "3", label: "付款时效（天）", group: "settle", kind: "number", hint: "超期进入看板告警" },
  { key: "allow_credit", value: "true", label: "允许挂账", group: "settle", kind: "bool" },
  {
    key: "print_channel", value: "preview", label: "打印通道", group: "print", kind: "select",
    options: [{ value: "preview", label: "窗口预览" }, { value: "pdf_silent", label: "PDF 静默" }, { value: "raw", label: "RAW 直连" }],
    hint: "Tauri v2 无静默打印 API，默认走预览窗口",
  },
  { key: "print_paper", value: "A4", label: "码单纸型", group: "print", kind: "select", options: [{ value: "A4", label: "A4 激光" }, { value: "dot241", label: "241 针式" }, { value: "thermal58", label: "58 热敏" }] },
  { key: "print_copies", value: "3", label: "联数（存根/财务/客户）", group: "print", kind: "number" },
  { key: "reprint_need_auth", value: "true", label: "补打需站长授权", group: "print", kind: "bool" },
  { key: "capture_keep_days", value: "365", label: "抓拍留存（天）", group: "retain", kind: "number" },
  { key: "retention_sample_days", value: "30", label: "留样保存（天）", group: "retain", kind: "number" },
  { key: "pii_mask_id_card", value: "true", label: "界面掩码身份证号", group: "retain", kind: "bool" },
  { key: "backup_keep_count", value: "14", label: "备份保留份数", group: "retain", kind: "number" },
];

export function settingValue(key: string, fallback = ""): string {
  return settings.find((s) => s.key === key)?.value ?? fallback;
}

/* --------------------------------------------------------- 单据号生成器 */

const seqCounter: Record<string, number> = {};
export function docNo(prefix: string, date: string): string {
  const key = `${prefix}:${station.code}:${date.slice(0, 4)}${date.slice(5, 7)}`;
  seqCounter[key] = (seqCounter[key] ?? 0) + 1;
  return `${prefix}${station.code}${date.slice(0, 4)}${date.slice(5, 7)}${pad(seqCounter[key], 6)}`;
}

/** 下一个磅单号（工作台取号预览用，不消耗真实流水） */
export function previewOrderNo(date: string): string {
  const key = `BD:${station.code}:${date.slice(0, 4)}${date.slice(5, 7)}`;
  return `BD${station.code}${date.slice(0, 4)}${date.slice(5, 7)}${pad((seqCounter[key] ?? 0) + 1, 6)}`;
}
