/**
 * 小票模板引擎的类型定义（自定义打印的统一抽象）。
 *
 * 设计目标：把「打印什么场景 / 该场景有哪些上下文数据 / 模板长什么样」三者解耦，
 * 这样新增一种票据只需在 scenarios.tsx 里登记一份目录，渲染器（render.tsx）与
 * 编辑器（TemplateEditor.tsx）无需改动即可支持。
 *
 * 与 05 文档 §9 的对应关系：三张核心票据（过磅单 / 质检单 / 结算凭证）原本写死在
 * sheets.tsx 里，现在改为「场景目录 + 用户模板」驱动；台账与日报表原本走系统打印，
 * 也纳入同一套模板体系，从而「每种场景都能自定义、且动态挑选字段」。
 */
import type { ReactNode } from "react";
import type { PaperKind } from "@/lib/constants";
import type { CodeScale } from "./code-size";
import type { ReceiptLayout } from "./paper";
import type {
  DailyReport,
  LedgerRow,
  OutboundDetail,
  PaymentRecord,
  QcReport,
  Settlement,
  Station,
  WeighOrder,
} from "@/mock/types";

/**
 * 系统中所有可打印小票的场景。与 `PrintLog.doc_type`、业务触发点一一对应。
 *
 * **这里的每一个 id 都会原样写进 `print_log.doc_type`**（`silent.ts` 里 `doc_type: scenario`，
 * 中间没有第二份映射），所以每个 id 都必须是库那一列 CHECK 允许的值——
 * 少一个值，票打得出来但留痕撞 CHECK（付款小票就这么活了很久，见迁移 0030）。
 * 判据钉在 `scripts/receipt-code/check.ts` 的 N 段。
 */
export type ReceiptScenario =
  | "weigh_order"
  | "quality_report"
  | "settlement_voucher"
  | "payment_receipt"
  | "outbound_order"
  | "ledger"
  | "daily_report";

/** 字段的语义类型，渲染器据此决定样式（金额/重量用等宽字体） */
export type FieldKind = "text" | "money" | "weight" | "ton" | "percent" | "datetime" | "enum";

/** 一个可被选入模板的上下文数据项（目录里的"一条数据"） */
export interface FieldDef {
  key: string;
  /** 中文名，编辑器的复选项与票面上的标签都用它 */
  label: string;
  /** 分组，编辑器按组折叠展示，便于在几十个字段里找到想要的 */
  group: string;
  kind: FieldKind;
}

/** 表格型区块里的一列定义 */
export interface ColumnDef {
  key: string;
  label: string;
  kind: FieldKind;
}

/** 一个可被表格区块引用的数据集（如结算单下的磅单明细、质检单下的指标） */
export interface TableDef {
  dataset: string;
  label: string;
  columns: ColumnDef[];
}

/**
 * 模板由若干有序区块组成；区块类型决定渲染方式。
 *
 * `qr` 与其他四种的区别只在落点：内容是同一条 `{{字段}}` 占位文本（与 text 区块同一套
 * 解析规则），但渲染出来是码而不是字。之所以仍让用户模板携带它而不写死在票面里——
 * 热敏机的码由 Rust（escpos 指令）画、A4 的码由前端 SVG 画，两边都必须读到同一份载荷，
 * 否则「预览里有什么、纸上就有什么」这条承诺就破了。
 *
 * 这个 kind 叫 `qr`、装的却可能是条码（`codeStyle`）：**kind 是存进用户本机模板里的字符串**，
 * 改名等于让所有存过码区块的站点一觉醒来发现票上没码了。所以加字段不改名，界面上叫「条码 / 二维码」。
 */
export type BlockKind = "kv" | "table" | "sign" | "text" | "qr";

/**
 * 码区块要画哪一种码。
 *
 * 现场两种枪都有：激光枪（几十块钱那种键盘口）解不动二维码，影像枪两种都吃。
 * 票上只印二维码，遇到前一种枪就是一张扫不出来的纸。字段缺省仍是 `"qr"`——
 * 老模板里没有这个字段，缺什么就照历史行为来，不擅自改任何人已经打顺了的版式。
 * 出厂默认模板里现在只剩一枚码：过磅单那枚「凭票结算码」，在窗口给影像枪扫的，只出二维码。
 * 结算凭证从前出厂带一枚**仅一维条码**的「凭单码」（伺候键盘口激光枪），随"扫凭证核销挂账"
 * 那条入口一起退役了（02 §F1.4 本版：磅房只认磅单码）——码制这个字段留给站长自己加的码。
 */
export type CodeStyle = "qr" | "barcode" | "both";

/** 区块类型的中文名。编辑器的添加按钮与预览里"空区块"的提示共用这一份，不抄第二遍 */
export const BLOCK_LABEL: Record<BlockKind, string> = {
  kv: "字段区",
  table: "表格区",
  sign: "署名区",
  text: "文本行",
  qr: "条码 / 二维码",
};

/** 码制选项的中文名（`ReceiptSection.codeStyle`） */
export const CODE_STYLE_LABEL: Record<CodeStyle, string> = {
  qr: "仅二维码",
  barcode: "仅一维条码（CODE128）",
  both: "二维码 + 条码都打",
};

