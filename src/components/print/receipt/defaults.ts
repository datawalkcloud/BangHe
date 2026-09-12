/**
 * 各场景的默认模板（出厂即用的版式，对应原 sheets.tsx 的三张票据 + 三类新增票据）。
 *
 * 默认模板只是「起点」：用户在小票模板编辑器里改完保存后，覆盖写进本地存储，
 * 打印时以用户模板为准；点「恢复默认」即回到这里。
 */
import type { ReceiptScenario, ReceiptTemplate } from "./types";

const BASELINE = "2026-09-12T00:00:00+08:00";

/** 生成稳定且唯一的区块 id（模板内排序用，不参与业务） */
export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function defaultTemplate(scenario: ReceiptScenario): ReceiptTemplate {
  switch (scenario) {
    case "weigh_order":
      return {
        scenario,
        name: "过磅单（默认）",
        paper: "A4",
        title: "收购码单（过磅单）",
        copyNote: "第一联 存根（粮站留存）",
        showReprintBadge: true,
        updatedAt: BASELINE,
        sections: [
          { id: uid(), kind: "kv", title: "售粮人信息", fields: ["party_name", "id_card_masked", "party_type_label", "vehicle_no"] },
          { id: uid(), kind: "kv", title: "品种与等级", fields: ["variety_name", "grade", "moisture_pct", "impurity_pct"] },
          { id: uid(), kind: "kv", title: "仓储与状态", fields: ["warehouse", "status_label", "weight_source_label"] },
          {
            id: uid(), kind: "kv", title: "重量明细",
            fields: ["gross_weight", "tare_weight", "net_weight", "package_deduct", "moisture_deduct", "impurity_deduct", "other_deduct", "deduct_total", "settlement_weight", "settlement_weight_ton"],
          },
          {
            id: uid(), kind: "kv", title: "金额",
            fields: ["price_per_ton", "price_per_jin", "goods_amount", "deduction_fee", "payable_amount", "paid_amount", "payable_upper", "payment_status_label", "payment_method_label"],
          },
          { id: uid(), kind: "text", text: "备注：{{remark}}" },
          { id: uid(), kind: "sign", signers: ["磅员", "化验员", "结算员", "售粮人签字"] },
        ],
      };
    case "quality_report":
      return {
        scenario,
        name: "质检单（默认）",
        paper: "A4",
        title: "质检单",
        copyNote: "第一联 存根（化验室留存）",
        showReprintBadge: true,
        updatedAt: BASELINE,
        sections: [
          { id: uid(), kind: "kv", title: "基本信息", fields: ["order_no", "party_name", "sample_no", "test_method_label"] },
          { id: uid(), kind: "table", title: "质检指标", dataset: "indicators", columns: ["name", "value", "std", "over", "note"] },
          { id: uid(), kind: "kv", title: "判定", fields: ["grade", "decision_label", "moisture_deduct", "impurity_deduct"] },
          { id: uid(), kind: "kv", title: "留样", fields: ["retention_no", "retention_until", "is_recheck"] },
          { id: uid(), kind: "text", text: "拒收原因：{{reject_reason}}" },
          { id: uid(), kind: "sign", signers: ["化验员签字", "司磅员确认"] },
        ],
      };
    case "settlement_voucher":
      return {
        scenario,
        name: "结算凭证（默认）",
        paper: "A4",
        title: "结算凭证",
        copyNote: "第一联 存根（财务入账）",
        showReprintBadge: true,
        updatedAt: BASELINE,
        sections: [
          { id: uid(), kind: "kv", title: "基本信息", fields: ["payee_name", "period", "order_count", "status_label"] },
          { id: uid(), kind: "table", title: "结算磅单明细", dataset: "orders", columns: ["order_no", "settlement_weight", "price", "goods_amount"] },
          { id: uid(), kind: "kv", title: "金额", fields: ["total_goods", "total_deduction", "payable", "paid", "unpaid", "payable_upper", "main_method_label"] },
          { id: uid(), kind: "sign", signers: ["收款人签字", "出纳", "站长"] },
        ],
      };
    case "payment_receipt":
      return {
        scenario,
        name: "付款小票（默认）",
        paper: "thermal80",
        title: "付款凭证",
        copyNote: "客户联",
        showReprintBadge: true,
        updatedAt: BASELINE,
        sections: [
          { id: uid(), kind: "kv", title: "基本信息", fields: ["pay_no", "paid_at", "party_name", "method_label", "trade_no", "voucher_no"] },
          { id: uid(), kind: "kv", title: "关联单据", fields: ["settle_no", "order_no"] },
          { id: uid(), kind: "kv", title: "金额", fields: ["amount", "amount_upper"] },
          { id: uid(), kind: "sign", signers: ["收款人签字", "经手人"] },
        ],
      };
    case "ledger":
      return {
        scenario,
        name: "收购台账（默认）",
        paper: "A4",
        title: "收购明细台账",
        copyNote: "报送留存",
        showReprintBadge: false,
        updatedAt: BASELINE,
        sections: [
          { id: uid(), kind: "kv", title: "汇总", fields: ["period", "row_count", "sum_net", "sum_settle", "sum_goods", "sum_payable", "sum_paid", "sum_credit"] },
          { id: uid(), kind: "table", title: "台账明细", dataset: "ledgerRows", columns: ["business_date", "order_no", "party_name", "variety_name", "net", "payable", "paid", "weigher"] },
        ],
      };
    case "daily_report":
      return {
        scenario,
        name: "收购日报表（默认）",
        paper: "A4",
        title: "收购日报表",
        copyNote: "站长留存",
        showReprintBadge: false,
        updatedAt: BASELINE,
        sections: [
          { id: uid(), kind: "kv", title: "当日汇总", fields: ["date", "orders", "parties", "net", "settle", "goods", "payable", "paid", "credit"] },
          { id: uid(), kind: "table", title: "分品种", dataset: "dailyVariety", columns: ["variety_name", "orders", "net", "goods", "payable", "paid", "credit", "manual", "reject"] },
        ],
      };
  }
}
