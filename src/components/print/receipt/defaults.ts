/**
 * 各场景的默认模板（出厂即用的版式，对应原 sheets.tsx 的三张票据 + 三类新增票据）。
 *
 * 默认模板只是「起点」：用户在打印模板编辑器里改完保存后，覆盖写进本地存储，
 * 打印时以用户模板为准；点「恢复默认」即回到这里。
 */
import type { PaperKind } from "@/lib/constants";
import type { FieldKind, GridCell, ReceiptScenario, ReceiptSection, ReceiptTemplate } from "./types";
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

/**
 * 照现场票样重排后的固定表格（`acquisitionVoucherTemplate`），2026-11-26 起是 A4 / 241 的出厂默认。
 * 这一份留给「想要字段多、不要格线」的站点，也留给热敏——卷纸上表格只会降级成一排排标签行。
 */
export function acquisitionSheetTemplate(paper: PaperKind): ReceiptTemplate {
  return withLayout({
    scenario: "weigh_order",
    name: "收购磅单（系统单据）",
    paper,
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
      // 这枚码**不是必备件**：没有扫码枪、或 58 纸嫌它占版的站点可以像其它区块一样删掉，
      // 结算窗口改按单号手敲 / 刷流转卡找单。出厂默认仍带着它——「先打票、后结算」那条
      // 主路径要靠它，只是不再拿 `required` 把删除入口锁死。
      {
        id: uid(),
        kind: "qr",
        title: "凭票结算码",
        text: "{{ticket_code}}",
        qrCaption: true,
      },
      // 价已经在票上了（制单那一刻就按价目表带过挂牌价，见 `orders.rs::create_order`），
      // 所以窗口那一步是"核对扣项、确认金额、领款"，不再说"算价"——票面与话术得对得上，
      // 客户照着票念的时候不能出现票上有的东西窗口却说没有
      { id: uid(), kind: "text", text: "结算：凭本票右下角的码到结算窗口确认扣项与金额后领款，无需重新过磅；票面标「预估」的金额以窗口确认的为准；票面丢失请到磅房补打。" },
      { id: uid(), kind: "sign", signers: ["磅员", "化验员", "结算员", "售粮人签字"] },
    ],
  });
}
function buildTemplate(scenario: ReceiptScenario): ReceiptTemplate {
  switch (scenario) {
    case "weigh_order":
      // 不指定纸型时的出厂那张 = A4，而 A4 / 241 出厂就是照票样的固定表格；
      // 热敏卷纸走字段区那份，分岔在 `defaultTemplate`
      return acquisitionVoucherTemplate("A4");
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
              "party_name", "counterparty_label", "variety_name", "grade", "warehouse", "vehicle_no", "driver_name", "stock_warning",
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
    case "outbound_voucher":
      // 出库唯一的一张纸：详情页那个按钮与工作台 F9 都打这份（从前还并列一个「打印码单」，
      // 2026-11-25 合一之后退役，只留 `outbound_order` 那一页给历史留痕对版式）
      return outboundWeighTicketTemplate("A4");
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

/**
 * 某场景在**某张纸**上的出厂默认模板。
 *
 * 纸型是模板的存储键之一（见 store.ts）：同一场景在 80 热敏与 A4 上是两份各自可改的版式，
 * 互不覆盖。缺省 paper 时取该场景出厂设计的那张纸，`scripts/receipt-code/check.ts` 与
 * 「没有登记打印机」时的兜底都按它走。
 */
/**
 * 画格线的两张纸。表格区块只在 A4 / 241 上有意义，卷纸（58 / 80）上会降级成一行行「标签 + 值」，
 * 所以这两张之外的纸型不出固定表格。
 */
function isGridPaper(paper: PaperKind): paper is "A4" | "dot241" {
  return paper === "A4" || paper === "dot241";
}

export function defaultTemplate(scenario: ReceiptScenario, paper?: PaperKind): ReceiptTemplate {
  if (scenario === "weigh_order" && paper && !isGridPaper(paper)) {
    // 磅单在卷纸上退回字段区小票：这张纸出厂原本是系统单据，固定表格换了默认纸型之后
    // 不能再拿 `buildTemplate` 的结果换个 `paper` 就交出去——那等于在 80 热敏上画十列表格
    return withLayout(acquisitionSheetTemplate(paper));
  }
  const base = buildTemplate(scenario);
  return withLayout(paper && paper !== base.paper ? { ...base, paper } : base);
}

/* ------------------------------------------------ 收购凭证（磅单的固定表格预设） */

/**
 * 「收购磅单（固定表格）」：格子与标签照纸质票样排，取值绑磅单场景字段。
 *
 * 2026-11-26 起这份是 A4 / 241 上磅单的**出厂默认**（先前挂在默认位置的是上面那份系统单据，
 * 这份只当预设）——现场用的就是这张印好的纸。反过来，系统单据降级成可选预设，
 * 想要字段多、不画格线的站点在编辑器里载入它。
 *
 * 表格区块（grid）只在 A4 / 241 单据风格里画格子，热敏纸上降级成「标签 + 值」行
 * （见 render.tsx / escpos.ts），所以这份不排到卷纸上当默认（`defaultTemplate` 里那道分岔）。
 *
 * 模板名里**不带纸型**（同出库磅单那条）：纸型是编辑器顶部的标签页、也是存储键的一维，
 * `defaultTemplate` 切纸型时只换 `paper` 不换名字，名字写着 A4 就会在 241 那一格挂出一份
 * 「收购凭证（A4）」和一份「收购凭证（241 针式）」——内容是同一份。
 *
 * 票样上有几栏我们系统里没有数据源：霉变扣量、不完善粒扣量（化验只出百分比，扣量算法里没有这两项）、
 * 折干水扣量/扣后量（票样印斜杠、库里没有这个口径）。从前它们排成空白格占着版位，2026-11-26 起
 * 整栏删掉、留下的栏按十列重新分配跨列——**版位给不存在的东西占着，就是让现场以为该往这儿看**。
 * 「留白给手写」这个理由只在预印纸质单上成立，我们打的是空白 A4 / 联单，纸上没有格子可填。
 */
export function acquisitionVoucherTemplate(paper: "A4" | "dot241"): ReceiptTemplate {
  return withLayout({
    scenario: "weigh_order",
    name: "收购磅单（固定表格）",
    paper,
    title: "收购凭证",
    copyNote: "第一联 存根（粮站留存）",
    showReprintBadge: true,
    // 日期与检质证号印在表格顶行（与票样同形），票头不再重复单号/日期/地址/电话那几行；
    // 站名照常打——票第一眼要认得出是哪家的
    showDocNo: false,
    showDocDate: false,
    showStationAddress: false,
    showStationPhone: false,
    updatedAt: BASELINE,
    sections: [
      {
        id: uid(),
        kind: "grid",
        // 整表十列：每一行的 colspan 合计必须是 10，`table-fixed` 按第一行均分列宽，
        // 行数不齐就等于把后面的行挤扁（自检脚本按这条查每一行）
        rows: [
          { cells: [head("日期"), val("business_date", undefined, 4), head("单位：kg、元", 2), head("检质证号"), val("qc_report_no", undefined, 2)] },
          { cells: [head("品名"), val("variety_name"), head("车号"), val("vehicle_no"), head("卖方名称"), val("party_name", undefined, 2), head("卖方电话"), val("party_phone", undefined, 2)] },
          { cells: [head("身份证号"), val("id_card_masked", undefined, 2), head("银行名称"), val("bank_name", undefined, 2), head("银行卡号"), val("bank_account", undefined, 3)] },
          { cells: [head("容重(g/L)"), val("bulk_density"), head("水分(%)"), val("moisture_pct", "percent"), head("杂质(%)"), val("impurity_pct", "percent"), head("霉变(%)"), val("mold_pct", "percent"), head("不完善粒(%)"), val("unsound_pct", "percent")] },
          { cells: [head("现场扣量"), val("other_deduct", "weight", 3), head("水扣量"), val("moisture_deduct", "weight", 2), head("杂质扣量"), val("impurity_deduct", "weight", 2)] },
          { cells: [head("毛重"), head("皮重"), head("净重"), head("总扣量"), head("计价净重"), head("公斤价"), head("市斤价"), head("金额", 2), head("卸车费")] },
          { cells: [val("gross_weight", "weight"), val("tare_weight", "weight"), val("net_weight", "weight"), val("deduct_total", "weight"), val("settlement_weight", "weight"), val("price_per_kg", "money"), val("price_per_jin", "money"), val("goods_amount", "money", 2), val("deduction_fee", "money")] },
          { cells: [head("实付大写"), val("payable_upper", undefined, 5), head("实付"), val("paid_amount", "money", 3)] },
          { cells: [head("毛检日期"), val("gross_at", "datetime", 3), head("皮检日期"), val("tare_at", "datetime", 3), head("入库仓号"), val("warehouse")] },
          { cells: [head("地址及电话"), val("party_contact", undefined, 3), head("备注"), val("remark", undefined, 5)] },
        ],
      },
      // 码与结算提示照系统单据那份带着：这份从预设升成出厂默认之后，「先打票、后结算」那条
      // 主路径不能跟着断——票样上本来没有码位，就打在这张纸的表格下面、署名上面。
      {
        id: uid(),
        kind: "qr",
        title: "凭票结算码",
        text: "{{ticket_code}}",
        qrCaption: true,
      },
      { id: uid(), kind: "text", text: "结算：凭本票右下角的码到结算窗口确认扣项与金额后领款，无需重新过磅；票面标「预估」的金额以窗口确认的为准；票面丢失请到磅房补打。" },
      { id: uid(), kind: "sign", signers: ["检斤员", "付款员"] },
    ],
  });
}

/** 表头格：只印标签、与右侧的值格左右并排（纸质表单「品种 ｜ ＿」那种两格） */
function head(label: string, colspan?: number): GridCell {
  return { label, head: true, ...(colspan ? { colspan } : {}) };
}

/** 值格：只印取值，标签在同一行左边的表头格里（整行都是值格时取上一行同一列） */
function val(key: string, kind?: FieldKind, colspan?: number): GridCell {
  return { label: "", key, ...(kind ? { kind } : {}), ...(colspan ? { colspan } : {}) };
}

/**
 * 「出库磅单」固定表格：照现场那张纸的格线排，八列均分，A4 与 241 针式同形。
 *
 * 抬头原样照票样印的是「发货凭证」，2026-11-25 改名出库磅单（`title` 与界面标签一起改，
 * 场景 id 与 `print_log.doc_type` 仍是 `outbound_voucher`，不动值域也就不动历史）。
 *
 * 与收购凭证那份是同一套格子画法（表头格 ｜ 值格左右并排，外加毛重 / 皮重 / 净重那一整行只有值、
 * 标签在上一行表头格里的排法）；分别是这张八列均分、收购凭证十列，栏位也各照各的票样。
 *
 * 2026-11-26 删掉票样上没有数据源的栏：水分（出库侧没有化验扣项，取值是空）、合同号、司机电话、
 * 前后箱号 / 前后封号（整行）、运费。这些从前排成空白格「留现场手填」，但我们打的是空白 A4 / 联单、
 * 纸上没有格子可填，留着只是让现场以为这几栏该往这儿看；删掉之后每行按八列重新分配跨列。
 * 对应的那几个字段仍在 `VOUCHER_FIELDS` 目录里（取值恒为空），编辑器里还能选，但版面上不再占位。
 *
 * 模板名里**不带纸型**：纸型是编辑器顶部的标签页、也是存储键的一维，同一份版式在 A4 与 241
 * 上是各自的一格。从前名字里写着「（A4）」，切到 241 那一格时 `defaultTemplate` 只换 `paper`
 * 不换名字，241 页上就同时挂着「出库磅单（A4）」和「出库磅单（241 针式）」两份一模一样的版式。
 */
export function outboundWeighTicketTemplate(paper: "A4" | "dot241"): ReceiptTemplate {
  return withLayout({
    scenario: "outbound_voucher",
    name: "出库磅单（固定表格）",
    paper,
    title: "出库磅单",
    copyNote: "第一联 存根（发货方留存）",
    showReprintBadge: true,
    // 日期与凭证号印在表格顶行（与票样同形），票头不再重复单号/日期/地址/电话那几行；
    // 站名照常打——票第一眼要认得出是哪家的
    showDocNo: false,
    showDocDate: false,
    showStationAddress: false,
    showStationPhone: false,
    updatedAt: BASELINE,
    sections: [
      {
        id: uid(),
        kind: "grid",
        // 整表八列：每行 colspan 合计必须是 8（同收购凭证那条，自检脚本按行查）
        rows: [
          { cells: [head("日期"), val("business_date", undefined, 2), head("单位：kg、元", 2), head("凭证号"), val("order_no", undefined, 2)] },
          { cells: [head("品种"), val("variety_name"), head("车号"), val("vehicle_no", undefined, 2), head("等级"), val("grade", undefined, 2)] },
          { cells: [head("收货方"), val("receiver", undefined, 3), head("出库仓号"), val("warehouse", undefined, 3)] },
          { cells: [head("毛重"), head("皮重"), head("净重"), head("公斤价"), head("市斤价", 2), head("司机名称", 2)] },
          { cells: [val("gross_weight", "weight"), val("tare_weight", "weight"), val("net_weight", "weight"), val("price_per_kg", "money"), val("price_per_jin", "money", 2), val("driver_name", "text", 2)] },
          { cells: [head("总金额大写"), val("goods_amount_upper", undefined, 4), head("金额"), val("goods_amount", "money", 2)] },
          { cells: [head("毛检时间"), val("gross_at", "datetime", 3), head("皮检时间"), val("tare_at", "datetime", 3)] },
          { cells: [head("备注"), val("remark", undefined, 7)] },
        ],
      },
      { id: uid(), kind: "sign", signers: ["发货方负责人", "检斤员", "收货方"] },
    ],
  });
}

/**
 * 「出库磅单（系统单据）」：同一张纸上的另一种排法——不画格线，按收购码单那种
 * 「字段区 + 备注 + 凭单码 + 说明 + 署名」排，给想要字段多、又不想照纸质表单填格的站点。
 *
 * 为什么挂在 `outbound_voucher` 场景而不是让人去改 `outbound_order` 那一页：出库三个出票点
 * （详情页 / 出库板 / 工作台 F9）打的都是 `outbound_voucher`，`outbound_order` 只剩历史留痕
 * （见 TemplateEditor 的 SCENARIO_LIST），在那一页改版式打不到纸上。
 *
 * 字段绑的是出库磅单自己的目录（`scenarios.tsx` 的 VOUCHER_FIELDS），不抄码单那套：两处字段名与
 * 取值口径不同（收货方 = `receiver`、市斤价、箱封几栏在码单目录里根本没有），跨场景抄会打成一片「—」。
 * 单号与业务日期也不列进字段区——票头那两行本来就打它们，同一张纸上再来一遍就是两个号。
 */
export function outboundSheetTemplate(paper: "A4" | "dot241"): ReceiptTemplate {
  return withLayout({
    scenario: "outbound_voucher",
    name: "出库磅单（系统单据）",
    paper,
    title: "出库磅单",
    copyNote: "第一联 存根（发货方留存）",
    showReprintBadge: true,
    updatedAt: BASELINE,
    sections: [
      {
        id: uid(),
        kind: "kv",
        // 同一个组的字段连着排：票面按"连续同组"切段，跳着排会冒出第二个同名小标题（同收购码单那条规矩）
        fields: [
          "variety_name", "grade", "warehouse", "vehicle_no", "receiver",
          "gross_weight", "tare_weight", "net_weight", "gross_at", "tare_at",
          "price_per_kg", "price_per_jin", "goods_amount", "goods_amount_upper",
          "driver_name",
        ],
      },
      { id: uid(), kind: "text", text: "备注：{{remark}}" },
      {
        id: uid(),
        kind: "qr",
        title: "凭单码",
        text: "{{order_no}}",
        qrCaption: true,
      },
      { id: uid(), kind: "text", text: "本单为出仓凭证，右下角的码就是本单凭证号，扫任意检索框可查到这张单。粮已出门后重量与金额不可改，需更正由站长红冲本单后另开一张。" },
      { id: uid(), kind: "sign", signers: ["发货方负责人", "检斤员", "收货方"] },
    ],
  });
}

/**
 * 某场景**在某张纸上**可「载入」的版式预设：该纸的出厂默认排第一，后面是同一张纸上的附加预设。
 * 磅单与出库磅单两张现在同形：A4 / 241 出厂是照票样的固定表格，附加的那份是系统单据；
 * 热敏出厂本来就是系统单据，附加为空。
 *
 * 按纸型筛是必须的：在 80 热敏那一页里列出一份 241 的版式，载入完纸型跟着跳到 241，
 * 等于让「选预设」这个动作偷偷改了顶部的纸张标签页。不传 paper = 全部（自检脚本按这条查出厂码块）。
 */
export function presetsFor(scenario: ReceiptScenario, paper?: PaperKind): ReceiptTemplate[] {
  const extras: ReceiptTemplate[] = [];
  if (scenario === "weigh_order") extras.push(acquisitionSheetTemplate("A4"), acquisitionSheetTemplate("dot241"));
  if (scenario === "outbound_voucher") extras.push(outboundSheetTemplate("A4"), outboundSheetTemplate("dot241"));
  return [defaultTemplate(scenario, paper), ...extras.filter((p) => !paper || p.paper === paper)];
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
 *  1. **流程必备区块**（只有出库码单的凭单码还带 `required`）缺了就补回来。位置照着出厂默认来：
 *     插在原本就在它前面的那个区块之后；默认里的锚点区块也被删了，就退到末尾——凭单码在署名前
 *     还是在票尾，都不影响它能不能被扫出来。磅单的凭票码已改为可选，删了不会被补回。
 *  2. **码下方那行可读内容**（`qrCaption`）缺了按「印」补齐，理由见 `withCodeCaptions`。
 *  3. **退役的凭单码块摘掉**，理由见 `withoutRetiredCodes`——这一条是删，删的理由比补的更硬：
 *     那张码已经没有东西会去扫它，而它装的号与磅单同形。
 *
 * 返回值在新旧内容一致时是**同一个引用**：`useReceiptTemplate` 直接把这个对象交给 React，
 * 每渲染一次都换新对象会让下游白白重渲染一轮。
 */
export function normalizeTemplate<T extends ReceiptTemplate>(template: T): T {
  const sections = withCodeCaptions(withoutRetiredCodes(template.sections));
  const baseline = defaultTemplate(template.scenario, template.paper).sections;
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
