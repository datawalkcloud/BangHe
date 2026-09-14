/**
 * 粮食出库与库存账的演示层（02 §M11、03 §9.28 / §9.23）。
 *
 * 与 Rust 侧 `outbound.rs` / `stock.rs` 同语义，逐条对齐，不做「演示层可以随便糊」：
 *  1. **校验短句一字不差**——面板 `onError` 直接把这句话透传给用户，
 *     浏览器预览和桌面端必须听到同一句话，否则演示里过、现场红的。
 *  2. **超库存只警示不拦车**：账面结存不够时照常完成出库，写一句 `stock_warning`。
 *  3. **过账即落账**：完成出库同时留下出库流水；红冲补一条对称入库流水并把
 *     `reversal_of_id` 指回被冲那条，**原流水永不删改**。
 *  4. **结存照样按 Σ入 − Σ出 真算**：入这一腿从 mock 磅单派生（已结算及之后且登记了
 *     去向的那些），判据与 `stock::IN_QUALIFIED` / 迁移 0021 逐字相同。
 *     浏览器里那本账因此不是道具——它跟桌面端会给出同一个数。
 *
 * 造数走种子随机（`mulberry32`），刷新后所有数字完全一致，截图与验收清单可复现。
 */
import type {
  OutboundCloseInput,
  OutboundCompleteInput,
  OutboundDetail,
  OutboundFilters,
  OutboundOrder,
  OutboundPage,
  OutboundSaveInput,
  MovementFilters,
  MovementPage,
  StockBalanceRow,
  StockMovementRow,
} from "./types";
import { amountFen } from "@/lib/calc";
import { GRADES } from "@/lib/constants";
import { parties, users, varieties, warehouses, TODAY, int, pick } from "./masters";
import { orders } from "./orders";
import { dateKey, isoOf, pad } from "./rng";

/** 站内经办人里能开出库单的那几位（值仓/站长/磅员/登记员）。 */
const KEEPERS = users.filter((u) =>
  ["station_master", "keeper", "weigher", "registrar"].includes(u.role),
);

/** 演示用的下游买家：`sale` 单要挂在档案上，取企业/经纪人类的两家。 */
function buyerPool() {
  const pool = parties.filter((p) => p.status === "active" && (p.party_type === "company" || p.party_type === "broker"));
  return pool.length ? pool : parties.filter((p) => p.status === "active").slice(0, 3);
}

/* ---------------------------------------------------------------- 出库流水（出腿） */

/**
 * 出库侧流水。与真库一样 append-only：完成出库加一条 `out`，红冲加一条对称 `in`，
 * 谁都不许改历史行。入库侧不在这里存——那是磅单的投影，每次现算（见 `inMovements`）。
 */
interface OutLegMove {
  id: number;
  kind: "in" | "out";
  outbound_id: number;
  /** 红冲的对称入库行指回被它冲掉的那条出库行 id */
  reversal_of_id: number | null;
  party_id: number | null;
  variety_id: number | null;
  grade: string | null;
  /** 出库扣在 from，红冲的对称行还回 to */
  from_warehouse_id: number | null;
  from_slot_id: number | null;
  to_warehouse_id: number | null;
  to_slot_id: number | null;
  weight_01kg: number;
  price_fen_per_ton: number | null;
  amount_fen: number | null;
  business_date: string;
  operated_at: string;
  operator_id: number;
  operator_name: string;
  remark: string | null;
}

let moveSeq = 1;
const outLeg: OutLegMove[] = [];

/** 与 `stock::IN_QUALIFIED` 逐字同口径：只认已结算及之后、且登记了去向、不是红冲单的磅单。 */
function inQualified() {
  return orders.filter(
    (o) =>
      o.warehouse_id != null &&
      o.settlement_weight_01kg != null &&
      ["settled", "paid", "archived"].includes(o.status) &&
      o.reversed_order_id == null,
  );
}

