/**
 * 库存账（02 §M11、03 §9.23）：结存矩阵 + 出入库流水。
 *
 * 两屏是一件事的两面，所以放在一页里、共用同一套筛选：
 *  · **结存**回答「这个仓这个品种还剩多少、还能出多少」；
 *  · **流水**回答「这个数是怎么来的」——每格都能下钻到自己那几条原始记录。
 * 只有结存没有流水，值仓对不上账时没有任何自查手段。
 *
 * 三条口径在界面上必须说清楚（都来自 `stock.rs`，这里不重算）：
 *  1. 结存 = Σ入 − Σ出，按 **仓房 × 品种**；货位不参与结存（现场货位是"大致搁哪儿"，
 *     账上不按货位盘）。
 *  2. 入库只认**已结算**的数量（`settlement_weight_01kg`）；已卸磅未结算的另出一列
 *     「待入账」，它**不在**结存里，但不许看着像凭空少了一截。
 *  3. 结存可以为负（超库存出库不拦车），负数行标红并给一句解释，不做"藏起来"。
 */
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { DownloadIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { csvName } from "@/lib/csv";
import { exportCsvFile } from "@/lib/export-csv";
import { dateTime, money, orDash, ton, todayISO } from "@/lib/format";
import { useVarieties, useWarehouses } from "@/hooks/useLookups";
import { ALL, Choose } from "@/components/business/Choose";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState, PageHeader } from "@/components/business/layout";
import { ToneBadge } from "@/components/business/badges";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "cn";
import type { MovementFilters, StockBalanceRow, StockMovementRow } from "@/mock/types";

type Tab = "balance" | "ledger";

const TABS: { key: Tab; label: string }[] = [
  { key: "balance", label: "结存" },
  { key: "ledger", label: "流水" },
];

