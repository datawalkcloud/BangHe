/**
 * 「这张票能不能在这儿算钱」的单一判定与话术（02 §F1.4 / 05 §5）。
 *
 * 算钱（结算）只有磅房工作台一个入口，触发方式有三种——刷第③卡、扫票面码、称重区那个
 * 「去结算」按钮——**扫的那一下只认磅单**（02 §F1.4 本版：码里就是单号本体，而磅房只认磅单
 * 这一种；出库单那张纸也带码，可它的消费口是值仓，不是这个窗口）。收钱（补付）三处：磅单详情
 * 「结算与付款」卡片底部那枚「付款」、结算台账里点开那张结算单，以及工作台第③刷/扫票命中
 * 一张已结算未付清的单时由 `requestSettle` 自己分过来——挂账的纸从前靠扫那枚「凭单码」进框，
 * 那枚码连同那个入口一起退役了。
 * **同一张单的可结算 / 可补付判据必须只有一份**：否则两处对同一张票给出两个结论
 * （一边放行一边拦住），正是扯皮与红冲的现场来源。算钱本身早已收在 `SettleForm`、
 * 补付收在 `PayDialog` 里那份 `PayForm`（同一份 `api.recordPayment`），这里收的是它们前面那层
 * "要不要把人放进框里、进不去时说什么"。
 *
 * 三条纪律：
 *  1. **只出结论，不出控件**。拦下来时怎么提示（吐司 / 红字 / 语音）由调用方按自己
 *     那块的界面决定，判定层只给 tone/title/body。
 *  2. **"已结算"的判据只用 `settled_at` / `status`**（03 §3.6 不变式 6 的前端镜像）。
 *     绝不能用 `settlement_weight_01kg` / `price_fen_per_ton` 不空来代理：`to_settle`
 *     的定义本身就是"重量已定、待结算"，建单还带预估价，按那种写法每一张待结单都会
 *     被判成"已结算"、把窗口自己锁死（历史事故）。`bill` 只是用来把结算单号念出来，
 *     没有它（工作台没预取结算单）判据照样准，`settled_at`/`status` 已覆盖。
 *  3. **"算过钱但钱没付完"不是死路**：那张单到窗口是来收钱的，不是来再结一遍的。
 *     `settleGateOf` 对这种单**放行**（返回 null），由调用方顺着单号取回结算单、
 *     交给 `creditPayGate` 与 `PayForm`——判据两份、话术两份，迟早一边开一边锁。
 */
import type { Settlement, WeighOrder } from "@/mock/types";
import { ORDER_STATUS } from "@/lib/constants";
import { dateTime, money } from "@/lib/format";
import { type ScannedCode, settleable } from "@/lib/ticket-code";

/** 判定的语气，与各页面的提示条/吐司同一套色板 */
export type GateTone = "info" | "warning" | "danger";

/** 拦事的结论：null 之外的一定带 title/body */
export interface SettleGate {
  tone: GateTone;
  title: string;
  body: string;
}

/**
 * 这张磅单是不是"钱已经算过、还没付完"（挂账或部分付款）。
 *
 * 判据用 `settled_at` + `payment_status`，与不变式 6 那条纪律同源：`paid_amount_fen`
 * 是结算侧按明细逐单摊下来的数（末单还担四舍五入差），拿它判"没付完"会在摊分处误判。
 * 过磅那一捕自动挂账之后，绝大多数回来的单都落在这里。
 */
export function awaitingPayment(order: WeighOrder): boolean {
  return order.settled_at != null && (order.payment_status === "unpaid" || order.payment_status === "partial");
}

/**
 * 能不能在 `order` 上算钱，返回 null 表示放行（可以进窗口那一框）。
 *
 * 判定顺序就是现场"为什么扫不下去"的顺序；每一条都带 title/body（尽量带 route 出路）——
 * 只写"不允许结算"等于把出纳一个人扔在窗口，他既不能改数，也说不清为什么不行。
 *
 * 放行不等于"进的是结算框"：已经算过钱、钱没付完的单在这里放行，由调用方按
 * `awaitingPayment` 把同一张单交给补付框（见文件头纪律 3）。
 *
 * 站点参数 `settlement_allow_part_pay`（允许挂账）**不在这里**：它管的是"要不要让这一单
 * 带着欠款走"，而眼前的单已经带着欠款回来了——收钱这一步永远放行，关掉挂账的站点照样
 * 要把历史挂账清掉（`PaymentsPage` 那条告警说的就是这件事）。所以这个函数不再收这个参数。
 */
