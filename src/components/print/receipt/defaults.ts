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
            // 一个字段区装下两段：小标题「基本信息 / 金额」由字段所属分组带出。
            // 这里**不列结算单号**：票头那三行本来就打「单号 = 结算单号」（`escpos.ts` 的票头与
            // `render.tsx` 同一条，取值走 `docMeta`），字段区再列一遍就是同一张纸上两个号。撤掉
            // 凭单码之后号也没丢——丢的只是那枚没人扫的条码。
            fields: [
              "payee_name", "period", "order_count", "status_label",
              "total_goods", "total_deduction", "payable", "paid", "unpaid", "payable_upper", "main_method_label",
            ],
          },
          { id: uid(), kind: "table", title: "结算磅单明细", dataset: "orders", columns: ["order_no", "settlement_weight", "price", "goods_amount"] },
          // 这里从前是「凭单码（挂账核销时扫）」那一维码块，随"扫结算凭证弹补付框"那条入口
          // 一起撤了（02 §F1.4 本版：磅房作业只认磅单码）。用户自己存过这版的站点由
          // `normalizeTemplate` 在取模板那一刻把那块摘掉——它现在打的是与磅单同形的纯数字号，
          // 留在纸上就是一个会被扫错的口。
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
    case "outbound_order":
      return {
        scenario,
        name: "出库码单（默认）",
        paper: "A4",
        title: "出库码单（出仓凭证）",
        copyNote: "第一联 存根（粮站留存）",
        showReprintBadge: true,
        updatedAt: BASELINE,
        sections: [
          {
            id: uid(),
            kind: "kv",
            // 小标题「基本信息 / 重量 / 金额」由字段所属分组带出（同过磅单那条规矩）。
            // **同一个组的字段必须连着排**：票面按"连续同组"切段（`render.kvClusters`，D 段钉住
            // 切段不重排），把 `stock_warning` 排到重量组后面就会冒出第二个「基本信息」小标题。
            // 「称重说明」与「超库存警示」都进字段区而不是另起文字行：没称过 / 没超库存时
            // 它们各自取到一句实话（"未过磅，净重为人工填写" / "—"），不会出现空半行。
            fields: [
              "order_no", "business_date", "kind_label", "status_label",
              "party_name", "counterparty_label", "variety_name", "grade", "warehouse", "vehicle_no", "stock_warning",
              "gross_weight", "tare_weight", "net_weight", "net_weight_ton", "weight_source_label", "weigh_note",
              "price_per_kg", "goods_amount", "goods_amount_upper", "payment_status_label",
            ],
          },
          { id: uid(), kind: "text", text: "备注：{{remark}}" },
          {
            id: uid(),
            kind: "qr",
            title: "凭单码",
            text: "{{ticket_code}}",
            qrCaption: true,
            required: true,
          },
          // 这句话是这张纸的用途说明，也是它与收购码单的分工：出库的码只定位单据，
          // 不进结算窗口那条路（结算框只认磅单，出库收款核销是波 3）。
          { id: uid(), kind: "text", text: "本单为出仓凭证，右下角的码就是本单单号，扫任意检索框可查到这张单。粮已出门后重量与金额不可改，需更正由站长红冲本单后另开一张。" },
          { id: uid(), kind: "sign", signers: ["制单人", "值仓（确认出仓）", "承运人 / 领用人签字"] },
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
 * 退役：把历史模板里的「凭单码」那块摘掉。
 *
 * 那是结算凭证从前带的一维码（载荷 = 版本位 + 票种位 `3` + 结算单号），配合"扫结算凭证弹补付框"
 * 那条入口用。本版图面契约改了（02 §F1.4）：**码里就是单号本体，而磅房作业只认磅单码**，
 * 也只认磅单码。于是这种块继续留着只有坏处——用户存过这版的站点会一直在结算凭证上打一条
 * 没人扫的条码，而它装的那串纯数字与磅单号同形，被顺手扫进窗口就是拿别的单号的形状去查磅单。
 *
 * 只摘**码块**（`kind === "qr"` 且载荷引用 `{{settle_code}}`）：那个才会打出可扫的东西。
 * 用户如果自己在文字块里写了 `{{settle_code}}`，那个字段已经不在结算凭证的字段表里，
 * 取不到值就照现有规则打 `—`——那是他自己写的一行字，不由这里替他删。
 *
 * 与另外两条兜底同一个位置（取用侧）、同一个引用语义：没东西可摘时返回原数组。
 */
function withoutRetiredCodes(sections: ReceiptSection[]): ReceiptSection[] {
  const kept = sections.filter((s) => !(s.kind === "qr" && /\{\{\s*settle_code\s*\}\}/.test(s.text ?? "")));
  return kept.length === sections.length ? sections : kept;
}

/**
 * 取用侧兜底：把历史模板里缺的东西补齐到「出厂该有的样子」，并把已经退役的东西摘掉。
 *
 * 为什么必须在**取用**这一侧做而不是保存这一侧：用户自定义模板存在本机 localStorage 里，
 * 而这里的每一条都是后来才加进默认模板的——一个早就保存过码单版式的站点，它的覆盖模板里
 * 天生没有凭票码、也没有码下方那行字。只在 `defaultTemplate` 里加等于什么也没做：
 * `store.ts` 的取值规则是"用户改过就以用户的为准"。与其要求站长逐个场景点一次「恢复默认」
 * （会连带丢掉他自己调好的版式），不如在取模板这一刻缺什么补什么、该退的退，其它一个都不动。
 *
 * 三条，都不覆盖用户已经表过态的东西：
 *  1. **流程必备区块**（凭票码）缺了就补回来。位置照着出厂默认来：插在原本就在它前面的那个
 *     区块之后；默认里的锚点区块也被删了，就退到末尾——凭票码在署名前还是在票尾，都不影响
 *     它能不能被扫出来。
 *  2. **码下方那行可读内容**（`qrCaption`）缺了按「印」补齐，理由见 `withCodeCaptions`。
 *  3. **退役的凭单码块摘掉**，理由见 `withoutRetiredCodes`——这一条是删，删的理由比补的更硬：
 *     那张码已经没有东西会去扫它，而它装的号与磅单同形。
 *
 * 返回值在新旧内容一致时是**同一个引用**：`useReceiptTemplate` 直接把这个对象交给 React，
 * 每渲染一次都换新对象会让下游白白重渲染一轮。
 */
export function normalizeTemplate<T extends ReceiptTemplate>(template: T): T {
  const sections = withCodeCaptions(withoutRetiredCodes(template.sections));
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
