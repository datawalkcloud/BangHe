/**
 * 交易数据生成：磅单、称重轨迹、化验单、结算单、付款流水、打印留痕、审计日志。
 *
 * 覆盖的异常样本（05 §10 验收清单要求逐一可查）：
 *   作废 / 红冲（负值抵消）/ 手录称重 / 皮重偏差超容差警示 / 化验拒收 /
 *   挂账未付与超期 / 打印失败 / 抓拍缺失 / 越权尝试被拒 / 复检覆盖首检
 *
 * 界面**不做**任何自动扣量与定等计算（02 §F4.4 计价引擎暂缓），
 * 这里的扣重与等级都是"人工录入的结果"，生成时只取净重的一个小比例，
 * 刻意不复现国标梯度公式，避免被误读为已实现规则引擎。
 */
import type {
  AuditLog,
  CapturePhoto,
  DeviceConfig,
  PaymentRecord,
  PrintLog,
  QcIndicatorRow,
  QcReport,
  Settlement,
  TimelineEvent,
  WeighOrder,
  WeighRecord,
} from "./types";
import type { Grade, OrderStatus, PaymentMethod, Tone } from "@/lib/constants";
import { INDICATORS } from "@/lib/constants";
import {
  ACTIVE_PARTIES,
  ALL_SLOTS,
  CASHIERS,
  GRADES,
  HISTORY_DAYS,
  INSPECTORS,
  KEEPERS,
  REGISTRARS,
  STATION_MASTER_ID,
  TODAY,
  WEIGHERS,
  chance,
  docNo,
  int,
  lookupPrice,
  partyOf,
  pick,
  userName,
  varietySpec,
  warehouses,
  devices,
} from "./masters";
import { addDays, alignDiv, amountFen, atMinute, dateKey, makePlate, roundHalfUp } from "./rng";

type Stage = "none" | "gross" | "tare" | "both";

export interface Transactional {
  orders: WeighOrder[];
  qcReports: QcReport[];
  settlements: Settlement[];
  payments: PaymentRecord[];
  prints: PrintLog[];
  audits: AuditLog[];
}

export const tx: Transactional = {
  orders: [],
  qcReports: [],
  settlements: [],
  payments: [],
  prints: [],
  audits: [],
};

let idSeq = 0;
const nextId = () => ++idSeq;

const CODE_TO_ID: Record<string, number> = { YM: 1, XM: 2, DG: 3, DD: 4 };
const WAREHOUSE_NAME = new Map(warehouses.map((w) => [w.id, w.name]));
const SLOT_LABEL = new Map(ALL_SLOTS.map((s) => [s.id, s.label]));

function stageOf(status: OrderStatus): Stage {
  switch (status) {
    case "draft":
    case "registered":
    case "qc_done":
    case "rejected":
      return "none";
    case "gross_weighed":
      return "gross";
    case "tare_weighed":
      return "tare";
    default:
      return "both";
  }
}

function pushAudit(
  at: string,
  actorId: number,
  action: string,
  no: string,
  reason: string | null,
  authorizedBy: string | null,
  result: AuditLog["result"] = "ok",
): void {
  tx.audits.push({
    id: nextId(), at, actor_id: actorId, actor_name: userName(actorId),
    action, entity: "weigh_order", entity_no: no, reason, authorized_by: authorizedBy, result,
  });
}

function pad3(n: number): string {
  return String(Math.abs(n) % 1000).padStart(3, "0");
}

