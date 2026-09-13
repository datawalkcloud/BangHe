/**
 * 「这张票能不能在这儿算钱」的单一判定与话术（02 §F1.4 / 05 §5）。
 *
 * 结算有两个入口——磅房工作台（刷卡或扫票）与 `/scan-settle` 扫码窗口——但**同一张单的
 * 可结算判据必须只有一份**：否则两个入口对同一张票给出两个结论（一边放行一边拦住），
 * 正是扯皮与红冲的现场来源。算钱本身早已收在 `SettleForm`（同一份 `api.settle`），
 * 这里收的是它前面那层"要不要把人放进结算框、进不去时说什么、该上哪儿去"。
 *
 * 两条纪律：
 *  1. **只出结论，不出控件**。`route` 是"这张单该被领去哪儿"的种类枚举，由调用方
 *     各自渲染成自己界面里的链接/按钮（扫码窗口用 `<Link>`，工作台用 toast），
 *     因为 TanStack Router 的 `to` 是字面量类型，判定层无法承载类型安全的跳转。
 *  2. **"已结算"的判据只用 `settled_at` / `status`**（03 §3.6 不变式 6 的前端镜像）。
 *     绝不能用 `settlement_weight_01kg` / `price_fen_per_ton` 不空来代理：`to_settle`
 *     的定义本身就是"重量已定、待结算"，建单还带预估价，按那种写法每一张待结单都会
 *     被判成"已结算"、把窗口自己锁死（历史事故）。`bill` 只是用来把结算单号念出来，
 *     没有它（工作台路径没预取结算单）判据照样准，`settled_at`/`status` 已覆盖。
 */
import type { Settlement, WeighOrder } from "@/mock/types";
import { ORDER_STATUS } from "@/lib/constants";
import { dateTime } from "@/lib/format";
import { type ScannedCode, settleable } from "@/lib/ticket-code";

/** 判定的语气，与各页面的提示条/吐司同一套色板 */
export type GateTone = "info" | "warning" | "danger";

/** 这张单该被领去哪儿（种类枚举，跳转控件由调用方按自己界面的类型安全路由渲染） */
export type SettleGateRoute = "order-detail" | "settlement-detail" | "workstation";

/** 拦事的结论：null 之外的一定带 title/body，且尽量带 route 给人一条出路 */
export interface SettleGate {
  tone: GateTone;
  title: string;
  body: string;
  route?: SettleGateRoute;
  /** 出路按钮文案（有 route 时给）；调用方渲染成链接或按钮 */
  routeLabel?: string;
}

/**
 * 能不能在 `order` 上算钱，返回 null 表示放行（可以进结算框）。
 *
 * 判定顺序就是现场"为什么扫不下去"的顺序；每一条都带 title/body（尽量带 route 出路）——
 * 只写"不允许结算"等于把出纳一个人扔在窗口，他既不能改数，也说不清为什么不行。
 */
export function settleGateOf(
  order: WeighOrder | null,
  bill: Settlement | null,
  maySettle: boolean,
  allowCredit: boolean,
): SettleGate | null {
  if (!order) return null;

  if (!maySettle) {
    return {
      tone: "danger",
      title: "当前岗位不能在这个窗口结算",
      body: "结算需要出纳或站长权限（05 §5）。请换当班出纳的账号登录；磅员只负责出票，不负认定价。",
    };
  }
  if (order.status === "voided" || order.status === "rejected" || order.status === "reversed" || order.status === "archived") {
    return {
      tone: "danger",
      title: `这张单是「${ORDER_STATUS[order.status].label}」，不能结算`,
      body: `${ORDER_STATUS[order.status].desc}${order.void_reason ? `。原因：${order.void_reason}` : ""}。要更正只能走红冲流程，不能在窗口直接改数收钱。`,
      route: "order-detail",
      routeLabel: "看这张单",
    };
  }
  const alreadySettled = !!bill || order.settled_at != null || order.status === "settled" || order.status === "paid";
  if (alreadySettled) {
    const paid = order.payment_status === "paid";
    return {
      tone: paid ? "info" : "warning",
      title: paid ? "这张单已经结算并付清了" : "这张单已经结算过，还没付清",
      body: `结算单 ${bill?.settle_no ?? "已生成"} 于 ${dateTime(bill?.settled_at ?? order.settled_at)}，重复结算在库里就被拦（不变式 6）。${
        paid ? "客户要再拿一张纸，凭这张结算单号到「结算台账」补打结算凭证或付款小票即可。" : allowCredit ? "挂账的到「付款与挂账」按结算单核销。" : "本站已关闭挂账，请把尾款当场付清。"
      }`,
      route: "settlement-detail",
      routeLabel: "看结算单",
    };
  }
  if (order.net_weight_01kg == null) {
    return {
      tone: "warning",
      title: "净重还没确定，算不了钱",
      body: `当前状态「${ORDER_STATUS[order.status].label}」：${ORDER_STATUS[order.status].desc}。请让客户回磅房把剩下的那一次过磅做完。`,
      route: "workstation",
      routeLabel: "带到工作台",
    };
  }
  return null;
}

/**
 * 扫进来这一串不是一张「可以直接结算的码单」时，当场说清楚"这是什么、该上哪儿去"。
 *
 * 返回 null 表示这张就是收购码单（BD），放行给调用方继续判可结算性；
 * 否则给出语气 + 一句人话。质检单/结算凭证/付款凭证/认不出，四类都在纸上流通，
 * 扫码框无法预知客户递上来的是哪张，只能靠前缀种类给不同的出路（02 §F1.4）。
 */
export function scanRejectNote(code: ScannedCode | null): { tone: GateTone; text: string } | null {
  if (!code) {
    return {
      tone: "danger",
      text: "这个码我们认不出来。可能是别家粮站的票，或码被压坏了——可以手输码单上的单号。",
    };
  }
  if (settleable(code)) return null;
  if (code.kind === "settlement") {
    return { tone: "warning", text: `递过来的是结算凭证（${code.docNo}），不是码单。结算凭证是已经算过钱的单子，挂账未付清请到「付款与挂账」核销。` };
  }
  if (code.kind === "payment") {
    return { tone: "info", text: `递过来的是付款凭证（${code.docNo}）：这一笔已经付过钱了。要复核付款记录去「付款与挂账」。` };
  }
  if (code.kind === "qc") {
    return { tone: "warning", text: `递过来的是质检单（${code.docNo}），质检单不能结算。请让客户翻出那张收购码单。` };
  }
  return { tone: "danger", text: `扫到的是本系统没有的单据种类（${code.docNo}），只有码单（BD）能在这里结算。` };
}
