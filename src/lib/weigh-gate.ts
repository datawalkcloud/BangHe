/**
 * 称重那一捕的闸门（02 §F1.4、05 §4 ②）。
 *
 * 目前只有一条：**捕毛重之前磅单上必须有单价**。
 *
 * 为什么闸口落在毛重而不是每一项：毛重是"这车粮上磅"的那一刻——农户到站先问价、谈成才卸货，
 * 所以收粮之前价必须已经落在单上（制单按价目表带出的挂牌价，或磅房现场定的价）。没有价就收粮，
 * 事后只能靠嘴对账。皮重那一捕不设这道闸：那是空车多重，与这车粮值多少钱无关；而且一次/二次
 * 称重顺序自由（02 §F1.2），先捕皮重后捕毛重的车，毛重那一捕照样会被拦下。
 *
 * 判定只有一份：`WeighPanel`（手点 / 手录）与 `useIcWorkflow`（刷卡推进）两条路都调这里。
 * 服务端 `orders.rs::capture` 与 mock `api.capture` 另有同一句话的硬闸兜底（两处文案逐字一致），
 * 前端这道只是"让操作员当场知道该干什么"，不是唯一一道。
 */
import type { WeighOrder } from "@/mock/types";

/**
 * 这一捕该不该被价闸拦下：拦下回人话，放行回 `null`。
 *
 * `type` 是**这一捕要捕的类型**（毛重 / 皮重），不是"单上缺哪一项"——复称毛重同样走这道闸
 * （复称就是重车再上磅，价更该已经定了）。
 */
export function priceGateOf(order: WeighOrder, type: "gross" | "tare"): string | null {
  if (type !== "gross") return null;
  if (order.price_fen_per_ton != null) return null;
  // 文案与 Rust `orders.rs::capture`、mock `api.capture` 逐字一致：三处说的是同一条规矩
  return "本单还没有单价：请先在称重区把单价填好（定价 / 改价），再刷卡或录入毛重";
}