function genDay(dayOffset: number, count: number): void {
  const date = dateKey(addDays(TODAY, dayOffset));
  let clock = 7 * 60 + int(0, 25);

  for (let i = 0; i < count; i++) {
    const party = pick(ACTIVE_PARTIES);
    const spec = varietySpec(int(1, 4));
    const varietyId = CODE_TO_ID[spec.code];
    const isBig = party.party_type !== "farmer";

    clock += int(6, 22);
    const regAt = atMinute(TODAY, dayOffset, clock, int(0, 59));
    const orderNo = docNo("BD", date);
    const registeredBy = pick(REGISTRARS);
    const weigherId = pick(WEIGHERS);
    const inspectorId = pick(INSPECTORS);
    const keeperId = pick(KEEPERS);

    /* ---------------------------------------------------------- 化验指标 */
    const [mLo, mHi] = spec.moistureBand;
    const moisture = int(mLo, mHi);
    const impurity = Math.max(20, spec.std.impurity + int(-40, 220));
    const unsound = Math.max(50, spec.std.unsound + int(-300, 500));
    const bulk = spec.std.bulk > 0 ? Math.max(600, spec.std.bulk + int(-60, 70)) : 0;
    const headRice = spec.std.headRice > 0 ? spec.std.headRice + int(-400, 700) : 0;
    const yellow = spec.indicators.includes("yellow_grain") ? int(0, 320) : 0;
    const mold = spec.indicators.includes("mold") ? int(0, 320) : 0;

    const decision: QcReport["decision"] =
      moisture > spec.rejectMoisture ? "reject" : moisture > spec.rejectMoisture - 250 ? "conditional" : "accept";
    const grade: Grade =
      decision === "reject"
        ? "等外"
        : moisture <= spec.std.moisture && impurity <= spec.std.impurity && unsound <= spec.std.unsound
          ? pick<Grade>(["一等", "二等", "二等", "三等"])
          : moisture <= spec.std.moisture + 200
            ? "三等"
            : "四等";

    const indicators: QcIndicatorRow[] = spec.indicators.map((code, idx) => {
      const meta = INDICATORS[code];
      const val =
        code === "moisture" ? moisture
        : code === "impurity" ? impurity
          : code === "unsound" ? unsound
            : code === "bulk_density" ? bulk
              : code === "head_rice" ? headRice
                : code === "yellow_grain" ? yellow
                  : code === "mold" ? mold
                    : null;
      const std =
        code === "moisture" ? spec.std.moisture
        : code === "impurity" ? spec.std.impurity
          : code === "unsound" ? spec.std.unsound
            : code === "bulk_density" ? spec.std.bulk
              : code === "head_rice" ? spec.std.headRice
                : code === "yellow_grain" ? 200
                  : code === "mold" ? 200
                    : null;
      const over = meta.lowerBetter === false ? (val ?? 0) < (std ?? 0) : (val ?? 0) > (std ?? 0);
      return {
        code,
        name: meta.name,
        value_num: code === "odor" ? null : val,
        value_text: code === "odor" ? pick(["正常", "正常", "无异味", "有轻微霉味"]) : null,
        unit: meta.unit,
        std_value: code === "odor" ? null : std,
        over_std: code === "odor" ? 0 : over ? 1 : 0,
        sort_order: idx,
      };
    });

    /* ------------------------------------------------------------- 重量 */
    const tare = alignDiv(isBig ? int(60000, 180000) * 10 : int(800, 15000));
    const net = alignDiv(isBig ? int(180000, 320000) * 10 : int(40000, 250000));
    const gross = tare + net;

    const packageCount = isBig ? 0 : chance(0.42) ? int(1, 24) : 0;
    const packageDeduct = packageCount * spec.pkgDeduct * 10;
    const moistureDeduct = moisture > spec.std.moisture ? roundHalfUp((net * int(0, 22)) / 1000) : 0;
    const impurityDeduct = impurity > spec.std.impurity ? roundHalfUp((net * int(0, 12)) / 1000) : 0;
    const otherDeduct = chance(0.06) ? roundHalfUp((net * int(5, 15)) / 1000) : 0;
    const deductTotal = packageDeduct + moistureDeduct + impurityDeduct + otherDeduct;
    const settleWeight = net - deductTotal;

    const priceRow = lookupPrice(varietyId, grade, date);
    const overridden = chance(0.08);
    const price = overridden ? int(220000, 250000) : priceRow?.price_fen_per_ton ?? spec.basePrice;
    const goods = amountFen(settleWeight, price);
    const deductionFee = chance(0.1) ? int(20, 120) * 100 : 0;
    const payable = goods - deductionFee;
    const manualWeigh = !isBig && chance(0.07);

    const slot =
      party.default_slot_id != null && chance(0.6)
        ? { slotId: party.default_slot_id, whId: party.default_warehouse_id ?? 1 }
        : (() => {
            const s = pick(ALL_SLOTS);
            return { slotId: s.id, whId: s.warehouse_id };
          })();

    /* --------------------------------------------------------- 状态编排 */
    let status: OrderStatus;
    if (decision === "reject") {
      status = "rejected";
    } else if (dayOffset === 0) {
      status = pick<OrderStatus>([
        "registered", "qc_done", "gross_weighed", "tare_weighed",
        "to_settle", "to_settle", "settled", "reweigh",
      ]);
    } else {
      // 千分位整数阈值：作废 2.6%、红冲 1.4%、待结算 3.5%、已结算未付 4%、已付清 54.5%、已归档 34%
      // “待结算”只留到次日：日结当日必须关账，挂上十几天不出账的单在真磅房是不合格的，
      // 首页的在途列表也会被这些旧尾巴淹没。
      const v = int(0, 999);
      status =
        v < 26 ? "voided"
        : v < 40 ? "reversed"
          : v < 75 ? (dayOffset >= -1 ? "to_settle" : "settled")
            : v < 115 ? "settled"
              : v < 660 ? "paid"
                : "archived";
    }
    const stage: Stage = stageOf(status);
    const hasGross = stage === "gross" || stage === "both";
    const hasTare = stage === "tare" || stage === "both";
    const settled = status === "settled" || status === "paid" || status === "archived" || status === "reversed";
    const priced = settled || status === "to_settle" || status === "reweigh";

    /* ------------------------------------------------------------- 付款 */
    let paymentStatus: WeighOrder["payment_status"] = "not_required";
    let paidAmount = 0;
    let payMethod: PaymentMethod | null = null;
    if (settled) {
      if (status !== "settled") {
        paymentStatus = "paid";
        paidAmount = payable;
        payMethod = pick<PaymentMethod>(["cash", "bank", "wechat", "transfer", "alipay"]);
      } else {
        paymentStatus = "unpaid";
      }
    }

    /* --------------------------------------------------------- 称重轨迹 */
    const records: WeighRecord[] = [];
    let recSeq = 0;
    const reweighed = stage === "both" && chance(0.09);
    if (hasGross) {
      if (reweighed) {
        records.push({
          id: nextId(), seq: ++recSeq, weigh_type: "gross",
          weight_01kg: gross - 1200, aligned_weight_01kg: gross - 1200, is_adopted: 0,
          adopt_reason: "车辆未停稳，首次读数偏小", source: "scale", device_code: "scale1",
          raw_frame: `ST,GS,+${((gross - 1200) / 10).toFixed(1)}kg`, stable: 0,
          captured_at: atMinute(TODAY, dayOffset, clock + 1, 4), operator_id: weigherId, has_photo: false,
        });
      }
      records.push({
        id: nextId(), seq: ++recSeq, weigh_type: "gross",
        weight_01kg: gross, aligned_weight_01kg: gross, is_adopted: 1,
        adopt_reason: reweighed ? "复称后采用新值" : null,
        source: manualWeigh ? "manual" : "scale", device_code: manualWeigh ? "—" : "scale1",
        raw_frame: manualWeigh ? null : `ST,GS,+${(gross / 10).toFixed(1)}kg`, stable: 1,
        captured_at: atMinute(TODAY, dayOffset, clock + 1, 12), operator_id: weigherId,
        has_photo: !manualWeigh && chance(0.86),
      });
    }
    if (hasTare) {
      records.push({
        id: nextId(), seq: ++recSeq, weigh_type: "tare",
        weight_01kg: tare, aligned_weight_01kg: tare, is_adopted: 1, adopt_reason: null,
        source: manualWeigh ? "manual" : "scale", device_code: manualWeigh ? "—" : "scale1",
        raw_frame: manualWeigh ? null : `ST,GS,+${(tare / 10).toFixed(1)}kg`, stable: 1,
        captured_at: atMinute(TODAY, dayOffset, clock + 7, 30), operator_id: weigherId,
        has_photo: !manualWeigh && chance(0.8),
      });
    }

    const drift = party.last_tare_01kg && hasTare ? Math.abs(tare - party.last_tare_01kg) / party.last_tare_01kg : 0;
    // 超容差不再走授权放行：只留一条警示（文案与 Rust capture 自动生成的同式）
    const tareWarn = hasTare && drift > 0.08 && chance(0.55);
    const tareWarnText =
      party.last_tare_01kg && tareWarn
        ? `实测皮重 ${(tare / 10).toFixed(1)}kg，较最近历史皮重 ${(party.last_tare_01kg / 10).toFixed(1)}kg 偏差 ${
            tare >= party.last_tare_01kg ? "+" : "-"
          }${(drift * 100).toFixed(1)}%，超出容差 3.00%`
        : null;

    const grossAt = records.find((x) => x.weigh_type === "gross" && x.is_adopted === 1)?.captured_at ?? null;
    const tareAt = records.find((x) => x.weigh_type === "tare" && x.is_adopted === 1)?.captured_at ?? null;
    const qcAt = atMinute(TODAY, dayOffset, Math.max(0, clock - 3), 20);
    const settledAt = priced ? atMinute(TODAY, dayOffset, clock + 14, int(0, 59)) : null;
    const paidAt = paymentStatus === "paid" ? atMinute(TODAY, dayOffset, clock + 22, int(0, 59)) : null;

    const order: WeighOrder = {
      id: nextId(),
      order_no: orderNo,
      business_date: date,
      status,
      party_id: party.id,
      party_name: party.name,
      party_type: party.party_type,
      id_card_no: party.id_card_no,
      variety_id: varietyId,
      variety_code: spec.code,
      variety_name: spec.name,
      grade: decision === "reject" || priced || stage === "both" ? grade : null,
      warehouse_id: decision === "reject" ? null : slot.whId,
      warehouse_name: decision === "reject" ? null : WAREHOUSE_NAME.get(slot.whId) ?? null,
      slot_id: decision === "reject" ? null : slot.slotId,
      slot_label: decision === "reject" ? null : SLOT_LABEL.get(slot.slotId) ?? null,
      vehicle_no: party.default_vehicle_no ?? (isBig ? makePlate(int, pick) : chance(0.4) ? makePlate(int, pick) : null),
      driver_name: party.name,
      gross_weight_01kg: hasGross ? gross : null,
      tare_weight_01kg: hasTare ? tare : null,
      net_weight_01kg: hasGross && hasTare ? net : null,
      package_deduct_01kg: priced ? packageDeduct : 0,
      package_count: priced ? packageCount : 0,
      moisture_deduct_01kg: priced ? moistureDeduct : 0,
      impurity_deduct_01kg: priced ? impurityDeduct : 0,
      other_deduct_01kg: priced ? otherDeduct : 0,
      deduct_total_01kg: priced ? deductTotal : 0,
      settlement_weight_01kg: priced ? settleWeight : null,
      price_fen_per_ton: priced ? price : null,
      price_list_id: priced && !overridden ? priceRow?.id ?? null : null,
      price_override_reason: priced && overridden ? "站长临时调价，口头通知" : null,
      goods_amount_fen: priced ? goods : null,
      deduction_fee_fen: priced ? deductionFee : 0,
      advance_fee_fen: 0,
      payable_amount_fen: priced ? payable : null,
      paid_amount_fen: paidAmount,
      payment_status: paymentStatus,
      payment_method: payMethod,
      weight_source: manualWeigh ? "manual" : "scale",
      tare_override_by: null,
      tare_override_reason: tareWarnText,
      is_manual_pricing: 1,
      reversed_order_id: null,
      reverse_of_id: null,
      qc_report_id: null,
      registered_by: registeredBy,
      registered_at: regAt,
      gross_at: grossAt,
      tare_at: tareAt,
      qc_at: qcAt,
      settled_at: settled ? settledAt : null,
      paid_at: paidAt,
      voided_at: status === "voided" ? atMinute(TODAY, dayOffset, clock + 9, 0) : null,
      void_reason: status === "voided" ? pick(["农户临时退粮，号已取故留痕", "品种录入错误，重开单", "车牌与姓名不符，撤单重登"]) : null,
      weigher_id: hasGross || hasTare ? weigherId : null,
      inspector_id: inspectorId,
      keeper_id: decision === "reject" ? null : keeperId,
      remark: chance(0.1) ? pick(["过筛后称重", "自带袋 20 只", "雨天，注意加扣水", "急粮优先结算"]) : null,
      created_at: regAt,
      updated_at: settledAt ?? regAt,
      records,
    };

    /* ------------------------------------------------------------ 化验单 */
    const report: QcReport = {
      id: nextId(),
      report_no: docNo("ZJ", date),
      order_id: order.id,
      order_no: orderNo,
      party_name: party.name,
      sample_no: `YP${date.replace(/-/g, "").slice(2)}${pad3(order.id)}`,
      variety_id: varietyId,
      grade,
      decision,
      reject_reason: decision === "reject" ? `水分 ${(moisture / 100).toFixed(2)}% 超拒收红线 ${(spec.rejectMoisture / 100).toFixed(2)}%` : null,
      moisture_deduct_01kg: moistureDeduct,
      impurity_deduct_01kg: impurityDeduct,
      test_method: decision === "reject" ? "visual" : pick<"lab" | "nir">(["nir", "nir", "lab"]),
      is_recheck: 0,
      first_report_id: null,
      is_effective: 1,
      inspector_id: inspectorId,
      inspected_at: qcAt,
      retention_no: decision === "reject" ? null : `LY${date.replace(/-/g, "").slice(2)}${pad3(int(1, 99))}`,
      retention_until: decision === "reject" ? null : dateKey(addDays(addDays(TODAY, dayOffset), 30)),
      indicators,
      remark: chance(0.08) ? "近红外快检，怀疑时送化验室复核" : null,
    };
    order.qc_report_id = report.id;
    tx.qcReports.push(report);

    if (decision !== "reject" && chance(0.05)) {
      const re: QcReport = {
        ...report,
        id: nextId(),
        report_no: docNo("ZJ", date),
        grade: GRADES[Math.max(0, GRADES.indexOf(grade) - 1)],
        test_method: "lab",
        is_recheck: 1,
        first_report_id: report.id,
        is_effective: 1,
        inspected_at: atMinute(TODAY, dayOffset, clock + 40, 0),
        remark: "农户对水分有异议，送化验室复测",
        indicators: indicators.map((it) => ({
          ...it,
          value_num: it.value_num != null ? Math.max(0, it.value_num - int(0, 130)) : null,
        })),
      };
      report.is_effective = 0;
      order.qc_report_id = re.id;
      tx.qcReports.push(re);
    }

    tx.orders.push(order);

    /* ------------------------------------------------------------ 打印 */
    if (settled) {
      tx.prints.push({
        id: nextId(), doc_type: "weigh_order", doc_no: orderNo, copies: 3, paper: "A4",
        printer_name: "HP LaserJet M403d", channel: "preview", is_reprint: 0, authorized_by: null,
        result: "success", error_msg: null, printed_at: settledAt ?? regAt, operator_id: weigherId,
      });
      if (chance(0.08)) {
        tx.prints.push({
          id: nextId(), doc_type: "weigh_order", doc_no: orderNo, copies: 1, paper: "A4",
          printer_name: "HP LaserJet M403d", channel: "preview", is_reprint: 1,
          authorized_by: STATION_MASTER_ID, result: "success", error_msg: null,
          printed_at: atMinute(TODAY, dayOffset, clock + 90, 0), operator_id: weigherId,
        });
      }
    }

    /* ------------------------------------------------------------ 审计 */
    pushAudit(regAt, registeredBy, "order.create", orderNo, null, null);
    if (tareWarn && tareAt) pushAudit(tareAt, weigherId, "tare.override", orderNo, order.tare_override_reason, null);
    if (manualWeigh && grossAt) pushAudit(grossAt, weigherId, "weigh.manual", orderNo, "仪表通讯中断，改为人工读数录入", userName(STATION_MASTER_ID));
    if (overridden && settledAt) pushAudit(settledAt, weigherId, "price.override", orderNo, "站长口头调价，未走价目表", userName(STATION_MASTER_ID));
    if (status === "voided" && order.voided_at) pushAudit(order.voided_at, registeredBy, "order.void", orderNo, order.void_reason, userName(STATION_MASTER_ID));
  }
}

