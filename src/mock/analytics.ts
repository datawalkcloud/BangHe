/**
 * 报表与看板的聚合逻辑。
 *
 * 这里刻意用 JS 累加，但**顺序与口径**严格照搬 docs/design/03 §10 的 SQL：
 *  - 剔除 voided / rejected / 未完成单，红冲单以负值参与（不变式 4）
 *  - 统计边界用 business_date 而非 created_at，避免跨零点争议
 *  - 合计与明细来自同一趟扫描，保证"总分相符"
 * 换成 SQLite 后这些函数整体删除，页面只改一次 invoke 调用。
 */
import type {
  DailyReport,
  Dashboard,
  LedgerRow,
  PartyRankRow,
  QualityReport,
  StaffLoadRow,
} from "./types";
import type { PartyType, Tone } from "@/lib/constants";
import { GRADES, PARTY_TYPE, PAYMENT_METHOD } from "@/lib/constants";
import { CASHIERS, HISTORY_DAYS, INSPECTORS, REGISTRARS, STATION_MASTER_ID, TODAY, WEIGHERS, devices, partyOf, settings, userName, varietySpec } from "./masters";
import { durationText, money } from "@/lib/format";
import { addDays, dateKey } from "./rng";
import { orders, payments, printLogs, qcOf, settlements } from "./orders";
import type { WeighOrder } from "./types";

/** 参与汇总统计的磅单：与 03 §10 报表 SQL 的 WHERE 完全一致。
 *
 * 03 §4.3 不变式 4：“作废/拒收不参与；红冲单必须参与，其负值抵消原单”。
 * 本数据集中原单与红冲单成对，故两者均保留（只剔 voided / rejected），
 * 且要求已完成称重与计价（settlement_weight 非空）。*/
function stat2(o: WeighOrder): boolean {
  return o.settlement_weight_01kg != null && o.status !== "voided" && o.status !== "rejected";
}

function sumW(rows: WeighOrder[]) {
  return {
    count: rows.length,
    net_01kg: rows.reduce((s, o) => s + (o.net_weight_01kg ?? 0), 0),
    settle_01kg: rows.reduce((s, o) => s + (o.settlement_weight_01kg ?? 0), 0),
    goods_fen: rows.reduce((s, o) => s + (o.goods_amount_fen ?? 0), 0),
    payable_fen: rows.reduce((s, o) => s + (o.payable_amount_fen ?? 0), 0),
    paid_fen: rows.reduce((s, o) => s + o.paid_amount_fen, 0),
  };
}

export function todayKey(): string {
  return dateKey(TODAY);
}

/** 距今分钟数（本地时间文本，不能用 UTC 差——03 §10 时区守则） */
function minutesSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

const OPEN = new Set(["draft", "registered", "qc_done", "gross_weighed", "tare_weighed", "reweigh", "to_settle"]);

