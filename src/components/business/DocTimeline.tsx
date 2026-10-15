/**
 * 单据全链路时间轴（05 §3 磅单详情"全链路时间轴"）。
 *
 * 目的很实际：迎检或纠纷时要能回答"这张单到底是几点几分谁干的哪一步"，
 * 所以每一步都带署名，且不用颜色单独表达语义。
 */
import type { TimelineEvent } from "@/mock/types";
import { TONE_DOT } from "@/lib/constants";
import { dateTime } from "@/lib/format";
import { cn } from "cn";

export function DocTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">暂无操作记录</p>;
  }
  return (
    <ol className="flex flex-col">
      {events.map((e, i) => (
        <li key={`${e.at}-${i}`} className="relative flex min-w-0 gap-3 pb-3 last:pb-0">
          {i < events.length - 1 && (
            <span className="absolute top-4 left-[5px] h-full w-px bg-border" aria-hidden />
          )}
          <span
            className={cn(
              "relative z-1 mt-1 size-[11px] shrink-0 rounded-full border-2 border-background",
              TONE_DOT[e.tone],
            )}
            aria-hidden
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium">{e.label}</span>
              <span className="tnum text-xs text-muted-foreground tabular-nums">{dateTime(e.at)}</span>
              <span className="text-xs text-muted-foreground">{e.actor}</span>
            </div>
            {e.detail && <p className="text-xs text-muted-foreground">{e.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** 精简版：工作台在途卡片、列表抽屉里用 */
export function DocSteps({ events }: { events: TimelineEvent[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {events.map((e, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span aria-hidden>→</span>}
          <span className={cn(e.tone === "danger" && "text-destructive", e.tone === "warning" && "text-warning")}>
            {e.label}
          </span>
        </span>
      ))}
    </div>
  );
}