/* ============================================== 结算 / 付款 / 红冲 生成 */

function genSettlements(): void {
  const groups = new Map<string, WeighOrder[]>();
  for (const o of tx.orders) {
    if (!o.settled_at || o.payable_amount_fen == null) continue;
    if (o.status === "reversed" || o.status === "voided") continue;
    const k = `${o.party_id}|${o.business_date}`;
    const arr = groups.get(k);
    if (arr) arr.push(o);
    else groups.set(k, [o]);
  }

  for (const list of Array.from(groups.values())) {
    const date = list[0].business_date;
    const party = partyOf(list[0].party_id);
    const payable = list.reduce((s, o) => s + (o.payable_amount_fen ?? 0), 0);
    const paid = list.reduce((s, o) => s + o.paid_amount_fen, 0);
    const paymentStatus: Settlement["payment_status"] = paid === 0 ? "unpaid" : paid >= payable ? "paid" : "partial";
    const method = list[0].payment_method ?? "cash";
    const settleNo = docNo("JS", date);

    const stl: Settlement = {
      id: nextId(),
      settle_no: settleNo,
      party_id: party.id,
      party_name: party.name,
      business_date: date,
      period_from: date,
      period_to: date,
      order_count: list.length,
      total_net_01kg: list.reduce((s, o) => s + (o.net_weight_01kg ?? 0), 0),
      total_deduct_01kg: list.reduce((s, o) => s + o.deduct_total_01kg, 0),
      total_settle_01kg: list.reduce((s, o) => s + (o.settlement_weight_01kg ?? 0), 0),
      total_goods_fen: list.reduce((s, o) => s + (o.goods_amount_fen ?? 0), 0),
      total_deduction_fen: list.reduce((s, o) => s + o.deduction_fee_fen, 0),
      total_advance_fen: 0,
      payable_fen: payable,
      paid_fen: paid,
      payment_status: paymentStatus,
      main_method: paymentStatus === "unpaid" ? null : method,
      payee_name: party.name,
      signed_by_party: paymentStatus === "unpaid" ? 0 : 1,
      status: "normal",
      settled_at: list[0].settled_at!,
      settler_id: paymentStatus === "unpaid" ? STATION_MASTER_ID : pick(CASHIERS),
      orders: list.map((o, idx) => ({
        order_id: o.id,
        order_no: o.order_no,
        goods_amount_fen: o.goods_amount_fen ?? 0,
        price_fen_per_ton: o.price_fen_per_ton ?? 0,
        settlement_weight_01kg: o.settlement_weight_01kg ?? 0,
        seq: idx + 1,
      })),
      remark: paymentStatus === "unpaid" ? "农户要求月底前结清" : null,
    };
    tx.settlements.push(stl);

    if (paid > 0) {
      tx.payments.push({
        id: nextId(),
        pay_no: docNo("FK", date),
        settlement_id: stl.id,
        settle_no: settleNo,
        order_id: null,
        order_no: null,
        party_id: party.id,
        party_name: party.name,
        amount_fen: paid,
        method,
        trade_no: method === "cash" ? null : `${date.replace(/-/g, "")}${int(100000, 999999)}`,
        payee_name: party.name,
        paid_at: list[0].paid_at ?? stl.settled_at,
        operator_id: pick(CASHIERS),
        voucher_no: chance(0.5) ? `PZ-${date.replace(/-/g, "").slice(4)}-${pad3(int(1, 99))}` : null,
        reversed: 0,
        remark: paymentStatus === "partial" ? "首付，余额挂账" : null,
      });
    }
  }
}

