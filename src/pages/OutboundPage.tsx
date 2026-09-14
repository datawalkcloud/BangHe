/**
 * 出库单中心（05 §3 `/outbound`，02 §M11）。
 *
 * 与磅单中心同一套界面纪律，两处刻意一致：
 *  1. **合计与行同一条筛选**（`summary` 由后端与列表同一趟扫描算出，见 03 §9 索引说明）。
 *     分屏对不上数是最难发现的那种错，所以这里不接受前端自己再 reduce 一遍。
 *  2. **超库存的行整行淡黄底 + 「超库存」徽章**：颜色不是唯一提示，
 *     黑白打印与色弱场景徽章文字仍在（05 §6.2）。这句话是服务端复算后写进
 *     `stock_warning` 的，列表只是把它露出来，不在前端重算一遍判据。
 *
 * 本期（波 1）出库净重为手填，所以这里给的是"改单—完成出库"的两步流，
 * 没有磅房工作台的实时读数。接秤与出库码单在下一批。
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import {
  OUTBOUND_KIND, OUTBOUND_STATUS, VOID_REASON_MIN,
  type OutboundKind, type OutboundStatus,
} from "@/lib/constants";
import { money, orDash, price, ton, todayISO, weight } from "@/lib/format";
import { useWarehouses } from "@/hooks/useLookups";
import { actorId, useSession } from "@/store/session";
import { ALL, Choose } from "@/components/business/Choose";
import { DataTable, type Column } from "@/components/business/DataTable";
import { PaymentStatusBadge, ToneBadge, WeightSourceBadge } from "@/components/business/badges";
import { EmptyState, PageHeader } from "@/components/business/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { OutboundFormDialog } from "@/components/outbound/OutboundFormDialog";
import type { OutboundFilters, OutboundOrder } from "@/mock/types";

const DEFAULT_FILTERS: OutboundFilters = {
  date_from: todayISO().slice(0, 8) + "01",
  date_to: todayISO(),
  status: "all",
  kind: "all",
  warehouse_id: null,
  keyword: "",
  page_size: 2000,
};

export function OutboundPage() {
  const qc = useQueryClient();
  const can = useSession((s) => s.can);
  const { data: warehouses = [] } = useWarehouses();

  const [filters, setFilters] = useState<OutboundFilters>(DEFAULT_FILTERS);
  const [kw, setKw] = useState("");
  const [form, setForm] = useState<{ open: boolean; editing: OutboundOrder | null }>({ open: false, editing: null });

  const query = useQuery({
    queryKey: ["outbound", filters],
    queryFn: () => api.listOutbound(filters),
  });
  const rows = query.data?.rows ?? [];
  const summary = query.data?.summary;
  const patch = (p: Partial<OutboundFilters>) => setFilters((f) => ({ ...f, ...p }));

  const complete = useMutation({
    mutationFn: (no: string) => api.completeOutbound({ order_no: no, operator_id: actorId() }),
    onSuccess: (row) => {
      // 完成出库会留下库存流水并可能带一句超库存警示——警示要看得见，故用 warning 不用 success
      if (row.stock_warning) toast.warning(row.stock_warning, { duration: 9000 });
      else toast.success(`${row.order_no} 已出库，库存已扣 ${ton(row.net_weight_01kg)}`);
      qc.invalidateQueries({ queryKey: ["outbound"] });
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
      qc.invalidateQueries({ queryKey: ["stock-movements"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const columns = useMemo<Column<OutboundOrder>[]>(
    () => [
      { key: "order_no", header: "出库单号", cell: (r) => <span className="tnum font-medium">{r.order_no}</span>, sortValue: (r) => r.order_no },
      { key: "business_date", header: "业务日期", cell: (r) => <span className="tnum">{r.business_date}</span>, sortValue: (r) => r.business_date },
      { key: "kind", header: "性质", cell: (r) => OUTBOUND_KIND[r.kind].label, sortValue: (r) => r.kind },
      {
        key: "party",
        header: "领出方",
        cell: (r) => <span className="font-medium">{orDash(r.party_name ?? r.counterparty_label)}</span>,
        sortValue: (r) => r.party_name ?? r.counterparty_label ?? "",
      },
      { key: "variety", header: "品种 / 等级", cell: (r) => `${orDash(r.variety_name)}${r.grade ? ` · ${r.grade}` : ""}` },
      { key: "wh", header: "出仓仓房", cell: (r) => orDash(r.slot_label ? `${r.warehouse_name} / ${r.slot_label}` : r.warehouse_name) },
      {
        key: "net",
        header: "出库净重",
        align: "right",
        cell: (r) => <span className="tnum">{r.net_weight_01kg == null ? "—" : weight(r.net_weight_01kg)}</span>,
        sortValue: (r) => r.net_weight_01kg,
        footer: (rs) => <span className="tnum">{ton(rs.reduce((s, r) => s + (r.net_weight_01kg ?? 0), 0))}</span>,
      },
      {
        key: "source",
        header: "重量来源",
        cell: (r) => <WeightSourceBadge source={r.weight_source} />,
        title: "本期出库净重一律手录；接秤后由称重捕获写「地磅」",
      },
      { key: "price", header: "单价", align: "right", cell: (r) => <span className="tnum">{price(r.price_fen_per_ton)}</span>, sortValue: (r) => r.price_fen_per_ton },
      {
        key: "goods",
        header: "货款",
        align: "right",
        cell: (r) => <span className="tnum">{r.goods_amount_fen == null ? "—" : money(r.goods_amount_fen)}</span>,
        sortValue: (r) => r.goods_amount_fen,
        footer: (rs) => <span className="tnum">{money(rs.reduce((s, r) => s + (r.goods_amount_fen ?? 0), 0))}</span>,
      },
      { key: "status", header: "状态", cell: (r) => <ToneBadge tone={OUTBOUND_STATUS[r.status].tone}>{OUTBOUND_STATUS[r.status].label}</ToneBadge>, sortValue: (r) => r.status },
      { key: "payment", header: "付款", cell: (r) => <PaymentStatusBadge status={r.payment_status} /> },
      {
        key: "actions",
        header: "操作",
        cell: (r) =>
          r.status === "draft" ? (
            <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
              <Button size="sm" variant="ghost" disabled={!can("outbound.create")} onClick={() => setForm({ open: true, editing: r })}>
                修改
              </Button>
              <Button size="sm" variant="outline" disabled={!can("outbound.create") || complete.isPending} onClick={() => complete.mutate(r.order_no)}>
                完成出库
              </Button>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">{r.stock_warning ? "见警示" : "—"}</span>
          ),
      },
    ],
    [can, complete],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="出库单中心"
        description={`共 ${query.data?.total ?? 0} 张 · 出库 ${ton(summary?.net_01kg ?? 0)} · 货款 ${money(summary?.goods_fen ?? 0)}`}
        actions={
          <Button size="sm" disabled={!can("outbound.create")} onClick={() => setForm({ open: true, editing: null })}>
            <PlusIcon />
            新建出库单
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2 border bg-muted/20 p-2.5">
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              业务日期
              <DateRangePicker
                value={{ from: filters.date_from ?? "", to: filters.date_to ?? "" }}
                onChange={(f, t) => patch({ date_from: f, date_to: t })}
                className="w-60"
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              性质
              <Choose
                aria-label="出库性质"
                className="w-28"
                value={filters.kind ?? "all"}
                onChange={(v) => patch({ kind: v as OutboundKind | "all" })}
                options={[
                  { value: "all", label: "全部" },
                  ...(Object.keys(OUTBOUND_KIND) as OutboundKind[]).map((k) => ({ value: k, label: OUTBOUND_KIND[k].label })),
                ]}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              状态
              <Choose
                aria-label="状态"
                className="w-28"
                value={filters.status ?? "all"}
                onChange={(v) => patch({ status: v as OutboundStatus | "all" })}
                options={[
                  { value: "all", label: "全部" },
                  ...(Object.keys(OUTBOUND_STATUS) as OutboundStatus[]).map((k) => ({ value: k, label: OUTBOUND_STATUS[k].label })),
                ]}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              仓房
              <Choose
                aria-label="仓房"
                className="w-36"
                value={filters.warehouse_id == null ? ALL : String(filters.warehouse_id)}
                onChange={(v) => patch({ warehouse_id: v === ALL ? null : Number(v) })}
                options={[
                  { value: ALL, label: "全部" },
                  ...warehouses.map((w) => ({ value: String(w.id), label: `${w.code} ${w.name}` })),
                ]}
              />
            </Label>
            <Label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
              关键字
              <Input
                value={kw}
                onChange={(e) => setKw(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") patch({ keyword: kw });
                }}
                placeholder="单号 / 领出方 / 领用方 / 车牌，回车查询"
                className="h-8 text-sm"
              />
            </Label>
            <Button size="sm" onClick={() => patch({ keyword: kw })}>
              <SearchIcon />
              查询
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setKw("");
                setFilters({ ...DEFAULT_FILTERS, date_from: filters.date_from, date_to: filters.date_to });
              }}
            >
              重置
            </Button>
          </div>

          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            loading={query.isLoading}
            rowHref={(r) => `/outbound/${r.order_no}`}
            empty={<EmptyState title="这一段时间没有出库单" description={`开出库单需要「${can("outbound.create") ? "值仓 / 站长 / 磅员 / 登记员" : "值仓或站长"}」岗位；本期出库净重为手填。至少写 ${VOID_REASON_MIN} 个字的原因是作废与红冲的硬性留痕。`} />}
            rowClassName={(r) => (r.stock_warning ? "bg-amber-50/70 dark:bg-amber-950/20" : undefined)}
          />
        </div>
      </div>

      <OutboundFormDialog open={form.open} onOpenChange={(v) => setForm((s) => ({ ...s, open: v }))} editing={form.editing} />
    </div>
  );
}
