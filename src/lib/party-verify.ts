/**
 * 刷证命中「已有档案」时的核验升级（02 §F3.1「读卡带入即已核验」在**没有保存按钮**那两条路上的落库处）。
 *
 * 收成这一个模块的理由与 `party-photo.ts` 一模一样。核验判据原本只活在档案页那条有「保存」的路上
 * （表单里本轮读到的证号与保存时的证号逐字相等才给 1，见 `PartiesPage` 的 `cardVerified`），而
 * **档案详情「读卡核对」**与**工作台「读卡认人」**都没有表单可保存：核对通过却不写标记，那行
 * 「未核验」就一直挂在页面上，农户刷了一回车、档案还是当年手录的样子。两处各写一遍判据，
 * 早晚有一处把演示卡也盖上章——台账把这台机切成 Mock 时回的就是假数据，那正是这条标记最怕的脏数据。
 *
 * 三条闸门，缺一不可（**顺序不能调**：「本来就是已核验」要说在「演示卡」前面，否则一张真读到的卡
 * 压在同一份假数据上会报出"演示卡不盖章"，把已经成立的核验说成没发生）：
 *  1. 档案已经是 1 → 空操作，不发写、不留审计、不顶 `updated_at`；
 *  2. `card.real` 为假 → 演示卡一律不盖章（与 `party-auto-register` 同一判据）；
 *  3. 卡面证号与档案证号的逐字比对交给**后端**重算（`party_verify_set`），不信前端那句"我已经比过了"：
 *     前端报什么就写 1，等于把「已核验」降级成一个可以随口声明的字段。
 *
 * 走 `setPartyVerified` 而不走 `saveParty({ id, id_card_verified: 1 })`：那条命令的审计只落一句
 * `party.update`，事后翻审计看不出这个人是**刷过卡**才升的级，而核验标记的全部价值就在于说得出来源。
 *
 * 本模块**不出声、不抛异常**：升级只是"顺手把档案补齐"，成功与否怎么说、要不要跟别的结果拼成一句，
 * 由调用方定（工作台单独报一声，档案详情把它拼进那一条 `said`）。标记没写成绝不该把制单崩掉。
 */
import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Party } from "@/mock/types";
import type { IdCardResult } from "@/store/device";
import { actorId } from "@/store/session";

/** 升级只看这三样：其余字段一寸不动（这也是不复用 `party_save` 的另一条理由——那条按整张表单回写） */
export type PartyForVerify = Pick<Party, "id" | "id_card_no" | "id_card_verified">;

/**
 * 四种结论，调用方要说的话各不相同：`upgraded` 是好消息，`already-verified` 与 `demo-card`
 * 都只算"这一刷没产生修改"，只有 `failed` 需要红字并指一条补救路。
 */
export type VerifyOutcome =
  | { kind: "upgraded"; party: Party }
  | { kind: "already-verified" }
  | { kind: "demo-card" }
  | { kind: "failed"; reason: string };

/**
 * 读卡命中这张档案、且卡面证号就是它 → 把 `id_card_verified` 写成 1。
 *
 * 成功后作废档案列表、这张档案的详情与审计三处缓存：档案页与详情页各读各的查询，
 * 只作废一处就会出现"同一格两处两个结论"。
 */
export async function upgradeVerifiedFromCard(
  card: Pick<IdCardResult, "id_card_no" | "real">,
  party: PartyForVerify,
  qc: QueryClient,
): Promise<VerifyOutcome> {
  if (party.id_card_verified === 1) return { kind: "already-verified" };
  if (!card.real) return { kind: "demo-card" };
  try {
    const saved = await api.setPartyVerified({
      party_id: party.id,
      id_card_no: card.id_card_no,
      operator_id: actorId(),
    });
    qc.invalidateQueries({ queryKey: ["parties"] });
    qc.invalidateQueries({ queryKey: ["party", party.id] });
    qc.invalidateQueries({ queryKey: ["audits"] });
    return { kind: "upgraded", party: saved };
  } catch (e) {
    return { kind: "failed", reason: e instanceof Error && e.message ? e.message : "核验标记写入失败" };
  }
}