export function buildDashboard(): Dashboard {
  const tk = todayKey();
  const dueDays = Number(settings.find((s) => s.key === "payment_due_days")!.value);
  const alertMinutes = Number(settings.find((s) => s.key === "open_order_alert_minutes")!.value);

  const todayRows = orders.filter((o) => o.business_date === tk);
  const s = sumW(todayRows.filter(stat2));
  const open = orders
    .filter((o) => OPEN.has(o.status))
    .map((o) => ({
      order_no: o.order_no,
      party_name: o.party_name,
      status: o.status,
      variety_name: o.variety_name,
      since_minutes: minutesSince(o.registered_at),
      overdue: minutesSince(o.registered_at) > alertMinutes,
    }))
    .sort((a, b) => b.since_minutes - a.since_minutes);

  const creditRows = settlements.filter((x) => x.payment_status !== "paid" && x.status === "normal");
  const overdueCredit = creditRows.filter((x) => addDays(new Date(`${x.business_date}T00:00:00`), dueDays).getTime() < Date.now());

  const alerts: Dashboard["alerts"] = [];
  if (overdueCredit.length) {
    alerts.push({
      level: "danger",
      title: `${overdueCredit.length} 笔挂账超过付款时效`,
      detail: `合计 ${money(overdueCredit.reduce((t, x) => t + (x.payable_fen - x.paid_fen), 0))} 未付，已超 ${dueDays} 天时效`,
      action: "去付款登记",
      href: "/payments",
    });
  }
  const overdueOpen = open.filter((o) => o.overdue);
  if (overdueOpen.length) {
    alerts.push({
      level: "warning",
      title: `${overdueOpen.length} 车在途超时`,
      detail: `最久 ${durationText(overdueOpen[0].since_minutes)}：${overdueOpen[0].order_no} ${overdueOpen[0].party_name}`,
      action: "回工作台继续",
      href: "/workstation",
    });
  }
  const offline = devices.filter((d) => d.is_enabled === 1 && d.last_status !== "online");
  if (offline.length) {
    alerts.push({
      level: "danger",
      title: `${offline.length} 台设备离线或故障`,
      detail: offline.map((d) => `${d.name}（${d.last_error ?? "未连接"}）`).join("；"),
      action: "打开设备中心",
      href: "/devices",
    });
  }
  const manualToday = todayRows.filter((o) => o.weight_source === "manual");
  if (manualToday.length) {
    alerts.push({
      level: "warning",
      title: `今日 ${manualToday.length} 单为手录称重`,
      detail: "手录单据迎检必查，请核对仪表日志",
      action: "查看手录清单",
      href: "/orders?weightSource=manual",
    });
  }

  const trend = Array.from({ length: HISTORY_DAYS + 1 }, (_, i) => {
    const d = dateKey(addDays(TODAY, i - HISTORY_DAYS));
    const rows = orders.filter((o) => o.business_date === d).filter(stat2);
    return { date: d, net_01kg: rows.reduce((t, o) => t + (o.net_weight_01kg ?? 0), 0), goods_fen: rows.reduce((t, o) => t + (o.goods_amount_fen ?? 0), 0), orders: rows.length };
  });

  const byVariety = varietySpecAll().map((v) => {
    const rows = orders.filter((o) => o.business_date >= dateKey(addDays(TODAY, -HISTORY_DAYS)) && o.variety_code === v.code).filter(stat2);
    return {
      variety_code: v.code,
      variety_name: v.name,
      net_01kg: rows.reduce((t, o) => t + (o.net_weight_01kg ?? 0), 0),
      goods_fen: rows.reduce((t, o) => t + (o.goods_amount_fen ?? 0), 0),
    };
  });

  const typeAgg = new Map<PartyType, { orders: number; net_01kg: number }>();
  for (const o of orders.filter((x) => x.business_date >= dateKey(addDays(TODAY, -HISTORY_DAYS)))) {
    if (!stat2(o)) continue;
    const cur = typeAgg.get(o.party_type) ?? { orders: 0, net_01kg: 0 };
    cur.orders += 1;
    cur.net_01kg += o.net_weight_01kg ?? 0;
    typeAgg.set(o.party_type, cur);
  }

  const hourCurve = Array.from({ length: 15 }, (_, i) => {
    const h = i + 6;
    return { hour: h, orders: todayRows.filter((o) => new Date(o.registered_at).getHours() === h).length };
  });

  return {
    today: {
      orders: s.count,
      net_01kg: s.net_01kg,
      settle_01kg: s.settle_01kg,
      goods_fen: s.goods_fen,
      payable_fen: s.payable_fen,
      paid_fen: s.paid_fen,
      credit_fen: s.payable_fen - s.paid_fen,
      manualCount: manualToday.length,
      rejectCount: todayRows.filter((o) => o.status === "rejected").length,
    },
    openOrders: open,
    alerts,
    trend,
    byVariety,
    byPartyType: Array.from(typeAgg.entries()).map(([type, v]) => ({ type, label: PARTY_TYPE[type], ...v })),
    hourCurve,
  };
}

function varietySpecAll() {
  return [varietySpec(1), varietySpec(2), varietySpec(3), varietySpec(4)];
}

