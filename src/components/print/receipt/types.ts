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
import type { ReceiptLayout } from "./paper";
import type {
  DailyReport,
  LedgerRow,
  PaymentRecord,
  QcReport,
  Settlement,
  Station,
  WeighOrder,
} from "@/mock/types";

/** 系统中所有可打印小票的场景。与 PrintLog.doc_type、业务触发点一一对应 */
export type ReceiptScenario =
  | "weigh_order"
  | "quality_report"
  | "settlement_voucher"
  | "payment_receipt"
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
 */
export type BlockKind = "kv" | "table" | "sign" | "text" | "qr";

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
  /** text / qr：自由文本行（如备注、提示语），qr 区块里这条就是二维码载荷，支持 {{字段}} 占位 */
  text?: string;
  /** qr：模块倍率（1=小 2=中 3=大）。热敏机另有自己的 size 指令，这里只管 A4/预览的视觉大小 */
  qrScale?: 1 | 2 | 3;
  /** qr：码下方是否附一行可读的单号（纸被晒白了、码扫不出来时人工兜底） */
  qrCaption?: boolean;
  /**
   * 业务流程必备件：编辑器不给删、恢复默认之外任何路径都不会丢掉它。
   *
   * 只有一种东西配得上这个标记——扫了就能定位单据的凭票码。它一旦被删，
   * 「先打票、后集中结算」这条主路径就断了：客户拿着没有码的票到窗口，
   * 司磅员只能靠手敲单号，纸质票存在的意义随之消失。删除入口在编辑器里禁用，
   * 真正的兜底在打印边界（见 `defaults.ts` 的 `ensureRequiredBlocks`）。
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
