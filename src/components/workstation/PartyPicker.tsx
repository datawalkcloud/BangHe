/**
 * 售粮人选择器。
 *
 * 工作台读卡失败或 reader 离线时（05 §10-1 要求无外设也能完成闭环），
 * 必须能按姓名 / 证号后 4 位 / 车牌搜档案，所以单独抽成可复用弹层，
 * 磅单筛选、结算中心都要用同一个。
 *
 * 结果列表用 shadcn 的 Command（cmdk）：上下键选择、回车选定都由它托管。
 * 检索在服务端做（api.listParties），因此要关掉 cmdk 的本地过滤。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Party } from "@/mock/types";
import { PARTY_TYPE } from "@/lib/constants";
import { maskIdCard, ton, weight } from "@/lib/format";
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[620px] gap-0 p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs">
            支持姓名、编号、证号后 4 位、手机号、车牌检索；查无此人请关掉本框点「新档案」就地建一张，开户行等其余信息到「农户与单位」补全。
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
            {data.map((p) => (
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
                <span className="w-24 shrink-0 truncate text-sm font-medium">{p.name}</span>
                <ToneBadge tone={p.party_type === "farmer" ? "neutral" : "info"}>{PARTY_TYPE[p.party_type]}</ToneBadge>
                <span className="tnum w-40 shrink-0 text-xs text-muted-foreground">{maskIdCard(p.id_card_no)}</span>
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
          <p className="text-xs text-muted-foreground">共 {data.length} 条命中</p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setKw("")} disabled={!kw}>
              清空
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              disabled={data.length === 0}
              onClick={() => {
                if (data[0]) {
                  onPick(data[0]);
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
