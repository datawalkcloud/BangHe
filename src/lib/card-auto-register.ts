/**
 * 刷到未登记卡 → 就地登记入库（06 §4.1 闸门 3 的自动登记分支）。
 *
 * 为什么收成这一个函数：读得到陌生 UID 的入口有两条——工作台后台常听 `useIcWorkflow`、
 * 「制单请放流转卡」`CardBindDialog`。两处各写一遍，早晚有一处又把"请到「流转卡」页登记"
 * 这句甩给磅员去读：卡就贴在感应区上、农户站在窗口前，让人切到另一屏点一次登记再回来重刷，
 * 正是这次要消掉的那一步。
 *
 * 只做三件事，"这一刷接下来干什么"的判断仍留在调用方：
 *  1. 写库只走 `card_pool_register` 这一条唯一入口（与卡池页「读卡登记」同一命令：卡号归一、
 *     `status='in_pool'` 入库、`audit card.register` 留痕），本模块绝不绕过它自己写库；
 *  2. `remark` 带上现场出处，卡池页一眼分得出这张是磅房当场收进来的、不是批量登记的；
 *  3. 入池成功立刻 invalidate `["cards"]`，空闲卡计数与"空闲卡仅 N 张"预警跟着翻。
 *
 * 失败只回原因、不抛：岗位无权 / 未解锁 / 库锁都只是"这一刻这张卡进不了池"，
 * 该由刷卡那一路说清下一步（换一张卡，或找站长），不该把整条监听循环崩掉。
 *
 * 已注销（`retired`）的卡不归本模块管：注销是站长明确封掉的号，绝不因为又有人刷到它就复活。
 *
 * 这条分支受站点参数 `card_auto_register`「允许使用未登记的流转卡」控制（默认开）：关掉即回到
 * "未登记一律拦下、须先到「流转卡」页登记"的硬闸门。**放行与否由调用方判**（只有它们拿得到
 * `useSetting`），本模块只负责"决定要登记时，怎么登记得留痕"——别让两条入口各写一套入库口径。
 */
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { actorId } from "@/store/session";

/** 现场刷卡自动入库的三条路，写进 `card.remark` 当留痕（"补绑"＝给「无卡制单」那张单补卡，06 §4.1） */
export type AutoRegisterScene = "发卡" | "制单绑卡" | "补绑";

/**
 * 站点参数「允许使用未登记的流转卡」`card_auto_register`（0016）收成这一句判断：
 * 开＝本模块这条自动登记分支；关＝闸门 3 退回硬拦，未登记的卡一律不用，须先到「流转卡」页登记。
 *
 * 库里没有这个键时按**开**走（与 `card_required_on_create` 的缺省口径同一式：`raw !== "false"`）——
 * 老库升级前没这个键，站长没动过就该维持"顺手能用"的默认体验；真要收紧是站长明确置 false 那一下。
 */
export const autoRegisterOn = (raw: string | undefined) => raw !== "false";

/** 成功＝这张卡已经在池里了；失败＝带一句能给磅员看的中文原因（原样来自服务端闸门） */
export type AutoRegisterResult = { ok: true } | { ok: false; reason: string };

export async function autoRegisterCard(
  qc: QueryClient,
  card_no: string,
  scene: AutoRegisterScene,
): Promise<AutoRegisterResult> {
  try {
    await api.cardPoolRegister({
      card_no,
      label: null, // 贴签是人工辨认用的编号，机器不替站点编
      remark: `工作台刷卡自动登记（${scene}）`,
      operator_id: actorId() ?? 0,
    });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "登记入库失败，请稍后再试" };
  }
  // 卡池页的列表与空闲预警都挂在这个键上，不翻就会"明明入池了，页面上还没有"
  qc.invalidateQueries({ queryKey: ["cards"] });
  toast.success(`卡 ${card_no} 不在卡池，已自动登记入库`, { id: `card-autoreg:${card_no}` });
  return { ok: true };
}
