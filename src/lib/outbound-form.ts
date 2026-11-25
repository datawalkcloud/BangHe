/**
 * 出库单表单的**模型**（02 §M11 F11.1）：草稿态的字段集、单位换算、必填判据。
 *
 * 为什么单独一份：出库有两个填写入口——「库存与出库」列表/详情的弹窗表单
 * （`OutboundFormDialog`）与磅房工作台出库模式那格的就地编辑
 * （`OutboundFormPanel`）。两边各写一套 ÷1000 与「还差哪几项」，迟早一边改成元/公斤、
 * 另一边还按元/吨判，而这两个入口写的必须是同一行账。
 *
 * 界面纪律不变：**校验以后端为准**（`outbound.rs::validate_save` 的中文短句原样透传），
 * 这里只做「一眼能看出没填」的即时提示与超库存参考数，不另立一套判据。
 */
import { amountFen } from "@/lib/calc";
import type { OutboundKind } from "@/lib/constants";
import { fromKg, fromYuanPerKg, toYuanPerKg, todayISO } from "@/lib/format";
import type { OutboundOrder, OutboundSaveInput } from "@/mock/types";

/** 表单态一律用「人看的单位」（kg / 元每公斤），提交时才换算成定点整数，避免两处 ÷1000 各算各的 */
export interface OutboundDraft {
  kind: OutboundKind;
  business_date: string;
  party_id: string;
  counterparty_label: string;
  variety_id: string;
  grade: string;
  warehouse_id: string;
  slot_id: string;
  vehicle_no: string;
  driver_name: string;
  net_kg: string;
  price_yuan_kg: string;
  remark: string;
}

export const EMPTY_OUTBOUND_DRAFT: OutboundDraft = {
  kind: "sale",
  business_date: todayISO(),
  party_id: "",
  counterparty_label: "",
  variety_id: "",
  grade: "",
  warehouse_id: "",
  slot_id: "",
  vehicle_no: "",
  driver_name: "",
  net_kg: "",
  price_yuan_kg: "",
  remark: "",
};

export function outboundDraftOf(o: OutboundOrder | null): OutboundDraft {
  if (!o) return { ...EMPTY_OUTBOUND_DRAFT, business_date: todayISO() };
  return {
    kind: o.kind,
    business_date: o.business_date,
    party_id: o.party_id == null ? "" : String(o.party_id),
    counterparty_label: o.counterparty_label ?? "",
    variety_id: o.variety_id == null ? "" : String(o.variety_id),
    grade: o.grade ?? "",
    warehouse_id: String(o.warehouse_id),
    slot_id: o.slot_id == null ? "" : String(o.slot_id),
    vehicle_no: o.vehicle_no ?? "",
    driver_name: o.driver_name ?? "",
    net_kg: o.net_weight_01kg == null ? "" : String(o.net_weight_01kg / 10),
    price_yuan_kg: o.price_fen_per_ton == null ? "" : String(toYuanPerKg(o.price_fen_per_ton)),
    remark: o.remark ?? "",
  };
}

/**
 * 还差哪几项 = 后端 `validate_save` 的必填集（仓房、品种，销售出库再加领出方档案）。
 * 灰按钮不解释自己只会让人反复点，所以两边都把缺的项念出来。
 */
export function missingOutboundFields(d: OutboundDraft): string[] {
  return [
    d.warehouse_id === "" && "出仓仓房",
    d.variety_id === "" && "品种",
    d.kind === "sale" && d.party_id === "" && "领出方档案",
  ].filter(Boolean) as string[];
}

/** 数字格换算：空 → null；填了但不是个数 → `bad` 里说清是哪一格（别把 "2.6x" 悄悄存成 0） */
export function outboundNumbers(d: OutboundDraft): { net01: number | null; priceFen: number | null; bad: string | null } {
  const num = (raw: string, label: string): { v: number | null; bad: string | null } => {
    const t = raw.trim();
    if (t === "") return { v: null, bad: null };
    const n = Number(t.replace(/[,，\s]/g, ""));
    return Number.isFinite(n) ? { v: n, bad: null } : { v: null, bad: `${label}「${t}」不是个数` };
  };
  const net = num(d.net_kg, "出库净重");
  const price = num(d.price_yuan_kg, "单价");
  return {
    net01: net.v == null ? null : Math.round(fromKg(net.v)),
    priceFen: price.v == null ? null : Math.round(fromYuanPerKg(price.v)),
    bad: net.bad ?? price.bad,
  };
}

/** 货款试算（与销售出库才计价同一条判据，仅用于界面回显） */
export function outboundGoodsFen(d: OutboundDraft): number | null {
  const { net01, priceFen } = outboundNumbers(d);
  return d.kind === "sale" && net01 != null && priceFen != null ? amountFen(net01, priceFen) : null;
}

/** 本单是否已过地磅（0029）：判据是毛/皮任一非空，不是 `weight_source === 'scale'` */
export function outboundWeighed(o: OutboundOrder | null | undefined): boolean {
  return o?.gross_weight_01kg != null || o?.tare_weight_01kg != null;
}

/**
 * 表单态 → `api.saveOutbound` 入参。`orderNo` 传 null 即新建（后端取 CK 号）。
 * 登记出库那一支单价一律留空：填了会被后端打回，与其让人填完再拒，不如不送。
 */
export function outboundSaveInput(d: OutboundDraft, orderNo: string | null, operatorId: number): OutboundSaveInput {
  const isSale = d.kind === "sale";
  const { net01, priceFen } = outboundNumbers(d);
  return {
    order_no: orderNo,
    kind: d.kind,
    business_date: d.business_date,
    party_id: d.party_id === "" ? null : Number(d.party_id),
    counterparty_label: d.counterparty_label.trim() || null,
    variety_id: d.variety_id === "" ? null : Number(d.variety_id),
    grade: d.grade || null,
    warehouse_id: Number(d.warehouse_id),
    slot_id: d.slot_id === "" ? null : Number(d.slot_id),
    vehicle_no: d.vehicle_no.trim() || null,
    driver_name: d.driver_name.trim() || null,
    net_weight_01kg: net01,
    price_fen_per_ton: isSale ? priceFen : null,
    remark: d.remark.trim() || null,
    operator_id: operatorId,
  };
}
