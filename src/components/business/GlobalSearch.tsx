/**
 * 全局检索 Ctrl+K（05 §5）。
 *
 * 现场真实诉求是"客户报个车牌或姓氏，我要立刻找到那张单"，
 * 所以命中项直接带出可跳转的单据/档案/结算单，而不是只给一个列表页链接。
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CreditCardIcon, FileTextIcon, UsersIcon } from "lucide-react";
import { api } from "@/lib/api";
import { money, ton } from "@/lib/format";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/business/layout";
import { cn } from "cn";

interface Hit {
  key: string;
  group: "磅单" | "售粮人" | "结算单";
  icon: typeof FileTextIcon;
  title: string;
  desc: string;
  trailing?: string;
  to: string;
  params?: Record<string, string | number>;
}

export function GlobalSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [kw, setKw] = useState("");
  const [cursor, setCursor] = useState(0);
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ["global-search", kw],
    queryFn: () => api.search(kw),
    enabled: open && kw.trim().length > 0,
  });

  const hits = useMemo<Hit[]>(() => {
    if (!data) return [];
    return [
      ...data.orders.map<Hit>((o) => ({
        key: `o${o.order_no}`,
        group: "磅单",
        icon: FileTextIcon,
        title: o.order_no,
        desc: `${o.party_name} · ${o.variety_name} · ${o.business_date}`,
        trailing: o.settlement_weight_01kg != null ? ton(o.settlement_weight_01kg) : undefined,
        to: "/orders/$orderNo",
        params: { orderNo: o.order_no },
      })),
      ...data.parties.map<Hit>((p) => ({
        key: `p${p.id}`,
        group: "售粮人",
        icon: UsersIcon,
        title: p.name,
        desc: `${p.party_type === "farmer" ? "农户" : "单位"} · 证号尾号 ${p.id_card_no.slice(-4)}`,
        to: "/parties/$id",
        params: { id: p.id },
      })),
      ...data.settlements.map<Hit>((s) => ({
        key: `s${s.settle_no}`,
        group: "结算单",
        icon: CreditCardIcon,
        title: s.settle_no,
        desc: `${s.party_name} · ${s.business_date}`,
        trailing: money(s.payable_fen),
        to: "/settlements/$settleNo",
        params: { settleNo: s.settle_no },
      })),
    ];
  }, [data]);

  useEffect(() => setCursor(0), [kw]);

  function go(h: Hit) {
    onOpenChange(false);
    // 命中项的 to/params 是从三个不同路由拼出来的 union，
    // 这里走一次收敛比在三处各写一个 Link 更划算
    void navigate({ to: h.to as never, params: h.params as never });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px] gap-0 p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm font-medium">
            全局检索
            <span className="text-xs font-normal text-muted-foreground">单号 / 姓名 / 证号后 4 位 / 车牌</span>
          </DialogTitle>
        </DialogHeader>
        <div className="px-4 py-3">
          <Input
            autoFocus
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="输入关键词…"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(hits.length - 1, c + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (e.key === "Enter" && hits[cursor]) {
                e.preventDefault();
                go(hits[cursor]);
              }
            }}
          />
        </div>
        <ul className="max-h-[320px] overflow-y-auto pb-2">
          {hits.map((h, i) => (
            <li key={h.key}>
              <button
                type="button"
                onClick={() => go(h)}
                onMouseEnter={() => setCursor(i)}
                className={cn(
                  "flex w-full items-center gap-2 px-4 py-2 text-left text-sm",
                  i === cursor && "bg-accent text-accent-foreground",
                )}
              >
                <h.icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="w-12 shrink-0 text-xs text-muted-foreground">{h.group}</span>
                <span className="min-w-0 flex-1 truncate">{h.title}</span>
                <span className="min-w-0 shrink basis-1/2 truncate text-xs text-muted-foreground">{h.desc}</span>
                {h.trailing && <span className="tnum shrink-0 text-xs tabular-nums">{h.trailing}</span>}
              </button>
            </li>
          ))}
          {kw.trim() && hits.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">
              没有匹配结果，换个关键词或到磅单中心按日期查
            </li>
          )}
        </ul>
        <div className="flex items-center gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>选择
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Enter</Kbd>打开
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd>关闭
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
