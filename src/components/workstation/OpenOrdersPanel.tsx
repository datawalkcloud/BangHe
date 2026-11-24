/**
 * ⑥ 在途作业面板（05 §4）。
 *
 * 磅房实际是排队作业：一辆车过完毛重就先下去卸货，窗口里必须一眼看到
 * "手上还压着几张单、各卡在哪一步、谁停太久"，否则第二天对账全靠回忆。
 * 一格一张单、竖向按制单先后排，点一张把它拉到台面上接着干。
 * 停留超阈值除了变色还必须带文字，黑白打印与色弱场景同样要能判读（05 §6.2）。
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import { api } from "@/lib/api";
import { ORDER_STATUS } from "@/lib/constants";
import { dateTimeShort, durationText, sinceMinutes, varietyLabel } from "@/lib/format";
import { useSetting } from "@/hooks/useLookups";
import { OrderStatusBadge } from "@/components/business/badges";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "cn";

export function OpenOrdersPanel({
  activeNo,
  onPick,
}: {
  activeNo?: string | null;
  onPick: (orderNo: string) => void;
}) {
  const { data = [], isLoading } = useQuery({
    queryKey: ["open-orders"],
    queryFn: () => api.openOrders(),
    // 在途状态变化最频繁，10 s 一次足够，且不阻塞操作
    refetchInterval: 10_000,
  });
  const threshold = useSetting("open_order_alert_minutes").num || 30;
  const sorted = data
    .slice()
    .sort((a, b) => (a.registered_at < b.registered_at ? -1 : a.registered_at > b.registered_at ? 1 : 0));

  return (
    <Card size="sm" className="min-w-0 py-0 gap-0">
      <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center px-2.5">
        <CardTitle className="text-xs font-semibold">在途作业</CardTitle>
        <CardAction className="self-center tnum text-xs text-muted-foreground">{sorted.length} 张</CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 p-2">
        {isLoading && <span className="text-xs text-muted-foreground">读取中…</span>}
        {!isLoading && sorted.length === 0 && <span className="text-xs text-muted-foreground">当前没有在途磅单</span>}
        {sorted.map((o) => {
          const mins = sinceMinutes(o.updated_at ?? o.registered_at);
          const overdue = mins >= threshold;
          const active = o.order_no === activeNo;
          return (
            <button
              key={o.order_no}
              type="button"
              onClick={() => onPick(o.order_no)}
              aria-pressed={active}
              title={`${o.party_name} · ${varietyLabel(o.variety_name)} · ${ORDER_STATUS[o.status].desc}`}
              className={cn(
                "flex w-full shrink-0 flex-col items-start gap-0.5 border bg-background px-2 py-1 text-left text-xs hover:bg-muted/40",
                // 超时只负责警示底色与文字（05 §6.2）；边框留给下面的选中分支决定，
                // cn 是 tailwind-merge，后写者胜——否则超时黄会把选中框盖掉。
                overdue && "bg-warning-bg hover:bg-warning-bg",
                active && !overdue && "bg-primary/5 hover:bg-primary/5",
                // 选中态跟 ChoiceCard / OutboundBoard 一样用主题色，不是前景黑白。
                active
                  ? "border-primary"
                  : overdue
                    ? "border-warning"
                    : "border-border hover:border-foreground/40",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="tnum font-medium">{o.order_no.slice(-6)}</span>
                <span className="min-w-0 truncate text-muted-foreground">{o.party_name}</span>
                <OrderStatusBadge status={o.status} className="text-[10px]" />
                {/* 还没绑卡的在途单要能被认出来，否则"回头补绑"这件事只活在制单那一刻的记忆里
                    （06 §4.0 的「无卡制单」+ §4.1 的补绑两条路都指得回这张单，但先得看得见它） */}
                {!o.card_no && (
                  <span
                    className="text-[10px] text-warning"
                    title="这张单还没有流转卡：把一张空闲卡放上感应区由工作台自动认领，或在磅单详情点「补绑流转卡」"
                  >
                    无卡
                  </span>
                )}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="tnum">{dateTimeShort(o.registered_at)}</span>
                {overdue && (
                  <span className="inline-flex items-center gap-0.5 font-semibold text-warning">
                    <AlertTriangleIcon className="size-3" />
                    停留 {durationText(mins)}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}