export interface ReceiptSection {
  id: string;
  kind: BlockKind;
  /** kv / table / sign 区块的标题（可空） */
  title?: string;
  /** kv：被选入的字段 key（顺序即票面顺序） */
  fields?: string[];
  /** table：引用的数据集 + 选中列 */
  dataset?: string;
  columns?: string[];
  /** sign：署名栏标签，如 ["磅员","化验员","售粮人签字"] */
  signers?: string[];
  /** text / qr：自由文本行（如备注、提示语），qr 区块里这条就是码的载荷，支持 {{字段}} 占位 */
  text?: string;
  /** qr：画哪种码。缺省 `"qr"`（这个字段出现之前存下来的模板全都只有二维码） */
  codeStyle?: CodeStyle;
  /**
   * qr：码的尺寸档位（见 `code-size.ts` 的档位表，一模块占几个点）。
   *
   * 从前只有 A4 与预览认它、热敏机恒用固件默认的 4 点，于是站长把「大」调到最大，
   * 小票机打出来分毫未变——现在三条路都读它。二维码与一维码共用这一档：
   * 对条码而言它是窄条的宽度，同一档出来的物理大小与二维码一致。
   */
  qrScale?: CodeScale;
  /**
   * qr：码下方是否附一行可读的内容——**就是码的载荷原文**。本版的载荷就是单号本体
   * （02 §F1.4），所以这一行与票面那行「单号」同值：它的用处不再是"码里还有位前缀、
   * 票头没写"，而是磨花、缺针时人眼能直接读出码里究竟装了什么、与票头对不对得上。
   *
   * 码被晒白、磨花、缺针断线之后，这行字是票上唯一还认得出是哪张单的东西，所以它是现场
   * 兜底而不是版式偏好：**缺省即印**。没写过这个字段的老模板由 `defaults.ts` 的
   * `normalizeTemplate` 在取用那一刻补成 `true`；只有用户明确关过（`false`）的不印。
   * 热敏那一路（`escpos.ts`）与 A4 / 预览这一路都认它，两处不能再分叉。
   */
  qrCaption?: boolean;
  /**
   * 业务流程必备件：编辑器不给删、恢复默认之外任何路径都不会丢掉它。
   *
   * 只有一种东西配得上这个标记——扫了就能定位单据的凭票码。它一旦被删，
   * 「先打票、后集中结算」这条主路径就断了：客户拿着没有码的票到窗口，
   * 司磅员只能靠手敲单号，纸质票存在的意义随之消失。删除入口在编辑器里禁用，
   * 真正的兜底在打印边界（见 `defaults.ts` 的 `normalizeTemplate`）。
   */
  required?: boolean;
}

/** 一张完整的小票模板 */
export interface ReceiptTemplate {
  scenario: ReceiptScenario;
  name: string;
  paper: PaperKind;
  /**
   * 票面版式。缺省按纸型推（热敏 → 小票风格，A4 / 针式 → 单据风格），
   * 一旦用户在编辑器里动过就以模板存的为准——否则"把 241 联单排成小票风格"这种
   * 合理需求没法表达。见 paper.ts 的说明。
   */
  layout?: ReceiptLayout;
  /** 票据大标题，如「收购码单（过磅单）」 */
  title: string;
  /** 联次说明，如「第一联 存根（粮站留存）」 */
  copyNote: string;
  /** 是否允许在票面上显示「补打」角标（补打场景由打印入口传入，这里只是开关） */
  showReprintBadge: boolean;
  sections: ReceiptSection[];
  updatedAt: string;
}

/** 把人员 id 翻译成姓名；署名栏与经手人列都用它 */
export type NameResolver = (id: number | null | undefined) => string;

/**
 * 渲染某张小票时需要的全部上下文。
 * 一个对象装下所有场景的载荷，缺哪个由对应场景的解析器自行判空——
 * 这样 ReceiptContext 类型稳定，新增场景不必改到处传参。
 */
export interface ReceiptContext {
  station: Station;
  names: NameResolver;
  reprint?: boolean;
  order?: WeighOrder;
  qc?: QcReport | null;
  settlement?: Settlement;
  payment?: PaymentRecord;
  /** 出库码单（F11.7）。带 0029 的毛/皮与称重轨迹，票面才印得出「这重量怎么来的」 */
  outbound?: OutboundDetail;
  ledgerRows?: LedgerRow[];
  daily?: DailyReport;
}

/** 场景规格：目录 + 解析器 + 样例，渲染器与编辑器都只认这个接口 */
export interface ScenarioSpec {
  id: ReceiptScenario;
  label: string;
  /** 业务里在哪里触发打印（用于规划说明） */
  entry: string;
  /** 字段目录，编辑器据此渲染可选数据面板 */
  fields: FieldDef[];
  /** 字段分组顺序（决定面板折叠顺序） */
  groups: string[];
  /** 表格型数据集（质检指标 / 结算磅单明细 / 台账行 / 日报表品种行） */
  tables?: TableDef[];
  /** 按 key 把一条上下文数据解析成票面文本 */
  resolveField: (key: string, ctx: ReceiptContext) => ReactNode;
  /** 取某数据集的行（已解析为「列 key → 文本」），无该数据集返回空 */
  tableRows?: (dataset: string, ctx: ReceiptContext) => Array<Record<string, ReactNode>>;
  /** 编辑器实时预览用的样例上下文（不依赖接口） */
  sampleContext: () => ReceiptContext;
}