export function buildDaily(date: string): DailyReport {
  const rows: DailyReport["rows"] = [];
  for (const v of varietySpecAll()) {
    const list = orders.filter((o) => o.business_date === date && o.variety_code === v.code).filter(stat2);
    if (!list.length) continue;
    const qcMoist = list.map((o) => qcOf(o.qc_report_id)).filter((q) => q != null && q.is_effective === 1);
    const mo = qcMoist.map((q) => q!.indicators.find((i) => i.code === "moisture")?.value_num ?? null).filter((x): x is number => x != null);
    rows.push({
      variety_name: v.name,
      variety_code: v.code,
      orders: list.length,
      parties: new Set(list.map((o) => o.party_id)).size,
      gross_01kg: list.reduce((t, o) => t + (o.gross_weight_01kg ?? 0), 0),
      tare_01kg: list.reduce((t, o) => t + (o.tare_weight_01kg ?? 0), 0),
      net_01kg: list.reduce((t, o) => t + (o.net_weight_01kg ?? 0), 0),
      deduct_01kg: list.reduce((t, o) => t + o.deduct_total_01kg, 0),
      settle_01kg: list.reduce((t, o) => t + (o.settlement_weight_01kg ?? 0), 0),
      goods_fen: list.reduce((t, o) => t + (o.goods_amount_fen ?? 0), 0),
      deduction_fee_fen: list.reduce((t, o) => t + o.deduction_fee_fen, 0),
      payable_fen: list.reduce((t, o) => t + (o.payable_amount_fen ?? 0), 0),
      paid_fen: list.reduce((t, o) => t + o.paid_amount_fen, 0),
      credit_fen: list.reduce((t, o) => t + ((o.payable_amount_fen ?? 0) - o.paid_amount_fen), 0),
      avg_moisture_001pct: mo.length ? Math.round(mo.reduce((a, b) => a + b, 0) / mo.length) : null,
      manual_count: list.filter((o) => o.weight_source === "manual").length,
      reject_count: orders.filter((o) => o.business_date === date && o.variety_code === v.code && o.status === "rejected").length,
    });
  }
  rows.sort((a, b) => b.net_01kg - a.net_01kg);
  const all = orders.filter((o) => o.business_date === date).filter(stat2);
  return {
    date,
    rows,
    total: {
      orders: all.length,
      parties: new Set(all.map((o) => o.party_id)).size,
      net_01kg: all.reduce((t, o) => t + (o.net_weight_01kg ?? 0), 0),
      settle_01kg: all.reduce((t, o) => t + (o.settlement_weight_01kg ?? 0), 0),
      goods_fen: all.reduce((t, o) => t + (o.goods_amount_fen ?? 0), 0),
      payable_fen: all.reduce((t, o) => t + (o.payable_amount_fen ?? 0), 0),
      paid_fen: all.reduce((t, o) => t + o.paid_amount_fen, 0),
      credit_fen: all.reduce((t, o) => t + ((o.payable_amount_fen ?? 0) - o.paid_amount_fen), 0),
    },
    prevDayNet_01kg: orders.filter((o) => o.business_date === dateKey(addDays(new Date(`${date}T00:00:00`), -1))).filter(stat2).reduce((t, o) => t + (o.net_weight_01kg ?? 0), 0),
    lastWeekNet_01kg: orders.filter((o) => o.business_date === dateKey(addDays(new Date(`${date}T00:00:00`), -7))).filter(stat2).reduce((t, o) => t + (o.net_weight_01kg ?? 0), 0),
  };
}

export function buildLedger(from: string, to: string): LedgerRow[] {
  const list = orders
    .filter((o) => o.business_date >= from && o.business_date <= to && o.status !== "voided" && o.status !== "rejected")
    .slice()
    .sort((a, b) => (a.business_date === b.business_date ? (a.registered_at < b.registered_at ? -1 : 1) : a.business_date < b.business_date ? -1 : 1));
  return list.map((o, idx) => {
    const q = qcOf(o.qc_report_id);
    return {
      seq: idx + 1,
      business_date: o.business_date,
      order_no: o.order_no,
      party_name: o.party_name,
      party_type: o.party_type,
      id_card_no: o.id_card_no,
      address: partyOf(o.party_id).address,
      variety_name: o.variety_name,
      grade: o.grade,
      vehicle_no: o.vehicle_no,
      warehouse_name: o.warehouse_name,
      gross_weight_01kg: o.gross_weight_01kg,
      tare_weight_01kg: o.tare_weight_01kg,
      net_weight_01kg: o.net_weight_01kg,
      deduct_total_01kg: o.deduct_total_01kg,
      settlement_weight_01kg: o.settlement_weight_01kg,
      moisture_001pct: q?.indicators.find((i) => i.code === "moisture")?.value_num ?? null,
      impurity_001pct: q?.indicators.find((i) => i.code === "impurity")?.value_num ?? null,
      price_fen_per_ton: o.price_fen_per_ton,
      goods_amount_fen: o.goods_amount_fen,
      deduction_fee_fen: o.deduction_fee_fen,
      payable_amount_fen: o.payable_amount_fen,
      paid_amount_fen: o.paid_amount_fen,
      credit_amount_fen: (o.payable_amount_fen ?? 0) - o.paid_amount_fen,
      payment_method: o.payment_method,
      weight_source: o.weight_source,
      weigher_name: userName(o.weigher_id),
      inspector_name: userName(o.inspector_id),
      settled: o.settled_at != null,
    };
  });
}

