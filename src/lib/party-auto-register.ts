/**
 * 刷到身份证后的两条**自动建档**路径（06 §4.0 两刷一条流里"人"这一半的落库处）。
 *
 * 为什么收成这一个模块：工作台原来读到没档案的证号就弹「快捷登记」要磅员补一个电话，
 * 读到同名老档案（当年手录、证号那格空着）又只能让磅员去档案页手工编辑——农户一手拿证
 * 一手拿卡站在窗口前，这两下点击都是白给的。收成两条命令式函数，是为了让「身份与制单」
 * 面板、`RegistrationDialog`（F7 弹窗复用同一面板）走同一套写库口径，不出现第二套建档规则。
 *
 * 与 `party_save` 的关系与 `card-auto-register` 同一条纪律：**只走那一条唯一入口**，
 * 本模块绝不绕过它自己写库；`party_save` 里"一人一档""证号占用"的闸门照原样生效，
 * 撞上了就把服务端那句人话回给调用方，由它决定怎么跟磅员说。
 *
 * 两条路径各自守的口径：
 *  - `enrollFromIdCard`：卡面读到什么就写什么，**电话留空**（读卡读不出电话），
 *    所以建完必须说一声"得空到农户档案补一下"，别让人以为档案已经全了；
 *  - `bindIdCardToParty`：只往那张**证号为空**的老档案里补证号，历史磅单原样跟着它。
 *    送 `party_save` 时把 `name / party_type / phone` 一并带回——更新分支对这些字段
 *    是"你给了就覆盖"（`src/mock/api.ts` 的 `phone: phoneKey(input.phone)` 尤狠，
 *    不传就把人家原有电话抹成空），漏一个就是替农户改了档案。
 *    住址**故意不带**：卡面住址与档案住址可以不同（人会搬家），补证号不等于顺手换住址，
 *    那要人在档案页明确改一次（02 §F3.1「只补缺、不覆盖」）。
 *
 * 失败只回原因、不抛：这两条都是"顺手把档案补齐"，补不上不该把制单整条流程崩掉。
 * 人像照片挂在 `enrollFromIdCard` 里，走 `backfillPartyPhotoFromCard` 自己那一份降级，
 * 这里不再重复处理（失败也只是照片没补上，档案照旧成立）。
 */
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Party } from "@/mock/types";
import type { IdCardResult } from "@/store/device";
import { actorId } from "@/store/session";
import { backfillPartyPhotoFromCard } from "@/lib/party-photo";

/** 成功＝档案已经落成（新的或补好的），把这一行交回调用方直接选为本单售粮人；失败＝一句能给人看的中文原因 */
export type PartyRegisterResult = { ok: true; party: Party } | { ok: false; reason: string };

/** 服务端回的是人话（"该身份证号已是档案「XXX」…"），原样送到眼前，不做二次加工 */
const reasonOf = (e: unknown) => (e instanceof Error && e.message ? e.message : "建档失败，请到「农户与单位」手工登记");

/** 三条读路径共用：档案行、这张档案的详情、按档案行渲染的列表与审计都要跟着翻 */
function refresh(qc: QueryClient, party: Party) {
  qc.invalidateQueries({ queryKey: ["parties"] });
  qc.invalidateQueries({ queryKey: ["party", party.id] });
  qc.invalidateQueries({ queryKey: ["audits"] });
}

/**
 * 卡面这张证在系统里没有档案 → 就地按卡面建一张（02 §F1.1「无档案时不出现两次以上的手工输入」）。
 *
 * 类型一律给「农户」：读卡读出来的是居民身份证，种粮大户/经纪人/合作社是经营属性，
 * 卡面上没有，磅员在档案页改一次即可，这里不替站点猜。
 */
export async function enrollFromIdCard(qc: QueryClient, card: IdCardResult): Promise<PartyRegisterResult> {
  let party: Party;
  try {
    party = await api.saveParty({
      name: card.name.trim(),
      party_type: "farmer",
      id_card_no: card.id_card_no.trim().toUpperCase(),
      phone: "",
      address: card.address.trim(),
      status: "active",
      // 「已核验」只在真机读回时才给：演示卡与手录一样，不该冒充"证号与卡面逐字相等"
      id_card_verified: card.real ? 1 : 0,
      operator_id: actorId(),
    });
  } catch (e) {
    return { ok: false, reason: reasonOf(e) };
  }
  refresh(qc, party);
  toast.success(`已按身份证建档：${party.name}（${party.code}）`, {
    description: "读卡读不出电话，得空到「农户与单位」补一下；开户行、挂账额度同理。",
  });
  // 卡面那张证件照顺手挂上档案（02 §F3.1：刷证建档即自动用人像，不用手传）。
  // 它内部自带降级与提示，这里 fire-and-forget——照片存不上也不该拦住刚建好的这张档案去制单。
  void backfillPartyPhotoFromCard(card, party, qc);
  return { ok: true, party };
}

/**
 * 同名且**证号为空**的老档案 → 把这张卡上的证号补录进去（沿用它的历史磅单与余额）。
 *
 * 这是"是否是同一人"弹窗里点「是本人」那一条：认下来之后只补那一格空的，
 * 其余字段原样送回，绝不在补证号的同时替农户改名字、换类型或清电话。
 */
export async function bindIdCardToParty(
  qc: QueryClient,
  party: Party,
  card: IdCardResult,
): Promise<PartyRegisterResult> {
  try {
    const saved = await api.saveParty({
      id: party.id,
      // 以下三项是"原样带回"，不是"重新录入"：漏一项就会被覆盖成空值
      name: party.name,
      party_type: party.party_type,
      phone: party.phone,
      id_card_no: card.id_card_no.trim().toUpperCase(),
      id_card_verified: card.real ? 1 : 0,
      operator_id: actorId(),
    });
    refresh(qc, saved);
    toast.success(`证号已补进档案「${saved.name}」（${saved.code}）`, {
      description: "这张档案此前的历史磅单与挂账照旧跟着它。",
    });
    // 补证号这一刷同样能带出人像：档案本来没照片才补（只补缺），有照片一律不动
    void backfillPartyPhotoFromCard(card, saved, qc);
    return { ok: true, party: saved };
  } catch (e) {
    return { ok: false, reason: reasonOf(e) };
  }
}
