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
  QuickOption,
  Station,
  UserAccount,
  Warehouse,
} from "./types";
import type { Grade, PartyType, QuickOptionKind, Role } from "@/lib/constants";
import {
  CARD_RETIRE_REASONS,
  ODOR_PRESETS,
  ORDER_REMARK_PRESETS,
  PRICE_REASONS,
  QUICK_OPTION_KINDS,
  REJECT_REASONS,
  VOID_REASONS,
} from "@/lib/constants";
import { demoSettings } from "@/lib/settings-catalog";
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
  name: "磅禾粮食收储站",
  address: "河南省周口市川汇区磅禾路 8 号",
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
  // 期初是"建库那一刻手里已有的实存"。四行刻意铺成三种状态：细分到品种 / 申报 0（空仓起账）
  // / 从没申报，界面上「没填」与「填了 0」必须长得不一样，否则站长分不清哪间仓建过账。
  { code: "C01", name: "1号仓库", kind: "house" as const, capacity: 3000, opening: 800, openingVariety: 1, slots: 6 },
  { code: "C02", name: "2号仓库", kind: "house" as const, capacity: 2500, opening: 0, openingVariety: null, slots: 5 },
  { code: "B01", name: "露天囤", kind: "barn" as const, capacity: 1200, opening: null, openingVariety: null, slots: 4 },
  { code: "J01", name: "接收工作塔", kind: "silo" as const, capacity: 5000, opening: null, openingVariety: null, slots: 3 },
];

/**
 * 仓房种子的形状：只有**档案态**字段（期初也算——它是站长建库时填的那一格）。
 * 结存 / 待入账 / 剩余容量是库存账算出来的，由 `mock/outbound.ts` 现算、`api.warehouses()`
 * 挂上：种子手抄一份结存就成了会过期的假账，与真库「期初本身就是 §9.23 一笔流水」不同构。
 */
export type WarehouseSeed = Omit<Warehouse, "balance_01kg" | "pending_in_01kg" | "remain_01kg">;

