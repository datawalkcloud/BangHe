/**
 * 工作台录单链路的原生通道（02 §7 M2–M5；03 §3.5 编号、§4.3 不变式）。
 *
 * 与 `masters-native.ts` / `dashboard-native.ts` 同一套规矩：桌面端 invoke 走
 * 真库（`src-tauri/src/orders.rs`），浏览器预览回落 mock，演示不断线。
 * 覆盖的正是工作台跑闭环要碰的全部函数：
 *   售粮人档案（listParties / getParty / saveParty）
 *   磅单（listOrders / getOrder / openOrders / createOrder / capture）
 *   化验（listQc / saveQc）  结算（settle）  打印留痕（logPrint）
 *   事后改写磅单的定级与定种（setOrderGrade / setOrderVariety，0017 之后品种可空、结算前补定）
 * 桌面端从此「建档 → 制单 → 称重 → 化验 → 结算 → 打印 → 看板/台账」整条链
 * 读写同一颗 SQLite；单号按 §3.5 走 seq_counter（BD01+年月+6 位流水）。
 *
 * 仍留在 mock 的（各自单独一轮，别混进这次）：
 *  - 作废 / 红冲 / 复称替换（OrderDetailPage、OrdersPage 的写路径）；
 *  - 结算中心与付款登记的读（listSettlements / settlementOf / credits…）——
 *    但工作台 settle() 当场结清写下的 settlement / payment_record 已进真库，
 *    看板挂账告警能查到它们；
 *  - qcQueue、设备中心、系统参数。
 * 命令层的岗位闸门在 Rust（auth 会话为准，入参 operator_id 一律忽略）。
 */
import { runningInTauri } from "@/lib/native";
import { api as mock } from "@/mock/api";
import type { PartyDetail, PartyPhotoImage } from "@/mock/api";
import type { OrderFilters, PageResult, Party, QcReport, Settlement, WeighOrder } from "@/mock/types";
import type { OrderRow } from "@/mock/api";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : `${cmd} 调用失败`);
  }
}

/** 只读：桌面端真库、浏览器 mock，返回同一份字段 */
function route<T>(cmd: string, demo: () => Promise<T>, args?: Record<string, unknown>) {
  return (): Promise<T> => (runningInTauri() ? call<T>(cmd, args) : demo());
}

/** 带参只读 */
function route1<A extends unknown[], T>(cmd: string, demo: (...a: A) => Promise<T>) {
  return (...a: A): Promise<T> => (runningInTauri() ? call<T>(cmd, a2args(cmd, a)) : demo(...a));
}

/** 写入：input 原样透传，返回值是真库重读出来的行 */
function routeSave<T, I>(cmd: string, demo: (input: I) => Promise<T>) {
  return (input: I): Promise<T> => (runningInTauri() ? call<T>(cmd, { input }) : demo(input));
}

// route1 的参数名映射：命令 → 各位置参数在 invoke args 里的键
const ARGS_MAP: Record<string, string[]> = {
  order_get: ["no"],
  order_list: ["filters"],
  party_list: ["keyword", "partyType"],
  party_get: ["id"],
  party_photo: ["partyId"],
  capture_photo: ["attachmentId"],
  qc_list: ["opts"],
};
function a2args(cmd: string, a: unknown[]): Record<string, unknown> {
  const keys = ARGS_MAP[cmd] ?? [];
  const out: Record<string, unknown> = {};
  keys.forEach((k, i) => {
    if (a[i] !== undefined) out[k] = a[i];
  });
  return out;
}

export type PartySaveInput = Parameters<typeof mock.saveParty>[0];
export type PartyPhotoInput = Parameters<typeof mock.setPartyPhoto>[0];
export type CreateOrderInput = Parameters<typeof mock.createOrder>[0];
export type UpdateOrderInput = Parameters<typeof mock.updateOrder>[0];
export type CaptureInput = Parameters<typeof mock.capture>[0];
export type SaveQcInput = Parameters<typeof mock.saveQc>[0];
export type SettleInput = Parameters<typeof mock.settle>[0];
export type GradeAdjustInput = Parameters<typeof mock.setOrderGrade>[0];
export type VarietyAdjustInput = Parameters<typeof mock.setOrderVariety>[0];
export type PrintLogInput = Parameters<typeof mock.logPrint>[0];