/** 已称完、去向已定、但还没结算（数量未定）的那部分——单列一栏，不静默消失。 */
function pendingInByCell() {
  const map = new Map<string, number>();
  for (const o of orders) {
    if (
      o.warehouse_id == null ||
      o.net_weight_01kg == null ||
      o.reversed_order_id != null ||
      !["gross_weighed", "tare_weighed", "reweigh", "to_settle"].includes(o.status)
    )
      continue;
    const key = `${o.warehouse_id}|${o.variety_id ?? 0}`;
    map.set(key, (map.get(key) ?? 0) + o.net_weight_01kg);
  }
  return map;
}

/** 入库侧投影：每次现算，真相在磅单上（与真库的 `sync_in_movement` 同一套判据）。 */
function inMovements(): StockMovementRow[] {
  return inQualified().map((o) => ({
    id: -o.id, // 负数：派生行没有自己的库 id，别让它与出库流水的 id 撞上
    kind: "in" as const,
    signed_01kg: o.settlement_weight_01kg ?? 0,
    weight_01kg: o.settlement_weight_01kg ?? 0,
    order_id: o.id,
    order_no: o.order_no,
    outbound_id: null,
    outbound_no: null,
    party_id: o.party_id,
    party_name: o.party_name,
    variety_id: o.variety_id,
    variety_name: o.variety_name,
    grade: o.grade,
    warehouse_id: o.warehouse_id,
    warehouse_name: o.warehouse_name,
    from_warehouse_id: null,
    from_warehouse_name: null,
    to_warehouse_id: o.warehouse_id,
    to_warehouse_name: o.warehouse_name,
    amount_fen: o.goods_amount_fen,
    business_date: o.business_date,
    operated_at: o.settled_at ?? o.created_at,
    operator_name: "由磅单派生",
    reversal_of_id: null,
    remark: "入仓投影（去向已定，数量以结算重量为准）",
  }));
}

function outLegRows(): StockMovementRow[] {
  const whName = (id: number | null) => warehouses.find((w) => w.id === id)?.name ?? null;
  const pName = (id: number | null) => parties.find((p) => p.id === id)?.name ?? null;
  const vName = (id: number | null) => varieties.find((v) => v.id === id)?.name ?? null;
  return outLeg.map((m) => ({
    id: m.id,
    kind: m.kind,
    signed_01kg: m.kind === "in" ? m.weight_01kg : -m.weight_01kg,
    weight_01kg: m.weight_01kg,
    order_id: null,
    order_no: null,
    outbound_id: m.outbound_id,
    outbound_no: docs.find((d) => d.id === m.outbound_id)?.order_no ?? null,
    party_id: m.party_id,
    party_name: pName(m.party_id),
    variety_id: m.variety_id,
    variety_name: vName(m.variety_id),
    grade: m.grade,
    warehouse_id: m.kind === "in" ? m.to_warehouse_id : m.from_warehouse_id,
    warehouse_name: whName(m.kind === "in" ? m.to_warehouse_id : m.from_warehouse_id),
    from_warehouse_id: m.from_warehouse_id,
    from_warehouse_name: whName(m.from_warehouse_id),
    to_warehouse_id: m.to_warehouse_id,
    to_warehouse_name: whName(m.to_warehouse_id),
    amount_fen: m.amount_fen,
    business_date: m.business_date,
    operated_at: m.operated_at,
    operator_name: m.operator_name,
    reversal_of_id: m.reversal_of_id,
    remark: m.remark,
  }));
}

/**
 * 期初建账行（0022）：真库里它是 `stock_movement` 的一条 `kind='in'` 流水，mock 也不把它
 * 躺在档案列上——每次现算成流水形状，`stockBalance()` 与 `available01kg()` 才会一起吃进去，
 * 浏览器里那本账与桌面端才会给出同一个数。
 * id 取 `-1_000_000 - warehouse_id`：派生行没有自己的库 id，与 `inMovements` 的负数约定同一段，
 * 但要避开磅单派生行（`-order_id`）与出库流水（正 id）已经占用的号位。
 */
