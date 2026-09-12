/**
 * 磅单中心（05 §3 `/orders`）。
 *
 * 列表是磅房被查最多的界面，所以筛选条件全部进 URL 之外的本地状态即可，
 * 但合计行必须与筛选同源（mock 层的 summary 与列表同一趟扫描算出，
 * 真实实现是同一条 SQL 的窗口函数，见 03 §9 索引说明）。
 *
 * 手录来源的行整行淡黄底 + 「手录」徽章：颜色不是唯一提示，
 * 黑白打印时徽章文字仍然在（05 §6.2）。
 */
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { DownloadIcon, PrinterIcon, SearchIcon, SlidersHorizontalIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { OrderRow } from "@/mock/api";
import type { OrderFilters } from "@/mock/types";
import type { OrderStatus, PaymentStatus, WeightSource } from "@/lib/constants";
import { ORDER_STATUS, PARTY_TYPE, PAYMENT_STATUS, WEIGHT_SOURCE } from "@/lib/constants";
import { maskIdCard, money, orDash, price as fmtPrice, shiftDay, toKg, todayISO, weight } from "@/lib/format";
import { downloadCsv, csvName } from "@/lib/csv";
import { useStaffNames, useVarieties } from "@/hooks/useLookups";
import { useHotkey } from "@/hooks/useHotkey";
import { actorId, useSession } from "@/store/session";
import { ALL, Choose } from "@/components/business/Choose";
import { DataTable, type Column } from "@/components/business/DataTable";
import { OrderStatusBadge, PaymentStatusBadge, WeightSourceBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Label } from "@/components/ui/label";
import { EmptyState, PageHeader } from "@/components/business/layout";
import { cn } from "cn";

/** 默认只显示磅员天天要看的列，其余收进「列」下拉，1280 px 才放得下 */
const OPTIONAL_COLS = ["party_type", "grade", "id_card", "gross", "tare", "deduct", "goods"] as const;
type OptionalCol = (typeof OPTIONAL_COLS)[number];

/** 附加列在序列中的插入位（键 = 落在哪一列之后），保证勾选顺序不抖动 */
type Slot = { col: Column<OrderRow>; opt?: OptionalCol };

export function OrdersPage() {
  const navigate = useNavigate();
  const can = useSession((s) => s.can);
  const names = useStaffNames();
  const { data: varieties = [] } = useVarieties();

  const [filters, setFilters] = useState<OrderFilters>({
    dateFrom: shiftDay(todayISO(), -6),
    dateTo: todayISO(),
    status: "all",
    varietyId: "all",
    paymentStatus: "all",
    weightSource: "all",
    keyword: "",
    pageSize: 2000,
  });
  const [kw, setKw] = useState("");
  const [show, setShow] = useState<Record<OptionalCol, boolean>>({
    party_type: false,
    grade: false,
    id_card: false,
    gross: false,
    tare: false,
    deduct: false,
    goods: false,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);

  const query = useQuery({
    queryKey: ["orders", filters],
    queryFn: () => api.listOrders(filters),
  });
  const rows = query.data?.rows ?? [];
  const summary = query.data?.summary;

  const patch = (p: Partial<OrderFilters>) => setFilters((f) => ({ ...f, ...p }));

  /**
   * 附加列不是「加在末尾」，而是插在语义相邻的位置：身份紧跟姓名、毛皮紧跟净重、
   * 货款紧跟应付，这样勾完不必再横向拖找。整列的显示条件收敛进 Slot.opt。
   */
  const allColumns = useMemo<Column<OrderRow>[]>(() => {
    const slots: Slot[] = [
      {
        col: { key: "order_no", header: "磅单号", cell: (r) => <span className="tnum font-medium">{r.order_no}</span>, sortValue: (r) => r.order_no },
      },
      { col: { key: "business_date", header: "业务日期", cell: (r) => <span className="tnum">{r.business_date}</span>, sortValue: (r) => r.business_date } },
      { col: { key: "party_name", header: "售粮人", cell: (r) => <span className="font-medium">{r.party_name}</span>, sortValue: (r) => r.party_name } },
      { opt: "party_type", col: { key: "party_type", header: "身份", cell: (r) => PARTY_TYPE[r.party_type] } },
      { opt: "id_card", col: { key: "id_card", header: "证号", cell: (r) => <span className="tnum text-muted-foreground">{maskIdCard(r.id_card_no)}</span> } },
      { col: { key: "variety_name", header: "品种", cell: (r) => r.variety_name, sortValue: (r) => r.variety_name } },
      { opt: "grade", col: { key: "grade", header: "等级", cell: (r) => orDash(r.grade) } },
      { col: { key: "vehicle_no", header: "车牌", cell: (r) => <span className="tnum">{orDash(r.vehicle_no)}</span> } },
      {
        opt: "gross",
        col: {
          key: "gross",
          header: "毛重",
          align: "right",
          cell: (r) => <span className="tnum">{r.gross_weight_01kg == null ? "—" : weight(r.gross_weight_01kg)}</span>,
          sortValue: (r) => r.gross_weight_01kg,
        },
      },
      {
        opt: "tare",
        col: {
          key: "tare",
          header: "皮重",
          align: "right",
          cell: (r) => <span className="tnum">{r.tare_weight_01kg == null ? "—" : weight(r.tare_weight_01kg)}</span>,
          sortValue: (r) => r.tare_weight_01kg,
        },
      },
      {
        col: {
          key: "net",
          header: "净重",
          align: "right",
          cell: (r) => <span className="tnum">{weight(r.net_weight_01kg)}</span>,
          sortValue: (r) => r.net_weight_01kg,
          footer: () => <span className="tnum">{weight(summary?.net_01kg ?? 0)}</span>,
        },
      },
      {
        opt: "deduct",
        col: { key: "deduct", header: "扣重", align: "right", cell: (r) => <span className="tnum">{weight(r.deduct_total_01kg)}</span>, sortValue: (r) => r.deduct_total_01kg },
      },
      {
        col: {
          key: "settle",
          header: "结算重量",
          align: "right",
          cell: (r) => <span className="tnum">{weight(r.settlement_weight_01kg)}</span>,
          sortValue: (r) => r.settlement_weight_01kg,
          footer: () => <span className="tnum">{weight(summary?.settle_01kg ?? 0)}</span>,
        },
      },
      {
        col: {
          key: "price",
          header: "单价",
          align: "right",
          cell: (r) => <span className="tnum">{r.price_fen_per_ton == null ? "—" : fmtPrice(r.price_fen_per_ton).perTon}</span>,
          sortValue: (r) => r.price_fen_per_ton,
        },
      },
      {
        opt: "goods",
        col: {
          key: "goods",
          header: "货款",
          align: "right",
          cell: (r) => <span className="tnum">{r.goods_amount_fen == null ? "—" : money(r.goods_amount_fen)}</span>,
          sortValue: (r) => r.goods_amount_fen,
        },
      },
      {
        col: {
          key: "payable",
          header: "应付",
          align: "right",
          cell: (r) => <span className="tnum font-medium">{money(r.payable_amount_fen)}</span>,
          sortValue: (r) => r.payable_amount_fen,
          footer: () => <span className="tnum">{money(summary?.payable_fen ?? 0)}</span>,
        },
      },
      { col: { key: "status", header: "状态", cell: (r) => <OrderStatusBadge status={r.status} />, sortValue: (r) => r.status } },
      { col: { key: "payment", header: "付款", cell: (r) => <PaymentStatusBadge status={r.payment_status} /> } },
      { col: { key: "source", header: "称重来源", cell: (r) => <WeightSourceBadge source={r.weight_source} /> } },
    ];
    return slots.filter((s) => !s.opt || show[s.opt]).map((s) => s.col);
  }, [show, summary]);

  function exportCsv() {
    if (rows.length === 0) {
      toast.error("当前筛选结果为空，没有可导出的行");
      return;
    }
    const headers = ["磅单号", "业务日期", "售粮人", "证号", "品种", "等级", "车牌", "仓房/货位", "毛重kg", "皮重kg", "净重kg", "扣重kg", "结算重量kg", "单价元/吨", "货款元", "扣款元", "应付元", "已付元", "状态", "付款状态", "称重来源", "磅员", "制单时间"];
    const data = rows.map((r) => [
      r.order_no,
      r.business_date,
      r.party_name,
      maskIdCard(r.id_card_no),
      r.variety_name,
      r.grade ?? "",
      r.vehicle_no ?? "",
      `${r.warehouse_name ?? ""}${r.slot_label ? `/${r.slot_label}` : ""}`,
      r.gross_weight_01kg == null ? "" : toKg(r.gross_weight_01kg),
      r.tare_weight_01kg == null ? "" : toKg(r.tare_weight_01kg),
      r.net_weight_01kg == null ? "" : toKg(r.net_weight_01kg),
      toKg(r.deduct_total_01kg),
      r.settlement_weight_01kg == null ? "" : toKg(r.settlement_weight_01kg),
      r.price_fen_per_ton == null ? "" : r.price_fen_per_ton / 100,
      r.goods_amount_fen == null ? "" : r.goods_amount_fen / 100,
      r.deduction_fee_fen / 100,
      r.payable_amount_fen == null ? "" : r.payable_amount_fen / 100,
      r.paid_amount_fen / 100,
      ORDER_STATUS[r.status].label,
      PAYMENT_STATUS[r.payment_status].label,
      WEIGHT_SOURCE[r.weight_source].label,
      names(r.weigher_id),
      r.registered_at.slice(0, 19).replace("T", " "),
    ]);
    const n = downloadCsv(csvName(`磅单台账_${filters.dateFrom}_${filters.dateTo}`), headers, data);
    toast.success(`已导出 ${n} 行（CSV，Excel 可直接打开）`);
  }

  useHotkey("ctrl+e", exportCsv, { allowInInput: true });

  const batch = useMutation({
    mutationFn: async () => {
      const list = [...selected];
      for (const no of list) {
        await api.logPrint({
          doc_type: "weigh_order",
          doc_no: no,
          paper: "A4",
          printer_name: "HP LaserJet M403d",
          channel: "preview",
          is_reprint: true,
          operator_id: actorId(),
        });
      }
      return list.length;
    },
    onSuccess: (n) => {
      toast.success(`已按顺序送打 ${n} 张码单（补打，已记授权留痕）`);
      setSelected(new Set());
      setBatchOpen(false);
    },
    onError: () => toast.error("批量打印中断，已打印的张数在打印日志里可查"),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="磅单中心"
        description={`共 ${query.data?.total ?? 0} 张 · 净重 ${weight(summary?.net_01kg ?? 0)} · 应付 ${money(summary?.payable_fen ?? 0)}`}
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={selected.size === 0 || !can("print")}
              onClick={() => setBatchOpen(true)}
            >
              <PrinterIcon />
              批量打印{selected.size > 0 ? `（${selected.size}）` : ""}
            </Button>
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
              <DownloadIcon />
              导出（Ctrl+E）
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2 border bg-muted/20 p-2.5">
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              业务日期
              <DateRangePicker
                value={{ from: filters.dateFrom ?? "", to: filters.dateTo ?? "" }}
                onChange={(f, t) => patch({ dateFrom: f, dateTo: t })}
                className="w-60"
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              状态
              <Choose
                aria-label="状态"
                className="w-28"
                value={filters.status ?? "all"}
                onChange={(v) => patch({ status: v as OrderStatus | "all" })}
                options={[{ value: "all", label: "全部" }, ...(Object.keys(ORDER_STATUS) as OrderStatus[]).map((k) => ({ value: k, label: ORDER_STATUS[k].label }))]}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              品种
              <Choose
                aria-label="品种"
                className="w-28"
                value={String(filters.varietyId ?? ALL)}
                onChange={(v) => patch({ varietyId: v === ALL ? "all" : Number(v) })}
                options={[{ value: ALL, label: "全部" }, ...varieties.map((v) => ({ value: String(v.id), label: v.name }))]}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              付款
              <Choose
                aria-label="付款状态"
                className="w-28"
                value={filters.paymentStatus ?? "all"}
                onChange={(v) => patch({ paymentStatus: v as PaymentStatus | "all" })}
                options={[{ value: "all", label: "全部" }, ...(Object.keys(PAYMENT_STATUS) as PaymentStatus[]).map((k) => ({ value: k, label: PAYMENT_STATUS[k].label }))]}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              称重来源
              <Choose
                aria-label="称重来源"
                className="w-28"
                value={filters.weightSource ?? "all"}
                onChange={(v) => patch({ weightSource: v as WeightSource | "all" })}
                options={[{ value: "all", label: "全部" }, ...(Object.keys(WEIGHT_SOURCE) as WeightSource[]).map((k) => ({ value: k, label: WEIGHT_SOURCE[k].label }))]}
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
                placeholder="单号 / 姓名 / 证号后 4 位 / 车牌，回车查询"
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
                setFilters({ dateFrom: shiftDay(todayISO(), -6), dateTo: todayISO(), status: "all", varietyId: "all", paymentStatus: "all", weightSource: "all", keyword: "", pageSize: 2000 });
              }}
            >
              重置
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
                <SlidersHorizontalIcon />
                列
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>附加列</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {OPTIONAL_COLS.map((k) => (
                    <DropdownMenuCheckboxItem
                      key={k}
                      checked={show[k]}
                      onCheckedChange={(v) => setShow((s) => ({ ...s, [k]: v === true }))}
                    >
                      {OPTIONAL_LABEL[k]}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <DataTable
            columns={allColumns}
            rows={rows}
            rowKey={(r) => r.order_no}
            loading={query.isPending}
            rowHref={(r) => `/orders/${r.order_no}`}
            onRowClick={(r) => void navigate({ to: "/orders/$orderNo", params: { orderNo: r.order_no } })}
            selected={selected}
            onSelectedChange={setSelected}
            rowClassName={(r) =>
              cn(
                r.weight_source === "manual" && "bg-warning-bg",
                (r.status === "voided" || r.status === "rejected") && "text-muted-foreground line-through decoration-1",
              )
            }
            empty={
              <EmptyState
                title="没有符合条件的磅单"
                description="换个日期段或清空关键字再试；今天还没开磅的话去工作台取号。"
                action={
                  <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/workstation" })}>
                    去磅房工作台
                  </Button>
                }
              />
            }
            toolbar={
              <span className="text-xs text-muted-foreground">
                点击行进详情，Ctrl+点击在新窗口并排对单；勾选后可批量补打（需站长授权）。
              </span>
            }
          />
        </div>
      </div>

      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="max-w-[460px]">
          <DialogHeader>
            <DialogTitle className="text-sm">批量打印 {selected.size} 张码单</DialogTitle>
            <DialogDescription className="text-xs">
              真实实现会依次生成 PDF 送入同一打印机，中途失败会停在那里并提示重试；
              本版本逐张写打印留痕，用于验证联次与授权链路。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-40 overflow-y-auto border p-2 text-xs">
            {[...selected].map((no) => (
              <div key={no} className="tnum flex items-center gap-2">
                <Checkbox checked aria-label={no} className="pointer-events-none" />
                {no}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBatchOpen(false)}>
              取消
            </Button>
            <Button onClick={() => batch.mutate()} disabled={batch.isPending}>
              <PrinterIcon />
              开始送打
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const OPTIONAL_LABEL: Record<OptionalCol, string> = {
  party_type: "身份类型",
  grade: "等级",
  id_card: "证号（掩码）",
  gross: "毛重",
  tare: "皮重",
  deduct: "扣重合计",
  goods: "货款",
};