export const ordersApi = {
  /* -------------------------------------------------------------- 售粮人 */
  listParties: route1<[keyword: string, type?: Party["party_type"] | "all"], Party[]>("party_list", (kw, type) => mock.listParties(kw, type)),
  getParty: route1<[id: number], PartyDetail | null>("party_get", (id) => mock.getParty(id)),
  saveParty: routeSave<Party, PartySaveInput>("party_save", (i) => mock.saveParty(i)),
  /** 档案人像的读通道：真库回附件字节的 data URL，浏览器预览回演示头像 */
  partyPhoto: route1<[partyId: number], PartyPhotoImage | null>("party_photo", (id) => mock.partyPhoto(id)),
  /** 过磅抓拍图的读通道（04 §4.3）：键是 attachment.id（一次过磅最多 3 张，逐张列），真库回附件 JPEG 的 data URL 并记 pii.read，浏览器预览回演示抓拍 */
  capturePhoto: route1<[attachmentId: number], PartyPhotoImage | null>("capture_photo", (id) => mock.capturePhoto(id)),
  /** 换/清档案人像（`source_path` 空串＝清除）。与 saveParty 分开一条：照片写不进去不该回滚已成立的建档 */
  setPartyPhoto: routeSave<Party, PartyPhotoInput>("party_photo_set", (i) => mock.setPartyPhoto(i)),

  /* -------------------------------------------------------------- 磅单 */
  listOrders: route1<[f: OrderFilters], PageResult<OrderRow>>("order_list", (f) => mock.listOrders(f)),
  getOrder: route1<[no: string], WeighOrder | null>("order_get", (no) => mock.getOrder(no)),
  openOrders: route("order_open", () => mock.openOrders()),
  createOrder: routeSave<WeighOrder, CreateOrderInput>("order_create", (i) => mock.createOrder(i)),
  /** 制单后就地补改车牌 / 备注：不碰钱与状态，过磅结算期间都允许改（对齐 Rust order_update） */
  updateOrder: routeSave<WeighOrder | null, UpdateOrderInput>("order_update", (i) => mock.updateOrder(i)),
  capture: routeSave<WeighOrder | null, CaptureInput>("order_capture", (i) => mock.capture(i)),

  /* -------------------------------------------------------------- 化验 */
  listQc: route1<[opts?: { onlyPending?: boolean; keyword?: string }], QcReport[]>("qc_list", (opts) => mock.listQc(opts)),
  saveQc: routeSave<QcReport | null, SaveQcInput>("qc_save", (i) => mock.saveQc(i)),

  /* -------------------------------------------------------------- 结算 */
  settle: routeSave<{ order: WeighOrder; settlement: Settlement } | null, SettleInput>("order_settle", (i) => mock.settle(i)),
  /** 调整等级：只改磅单的业务定级，化验单判定不动（Rust 侧与 settle 同在 orders.rs） */
  setOrderGrade: routeSave<WeighOrder | null, GradeAdjustInput>("order_set_grade", (i) => mock.setOrderGrade(i)),
  /** 调整收购品种：0017 之后品种不再挡制单，制单格 / 化验区 / 结算框三处都改磅单这一列，
   *  化验单上当初判定所用的品种快照不动（Rust 侧与 set_grade 同骨架、同 VOIDABLE 闸） */
  setOrderVariety: routeSave<WeighOrder | null, VarietyAdjustInput>("order_set_variety", (i) => mock.setOrderVariety(i)),

  /* ------------------------------------------------------------ 打印留痕 */
  logPrint: (input: PrintLogInput): Promise<void> =>
    runningInTauri() ? call<void>("print_log_add", { input }) : mock.logPrint(input),
};
