/**
 * 刷证命中"已有档案"时的人像补齐（02 §F3.1「只补缺、不覆盖」的唯一实现处）。
 *
 * 为什么收成这一个函数：这条规则有三个入口——工作台「读卡」认人制单、档案页「读卡建档」、
 * 档案详情「读卡核对」。三处各写一遍的话，早晚有一处忘了判"档案已经有照片"，
 * 或者只在表单里挂着不写库，磅员就会看见"刷了卡档案却还是没照片"（这次就是这个）。
 *
 * 判据只有两条，缺一不可：
 *  1. 这张档案**当前没有**人像才补——已有照片要换得由人在表单里点「换一张」并保存，
 *     不能因为谁顺手刷了一次卡就把农户换脸；
 *  2. 本次读卡**确实取到了**照片（解码组件不配套的机型拿不到，属正常降级）。
 *
 * 写入走 `party_photo_set`：与档案保存分开一步，失败只是"照片没补上"，
 * 绝不打断制单/核对本身，所以调用方可以 fire-and-forget。
 */
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Party } from "@/mock/types";
import { actorId } from "@/store/session";

/** 补一张照片所需的最小信息：读卡结果里的照片路径 + 档案当前挂没挂照片 */
export type CardWithPhoto = { photo_path: string | null };
export type PartyForPhoto = Pick<Party, "id" | "name" | "photo_attachment_id">;

/**
 * 命中已有档案时尝试补人像；**真的补上了**才返回保存后的档案行，否则返回 `null`
 * （已有照片、这次没取到照片、或写入失败——后两种都会由这里自己说一声，调用方不必再报）。
 */
export async function backfillPartyPhotoFromCard(
  card: CardWithPhoto,
  party: PartyForPhoto,
  qc: QueryClient,
): Promise<Party | null> {
  if (party.photo_attachment_id != null) return null; // 只补缺：已有照片一律不动
  if (!card.photo_path) return null; // 这次没从证件里取到照片，不空跑一次写
  try {
    const saved = await api.setPartyPhoto({
      party_id: party.id,
      source_path: card.photo_path,
      operator_id: actorId(),
      source_label: "读卡带入",
    });
    // 档案行、这张档案的人像缓存、以及按档案行渲染的列表都要跟着翻，否则界面还停在"无照片"
    qc.invalidateQueries({ queryKey: ["party-photo", party.id] });
    qc.invalidateQueries({ queryKey: ["party", party.id] });
    qc.invalidateQueries({ queryKey: ["parties"] });
    qc.invalidateQueries({ queryKey: ["audits"] });
    toast.success(`已把身份证照片补进「${saved.name}」的档案`);
    return saved;
  } catch (e) {
    // 说清"档案没事、只是照片没补上"，别让磅员以为这一刷白刷了
    toast.warning(`档案「${party.name}」的人像照片没补上`, {
      description: `${e instanceof Error ? e.message : "请到农户档案手工上传一张"}；不影响本单继续制单。`,
    });
    return null;
  }
}