function openingMoves(): StockMovementRow[] {
  return warehouses
    .filter((w) => w.opening_01kg != null)
    .map((w) => ({
      id: -1_000_000 - w.id,
      kind: "in" as const,
      signed_01kg: w.opening_01kg ?? 0,
      weight_01kg: w.opening_01kg ?? 0,
      order_id: null,
      order_no: null,
      outbound_id: null,
      outbound_no: null,
      party_id: null,
      party_name: null,
      variety_id: w.opening_variety_id,
      variety_name: vName(w.opening_variety_id),
      grade: null,
      warehouse_id: w.id,
      warehouse_name: w.name,
      from_warehouse_id: null,
      from_warehouse_name: null,
      to_warehouse_id: w.id,
      to_warehouse_name: w.name,
      amount_fen: null,
      business_date: dateKey(TODAY),
      operated_at: isoOf(TODAY),
      operator_name: "由仓房档案派生",
      reversal_of_id: null,
      remark: "期初建账（仓房档案录入，不来自磅单/出库单）",
    }));
}

const allMoves = () => [...inMovements(), ...openingMoves(), ...outLegRows()];

/* --------------------------------------------------------------------- 结存与流水 */

/**
 * 仓房粒度的汇总（跨品种合并），与 `stock::warehouse_totals` 同口径：判据一律复用本模块
 * 的 `allMoves()` 与 `pendingInByCell()`，这里只换聚合粒度，不另写一套「仓里有多少粮」。
 */
export function warehouseTotals(): Map<
  number,
  { opening_01kg: number | null; opening_variety_id: number | null; balance_01kg: number; pending_in_01kg: number }
> {
  const map = new Map<
    number,
    { opening_01kg: number | null; opening_variety_id: number | null; balance_01kg: number; pending_in_01kg: number }
  >();
  const touch = (whId: number) => {
    let t = map.get(whId);
    if (!t) {
      const seed = warehouses.find((w) => w.id === whId);
      t = {
        opening_01kg: seed?.opening_01kg ?? null,
        opening_variety_id: seed?.opening_variety_id ?? null,
        balance_01kg: 0,
        pending_in_01kg: 0,
      };
      map.set(whId, t);
    }
    return t;
  };
  for (const w of warehouses) touch(w.id);
  for (const m of allMoves()) {
    if (m.warehouse_id == null) continue; // 与真库一致：归不到仓房的流水不参与容量
    touch(m.warehouse_id).balance_01kg += m.signed_01kg;
  }
  // 待入账的键是 `仓房|品种`，这里只要仓房那一截
  for (const [key, qty] of pendingInByCell()) {
    const whId = Number(key.split("|")[0]);
    if (Number.isFinite(whId)) touch(whId).pending_in_01kg += qty;
  }
  return map;
}

/** 账面结存（0.1kg）：入库为正、出库为负。与 `stock::available_01kg` 同式。 */
function available01kg(warehouseId: number, varietyId: number | null): number {
  return allMoves()
    .filter((m) => m.warehouse_id === warehouseId && (m.variety_id ?? null) === (varietyId ?? null))
    .reduce((s, m) => s + m.signed_01kg, 0);
}

export function stockBalance(): StockBalanceRow[] {
  const cells = new Map<string, StockBalanceRow>();
  const touch = (whId: number | null, varId: number | null): StockBalanceRow | null => {
    if (whId == null) return null; // 结存按仓房聚合，无仓流水不体现在矩阵里
    const key = `${whId}|${varId ?? 0}`;
    let row = cells.get(key);
    if (!row) {
      const wh = warehouses.find((w) => w.id === whId);
      const v = varieties.find((x) => x.id === varId);
      row = {
        warehouse_id: whId,
        warehouse_code: wh?.code ?? "—",
        warehouse_name: wh?.name ?? "未知仓房",
        variety_id: varId,
        variety_code: v?.code ?? null,
        variety_name: v?.name ?? null,
        balance_01kg: 0,
        in_01kg: 0,
        out_01kg: 0,
        pending_in_01kg: 0,
        last_move_at: null,
      };
      cells.set(key, row);
    }
    return row;
  };
  for (const m of allMoves()) {
    const row = touch(m.warehouse_id, m.variety_id);
    if (!row) continue;
    if (m.kind === "in") row.in_01kg += m.weight_01kg;
    else row.out_01kg += m.weight_01kg;
    if (!row.last_move_at || m.operated_at > row.last_move_at) row.last_move_at = m.operated_at;
    row.balance_01kg = row.in_01kg - row.out_01kg;
  }
  // 只有待入账、还没有任何流水的组合也要补一行：那几吨粮不能凭空消失
  const pending = pendingInByCell();
  for (const [key, qty] of pending) {
    const [whId, varId] = key.split("|").map(Number);
    const row = touch(whId, varId === 0 ? null : varId);
    if (row) row.pending_in_01kg = qty;
  }
  return [...cells.values()].sort(
    (a, b) => a.warehouse_code.localeCompare(b.warehouse_code) || (a.variety_code ?? "").localeCompare(b.variety_code ?? ""),
  );
}