/** 红冲单：负值、与原单互相指向，号码永久占位不复用 */
function genReverses(): void {
  const targets = tx.orders.filter((o) => o.status === "reversed");
  for (const src of targets) {
    const neg: WeighOrder = {
      ...src,
      id: nextId(),
      order_no: docNo("HC", src.business_date),
      reversed_order_id: src.id,
      reverse_of_id: null,
      net_weight_01kg: -(src.net_weight_01kg ?? 0),
      settlement_weight_01kg: -(src.settlement_weight_01kg ?? 0),
      deduct_total_01kg: -src.deduct_total_01kg,
      goods_amount_fen: -(src.goods_amount_fen ?? 0),
      payable_amount_fen: -(src.payable_amount_fen ?? 0),
      paid_amount_fen: -(src.paid_amount_fen ?? 0),
      price_list_id: null,
      price_override_reason: null,
      voided_at: null,
      void_reason: null,
      records: [],
      remark: `红冲 ${src.order_no}：结算重量录入错误，经站长授权重开`,
    };
    src.reverse_of_id = neg.id;
    tx.orders.push(neg);
    pushAudit(neg.updated_at ?? neg.registered_at, neg.registered_by, "order.reverse", neg.order_no, neg.remark, userName(STATION_MASTER_ID));
  }
}

