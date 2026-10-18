/**
 * ⑥ 在途作业条（05 §4）。
 *
 * 磅房实际是排队作业：一辆车过完毛重就先下去卸货，窗口里必须一眼看到
 * "手上还压着几张单、各卡在哪一步、谁停太久"，否则第二天对账全靠回忆。
 * 停留超阈值除了变色还必须带文字，黑白打印与色弱场景同样要能判读（05 §6.2）。
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import { api } from "@/lib/api";
import { ORDER_STATUS } from "@/lib/constants";
import { dateTimeShort, durationText, sinceMinutes, varietyLabel } from "@/lib/format";
import { useSetting } from "@/hooks/useLookups";
import { OrderStatusBadge } from "@/components/business/badges";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "cn";

export function OpenOrdersBar({
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
    <div className="flex shrink-0 items-stretch gap-1.5 border-t bg-muted/30 px-2 py-1">
      <span className="flex shrink-0 items-center text-xs font-medium text-muted-foreground">
        在途作业 {data.length} 张
      </span>
      <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-0.5">
        {isLoading && <span className="self-center text-xs text-muted-foreground">读取中…</span>}
        {!isLoading && sorted.length === 0 && (
          <span className="self-center text-xs text-muted-foreground">当前没有在途磅单</span>
        )}
        {sorted.length > 0 && (
          <ToggleGroup
            spacing={1}
            variant="outline"
            size="sm"
            className="shrink-0"
            value={activeNo ? [activeNo] : []}
            onValueChange={(v) => {
              // 再点已在台面上的那张 Base UI 会取消按压（v 为空），单选语义下保持原值
              if (!v.length) return;
              onPick(String(v[v.length - 1]));
            }}
          >
            {sorted.map((o) => {
              const mins = sinceMinutes(o.updated_at ?? o.registered_at);
              const overdue = mins >= threshold;
              const active = o.order_no === activeNo;
              return (
                <ToggleGroupItem
                  key={o.order_no}
                  value={o.order_no}
                  title={`${o.party_name} · ${varietyLabel(o.variety_name)} · ${ORDER_STATUS[o.status].desc}`}
                  className={cn(
                    "h-auto w-auto shrink-0 gap-2 rounded-none bg-background px-2 py-1 text-left text-xs font-normal hover:bg-background aria-pressed:bg-background",
                    active ? "border-foreground" : "border-border hover:border-foreground/40",
                    overdue && "border-warning bg-warning-bg hover:bg-warning-bg aria-pressed:bg-warning-bg",
                  )}
                >
                  <span className="tnum font-medium">{o.order_no.slice(-6)}</span>
                  <span className="max-w-[5rem] truncate text-muted-foreground">{o.party_name}</span>
                  <OrderStatusBadge status={o.status} className="text-[10px]" />
                  {/* 还没绑卡的在途单要能被认出来，否则"回头补绑"这件事只活在制单那一刻的记忆里
                      （06 §4.0 的「无卡制单」+ §4.1 的补绑两条路都指得回这张单，但先得看得见它） */}
                  {!o.card_no && (
                    <span
                      className="shrink-0 text-[10px] text-warning"
                      title="这张单还没有流转卡：把一张空闲卡放上感应区由工作台自动认领，或在磅单详情点「补绑流转卡」"
                    >
                      无卡
                    </span>
                  )}
                  <span className={cn("tnum text-muted-foreground", overdue && "font-semibold text-warning")}>
                    {dateTimeShort(o.registered_at)}
                  </span>
                  {overdue && (
                    <span className="inline-flex items-center gap-0.5 text-warning">
                      <AlertTriangleIcon className="size-3" />
                      停留 {durationText(mins)}
                    </span>
                  )}
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
        )}
      </div>
    </div>
  );
}