export function stockMovements(f: MovementFilters = {}): MovementPage {
  const rows = allMoves()
    .filter((m) => (f.warehouse_id ? m.warehouse_id === f.warehouse_id : true))
    .filter((m) => (f.variety_id ? m.variety_id === f.variety_id : true))
    .filter((m) => (f.kind && f.kind !== "all" ? m.kind === f.kind : true))
    .filter((m) => (f.date_from ? m.business_date >= f.date_from! : true))
    .filter((m) => (f.date_to ? m.business_date <= f.date_to! : true))
    .sort((a, b) => (a.operated_at < b.operated_at ? 1 : a.operated_at > b.operated_at ? -1 : b.id - a.id));
  const page = f.page ?? 1;
  const size = f.page_size ?? 50;
  return { rows: rows.slice((page - 1) * size, page * size), total: rows.length };
}

/* --------------------------------------------------------------------- 出库单据 */

let docSeq = 1;
const docs: OutboundOrder[] = [];

function nextNo(businessDate: string): string {
  const ym = businessDate.slice(0, 7).replace("-", "");
  return `CK01${ym}${pad(docSeq++, 6)}`;
}

const whName = (id: number) => warehouses.find((w) => w.id === id)?.name ?? "未知仓房";
const slotLabel = (id: number | null) =>
  id == null ? null : warehouses.flatMap((w) => w.slots).find((s) => s.id === id)?.label ?? null;
const vName = (id: number | null) => varieties.find((v) => v.id === id)?.name ?? null;
const pName = (id: number | null) => parties.find((p) => p.id === id)?.name ?? null;

function snapshot(d: OutboundOrder): OutboundOrder {
  return {
    ...d,
    warehouse_name: whName(d.warehouse_id),
    slot_label: slotLabel(d.slot_id),
    variety_name: vName(d.variety_id),
    party_name: pName(d.party_id),
  };
}