let slotSeq = 0;
export const warehouses: WarehouseSeed[] = WAREHOUSE_SEED.map((w, wi) => ({
  id: wi + 1,
  code: w.code,
  name: w.name,
  kind: w.kind,
  capacity_ton: w.capacity,
  // 吨 → 0.1kg 只在这一处换算一次（1 吨 = 10000 个 0.1kg），界面与账上都不再出现第二种单位
  opening_01kg: w.opening == null ? null : Math.round(w.opening * 10_000),
  opening_variety_id: w.openingVariety,
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
          ? `${pick(["磅禾", "豫东", "中裕", "金穗"])}粮油贸易有限公司`
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
        // 人像选填：自然人多走"刷证建档"，卡面照片当时就带进来了；单位是手工建的，本来就没照片
        photo_attachment_id:
          plan.type === "farmer" || plan.type === "large_grower" ? (chance(0.62) ? 9000 + seq : null) : null,
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
    // 现场实机（2026-09-11 接入）：精伦 Routon iDR，加载 resources/sdtapi/ 下的 64 位 Sdtapi.dll 进程内直调，
    // 不再有 x86 桥接子进程与端口段。一台机两条通道（身份证 SAM + IC/Mifare），能读什么由 lib/card-reader 登记。
    // 状态一律从"未检测"起，等面板真探到 SAM 号才转绿。
    id: 3, code: "idcard1", name: "证卡阅读器 精伦 Routon iDR（身份证 + IC）", kind: "idcard", driver: "routon_sdtapi",
    config: { transport: "Sdtapi.dll x64 in-process", dll: "resources/sdtapi/Sdtapi.dll", photo: "false", icKey: "FFFFFFFFFFFF" },
    is_enabled: 1, is_mock: 0, is_default: 1, last_status: "unknown", last_ok_at: null, last_error: null, err_count: 0,
  },
  {
    id: 4, code: "cam1", name: "磅区抓拍（海康 ISAPI）", kind: "camera", driver: "hikvision_isapi",
    // captureOnWeigh：这台勾了「过磅抓拍」——每次过磅（毛/皮各一捕）由它拍一张（04 §4）。
    // 与升级迁移 0019 对老库的处理一致：只把原来那台默认相机自动勾上，其余相机默认不勾。
    // 两条码流分工：snapshotUrl 指主码流 101（原图清楚，一张一张地拿），previewUrl 指子码流 102
    // （工作台常驻画面走 RTSP 拉它，见 camera_stream.rs）——RTSP 路径由 previewUrl 的通道号推出来，不必再填。
    config: {
      host: "192.168.1.64",
      user: "weigh",
      snapshotUrl: "/ISAPI/Streaming/channels/101/picture",
      previewUrl: "/ISAPI/Streaming/channels/102/picture",
      captureOnWeigh: true,
    },
    is_enabled: 1, is_mock: 0, is_default: 1, last_status: "online", last_ok_at: "1 分钟前", last_error: null, err_count: 0,
  },
  {
    id: 5, code: "cam2", name: "卸粮口（大华 CGI）", kind: "camera", driver: "dahua_cgi",
    // 大华的抓图路径里没有通道号可推（channel=1 是镜头号不是码流号），所以预览要人填 rtspUrl：subtype=1 是它的子码流。
    config: {
      host: "192.168.1.65",
      user: "admin",
      snapshotUrl: "/cgi-bin/snapshot.cgi?channel=1",
      rtspUrl: "/cam/realmonitor?channel=1&subtype=1",
    },
    is_enabled: 1, is_mock: 0, is_default: 0, last_status: "error", last_ok_at: "昨天 17:20", last_error: "HTTP 401 密码已变更", err_count: 7,
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
    // 现场实机（2026-09-11 接入）：斯普瑞特 SPRT 80mm，ESC/POS 直写 usbprint.sys，不经打印队列
    id: 8, code: "prn_ticket", name: "小票机 斯普瑞特 SPRT 80mm", kind: "printer", driver: "escpos_usbprint",
    config: { paper: "thermal80", cols: 48, vid: "0x0483", pid: "0x5720", transport: "usbprint.sys" },
    is_enabled: 1, is_mock: 0, is_default: 0, last_status: "unknown", last_ok_at: null, last_error: null, err_count: 0,
  },
];

export const defaultDevice = (kind: DeviceConfig["kind"]) =>
  devices.find((d) => d.kind === kind && d.is_default === 1) ?? devices.find((d) => d.kind === kind) ?? null;

/* ------------------------------------------------------------- 系统参数 */

/**
 * 演示值取自 `src/lib/settings-catalog.ts` 那份目录，不再手写一遍。
 * 键名与单位口径统一到 03 §9.3.1 之后，mock 再自带一套字典就是第二套事实——
 * 桌面端读库、浏览器读目录，两边共用的只能是这一份。
 */
export const settings: AppSetting[] = demoSettings().map((s) =>
  s.key === "station_name" ? { ...s, value: station.name } : s,
);

export function settingValue(key: string, fallback = ""): string {
  return settings.find((s) => s.key === key)?.value ?? fallback;
}

/* ------------------------------------------------- 常用语快捷选项（可后台维护） */

/**
 * 事由/原因/结论类文本框的下拉候选，浏览器预览的常驻小表（桌面端读 `quick_option` 表）。
 * 种子取 `src/lib/constants.ts` 那六组 presets（与 0015 迁移灌库的内容逐字一致），
 * 之后可在「基础档案 › 常用语/快捷选项」里增删改，改动只活在本会话内存里、重启回种子。
 */
function seedQuickOptions(): QuickOption[] {
  const groups: Record<QuickOptionKind, { label: string; value: string }[]> = {
    void: VOID_REASONS.map((p) => ({ label: p.label, value: p.reason })),
    price: PRICE_REASONS.map((p) => ({ label: p.label, value: p.value })),
    reject: REJECT_REASONS.map((p) => ({ label: p.label, value: p.value })),
    card_retire: CARD_RETIRE_REASONS.map((p) => ({ label: p.label, value: p.value })),
    remark: ORDER_REMARK_PRESETS.map((p) => ({ label: p.label, value: p.value })),
    odor: ODOR_PRESETS.map((p) => ({ label: p.label, value: p.value })),
  };
  const rows: QuickOption[] = [];
  let seq = 0;
  for (const { kind } of QUICK_OPTION_KINDS) {
    groups[kind].forEach((p, i) => {
      rows.push({ id: ++seq, kind, label: p.label, value: p.value, sort_order: i + 1, is_active: 1 });
    });
  }
  return rows;
}

export const quickOptions: QuickOption[] = seedQuickOptions();

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