/** 与单据无关但必须能查到的样本：越权尝试被拒、针式打印机失败 */
function genSpecialSamples(): void {
  const actor = pick(REGISTRARS);
  pushAudit(
    atMinute(TODAY, -1, 16 * 60 + 42, 10), actor, "order.void", tx.orders[3]?.order_no ?? "—",
    "查询审计岗无作废权限", null, "denied",
  );
  tx.prints.push({
    id: nextId(), doc_type: "weigh_order", doc_no: tx.orders[5]?.order_no ?? "—", copies: 1, paper: "dot241",
    printer_name: "EPSON LQ-630K", channel: "raw", is_reprint: 0, authorized_by: null,
    result: "failed", error_msg: "打印机脱机或缺纸（winspool: SPOOL_E_OFFLINE）",
    printed_at: atMinute(TODAY, -3, 11 * 60 + 12, 0), operator_id: pick(WEIGHERS),
  });
}

/* ------------------------------------------------------------- 一次性构建 */

for (let d = -HISTORY_DAYS; d <= 0; d++) {
  const weekday = addDays(TODAY, d).getDay();
  const busy = weekday === 0 || weekday === 6 ? 1.28 : 1;
  genDay(d, Math.max(4, Math.round((9 + int(-3, 4)) * busy)));
}
genSettlements();
genReverses();
genSpecialSamples();

