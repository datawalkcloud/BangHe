/**
 * 全局检索 Ctrl+K（05 §5）。
 *
 * 现场真实诉求是"客户报个车牌或姓氏，我要立刻找到那张单"，
 * 所以命中项直接带出可跳转的单据/档案/结算单，而不是只给一个列表页链接。
 *
 * 列表用 shadcn 的 Command（cmdk）：上下键选择、回车打开、Esc 关闭都由它托管，
 * 不必再自己维护 cursor 状态。检索本身在服务端做，因此要关掉 cmdk 的本地过滤。
 */
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CreditCardIcon, FileTextIcon, UsersIcon } from "lucide-react";
import { api } from "@/lib/api";
import { ORDER_STATUS } from "@/lib/constants";
import { money, ton } from "@/lib/format";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/business/layout";

interface Hit {
  key: string;
  group: "磅单" | "售粮人" | "结算单" | "在场";
  icon: typeof FileTextIcon;
  title: string;
  desc: string;
  trailing?: string;
  to: string;
  params?: Record<string, string | number>;
}

/** 结果分组的固定顺序：先单后档再结算，跟现场"手上有单就先找单"的习惯一致 */
const GROUP_ORDER: Hit["group"][] = ["磅单", "售粮人", "结算单"];

export function GlobalSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [kw, setKw] = useState("");
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ["global-search", kw],
    queryFn: () => api.search(kw),
    enabled: open && kw.trim().length > 0,
  });
  /** 空输入时改给"在场名单"：不打字的人点开就能挑今天在场的那张单 */
  const { data: openOrders = [] } = useQuery({
    queryKey: ["openOrders"],
    queryFn: () => api.openOrders(),
    enabled: open && kw.trim().length === 0,
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

  /** 空输入时的那份"在场名单"：形状与命中项一致，点一下同样直达磅单页 */
  const openHits = useMemo<Hit[]>(
    () =>
      openOrders.map<Hit>((o) => ({
        key: `w${o.order_no}`,
        group: "在场",
        icon: FileTextIcon,
        title: o.order_no,
        desc: `${o.party_name} · ${ORDER_STATUS[o.status].label}`,
        trailing: o.settlement_weight_01kg != null ? ton(o.settlement_weight_01kg) : undefined,
        to: "/orders/$orderNo",
        params: { orderNo: o.order_no },
      })),
    [openOrders],
  );

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
            <span className="text-xs font-normal text-muted-foreground">不必打字：直接点下面在场的单</span>
          </DialogTitle>
        </DialogHeader>
        {/* 输入框容器自带 p-1，这里按对话框的 16 px 栅格纠正为 px-3。 */}
        <Command
          shouldFilter={false}
          className="rounded-none bg-transparent p-0 [&_[data-slot=command-input-wrapper]]:px-3 [&_[data-slot=command-input-wrapper]]:pt-3"
        >
          <CommandInput autoFocus value={kw} onValueChange={setKw} placeholder="会打字就输单号 / 姓名 / 证号后 4 位 / 车牌" />
          <CommandList className="max-h-[320px] scroll-py-1">
            <CommandEmpty className="px-4 py-6 text-muted-foreground">
              {kw.trim()
                ? "没有匹配结果，换个关键词或到磅单中心按日期查"
                : "此刻没有在场单；要查历史单请输单号 / 姓名 / 证号后 4 位"}
            </CommandEmpty>
            {(kw.trim() ? GROUP_ORDER : (["在场"] as Hit["group"][])).map((g) => {
              const rows = (kw.trim() ? hits : openHits).filter((h) => h.group === g);
              if (rows.length === 0) return null;
              return (
                <CommandGroup key={g} heading={g}>
                  {rows.map((h) => (
                    <CommandItem
                      key={h.key}
                      value={h.key}
                      onSelect={() => go(h)}
                      // CommandItem 末尾挂了一个恒为 opacity-0 的选中勾（给可勾选命令用），
                      // 这里不做勾选，直接藏掉，免得右端白留 1em
                      className="gap-2 [&>svg:last-child]:hidden"
                    >
                      <h.icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{h.title}</span>
                      <span className="min-w-0 shrink basis-1/2 truncate text-xs text-muted-foreground">{h.desc}</span>
                      {h.trailing && <span className="tnum shrink-0 text-xs tabular-nums">{h.trailing}</span>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
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