export function StockPage() {
  const [tab, setTab] = useState<Tab>("balance");
  const { data: warehouses = [] } = useWarehouses();
  const { data: varieties = [] } = useVarieties();

  const [wh, setWh] = useState<number | null>(null);
  const [variety, setVariety] = useState<number | null>(null);
  const [movFilters, setMovFilters] = useState<MovementFilters>({
    kind: "all",
    date_from: todayISO().slice(0, 8) + "01",
    date_to: todayISO(),
    page_size: 2000,
  });

  const balanceQ = useQuery({ queryKey: ["stock-balance"], queryFn: () => api.stockBalance() });
  const movementsQ = useQuery({
    queryKey: ["stock-movements", wh, variety, movFilters],
    queryFn: () => api.stockMovements({ ...movFilters, warehouse_id: wh, variety_id: variety }),
  });

  /* ------------------------------------------------------------------ 结存 */

  const rows = balanceQ.data ?? [];
  /** 按仓房分组展示；每格结存 = Σ入 − Σ出，与下方流水同一判据 */
  const grouped = useMemo(() => {
    const map = new Map<number, { name: string; code: string; cells: StockBalanceRow[] }>();
    for (const r of rows) {
      const g = map.get(r.warehouse_id) ?? { name: r.warehouse_name, code: r.warehouse_code, cells: [] };
      g.cells.push(r);
      map.set(r.warehouse_id, g);
    }
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [rows]);
  const totalBalance = rows.reduce((s, r) => s + r.balance_01kg, 0);
  const negative = rows.filter((r) => r.balance_01kg < 0);

  /* ------------------------------------------------------------------ 流水 */

  const moves = movementsQ.data?.rows ?? [];
  const moveColumns = useMemo<Column<StockMovementRow>[]>(
    () => [
      { key: "at", header: "记账时间", cell: (r) => <span className="tnum text-xs">{dateTime(r.operated_at)}</span>, sortValue: (r) => r.operated_at },
      { key: "date", header: "业务日期", cell: (r) => <span className="tnum">{r.business_date}</span>, sortValue: (r) => r.business_date },
      {
        key: "kind",
        header: "方向",
        cell: (r) => (
          <span className={cn("font-medium", r.kind === "in" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
            {r.kind === "in" ? "入仓" : r.kind === "out" ? "出仓" : r.kind}
          </span>
        ),
        sortValue: (r) => r.kind,
      },
      {
        key: "doc",
        header: "凭据单据",
        cell: (r) =>
          r.outbound_no ? (
            <Link to="/outbound/$no" params={{ no: r.outbound_no }} className="tnum underline-offset-2 hover:underline">
              {r.outbound_no}
            </Link>
          ) : r.order_no ? (
            <Link to="/orders/$orderNo" params={{ orderNo: r.order_no }} className="tnum underline-offset-2 hover:underline">
              {r.order_no}
            </Link>
          ) : (
            "—"
          ),
      },
      { key: "party", header: "往来单位", cell: (r) => orDash(r.party_name) },
      { key: "variety", header: "品种 / 等级", cell: (r) => `${orDash(r.variety_name)}${r.grade ? ` · ${r.grade}` : ""}` },
      { key: "wh", header: "仓房", cell: (r) => orDash(r.warehouse_name) },
      {
        key: "qty",
        header: "变动量",
        align: "right",
        cell: (r) => (
          <span className={cn("tnum font-medium", r.signed_01kg < 0 && "text-destructive")}>
            {r.signed_01kg > 0 ? "+" : ""}
            {ton(r.signed_01kg)}
          </span>
        ),
        sortValue: (r) => r.signed_01kg,
        footer: (rs) => <span className="tnum">{ton(rs.reduce((s, r) => s + r.signed_01kg, 0))}</span>,
      },
      {
        key: "amount",
        header: "金额",
        align: "right",
        cell: (r) => <span className="tnum">{r.amount_fen == null ? "—" : money(r.amount_fen)}</span>,
        sortValue: (r) => r.amount_fen,
      },
      { key: "operator", header: "经办", cell: (r) => orDash(r.operator_name) },
      {
        key: "remark",
        header: "备注",
        cell: (r) => (
          <span className="text-xs text-muted-foreground">
            {r.reversal_of_id ? <ToneBadge tone="warning" className="mr-1 h-4 text-[10px]">红冲</ToneBadge> : null}
            {orDash(r.remark)}
          </span>
        ),
      },
    ],
    [],
  );

  function exportCsv() {
    if (moves.length === 0) {
      toast.error("当前筛选结果为空，没有可导出的行");
      return;
    }
    const headers = ["记账时间", "业务日期", "方向", "凭据单据", "往来单位", "品种", "等级", "仓房", "变动量吨", "金额元", "经办", "备注"];
    const data = moves.map((r) => [
      dateTime(r.operated_at),
      r.business_date,
      r.kind === "in" ? "入仓" : r.kind === "out" ? "出仓" : r.kind,
      r.outbound_no ?? r.order_no ?? "",
      r.party_name ?? "",
      r.variety_name ?? "",
      r.grade ?? "",
      r.warehouse_name ?? "",
      (r.signed_01kg / 10000).toFixed(2),
      r.amount_fen == null ? "" : (r.amount_fen / 100).toFixed(2),
      r.operator_name,
      r.remark ?? "",
    ]);
    return exportCsvFile({ filename: csvName(`库存流水_${movFilters.date_from ?? ""}_${movFilters.date_to ?? ""}`), headers, rows: data });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="库存账"
        description={
          tab === "balance"
            ? `全站在库 ${ton(totalBalance)}${negative.length ? ` · ${negative.length} 格为负（超库存出库未拦）` : ""}`
            : `共 ${movementsQ.data?.total ?? 0} 条流水 · 当前筛选净变动 ${ton(moves.reduce((s, r) => s + r.signed_01kg, 0))}`
        }
        tabs={
          <Tabs value={tab} onValueChange={setTab} className="gap-0">
            <TabsList className="mb-1 h-auto max-w-full flex-wrap justify-start">
              {TABS.map((t) => (
                <TabsTrigger key={t.key} value={t.key} className="flex-none text-sm">
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
        actions={
          tab === "ledger" ? (
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={moves.length === 0}>
              <DownloadIcon />
              导出
            </Button>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {/* 两个视图共用这一排筛选：从结存某一格下钻到流水，靠的就是同一组 仓房 + 品种 */}
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            仓房
            <Choose
              aria-label="仓房"
              className="w-40"
              value={wh == null ? ALL : String(wh)}
              onChange={(v) => setWh(v === ALL ? null : Number(v))}
              options={[{ value: ALL, label: "全部" }, ...warehouses.map((w) => ({ value: String(w.id), label: `${w.code} ${w.name}` }))]}
            />
          </Label>
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            品种
            <Choose
              aria-label="品种"
              className="w-32"
              value={variety == null ? ALL : String(variety)}
              onChange={(v) => setVariety(v === ALL ? null : Number(v))}
              options={[{ value: ALL, label: "全部" }, ...varieties.map((v) => ({ value: String(v.id), label: v.name }))]}
            />
          </Label>
          {tab === "ledger" ? (
            <>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                方向
                <Choose
                  aria-label="方向"
                  className="w-24"
                  value={movFilters.kind ?? "all"}
                  onChange={(v) => setMovFilters((f) => ({ ...f, kind: v as MovementFilters["kind"] }))}
                  options={[
                    { value: "all", label: "全部" },
                    { value: "in", label: "入仓" },
                    { value: "out", label: "出仓" },
                  ]}
                />
              </Label>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                业务日期
                <DateRangePicker
                  value={{ from: movFilters.date_from ?? "", to: movFilters.date_to ?? "" }}
                  onChange={(f, t) => setMovFilters((x) => ({ ...x, date_from: f, date_to: t }))}
                  className="w-72"
                />
              </Label>
            </>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setWh(null);
              setVariety(null);
            }}
          >
            清除筛选
          </Button>
        </div>

        {tab === "balance" ? (
          <div className="flex flex-col gap-4">
            {grouped.length === 0 ? (
              <EmptyState
                title="还没有任何库存流水"
                description="过磅结算并登记入仓去向、或完成出库单后，这里会自动出现流水。"
              />
            ) : null}
            {grouped.map((g) => (
              <Card key={g.code} size="sm" className="gap-0 p-0">
                <CardHeader className="bg-muted/30 px-3 py-2">
                  <CardTitle className="text-sm font-medium">
                    {g.code} · {g.name}
                  </CardTitle>
                  <CardAction>
                    <span className="tnum text-xs text-muted-foreground">
                      在库 {ton(g.cells.reduce((s, c) => s + c.balance_01kg, 0))} · {g.cells.length} 个品种
                    </span>
                  </CardAction>
                </CardHeader>
                <CardContent className="p-0">
                <DataTable
                  columns={[
                    { key: "variety", header: "品种", cell: (r) => orDash(r.variety_name ?? (r.variety_id == null ? "未定品种" : null)) },
                    { key: "grade", header: "等级口径", cell: () => <span className="text-xs text-muted-foreground">按品种汇总，不分等级</span> },
                    { key: "in", header: "累计入仓", align: "right", cell: (r) => <span className="tnum">{ton(r.in_01kg)}</span>, sortValue: (r) => r.in_01kg },
                    { key: "out", header: "累计出仓", align: "right", cell: (r) => <span className="tnum">{ton(r.out_01kg)}</span>, sortValue: (r) => r.out_01kg },
                    {
                      key: "balance",
                      header: "账面结存",
                      align: "right",
                      cell: (r) => (
                        <span className={cn("tnum font-medium", r.balance_01kg < 0 && "text-destructive")}>
                          {ton(r.balance_01kg)}
                          {r.balance_01kg < 0 ? <span className="ml-1 text-[10px] font-normal">超库存</span> : null}
                        </span>
                      ),
                      sortValue: (r) => r.balance_01kg,
                      title: "Σ入 − Σ出；入库只认已结算的结算重量",
                    },
                    {
                      key: "pending",
                      header: "待入账",
                      align: "right",
                      cell: (r) =>
                        r.pending_in_01kg > 0 ? (
                          <span className="tnum text-amber-700 dark:text-amber-400" title="已卸磅、净重已知但尚未结算，不计入结存">
                            {ton(r.pending_in_01kg)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        ),
                      sortValue: (r) => r.pending_in_01kg,
                    },
                    { key: "last", header: "最后动仓", cell: (r) => <span className="text-xs text-muted-foreground">{r.last_move_at ? dateTime(r.last_move_at) : "—"}</span> },
                    {
                      key: "drill",
                      header: "",
                      cell: (r) => (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setWh(r.warehouse_id);
                            setVariety(r.variety_id);
                            setTab("ledger");
                          }}
                        >
                          看流水
                        </Button>
                      ),
                    },
                  ]}
                  rows={g.cells}
                  rowKey={(r) => `${r.warehouse_id}-${r.variety_id ?? 0}`}
                  dense
                  loading={balanceQ.isLoading}
                />
                </CardContent>
              </Card>
            ))}
            <p className="text-xs text-muted-foreground">
              结存不含未结算入仓量，已卸磅未结算部分见「待入账」；货位不计入结存；红冲不改历史流水。
            </p>
          </div>
        ) : (
          <DataTable
            columns={moveColumns}
            rows={moves}
            rowKey={(r) => `${r.kind}-${r.id}`}
            loading={movementsQ.isLoading}
            empty={<p className="py-8 text-center text-sm text-muted-foreground">这一段时间没有动仓记录</p>}
          />
        )}
      </div>
    </div>
  );
}
