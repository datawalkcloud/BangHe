/**
 * 磅单票面码的载荷契约（02 §F1.4「先打码单、后集中结算」的落地凭据）。
 *
 * 业务背景：绝大多数粮站的常态是**先过磅、先打码单把票给客户**，客户下午/第二天
 * 再拿一票或多票到结算窗口统一算钱。于是纸上必须有一个东西能让结算窗口一步定位到
 * 那张磅单——纸质码单上能扫的就只有这一个二维码，它一旦改动，发出去的旧票全部作废，
 * 所以这份契约收敛在本文件：写的一侧只有一条轨，读的一侧只允许**新增兼容轨**，
 * 不许改已有轨的解析结果。
 *
 * **本版契约只有一句话：码里装的就是票面那行「单号」，一位前缀都不加。**
 * 单号 `01202610000053` → 码里也是 `01202610000053`。
 *
 * 走到这一步是两件事叠在一起，都不是审美：
 *  1. **字母不能有**（这一条从没变过，是现场两次事故换来的）。2026-10-07 那台开着中文
 *     输入法的装机上，票面印 `BH1:BD01202610000053`，枪打进来是 `BH：BD1202610000053`
 *     （`B`、`H` 落进拼音合成串、紧跟的 `1` 被当成候选项序号键吃掉、冒号折成全角），
 *     另一台更狠，只剩 `D01202610000069`。字母是这件事的必要条件：一串纯数字没有任何
 *     东西可以开始拼拼音。所以号与载荷一起数字化了（03 §3.5 / 迁移 0026）。
 *  2. **票种位也不要了**。磅房作业只认磅单码：结算凭证那枚「凭单码」连同它的扫码入口
 *     一起退役（02 §F1.4 兑付那一步）。从前把票种塞进载荷第 2 位，为的是在窗口分开
 *     "来结算的码单"与"来付尾款的凭证"；现在窗口这一侧只按磅单查库，那两位前缀只剩坏处：
 *     码与票面那行字不再是同一串（磨花了照字敲就敲不进去），扫进任何检索框都要先剥掉它
 *     （`searchKeyword`），而"为什么扫出来的比号多两位"这句话每次装机都要从版本位讲一遍。
 *
 * 三条设计约束：
 *  1. **只装定位符**：金额、扣量、证号一律不进载荷。票是先打的、价是后算的，把金额写进码
 *     就等于允许客户改价；把证号写进码等于把 PII 印在流通纸上。载荷只是定位符，
 *     一切数值以扫到单号后从库里读出来的为准。
 *  2. **种类靠查库判，不在形状上赌**：递进来一串像单号的数字，就按磅单去查，查不到当场说
 *     "查无此单"。同一站点同一月里各票种各自从 1 号排起、必然出现同号（`seq_counter` 按票种
 *     分开计数，<span>orders.rs 的 `next_no`</span>），而**带码的票不止磅单一种**（出库单也带，
 *     02 §M11）——所以"库里查到一张同号磅单"不等于"客户递来的就是它"。这一条由工作台那道
 *     **同号闸门**收尾：这串号同时是出库单时当场说破、不开框（自检 F6 / F7 把两者钉在一起）。
 *  3. **只加不改**：已经发到农户手里的票不许因为升级扫不出来。读的一侧三条轨永久并存——
 *     ① 本版（＝单号本体）② 上一版的数字载荷（`11`…`15` + 单号）③ 更早的 `BH1:` 字母轨
 *     （含版本位被输入法吞掉的 `BH:`）。写的一侧只有 ①。
 */

/** 认得的旧载荷版本位（第 ② 轨），按新→旧排列。本版写侧不再有版本位 */
const KNOWN_VERSIONS: readonly string[] = ["1"];

/** 单据种类。与 `print_log.doc_type`、五种取号角对得上 */
export type DocKind = "order" | "qc" | "settlement" | "payment" | "outbound" | "unknown";

interface KindSpec {
  kind: DocKind;
  /** 中文名，用于"客户递上来的不是磅单"这类提示 */
  label: string;
}

/** 种类 → 中文名。三条读轨共用这一份，别在话术里再抄一遍 */
const KIND_LABEL: Record<DocKind, string> = {
  order: "收购码单",
  qc: "质检单",
  settlement: "结算凭证",
  payment: "付款凭证",
  outbound: "出库单",
  unknown: "单据",
};

