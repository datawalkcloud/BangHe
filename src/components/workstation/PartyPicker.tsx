/**
 * 售粮人选择器。
 *
 * 工作台读卡失败或 reader 离线时（05 §10-1 要求无外设也能完成闭环），
 * 必须能按姓名 / 证号后 4 位 / 车牌搜档案，所以单独抽成可复用弹层，
 * 磅单筛选、结算中心都要用同一个。
 *
 * 结果列表用 shadcn 的 Command（cmdk）：上下键选择、回车选定都由它托管。
 * 检索在服务端做（api.listParties），因此要关掉 cmdk 的本地过滤。
 *
 * 不会打字的人是靠"翻"而不是靠"搜"的：空关键词时后端给的是全量档案，这里把
 * **此刻在场**的人排到最前，并给每行挂上人像缩略图——磅员认脸比认姓名的字快得多。
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Party } from "@/mock/types";
import { PARTY_TYPE } from "@/lib/constants";
import { ton, weight } from "@/lib/format";
import { PartyPortrait } from "@/components/business/PartyPortrait";
import { IdCardText } from "@/components/business/IdCardText";
import { ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { EmptyState } from "@/components/business/layout";

export function PartyPicker({
  open,
  onOpenChange,
  onPick,
  title = "选择售粮人",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (p: Party) => void;
  title?: string;
}) {
  const [kw, setKw] = useState("");
  const { data = [], isFetching } = useQuery({
    queryKey: ["parties", kw],
    queryFn: () => api.listParties(kw),
    enabled: open,
  });
  const { data: openOrders = [] } = useQuery({
    queryKey: ["openOrders"],
    queryFn: () => api.openOrders(),
    enabled: open,
  });

  /**
   * 没输关键词 = 人在"翻名单"。这时把当天还在场的人顶到最前：
   * 磅房里要重新选人的，几乎都是刚过完毛重还没走的人，往上翻两行就够着了。
   */
  const inYard = useMemo(() => new Set(openOrders.map((o) => o.party_id)), [openOrders]);
  const rows = useMemo(() => {
    if (kw.trim() || inYard.size === 0) return data;
    return [...data].sort((a, b) => Number(inYard.has(b.id)) - Number(inYard.has(a.id)));
  }, [data, inYard, kw]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[620px] gap-0 p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs">
            点一行即选定，可搜姓名、证号后 4 位、手机号或车牌。
          </DialogDescription>
        </DialogHeader>

        {/* 输入框容器自带 p-1，这里按对话框的 16 px 栅格纠正为 px-3。 */}
        <Command
          shouldFilter={false}
          className="rounded-none bg-transparent p-0 [&_[data-slot=command-input-wrapper]]:px-3 [&_[data-slot=command-input-wrapper]]:pt-3"
        >
          <CommandInput autoFocus value={kw} onValueChange={setKw} placeholder="输入姓名或证号后 4 位…" />
          <CommandList className="max-h-[46vh] min-h-[160px]">
            <CommandEmpty className="py-0">
              <EmptyState
                title={isFetching ? "正在查询…" : "没有匹配的档案"}
                description={isFetching ? undefined : "关掉后点「新档案」手工录入证号建一张，或读卡后在弹窗里快捷登记。"}
              />
            </CommandEmpty>
            {rows.map((p) => (
              <CommandItem
                key={p.id}
                value={String(p.id)}
                onSelect={() => {
                  onPick(p);
                  onOpenChange(false);
                }}
                // 末尾那个恒为 opacity-0 的选中勾用不上，藏掉免得右端白留 1em
                className="gap-3 px-4 py-2.5 [&>svg:last-child]:hidden"
              >
                {p.photo_attachment_id != null && <PartyPortrait partyId={p.id} size="sm" />}
                <span className="w-24 shrink-0 truncate text-sm font-medium">{p.name}</span>
                {inYard.has(p.id) && <ToneBadge tone="success">在场</ToneBadge>}
                <ToneBadge tone={p.party_type === "farmer" ? "neutral" : "info"}>{PARTY_TYPE[p.party_type]}</ToneBadge>
                <IdCardText value={p.id_card_no} partyId={p.id} className="tnum w-40 shrink-0 text-xs text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {p.default_vehicle_no ? `车牌 ${p.default_vehicle_no}` : "无默认车牌"}
                  {p.last_tare_01kg != null ? ` · 上次皮重 ${weight(p.last_tare_01kg, false)}（${ton(p.last_tare_01kg)}）` : ""}
                </span>
                {p.status === "disabled" && <ToneBadge tone="danger">已停用</ToneBadge>}
              </CommandItem>
            ))}
          </CommandList>
        </Command>

        <DialogFooter className="mx-0 items-center gap-2 border-t px-4 py-3 sm:justify-between">
          <p className="text-xs text-muted-foreground">
            共 {rows.length} 条{inYard.size > 0 && !kw.trim() ? `，其中在场 ${rows.filter((p) => inYard.has(p.id)).length} 人` : ""}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setKw("")} disabled={!kw}>
              清空
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              disabled={rows.length === 0}
              onClick={() => {
                if (rows[0]) {
                  onPick(rows[0]);
                  onOpenChange(false);
                }
              }}
            >
              选第一位
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
