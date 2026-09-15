/**
 * 各场景的默认模板（出厂即用的版式，对应原 sheets.tsx 的三张票据 + 三类新增票据）。
 *
 * 默认模板只是「起点」：用户在小票模板编辑器里改完保存后，覆盖写进本地存储，
 * 打印时以用户模板为准；点「恢复默认」即回到这里。
 */
import type { ReceiptScenario, ReceiptSection, ReceiptTemplate } from "./types";
import { defaultLayout } from "./paper";

const BASELINE = "2026-09-12T00:00:00+08:00";

/** 生成稳定且唯一的区块 id（模板内排序用，不参与业务） */
export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * 出厂版式：纸型说了算（热敏 → 小票风格，A4 / 针式 → 单据风格）。
 *
 * 落进模板里而不是每次渲染时再推，是为了让"版式"在编辑器里是个看得见、能改的字段：
 * 用户把纸型从 A4 改成 80 热敏时，编辑器顺手把版式切成小票风格，之后他还能改回去。
 */
function withLayout(t: ReceiptTemplate): ReceiptTemplate {
  return { ...t, layout: t.layout ?? defaultLayout(t.paper) };
}

function buildTemplate(scenario: ReceiptScenario): ReceiptTemplate {
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
          {
            id: uid(),
            kind: "kv",
            // 不写区块标题：票面上每一段的小标题由字段自己的分组带出（见 render.tsx 的 kvClusters）
            fields: [
              "party_name", "id_card_masked", "party_type_label", "vehicle_no",
              "variety_name", "grade", "moisture_pct", "impurity_pct",
              "warehouse", "status_label", "weight_source_label",
              "gross_weight", "tare_weight", "net_weight", "package_deduct", "moisture_deduct", "impurity_deduct", "other_deduct", "deduct_total", "settlement_weight", "settlement_weight_ton", "tare_warning",
              "price_per_kg", "goods_amount", "deduction_fee", "payable_amount", "paid_amount", "payable_upper", "payment_status_label", "payment_method_label",
            ],
          },
          { id: uid(), kind: "text", text: "备注：{{remark}}" },
          {
            id: uid(),
            kind: "qr",
            title: "凭票结算码",
            text: "{{ticket_code}}",
            qrCaption: true,
            required: true,
          },
          // 价已经在票上了（制单那一刻就按价目表带过挂牌价，见 `orders.rs::create_order`），
          // 所以窗口那一步是"核对扣项、确认金额、领款"，不再说"算价"——票面与话术得对得上，
          // 客户照着票念的时候不能出现票上有的东西窗口却说没有
          { id: uid(), kind: "text", text: "结算：凭本票右下角的码到结算窗口确认扣项与金额后领款，无需重新过磅；票面标「预估」的金额以窗口确认的为准；票面丢失请到磅房补打。" },
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
          {
            id: uid(),
            kind: "kv",
            // 一个字段区装下三段：小标题「基本信息 / 判定 / 留样」由字段所属分组带出
            fields: [
              "order_no", "party_name", "sample_no", "test_method_label",
              "grade", "decision_label", "moisture_deduct", "impurity_deduct",
              "retention_no", "retention_until", "is_recheck",
            ],
          },
          { id: uid(), kind: "table", title: "质检指标", dataset: "indicators", columns: ["name", "value", "std", "over", "note"] },
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
          {
            id: uid(),
            kind: "kv",
            // 一个字段区装下两段：小标题「基本信息 / 金额」由字段所属分组带出
            fields: [
              "payee_name", "period", "order_count", "status_label",
              "total_goods", "total_deduction", "payable", "paid", "unpaid", "payable_upper", "main_method_label",
            ],
          },
          { id: uid(), kind: "table", title: "结算磅单明细", dataset: "orders", columns: ["order_no", "settlement_weight", "price", "goods_amount"] },
          // 出厂就出**一维码**，与过磅单那枚凭票码（只出二维码）刻意不同：
          // 这张凭证的归宿是结算窗口的扫码枪，而现场那支多半是几十块的键盘口激光枪，
          // 解不动二维码；挂账的客户把凭证再递回来核销时，扫不出来就得让人手敲单号。
          // 纸型是 A4（210mm 可打 182mm），一条 CODE128 连静区约 60mm，放得下不必压。
          // 老模板没有 codeStyle 字段，缺省仍是 "qr"（见 types.ts）——已经打顺了的站点不受影响。
          { id: uid(), kind: "qr", title: "凭单码（挂账核销时扫）", text: "{{settle_code}}", codeStyle: "barcode", qrCaption: true },
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
          {
            id: uid(),
            kind: "kv",
            // 一个字段区装下三段：小标题「基本信息 / 关联 / 金额」由字段所属分组带出
            fields: [
              "pay_no", "paid_at", "party_name", "method_label",
              "trade_no", "voucher_no", "settle_no", "order_no",
              "amount", "amount_upper",
            ],
          },
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

/** 某场景的出厂默认模板 */
export function defaultTemplate(scenario: ReceiptScenario): ReceiptTemplate {
  return withLayout(buildTemplate(scenario));
}

/**
 * 码区块缺省一律「印内容」——条码被晒白、磨花、缺针断线之后，这行字是票上唯一还认得出
 * 是哪张单的东西，所以它是现场兜底而不是版式偏好：没写过这个字段的模板按「印」算。
 * 明确关过（`false`）的不动，那是用户自己权衡过纸宽做的决定。
 */
function withCodeCaptions(sections: ReceiptSection[]): ReceiptSection[] {
  if (!sections.some((s) => s.kind === "qr" && s.qrCaption === undefined)) return sections;
  return sections.map((s) => (s.kind === "qr" && s.qrCaption === undefined ? { ...s, qrCaption: true } : s));
}

/**
 * 取用侧兜底：把历史模板里缺的东西补齐到「出厂该有的样子」。
 *
 * 为什么必须在**取用**这一侧做而不是保存这一侧：用户自定义模板存在本机 localStorage 里，
 * 而这里的每一条都是后来才加进默认模板的——一个早就保存过码单版式的站点，它的覆盖模板里
 * 天生没有凭票码、也没有码下方那行字。只在 `defaultTemplate` 里加等于什么也没做：
 * `store.ts` 的取值规则是"用户改过就以用户的为准"。与其要求站长逐个场景点一次「恢复默认」
 * （会连带丢掉他自己调好的版式），不如在取模板这一刻缺什么补什么，已有的一个都不动。
 *
 * 两条兜底，都不覆盖用户已经表过态的东西：
 *  1. **流程必备区块**（凭票码）缺了就补回来。位置照着出厂默认来：插在原本就在它前面的那个
 *     区块之后；默认里的锚点区块也被删了，就退到末尾——凭票码在署名前还是在票尾，都不影响
 *     它能不能被扫出来。
 *  2. **码下方那行可读内容**（`qrCaption`）缺了按「印」补齐，理由见 `withCodeCaptions`。
 *
 * 返回值在新旧内容一致时是**同一个引用**：`useReceiptTemplate` 直接把这个对象交给 React，
 * 每渲染一次都换新对象会让下游白白重渲染一轮。
 */
export function normalizeTemplate<T extends ReceiptTemplate>(template: T): T {
  const sections = withCodeCaptions(template.sections);
  const baseline = defaultTemplate(template.scenario).sections;
  const missing = baseline.filter((b) => b.required && !sections.some((s) => s.kind === b.kind && s.required));
  if (missing.length === 0) return sections === template.sections ? template : { ...template, sections };

  const next = [...sections];
  for (const block of missing) {
    const restored: ReceiptSection = { ...block, id: uid() };
    const anchorInDefault = baseline.slice(0, baseline.indexOf(block)).reverse().find((a) => !a.required);
    const anchorIdx = anchorInDefault ? next.findIndex((s) => s.kind === anchorInDefault.kind && s.title === anchorInDefault.title) : -1;
    if (anchorIdx >= 0) next.splice(anchorIdx + 1, 0, restored);
    else next.push(restored);
  }
  return { ...template, sections: next };
}