/** 制单/改单共同的校验，短句与 `outbound.rs::validate_save` 逐字一致。 */
function validate(i: OutboundSaveInput): { slot_id: number | null; grade: string | null; goods: number | null } {
  if (!["sale", "record"].includes(i.kind)) {
    throw new Error(`出库性质「${i.kind}」不在值域内（sale 销售出库 / record 登记出库）`);
  }
  const wh = warehouses.find((w) => w.id === i.warehouse_id && w.is_active === 1);
  if (!wh) throw new Error("入库仓房不存在或已停用");
  let slotId: number | null = i.slot_id ?? null;
  if (slotId != null && !wh.slots.some((s) => s.id === slotId && s.is_active === 1)) {
    throw new Error("货位不存在或已停用，或不属于所选仓房");
  }
  if (i.variety_id == null) {
    throw new Error("必须指定品种：库存按 仓房 × 品种 记账，品种空的出库单结存对不上");
  }
  if (!varieties.some((v) => v.id === i.variety_id && v.is_active === 1)) {
    throw new Error("所选品种不存在或已停用，请改选在用品种");
  }
  const grade = i.grade?.trim() || null;
  if (grade && !GRADES.includes(grade as (typeof GRADES)[number])) {
    throw new Error(`等级「${grade}」不在值域内（${GRADES.join(" / ")}）`);
  }
  if (i.kind === "sale") {
    if (i.party_id == null) throw new Error("销售出库必须选领出方档案：货款要挂在谁头上");
    const p = parties.find((x) => x.id === i.party_id);
    if (!p) throw new Error("领出方档案不存在，请先在往来单位建档");
    if (p.status !== "active") {
      throw new Error(`领出方「${p.name}」档案已停用，不能开新出库单；确需出货请先启用该档案`);
    }
  } else {
    if (i.price_fen_per_ton != null) {
      throw new Error("登记出库不计价，单价请留空；要收钱请把性质改成销售出库");
    }
  }
  if (i.net_weight_01kg != null && i.net_weight_01kg <= 0) {
    throw new Error("出库净重必须大于 0；这一车什么都没出就直接作废本单");
  }
  if (i.price_fen_per_ton != null && i.price_fen_per_ton <= 0) {
    throw new Error("单价必须大于 0；不收钱的出库请把性质改成登记出库并清空单价");
  }
  const goods =
    i.kind === "sale" && i.net_weight_01kg != null && i.price_fen_per_ton != null
      ? amountFen(i.net_weight_01kg, i.price_fen_per_ton)
      : null;
  return { slot_id: slotId, grade, goods };
}

/** 库存侧警示：账面不够也放行，只把算给你看的那句话留下。 */
function warningOf(warehouseId: number, varietyId: number | null, weight: number): string | null {
  const avail = available01kg(warehouseId, varietyId);
  if (avail >= weight) return null;
  return `${whName(warehouseId)} 账面结存 ${(avail / 10000).toFixed(2)} 吨，本次出库 ${(weight / 10000).toFixed(2)} 吨，超出 ${((weight - avail) / 10000).toFixed(2)} 吨（未结算的入仓量不计入账面，出库照常放行）`;
}

export function saveOutbound(i: OutboundSaveInput): OutboundOrder {
  const { slot_id, grade, goods } = validate(i);
  const businessDate = i.business_date?.trim() || dateKey(TODAY);
  if (businessDate > dateKey(TODAY)) throw new Error(`业务日期 ${businessDate} 晚于今天，不能往未来记账`);
  const now = isoOf(new Date());
  const editor = i.order_no?.trim();
  if (!editor) {
    const keeper = KEEPERS[0] ?? users[0];
    const doc: OutboundOrder = {
      id: docSeq + 1000,
      order_no: nextNo(businessDate),
      business_date: businessDate,
      kind: i.kind,
      status: "draft",
      party_id: i.party_id ?? null,
      party_name: null,
      counterparty_label: i.counterparty_label?.trim() || null,
      variety_id: i.variety_id ?? null,
      variety_name: null,
      grade: grade as OutboundOrder["grade"],
      warehouse_id: i.warehouse_id,
      warehouse_name: "",
      slot_id,
      slot_label: null,
      vehicle_no: i.vehicle_no?.trim() || null,
      net_weight_01kg: i.net_weight_01kg ?? null,
      weight_source: "manual",
      price_fen_per_ton: i.price_fen_per_ton ?? null,
      goods_amount_fen: goods,
      // 草稿期一律 not_required：成为一笔应收发生在完成出库那一刻
      payment_status: "not_required",
      stock_warning: null,
      void_reason: null,
      remark: i.remark?.trim() || null,
      created_at: now,
      created_by: keeper.id,
      created_name: keeper.display_name,
      completed_at: null,
      completed_by: null,
      completed_name: null,
      updated_at: null,
    };
    docs.push(snapshot(doc));
    return doc;
  }
  const cur = docs.find((d) => d.order_no === editor);
  if (!cur) throw new Error("出库单不存在，可能已被删除");
  if (cur.status !== "draft") {
    throw new Error(`本单已「${STATUS_LABEL[cur.status]}」，不能再改；要更正请走红冲后另开一张`);
  }
  Object.assign(cur, {
    business_date: businessDate,
    kind: i.kind,
    party_id: i.party_id ?? null,
    counterparty_label: i.counterparty_label?.trim() || null,
    variety_id: i.variety_id ?? null,
    grade: grade as OutboundOrder["grade"],
    warehouse_id: i.warehouse_id,
    slot_id,
    vehicle_no: i.vehicle_no?.trim() || null,
    net_weight_01kg: i.net_weight_01kg ?? null,
    price_fen_per_ton: i.price_fen_per_ton ?? null,
    goods_amount_fen: goods,
    remark: i.remark?.trim() || null,
    updated_at: now,
  });
  docs[docs.indexOf(cur)] = snapshot(cur);
  return docs[docs.indexOf(cur)];
}