export function buildQuality(from: string, to: string): QualityReport {
  const list = orders.filter((o) => o.business_date >= from && o.business_date <= to && o.qc_report_id != null);
  const byVariety = varietySpecAll().map((v) => {
    const sub = list.filter((o) => o.variety_code === v.code);
    const stat = sub.filter(stat2);
    const reports = sub.map((o) => qcOf(o.qc_report_id)).filter((x) => x != null && x.is_effective === 1);
    const avg = (code: string) => {
      const vals = reports.map((r) => r!.indicators.find((i) => i.code === code)?.value_num ?? null).filter((x): x is number => x != null);
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    };
    const spec = varietySpec(CODE_OF[v.code]);
    // 任一指标超国标的样本数（去重）：不能拿 over_moisture + over_impurity 相加当分子，
    // 同一单可能既超水分又超杂质，相加会让「问题率」超过 100%。
    const overAny = (code: string) => (r: NonNullable<ReturnType<typeof qcOf>>) =>
      (r.indicators.find((i) => i.code === code)?.value_num ?? -1) > (spec.std as Record<string, number>)[code];
    return {
      variety_name: v.name,
      variety_code: v.code,
      orders: sub.length,
      samples: reports.length,
      avg_moisture: avg("moisture"),
      avg_impurity: avg("impurity"),
      avg_unsound: avg("unsound"),
      over_moisture: reports.filter((r) => (r!.indicators.find((i) => i.code === "moisture")?.value_num ?? 0) > spec.std.moisture).length,
      over_impurity: reports.filter((r) => (r!.indicators.find((i) => i.code === "impurity")?.value_num ?? 0) > spec.std.impurity).length,
      over_any: reports.filter((r) => overAny("moisture")(r!) || overAny("impurity")(r!) || overAny("unsound")(r!)).length,
      reject: sub.filter((o) => o.status === "rejected").length,
      // 扣量率 = 扣量合计 / 净重合计（02 F7.3），只走参与汇总的完成单，与日报同源
      net_01kg: stat.reduce((t, o) => t + (o.net_weight_01kg ?? 0), 0),
      deduct_01kg: stat.reduce((t, o) => t + o.deduct_total_01kg, 0),
    };
  });

  const gradeDist = varietySpecAll().map((v) => ({
    variety_name: v.name,
    grades: GRADES.map((g) => ({ grade: g, count: list.filter((o) => o.variety_code === v.code && o.grade === g).length })),
  }));

  const buckets: { label: string; min: number; max: number }[] = [
    { label: "≤ 12.5%", min: 0, max: 1250 },
    { label: "12.5 – 14%", min: 1250, max: 1400 },
    { label: "14 – 15.5%", min: 1400, max: 1550 },
    { label: "15.5 – 18%", min: 1550, max: 1800 },
    { label: "> 18%", min: 1800, max: 99999 },
  ];
  const moistureBuckets = buckets.map((b) => {
    const n = list.reduce((t, o) => {
      const q = qcOf(o.qc_report_id);
      const m = q?.indicators.find((i) => i.code === "moisture")?.value_num;
      return m != null && m > b.min && m <= b.max ? t + 1 : t;
    }, 0);
    return { label: b.label, count: n };
  });

  return { dateFrom: from, dateTo: to, byVariety, gradeDist, moistureBuckets };
}

const CODE_OF: Record<string, number> = { YM: 1, XM: 2, DG: 3, DD: 4 };