tx.audits.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
tx.orders.sort((a, b) => (a.registered_at < b.registered_at ? 1 : -1));

export const orders = tx.orders;
export const qcReports = tx.qcReports;
export const settlements = tx.settlements;
export const payments = tx.payments;
export const printLogs = tx.prints;
export const auditLogs = tx.audits;

export const orderOf = (no: string): WeighOrder | null => orders.find((o) => o.order_no === no) ?? null;
export const orderById = (id: number): WeighOrder | null => orders.find((o) => o.id === id) ?? null;
export const settlementOfOrder = (orderId: number): Settlement | null =>
  settlements.find((s) => s.orders.some((x) => x.order_id === orderId)) ?? null;
export const printsOf = (no: string): PrintLog[] => printLogs.filter((p) => p.doc_no === no);
export const qcOf = (id: number | null | undefined): QcReport | null => qcReports.find((r) => r.id === id) ?? null;
export const auditsOf = (no: string): AuditLog[] => auditLogs.filter((x) => x.entity_no === no);

/** 磅单详情时间轴：登记 / 化验 / 两次称重 / 授权 / 结算 / 付款 / 作废 串成一条链 */
export function buildTimeline(o: WeighOrder): TimelineEvent[] {
  const ev: TimelineEvent[] = [];
  const add = (at: string | null | undefined, action: string, label: string, actor: string, tone: Tone, detail?: string | null) => {
    if (at) ev.push({ at, action, label, actor, tone, detail: detail ?? undefined });
  };
  add(o.registered_at, "order.create", "取号登记", userName(o.registered_by), "neutral", `${o.party_name} · ${o.variety_name ?? "未定品种"}`);
  const q = qcOf(o.qc_report_id);
  if (q) {
    add(q.inspected_at, "qc.save", `化验 ${q.report_no}${q.is_recheck ? "（复检）" : ""}`, userName(q.inspector_id),
      q.decision === "reject" ? "danger" : q.decision === "conditional" ? "warning" : "info",
      `${q.grade ?? "—"} · ${q.decision === "accept" ? "接收" : q.decision === "conditional" ? "条件接收" : "拒收"}`);
  }
  for (const r of o.records ?? []) {
    add(
      r.captured_at, "weigh.capture", r.weigh_type === "gross" ? "捕获毛重" : "捕获皮重", userName(r.operator_id),
      r.source === "manual" ? "warning" : "info",
      r.source === "manual" ? "手录" : r.adopt_reason ?? (r.is_adopted ? null : "已被复称替换"),
    );
  }
  if (o.tare_override_reason) {
    add(o.tare_at, "tare.override", "皮重偏差超容差", userName(o.tare_override_by ?? o.weigher_id), "warning", o.tare_override_reason);
  }
  const stl = settlementOfOrder(o.id);
  if (o.settled_at) add(o.settled_at, "settle.create", "生成结算单", userName(stl?.settler_id ?? null), "info", stl?.settle_no);
  if (o.paid_at) add(o.paid_at, "pay.record", "付款登记", userName(o.registered_by), "success", o.payment_method ?? undefined);
  if (o.voided_at) add(o.voided_at, "order.void", "作废", userName(o.registered_by), "danger", o.void_reason);
  if (o.reversed_order_id != null) add(o.updated_at, "order.reverse", "红冲单", userName(o.registered_by), "danger", orderById(o.reversed_order_id)?.order_no);
  if (o.reverse_of_id != null) add(o.updated_at, "order.reverse", "被红冲", userName(o.registered_by), "danger", orderById(o.reverse_of_id)?.order_no);
  return ev.sort((a, b) => (a.at > b.at ? 1 : -1));
}

