/**
 * 「是否是同一人」确认框（02 §F3.1 / 06 §4.0 两刷一条流里"认人"这一环的例外分支）。
 *
 * 什么时候弹：刷到一张证，**证号在系统里没有档案**，但档案里躺着一张以上同名、
 * 证号那一格却是空的老档案——早年手工建档、或者办证后改过号的农户都是这个样子。
 * 这时候静默新建（`enrollFromIdCard` 那条默认路）是**错的**：同一个人会在系统里出现两张档案，
 * 两张都有磅单，对账时就变成两个余额、两条挂账，谁也对不平（`party_save` 的"一人一档"闸门
 * 就是为这个存在的）。所以这一个岔口必须由人认一下，机器不替他猜。
 *
 * 判据只有一条，且刻意收得很窄：**同名 且 证号为空**。
 * 证号已经填了的档案不参与匹配——那要么是同一个人证号录错了（去档案页编辑那一格），
 * 要么本来就是两个人（读卡命中会另走一支），在这里再弹一次确认只会添乱。
 *
 * 框内三条出路，全部就地完成、不回档案页：
 *  - 认下来 → `bindIdCardToParty` 给那张老档案补上证号，**历史磅单照旧跟着它**；
 *  - 都不是 → `enrollFromIdCard` 按卡面新建一张（旧档案一个字都不动）；
 *  - 先不处理 → 关框，回到行内监听那一步，磅员仍可自己「搜档案」选人。
 */
import { useState } from "react";
import { UserRoundCheckIcon, UserRoundXIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Party } from "@/mock/types";
import type { IdCardResult } from "@/store/device";
import { PARTY_TYPE } from "@/lib/constants";
import { bindIdCardToParty, enrollFromIdCard } from "@/lib/party-auto-register";
import { IdCardText } from "@/components/business/IdCardText";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function SamePartyDialog({
  open,
  onOpenChange,
  card,
  candidates,
  onPick,
  onNeedManual,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 刚读到的那张证（弹窗开着期间调用方会清掉 store 里的 `last`，所以这里必须拿一份快照） */
  card: IdCardResult | null;
  /** 同名且证号为空的档案，按建档时间倒序 */
  candidates: Party[];
  /** 认定成功：这张档案即本单售粮人（补录与新建两条都算） */
  onPick: (p: Party) => void;
  /** 新建这条走不通（岗位无权 / 证号撞车 / 库锁）：交回面板打开快捷登记框手工建，别把这一刷白废 */
  onNeedManual: () => void;
}) {
  const qc = useQueryClient();
  /** 哪一条正在写库：只让那一行的按钮转圈，其余照旧可点 */
  const [busy, setBusy] = useState<number | "new" | null>(null);

  const bind = async (party: Party) => {
    if (!card) return;
    setBusy(party.id);
    const r = await bindIdCardToParty(qc, party, card);
    setBusy(null);
    if (r.ok) {
      onPick(r.party);
      onOpenChange(false);
      return;
    }
    // 真库闸门回的是人话（"该身份证号已是档案「XXX」…"），原样送到眼前，框留着让人改走别的出路
    toast.error(`没能补录证号：${r.reason}`);
  };

  const createNew = async () => {
    if (!card) return;
    setBusy("new");
    const r = await enrollFromIdCard(qc, card);
    setBusy(null);
    if (r.ok) {
      onPick(r.party);
      onOpenChange(false);
      return;
    }
    toast.error(`没能建档：${r.reason}`);
    onOpenChange(false);
    onNeedManual();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-sm">是否是同一个人？</DialogTitle>
          <DialogDescription className="text-xs">
            {card ? (
              <>
                读到 {card.name}（<IdCardText value={card.id_card_no} className="tnum" />），系统里有 {candidates.length} 张同名档案还没绑定身份证。是本人就补录证号、沿用它的历史磅单；不是本人就另建一张新档案。
              </>
            ) : (
              "系统里有同名档案还没绑定身份证，请确认是不是同一个人。"
            )}
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-1.5">
          {candidates.map((p) => (
            <li key={p.id} className="flex items-end gap-2 border bg-muted/30 p-1.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold">{p.name}</span>
                  <span className="tnum text-muted-foreground">{p.code}</span>
                  <span className="text-muted-foreground">{PARTY_TYPE[p.party_type]}</span>
                </span>
                <span className="truncate text-muted-foreground">{p.address || "住址未登记"}</span>
                <span className="tnum text-muted-foreground">
                  建档 {p.created_at.slice(0, 10).replace(/-/g, "/")}
                  {p.phone ? ` · ${p.phone}` : " · 无电话"}
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 text-xs"
                disabled={!card || busy !== null}
                onClick={() => void bind(p)}
              >
                <UserRoundCheckIcon />
                {busy === p.id ? "补录中…" : "是本人 · 补录身份证"}
              </Button>
            </li>
          ))}
        </ul>

        <DialogFooter className="sm:justify-between">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy !== null}>
            先不处理
          </Button>
          <Button size="sm" variant="outline" onClick={() => void createNew()} disabled={!card || busy !== null}>
            <UserRoundXIcon />
            {busy === "new" ? "建档中…" : "都不是 · 新建档案"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