const STATUS_LABEL: Record<OutboundOrder["status"], string> = {
  draft: "草稿",
  done: "已出库",
  voided: "已作废",
  reversed: "已红冲",
};

export function completeOutbound(i: OutboundCompleteInput): OutboundOrder {
  const cur = docs.find((d) => d.order_no === i.order_no);
  if (!cur) throw new Error("出库单不存在，可能已被删除");
  if (cur.status === "done") throw new Error("本单已完成出库，库存已扣，无需重复操作");
  if (cur.status !== "draft") {
    throw new Error(`本单当前为「${STATUS_LABEL[cur.status]}」，不能完成出库`);
  }
  const weight = cur.net_weight_01kg;
  if (weight == null || weight <= 0) throw new Error("先把出库净重填上再完成出库：库存要扣多少，全看这一格");
  if (cur.variety_id == null) throw new Error("本单还没有品种，无法按 仓房 × 品种 扣库存");
  if (cur.kind === "sale") {
    if (cur.party_id == null) throw new Error("销售出库必须选定出方，请先修改本单");
    if (!cur.price_fen_per_ton || cur.price_fen_per_ton <= 0) {
      throw new Error("销售出库必须有单价，否则货款算不出来，请先修改本单");
    }
  }
  const goods = cur.kind === "sale" ? amountFen(weight, cur.price_fen_per_ton ?? 0) : null;
  const now = isoOf(new Date());
  const keeper = KEEPERS[0] ?? users[0];
  cur.status = "done";
  cur.goods_amount_fen = goods;
  // 销售出库到这一刻才成为一笔应收；登记出库永不进入资金流程
  cur.payment_status = cur.kind === "sale" ? "unpaid" : "not_required";
  cur.stock_warning = warningOf(cur.warehouse_id, cur.variety_id, weight);
  cur.completed_at = now;
  cur.completed_by = keeper.id;
  cur.completed_name = keeper.display_name;
  cur.updated_at = now;
  outLeg.push({
    id: moveSeq++,
    kind: "out",
    outbound_id: cur.id,
    reversal_of_id: null,
    party_id: cur.party_id,
    variety_id: cur.variety_id,
    grade: cur.grade,
    from_warehouse_id: cur.warehouse_id,
    from_slot_id: cur.slot_id,
    to_warehouse_id: null,
    to_slot_id: null,
    weight_01kg: weight,
    price_fen_per_ton: cur.price_fen_per_ton,
    amount_fen: goods,
    business_date: cur.business_date,
    operated_at: now,
    operator_id: keeper.id,
    operator_name: keeper.display_name,
    remark: `出库单 ${cur.order_no} 完成出库`,
  });
  return snapshot(docs[docs.indexOf(cur)]);
}

export function voidOutbound(i: OutboundCloseInput): OutboundOrder {
  const reason = i.reason.trim();
  if ([...reason].length < 6) throw new Error("作废原因不得少于 6 个字（迎检要看得懂为什么废）");
  const cur = docs.find((d) => d.order_no === i.order_no);
  if (!cur) throw new Error("出库单不存在，可能已被删除");
  if (cur.status === "voided") throw new Error("本单已作废，无需重复操作");
  if (cur.status !== "draft") {
    throw new Error(`本单已「${STATUS_LABEL[cur.status]}」，库存已扣，只能由站长或保管员走红冲更正`);
  }
  cur.status = "voided";
  cur.void_reason = reason;
  cur.updated_at = isoOf(new Date());
  return snapshot(cur);
}