export function settleGateOf(order: WeighOrder | null, bill: Settlement | null, maySettle: boolean): SettleGate | null {
  if (!order) return null;

  if (!maySettle) {
    return {
      tone: "danger",
      title: "当前岗位不能结算这张单",
      // 这句话在工作台的三种触发上都要站得住：扫票面码、刷第③卡（这两条路上磅员确实不碰钱）、
      // 称重区那个「去结算」（磅房那条路上磅员另有一条只挂账的权）。所以不写"磅员只负责出票"，
      // 而是把边界说清楚——岗位拦下的事必须让人明白自己该换谁来。
      body: "结算需要出纳或站长权限。请换当班出纳或站长的账号登录。",
    };
  }
  if (order.status === "voided" || order.status === "rejected" || order.status === "reversed" || order.status === "archived") {
    return {
      tone: "danger",
      title: `这张单是「${ORDER_STATUS[order.status].label}」，不能结算`,
      body: `${ORDER_STATUS[order.status].desc}${order.void_reason ? `。原因：${order.void_reason}` : ""}。这张单不能再结算，也不能就地改数；要重做这一笔请另开一张磅单重新过磅。要复核这张单到「磅单中心」查它。`,
    };
  }
  const alreadySettled = !!bill || order.settled_at != null || order.status === "settled" || order.status === "paid";
  if (alreadySettled) {
    // 挂账 / 部分付款：这张单到窗口是来收钱的，放行给补付那一条路（调用方接 `creditPayGate`）
    if (awaitingPayment(order)) return null;
    const paid = order.payment_status === "paid";
    return {
      tone: paid ? "info" : "warning",
      title: paid ? "这张单已经结算并付清了" : "这张单已经结算过，钱的状态不对",
      body: `结算单 ${bill?.settle_no ?? "已生成"} 于 ${dateTime(bill?.settled_at ?? order.settled_at)}，不能重复结算。${
        paid ? "客户要再拿一张纸，凭这张结算单号到「结算台账」补打结算凭证或付款小票即可。" : "到「结算台账」打开这张结算单核对已付与未付，再在结算单详情里登记付款。"
      }`,
    };
  }
  if (order.net_weight_01kg == null) {
    return {
      tone: "warning",
      title: "净重还没确定，算不了钱",
      body: `当前状态「${ORDER_STATUS[order.status].label}」：${ORDER_STATUS[order.status].desc}。请让客户回磅房把剩下的那一次过磅做完。`,
    };
  }
  return null;
}

/** 未付余额（分）：结算单的权威口径，`paid_fen` 只加不平，负数一律当 0 看 */
export function unpaidFen(bill: Settlement): number {
  return Math.max(0, bill.payable_fen - bill.paid_fen);
}

/**
 * 要收钱的那张**结算单**（来自一张已经算过钱、钱没付完的磅单）能不能进补付框。
 *
 * 返回 null 表示放行进补付框（`PayForm`）；否则给出语气 + 一句人话。四条拦事的顺序
 * 就是窗口上"为什么收不下去"的顺序：查无此单 → 已撤销 → 已经付清 → 岗位不能收钱。
 *
 * 与 `settleGateOf` 的分工：那边判"能不能再算一遍钱"（不能，不变式 6），这边判
 * "能不能收这笔钱"。两条判据都只认库里的字段，不看界面缓存。进这一层的三条路
 * （磅单详情那枚「付款」、结算台账点开结算单、工作台第③刷/扫票命中挂账单）共用它。
 */