/**
 * 票种码（上一版载荷的第 2 位）→ 种类。
 *
 * 只服务第 ② 轨：那张纸上种类写在码里而不是号上，剥掉前两位才是库里的号。
 * 写的一侧用不到它——除了磅单，已经没有票要打码。`6`…`9` 留给以后的新票种，
 * 红冲单不占号（Rust 侧用 `reversed_order_id` 关联，只有 mock 里有个 `HC`）。
 */
export const DOC_KIND_BY_CODE: Record<string, KindSpec> = {
  "1": { kind: "order", label: KIND_LABEL.order },
  "2": { kind: "qc", label: KIND_LABEL.qc },
  "3": { kind: "settlement", label: KIND_LABEL.settlement },
  "4": { kind: "payment", label: KIND_LABEL.payment },
  "5": { kind: "outbound", label: KIND_LABEL.outbound },
};

/** 一条已解析的扫码结果 */
export interface ScannedCode {
  /**
   * 种类。本版那条轨（码＝单号本体）**不给种类**，返回 `unknown`：
   * 它是不是一张磅单由调用方查库定（约束 2），查到了才是 `order`。
   */
  kind: DocKind;
  /** 种类中文名（未知种类给"单据"） */
  label: string;
  /** 单据号本体，已归一化成大写。新号形是纯数字，存量号带两位字母前缀 */
  docNo: string;
  /**
   * 这一串是从哪儿来的：
   *  - `bare`    本版：单号本体——扫票面码、照票面那行字敲、从别的界面带过来，长得一样
   *  - `payload` 上一版的数字载荷（版本位 + 票种位 + 单号），种类从票种位来
   *  - `legacy`  更早的存量载荷（`BH1:` 头，含版本位被输入法吞掉的那一种）
   */
  source: "bare" | "payload" | "legacy";
}

/**
 * 单号本体（03 §3.5 新号形）：站码 2 + 年 4 + 月 2 + 流水 1~12（`doc_no_seq_len`），
 * 全数字。年只卡 `20xx`、月只卡 01-12——足以挡掉绝大多数外来条码（EAN-13 是 13 位、
 * 身份证 18 位带校验、IC 卡 UID 是 8 位十六进制），而**存不存在由查库说了算**，
 * 所以不按长度死卡，也不在这里比对站码。
 */
const DOC_NO_RE = /^\d{2}20\d{2}(0[1-9]|1[0-2])\d{1,12}$/;

/**
 * 存量单号：两位字母前缀打头（`BD01202610000053`），以及更早的连字符写法
 * （`BD20260912-00317`）。与今天的 `DOC_NO_RE` 逐字相同，**不许收紧**——
 * 存量库里的号就是这个形状，改一个字符就有票扫不出来。
 */
const LEGACY_DOC_NO_RE = /^[A-Z]{2}[A-Z0-9-]{4,22}$/;

/** 上一版的数字载荷：版本位 1 + 票种位 1-5 + 单号（9~20 位数字） */
const LEGACY_PAYLOAD_RE = /^([1-9])([1-5])(\d{9,20})$/;

/** 存量载荷里认得的头。冒号有无都认（全角已在归一化里折成半角） */
const LEGACY_HEADS = ["BH1:"] as const;

/**
 * 版本位可缺的宽容前缀：`BH1` 之外也认 `BH`。
 *
 * 现场实测（2026-10-07）：票面印的是 `BH1:BD01202610000053`，枪打进来却是
 * `BH：BD1202610000053`——丢的就是那一个版本位，其余字符基本齐。这种串按老规矩整条
 * 拒收，磅房看到的就是"扫三次失败三次"，而票是好的、单号是清楚的。所以这里只放宽
 * **版本位**这一格：`BH` / `BH:` / `BH1:` / `BH1` 都认，认完照旧要求剩下的部分过
 * `LEGACY_DOC_NO_RE` 并查得到单——**不做任何模糊匹配**：少一位数字、串位那种一律不救，
 * 宁可让操作员重扫一次，也不能拿一串像单号又不是单号的东西去结钱。
 *
 * 本版的载荷（纯单号）不需要这类容错：没有前缀就没有可吞的那一格。
 */