export function reverseOutbound(i: OutboundCloseInput): OutboundOrder {
  const reason = i.reason.trim();
  if ([...reason].length < 6) {
    throw new Error("红冲原因不得少于 6 个字（这张单为什么不算了，审计要看得懂）");
  }
  const cur = docs.find((d) => d.order_no === i.order_no);
  if (!cur) throw new Error("出库单不存在，可能已被删除");
  if (cur.status === "reversed") throw new Error("本单已红冲，不能再次红冲");
  if (cur.status !== "done") {
    throw new Error(`本单当前为「${STATUS_LABEL[cur.status]}」，未过账的单直接作废即可，无需红冲`);
  }
  const target = outLeg.find((m) => m.kind === "out" && m.outbound_id === cur.id);
  if (!target) throw new Error("本单在库存账里没有出库流水，不能红冲；请先让站长核查数据");
  const now = isoOf(new Date());
  const keeper = KEEPERS[0] ?? users[0];
  cur.status = "reversed";
  cur.void_reason = reason;
  cur.updated_at = now;
  // 对称入库：粮还回原来那个仓，被冲的那条出库行原地不动、由 reversal_of_id 互相指认
  outLeg.push({
    id: moveSeq++,
    kind: "in",
    outbound_id: cur.id,
    reversal_of_id: target.id,
    party_id: target.party_id,
    variety_id: target.variety_id,
    grade: target.grade,
    from_warehouse_id: null,
    from_slot_id: null,
    to_warehouse_id: target.from_warehouse_id,
    to_slot_id: target.from_slot_id,
    weight_01kg: target.weight_01kg,
    price_fen_per_ton: target.price_fen_per_ton,
    amount_fen: target.amount_fen,
    business_date: dateKey(TODAY),
    operated_at: now,
    operator_id: keeper.id,
    operator_name: keeper.display_name,
    remark: `红冲出库单 ${cur.order_no}：${reason}`,
  });
  return snapshot(cur);
}

export function listOutbound(f: OutboundFilters = {}): OutboundPage {
  const kw = (f.keyword ?? "").trim().toLowerCase();
  const rows = docs
    .filter((d) => (f.date_from ? d.business_date >= f.date_from : true))
    .filter((d) => (f.date_to ? d.business_date <= f.date_to : true))
    .filter((d) => (f.status && f.status !== "all" ? d.status === f.status : true))
    .filter((d) => (f.kind && f.kind !== "all" ? d.kind === f.kind : true))
    .filter((d) => (f.warehouse_id ? d.warehouse_id === f.warehouse_id : true))
    .filter((d) => (f.variety_id ? d.variety_id === f.variety_id : true))
    .filter((d) =>
      kw
        ? [d.order_no, d.party_name, d.counterparty_label, d.vehicle_no].some((s) =>
            (s ?? "").toLowerCase().includes(kw),
          )
        : true,
    )
    .sort((a, b) => (a.business_date < b.business_date ? 1 : a.business_date > b.business_date ? -1 : b.id - a.id));
  // 合计与行同一条筛选：分屏对不上数是最难发现的那种错
  const summary = rows.reduce(
    (s, d) => ({
      count: s.count + 1,
      net_01kg: s.net_01kg + (d.net_weight_01kg ?? 0),
      goods_fen: s.goods_fen + (d.goods_amount_fen ?? 0),
    }),
    { count: 0, net_01kg: 0, goods_fen: 0 },
  );
  const page = f.page ?? 1;
  const size = f.page_size ?? 50;
  return { rows: rows.slice((page - 1) * size, page * size), total: rows.length, summary };
}

export function getOutbound(no: string): OutboundDetail | null {
  const d = docs.find((x) => x.order_no === no);
  if (!d) return null;
  return {
    ...d,
    movements: outLegRows().filter((m) => m.outbound_id === d.id).sort((a, b) => (a.operated_at < b.operated_at ? -1 : 1)),
  };
}