export function creditPayGate(bill: Settlement | null, mayPay: boolean): SettleGate | null {
  if (!bill) {
    return {
      tone: "danger",
      title: "查不到这张结算单",
      body: "这张结算单可能是在别的电脑上结的，或号抄错了。到「结算台账」按售粮人姓名找一下，或让客户把收购码单拿来在窗口重扫一次。",
    };
  }
  if (bill.status === "revoked") {
    return {
      tone: "danger",
      title: `结算单 ${bill.settle_no} 已撤销，不能再登记付款`,
      body: "它名下那张磅单作废时，这张结算单同步撤销。要重做这一笔，请在磅房另开一张磅单重新过磅结算。",
    };
  }
  if (unpaidFen(bill) <= 0) {
    return {
      tone: "info",
      title: "这张结算单已经付清了",
      body: `应付 ${money(bill.payable_fen)} 已全额付清（售粮人 ${bill.payee_name}）。客户要再拿一张纸，到「结算台账」按这个单号补打结算凭证或付款小票即可。`,
    };
  }
  if (!mayPay) {
    return {
      tone: "danger",
      title: "当前岗位不能登记这笔付款",
      body: "登记付款需要出纳或站长权限。请换当班出纳或站长的账号登录，或把这张凭证交给出纳在「付款与挂账」核销。",
    };
  }
  return null;
}

/**
 * 扫进来这一串**不是一张磅单**时，当场说清楚"这是什么、该上哪儿去"。
 *
 * 返回 null 表示这就是收购码单（磅单），放行给调用方继续判可结算性。
 *
 * 只有**老纸上那两种带前缀的载荷**才会带着种类走到这里（02 §F1.4 本版：码里不再写种类，
 * 一串单号是不是磅单由调用方查库判，判不出来的那一句是「查不到磅单 …」而不是这里）。
 * 质检单 / 付款凭证 / 出库单 / 存量结算凭证这几类都在纸上流通，扫码框无法预知客户递上来
 * 的是哪张，只能靠老载荷里的票种码给出不同的出路。**认不出种类（`unknown`）那一支已经删掉**：
 * 本版的码本来就不带种类，留一支永远不会命中的话术比少一支更坑——改的人照着它以为
 * 系统还在按载荷判种类。
 *
 * `raw` 只给"认不出格式"那一支用：那一句就是「未知的码格式：<收到的原文>」，
 * 把现场排障需要的证据原样递到人眼前（为什么必须回显、以及截断口径见 `scanEcho`）。
 */
export function scanRejectNote(code: ScannedCode | null, raw?: string): { tone: GateTone; text: string } | null {
  if (!code) {
    return { tone: "danger", text: `未知的码格式：${scanEcho(raw)}` };
  }
  if (settleable(code)) return null;
  if (code.kind === "settlement") {
    return {
      tone: "warning",
      text: `递过来的是结算凭证（${code.docNo}）：这一笔已经算过钱。请到「结算台账」点开这张结算单登记付款，或在对应的磅单详情点「付款」。`,
    };
  }
  if (code.kind === "payment") {
    return { tone: "info", text: `递过来的是付款凭证（${code.docNo}）：这一笔已经付过钱了。要复核付款记录去「付款与挂账」。` };
  }
  if (code.kind === "qc") {
    return { tone: "warning", text: `递过来的是质检单（${code.docNo}），质检单不能结算。请让客户翻出那张收购码单。` };
  }
  if (code.kind === "outbound") {
    return { tone: "info", text: `递过来的是出库单（${code.docNo}）：出库不在磅房窗口结算。要复核这一笔到「库存与出库」里查它。` };
  }
  return { tone: "danger", text: `扫到的是本系统没有的单据（${code.docNo}）。窗口只认收购码单，扫它右下角那个码。` };
}

/**
 * 把扫到的一串原样回显（"未知的码格式：xxx"）。
 *
 * 回显的是**现场排障的第一手证据**：解析失败九成不是票的问题，而是枪的按键在捕获层被
 * 吃掉了一半（输入法正在合成、光标停在某个输入框里、或主线程卡顿把按键间隔拉长）。没有
 * 这串原文，磅房与装机的人只能来回猜"是票坏了还是机器坏了"。载荷契约里码上只有定位符
 * （02 §F1.4），回显安全；控制字符折成 `·` 才看得见枪的后缀，外来长码按 40 字符截断，
 * 不把整串身份证条码刷满屏幕。
 */
function scanEcho(raw?: string): string {
  const s = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "·").trim();
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