export function buildPartyRank(from: string, to: string): PartyRankRow[] {
  const map = new Map<number, PartyRankRow>();
  for (const o of orders.filter((x) => x.business_date >= from && x.business_date <= to && x.status !== "voided")) {
    const cur =
      map.get(o.party_id) ??
      {
        party_id: o.party_id, name: o.party_name, party_type: o.party_type,
        orders: 0, net_01kg: 0, goods_fen: 0, paid_fen: 0, credit_fen: 0, last_date: o.business_date, avg_tare_01kg: null,
      };
    if (stat2(o)) {
      cur.orders += 1;
      cur.net_01kg += o.net_weight_01kg ?? 0;
      cur.goods_fen += o.goods_amount_fen ?? 0;
      cur.paid_fen += o.paid_amount_fen;
      cur.credit_fen += (o.payable_amount_fen ?? 0) - o.paid_amount_fen;
    }
    if (o.business_date > cur.last_date) cur.last_date = o.business_date;
    map.set(o.party_id, cur);
  }
  const tares = new Map<number, number[]>();
  for (const o of orders) {
    if (o.tare_weight_01kg == null) continue;
    const arr = tares.get(o.party_id) ?? [];
    arr.push(o.tare_weight_01kg);
    tares.set(o.party_id, arr);
  }
  return Array.from(map.values())
    .map((r) => {
      const t = tares.get(r.party_id) ?? [];
      return { ...r, avg_tare_01kg: t.length ? Math.round(t.reduce((a, b) => a + b, 0) / t.length) : null };
    })
    .sort((a, b) => b.net_01kg - a.net_01kg);
}

export function buildStaffLoad(from: string, to: string): StaffLoadRow[] {
  const ids = Array.from(new Set([...WEIGHERS, ...REGISTRARS, ...INSPECTORS, ...CASHIERS, STATION_MASTER_ID]));
  return ids
    .map((id) => {
      const owned = orders.filter((o) => o.business_date >= from && o.business_date <= to && (o.weigher_id === id || o.registered_by === id));
      const manual = owned.filter((o) => o.weight_source === "manual").length;
      const voids = owned.filter((o) => o.status === "voided" && o.voided_at && o.registered_by === id).length;
      const overrides = orders.filter((o) => o.business_date >= from && o.business_date <= to && o.tare_override_by === id).length;
      const reprints = printLogs.filter((p) => p.is_reprint === 1 && p.operator_id === id && p.printed_at.slice(0, 10) >= from && p.printed_at.slice(0, 10) <= to).length;
      return {
        user_id: id,
        name: userName(id),
        role: userRole(id),
        orders: owned.length,
        manual_count: manual,
        manual_ratio: owned.length ? manual / owned.length : 0,
        void_count: voids,
        override_count: overrides,
        reprint_count: reprints,
      };
    })
    .filter((r) => r.orders > 0)
    .sort((a, b) => b.orders - a.orders);
}

function userRole(id: number) {
  if (id === STATION_MASTER_ID) return "station_master" as const;
  if (WEIGHERS.includes(id)) return "weigher" as const;
  if (REGISTRARS.includes(id)) return "registrar" as const;
  if (INSPECTORS.includes(id)) return "inspector" as const;
  if (CASHIERS.includes(id)) return "cashier" as const;
  return "viewer" as const;
}

export function creditRows() {
  return settlements
    .filter((s) => s.payment_status !== "paid" && s.status === "normal")
    .map((s) => ({
      settlement: s,
      unpaid_fen: s.payable_fen - s.paid_fen,
      due_date: dateKey(addDays(new Date(`${s.business_date}T00:00:00`), Number(settings.find((x) => x.key === "payment_due_days")!.value))),
      overdue_days: Math.max(0, Math.floor((Date.now() - new Date(`${s.business_date}T00:00:00`).getTime()) / 86400000) - Number(settings.find((x) => x.key === "payment_due_days")!.value)),
    }))
    .sort((a, b) => b.overdue_days - a.overdue_days);
}

export function paymentMethodDist(from: string, to: string): { label: string; fen: number; tone: Tone }[] {
  const map = new Map<string, number>();
  for (const p of payments.filter((x) => x.reversed === 0 && x.paid_at.slice(0, 10) >= from && x.paid_at.slice(0, 10) <= to)) {
    map.set(p.method, (map.get(p.method) ?? 0) + p.amount_fen);
  }
  const tones: Tone[] = ["info", "success", "warning", "danger", "neutral"];
  return Array.from(map.entries())
    .map(([k, v], i) => ({ label: METHOD_LABEL[k] ?? k, fen: v, tone: tones[i % tones.length] }))
    .sort((a, b) => b.fen - a.fen);
}

const METHOD_LABEL: Record<string, string> = PAYMENT_METHOD;
