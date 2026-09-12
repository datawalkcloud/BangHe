/**
 * 凭票二维码的载荷契约（02 §F1.4「先打码单、后集中结算」的落地凭据）。
 *
 * 业务背景：绝大多数粮站的常态是**先过磅、先打码单把票给客户**，客户下午/第二天
 * 再拿一票或多票到结算窗口统一算钱。于是纸上必须有一个东西能让结算窗口一步定位到
 * 那张磅单——纸质码单上能扫的就只有这一个二维码，它一旦改动，发出去的旧票全部作废，
 * 所以这份契约收敛在本文件，只允许**新增版本前缀**，不允许改已有的解析结果。
 *
 * 三条设计约束：
 *  1. **载荷必须能被扫码枪以"键盘"形式吐出来**：只用可见 ASCII，不含空格、中文、
 *     百分号之类会被输入法/编码转换折腾的字符；结算窗口因此不需要网络也能定位。
 *  2. **前缀即路由**：纸上同时可能印着磅单、质检单、结算单、付款小票四种条码，
 *     扫码框无法预知客户递上来的是哪张，只能靠前两个字符判种类并给出中文解释
 *     （见 `DOC_PREFIX`，与 Rust `next_no` 的四种前缀同源）。
 *  3. **码里不装钱、不装身份**：金额、扣量、证号一律不进载荷。票是先打的、价是后算的，
 *     把金额写进码就等于允许客户改价；把证号写进码等于把 PII 印在流通纸上。
 *     载荷只是"定位符"，一切数值以扫到单号后从库里读出来的为准。
 */

/**
 * 载荷前缀。`BH1:` 改动会让已发出的纸质票永久扫不出来，
 * 需要升级时只能新增 `BH2:` 并让解析器同时认两种（本文件的 `parseScannedCode` 已按此写）。
 */
export const TICKET_CODE_PREFIX = "BH1:";

/** 认得的版本前缀，按新→旧排列；扫码框与打印共用 */
const KNOWN_PREFIXES = ["BH1:"] as const;

/** 单据种类。与 `print_log.doc_type`、四种取号前缀对得上 */
export type DocKind = "order" | "qc" | "settlement" | "payment" | "unknown";

interface PrefixSpec {
  kind: DocKind;
  /** 中文名，用于"客户递上来的不是磅单"这类提示 */
  label: string;
}

/** 单据号前缀 → 种类（orders.rs:1328/1612/1861/1891 四处 `next_no` 的返回值） */
export const DOC_PREFIX: Record<string, PrefixSpec> = {
  BD: { kind: "order", label: "收购码单" },
  ZJ: { kind: "qc", label: "质检单" },
  JS: { kind: "settlement", label: "结算单" },
  FK: { kind: "payment", label: "付款凭证" },
};

/** 一条已解析的扫码结果 */
export interface ScannedCode {
  kind: DocKind;
  /** 种类中文名（未知种类给"单据"） */
  label: string;
  /** 单据号本体，已去掉版本前缀、已归一化成大写 */
  docNo: string;
  /** 是否带 BH1: 版本前缀。不带前缀说明是手输单号或旧版/外来条码，界面要区别提示 */
  prefixed: boolean;
}

/** 单据号本体的形状：大写字母数字与连字符，6~24 位。真库是「前缀+站码2+年4+月2+流水6」，
 *  样例/历史数据里带连字符的写法也要能扫，故不按长度死卡——存不存在由查库说了算 */
const DOC_NO_RE = /^[A-Z]{2}[A-Z0-9-]{4,22}$/;

/**
 * 把单据号编成印在票面上的二维码载荷。
 *
 * 磅单（BD）与结算单（JS）共用这一个函数：载荷格式是**跨票种统一**的契约，
 * 分两个函数写迟早会一边改了前缀、另一边没改。种类由单据号自己的前缀决定，
 * 扫码侧照 `DOC_PREFIX` 反查即可，不必在载荷里再标一遍。
 */
export function encodeDocCode(docNo: string): string {
  return `${TICKET_CODE_PREFIX}${normalize(docNo)}`;
}

/**
 * 解析扫码枪/手输框里拿到的一串字符。
 *
 * 容错是功能而不是锦上添花，现场三类脏输入每天都在发生：
 *  - 扫码枪后缀的回车、制表符、空格（`appendEnter` 的键盘模拟枪必带）；
 *  - 中文输入法下的全角冒号与全角数字（手输单号时最常见）；
 *  - 小写与首尾空白（手输）。
 * 归一化之后仍然认不出种类的，返回 null 交回界面提示，**不猜**。
 */
export function parseScannedCode(raw: string): ScannedCode | null {
  let s = normalize(raw);
  if (!s) return null;

  let prefixed = false;
  for (const p of KNOWN_PREFIXES) {
    const head = p.slice(0, p.length - 1); // "BH1"，冒号有无都认（全角已在归一化里折成半角）
    if (s.startsWith(head)) {
      s = s.slice(head.length).replace(/^:/, "");
      prefixed = true;
      break;
    }
  }
  if (!s) return null;

  const spec = DOC_PREFIX[s.slice(0, 2)];
  if (!DOC_NO_RE.test(s)) return null;
  return {
    kind: spec?.kind ?? "unknown",
    label: spec?.label ?? "单据",
    docNo: s,
    prefixed,
  };
}

/** 这个种类能不能直接进入结算（只有磅单可以） */
export function settleable(code: ScannedCode | null): code is ScannedCode & { kind: "order" } {
  return code?.kind === "order";
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