const TOLERANT_LEGACY_HEAD = /^BH1?/;

/**
 * 把一张单据的单号编成印在票面上的二维码/条码载荷。**所有票同一条规则**：
 *
 * **码里就是单号本体，一字不加**：票面那行「单号」与右下角那个码是同一串，晒白、磨花、
 * 缺针断线之后照字敲那一行也照样进得了窗口；检索框更是一个字符都不用处理。
 *
 * 带字母的存量号（升级前制单、事后补打的那张旧单）照它的本体打。从前这一种要额外套一个
 * `BH1:` 头，是因为载荷里得写出"这是第几版、这是哪种票"；现在两件事都不用码来说了，
 * 而那串字母本来就还在号上（`BH1:` + 字母号的输入法风险不比历史大）。真扫不进时，
 * 票面那行可读单号 + 「磅单中心」检索是留给这种纸的退路。
 *
 * 名字里不带票种，是因为规则里已经没有票种了：出库码单（02 §M11 F11.7）落笔时要问的
 * 就是"这张纸的码该装什么"，答案与磅单逐字相同——装它自己的号。种类靠查库判（见约束 2），
 * 不靠码里多出来的那两位。
 */
export function encodeTicketCode(docNo: string): string {
  return normalize(docNo);
}

/**
 * 磅单侧的名字，保留是因为它读起来就是"这张磅单的码"，调用点不必再解释一遍。
 * 与 [`encodeTicketCode`] 是同一件事，别在这里加任何磅单专属的处理——那会让两种票的码悄悄分叉。
 */
export function encodeOrderCode(docNo: string): string {
  return encodeTicketCode(docNo);
}

/**
 * 解析扫码枪/测试框里拿到的一串字符。三条读轨按"信息量多→少"排：
 * ② 上一版的数字载荷（种类写在票种位里）；③ 更早的 `BH1:` 字母轨；① 本版的单号本体。
 *
 * ① 落下来时 `kind` 是 `unknown` 而不是 `order`：**一串像单号的数字到底是不是真有一张磅单，
 * 只有库能回答**（约束 2）。界面拿它去查磅单，查到就是这张单、查不到就说"查无此单"。
 *
 * 容错是功能而不是锦上添花，现场三类脏输入每天都在发生：
 *  - 扫码枪后缀的回车、制表符、空格（`appendEnter` 的键盘模拟枪必带）；
 *  - 中文输入法下的全角冒号与全角数字（照票面那行字敲时最常见）；
 *  - 小写与首尾空白（手输）。
 * 归一化之后仍然认不出来的，返回 null 交回界面提示，**不猜**。
 */
export function parseScannedCode(raw: string): ScannedCode | null {
  const s = normalize(raw);
  if (!s) return null;

  // ② 上一版的数字载荷：版本位 + 票种位 + 单号（旧票还在农户手里，剥掉前两位才是号）
  const m = LEGACY_PAYLOAD_RE.exec(s);
  if (m) {
    const spec = DOC_KIND_BY_CODE[m[2]];
    if (KNOWN_VERSIONS.includes(m[1]) && spec && DOC_NO_RE.test(m[3])) {
      return { kind: spec.kind, label: spec.label, docNo: m[3], source: "payload" };
    }
    // 版本位或票种位对不上：不认成载荷，往下走单号本体那一条（认不出就统一 null）
  }

  // ③ 更早的存量载荷：BH1: 头 + 带字母前缀的单号
  const legacy = parseLegacy(s);
  if (legacy) return legacy;

  // ① 本版：一串单号本体（票面码、照票面那行字敲的、或从别的界面带过来的）
  if (DOC_NO_RE.test(s)) return { kind: "unknown", label: KIND_LABEL.unknown, docNo: s, source: "bare" };

  return null;
}

/** 存量单号的前两位字母 → 种类。只服务第 ③ 轨，本版的码不从号上抠种类 */
const LEGACY_KIND_BY_PREFIX: Record<string, DocKind> = {
  BD: "order",
  ZJ: "qc",
  JS: "settlement",
  FK: "payment",
  CK: "outbound",
};