/* ------------------------------------------------------------------ 演示数据 */

/**
 * 造几张已经走完流程的出库单：先入账（有货可出），再出库，最后来一张红冲，
 * 让结存页与流水页一打开就有账可对。种子固定，刷新后数字完全一致。
 */
function seedDocs() {
  const keepers = KEEPERS.length ? KEEPERS : users.slice(0, 1);
  const buyers = buyerPool();
  const activeWh = warehouses.filter((w) => w.is_active === 1);
  const plan: { day: number; kind: "sale" | "record"; done: boolean }[] = [
    { day: -6, kind: "sale", done: true },
    { day: -5, kind: "sale", done: true },
    { day: -4, kind: "record", done: true },
    { day: -3, kind: "sale", done: true },
    { day: -2, kind: "sale", done: false },
    { day: -1, kind: "record", done: true },
    { day: 0, kind: "sale", done: false },
  ];
  for (const p of plan) {
    const date = dateKey(new Date(TODAY.getTime() + p.day * 86400000));
    const wh = pick(activeWh);
    const v = pick(varieties.filter((x) => x.is_active === 1));
    const keeper = pick(keepers);
    const buyer = p.kind === "sale" ? pick(buyers) : null;
    const weight = int(50, 180) * 1000; // 5–18 吨，0.1kg 单位
    const price = p.kind === "sale" ? int(2300, 2900) * 100 : null; // 2300–2900 元/吨，分/吨
    const created = new Date(TODAY.getTime() + p.day * 86400000);
    created.setHours(9 + int(0, 6), int(0, 59), 0, 0);
    const doc: OutboundOrder = {
      id: docSeq + 1000,
      order_no: nextNo(date),
      business_date: date,
      kind: p.kind,
      status: p.done ? "done" : "draft",
      party_id: buyer?.id ?? null,
      party_name: buyer?.name ?? null,
      counterparty_label: p.kind === "record" ? pick(["饲喂用粮", "职工食堂", "本站种子库"]) : null,
      variety_id: v.id,
      variety_name: v.name,
      grade: pick(GRADES) as OutboundOrder["grade"],
      warehouse_id: wh.id,
      warehouse_name: wh.name,
      slot_id: wh.slots.length ? pick(wh.slots).id : null,
      slot_label: null,
      vehicle_no: null,
      net_weight_01kg: weight,
      weight_source: "manual",
      price_fen_per_ton: price,
      goods_amount_fen: price != null ? amountFen(weight, price) : null,
      payment_status: p.done && p.kind === "sale" ? "unpaid" : "not_required",
      stock_warning: null,
      void_reason: null,
      remark: null,
      created_at: isoOf(created),
      created_by: keeper.id,
      created_name: keeper.display_name,
      completed_at: p.done ? isoOf(created) : null,
      completed_by: p.done ? keeper.id : null,
      completed_name: p.done ? keeper.display_name : null,
      updated_at: p.done ? isoOf(created) : null,
    };
    doc.slot_label = slotLabel(doc.slot_id);
    docs.push(doc);
    if (p.done) {
      outLeg.push({
        id: moveSeq++,
        kind: "out",
        outbound_id: doc.id,
        reversal_of_id: null,
        party_id: doc.party_id,
        variety_id: doc.variety_id,
        grade: doc.grade,
        from_warehouse_id: doc.warehouse_id,
        from_slot_id: doc.slot_id,
        to_warehouse_id: null,
        to_slot_id: null,
        weight_01kg: weight,
        price_fen_per_ton: price,
        amount_fen: doc.goods_amount_fen,
        business_date: date,
        operated_at: doc.created_at,
        operator_id: keeper.id,
        operator_name: keeper.display_name,
        remark: `出库单 ${doc.order_no} 完成出库`,
      });
    }
  }
  // 最后过账那张补一次警示判定，演示「超库存不拦车」这条口径看得见
  for (const d of docs.filter((x) => x.status === "done")) {
    d.stock_warning = warningOf(d.warehouse_id, d.variety_id, d.net_weight_01kg ?? 0);
  }
}
seedDocs();