/** 勾了「过磅抓拍」且启用的相机（04 §4）：每次过磅由它们各拍一张，最多 3 台。
 *  与真库 `camera::list_capture_cameras` 同口径（is_default 优先、按 id、截三台）。 */
export function captureCameras(): DeviceConfig[] {
  return devices
    .filter((d) => d.kind === "camera" && d.is_enabled === 1 && d.config?.captureOnWeigh === true)
    .sort((a, b) => (b.is_default - a.is_default) || (a.id - b.id))
    .slice(0, 3);
}

/**
 * 附件墙：一次称重（毛重一捕 / 皮重一捕）最多 3 台相机各一张，逐张列并标出是哪台拍的。
 * 一条被采纳的轨迹 `has_photo` 为真就按参与抓拍的相机铺多张，一张都没有才补一格「无抓拍」
 * （05 §6.5 不弹窗阻塞）。合成附件 id 用 `记录 id * 100 + 序号`，与真库的 attachment.id 一样
 * 只作读图寻址；缺图占位格用 `-记录 id`（负数，与正数附件 id 不撞号，前端 missing 时也不会去读）。
 */
export function photosOf(o: WeighOrder) {
  const cams = captureCameras();
  const out: CapturePhoto[] = [];
  for (const r of o.records ?? []) {
    if (r.is_adopted !== 1) continue;
    const label = r.weigh_type === "gross" ? "毛重抓拍" : "皮重抓拍";
    if (r.has_photo && cams.length > 0) {
      cams.forEach((c, i) =>
        out.push({
          id: r.id * 100 + (i + 1),
          biz_type: "scale_capture" as const,
          label,
          device_label: c.name,
          tone: "info" as Tone,
          captured_at: r.captured_at,
          missing: false,
        }),
      );
    } else {
      out.push({
        id: -r.id,
        biz_type: "scale_capture" as const,
        label,
        device_label: null,
        tone: "danger" as Tone,
        captured_at: r.captured_at,
        missing: true,
      });
    }
  }
  return out;
}