/**
 * 第 ②③ 轨共用的字母号那一侧：认头 → 认单号形状 → 按前两位字母判种类。
 * 带不带 `BH1:` 头都认（头是"这张纸印的是上一版载荷"的证据，仅此而已），
 * 解析结果与改版前逐字一致——存量库里的号就是这个形状。
 */
function parseLegacy(s: string): ScannedCode | null {
  let rest = s;
  let head = false;
  for (const p of LEGACY_HEADS) {
    const h = p.slice(0, p.length - 1); // "BH1"
    if (rest.startsWith(h)) {
      rest = rest.slice(h.length).replace(/^:/, "");
      head = true;
      break;
    }
  }
  if (!head) {
    // 版本位被输入法吃掉的那一种（见 TOLERANT_LEGACY_HEAD）：剥掉 BH 后必须还剩一串像单号的东西
    const m = TOLERANT_LEGACY_HEAD.exec(rest);
    if (m && rest.length > m[0].length) {
      rest = rest.slice(m[0].length).replace(/^:/, "");
      head = true;
    }
  }
  if (!rest || !LEGACY_DOC_NO_RE.test(rest)) return null;
  const kind = LEGACY_KIND_BY_PREFIX[rest.slice(0, 2)] ?? "unknown";
  return {
    kind,
    label: KIND_LABEL[kind],
    docNo: rest,
    // 没头 = 本版补打存量单打出来的那串本体（① 轨）；有头 = 手上那张老纸（③ 轨）
    source: head ? "legacy" : "bare",
  };
}

/** 这张票能不能直接进磅房那个结算框（只有磅单可以；旧票轨认得出的种类在这里用） */
export function settleable(code: ScannedCode | null): code is ScannedCode & { kind: "order" } {
  return code?.kind === "order";
}

/**
 * 把「关键字检索框」里收到的一串换成**真正拿去查库的那一串**。
 *
 * 本版的码与票面单号是同一串，扫一下什么都不用改；这一步服务的是剩下的两种情况：
 *  - **手上的旧票**：上一版载荷比号多两位（`1101202610000053`），更早的还带着 `BH1:` 头。
 *    库里存的是单号本体，带着这些去 `LIKE` 必然零命中，而现场只看到"扫了没反应"。
 *  - **枪与输入法留下的渣**：回车/制表后缀、全角数字、首尾空白——`normalize` 一并折掉。
 *
 * **只有确实解析成一张票时才改写**：本版那条轨的 `docNo` 本来就等于输入本身，
 * 姓名、车牌、证号后 4 位过不了解析，原样交回。
 *
 * 站码形如 `1x`/`2x` 的单号不会被误剥两位：剥完之后剩下的串必须仍过 `DOC_NO_RE`
 * （第 3–4 位得是 `20`，即年份以 20 结尾才可能撞上），过不了就退回单号本体那一轨、
 * 原样交回。这一条由 `scripts/receipt-code/check.ts` 的 K 段钉住。
 */
export function searchKeyword(raw: string): string {
  const trimmed = raw.trim();
  const code = parseScannedCode(trimmed);
  return code ? code.docNo : trimmed;
}

/**
 * 归一化：全角→半角、去空白与控制字符、转大写。
 * 扫码枪在 Windows 上就是一个键盘设备，换行是以按键形式进来的，所以必须先切第一行再清干净。
 */
function normalize(raw: string): string {
  return raw
    .split(/[\r\n]+/)[0]
    .replace(/[\t\b\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, "")
    // 全角 ASCII（含全角冒号、全角数字字母）统一折回半角，覆盖中文输入法手输
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toUpperCase();
}

/**
 * 票面码示例（测试扫码框的占位文案与站点参数说明用）。号形只在这里写一遍，
 * 界面另抄一份的话，改了号形就会有一处一直在教操作员打一串废码。
 *
 * 本版的码＝单号本体，与票面那行「单号」逐字相同。老纸上的载荷（比号多两位版本位 + 票种位）
 * 由 `parseScannedCode` 的第 ② 轨认，那份示例直接看 `scripts/receipt-code/check.ts` 的 J 段。
 */
export const CODE_EXAMPLES = {
  order: encodeOrderCode("01202610000053"),
};
