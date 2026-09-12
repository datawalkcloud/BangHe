/**
 * 台账报表（05 §3 `/reports/$kind`）。
 *
 * 五类报表共用一个壳：切片导航在标题下方，URL 可直接贴给同事，
 * 也方便站长"报表就是这几个 tab"的记忆习惯。
 *
 * 三条硬约定：
 * 1. 合计一律读接口返回的全集，绝不用当前分页累加冒充总计（02 §F6.2）；
 * 2. 红冲单参与汇总（负值抵消），只剔作废与拒收——台账与屏幕必须同源；
 * 3. 证件号在界面与导出里都脱敏，向监管报送全号是现场人工勾选的独立动作。
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { DownloadIcon, PrinterIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { DailyReport, LedgerRow, PartyRankRow, QualityReport, StaffLoadRow } from "@/mock/types";
import type { Grade, Tone } from "@/lib/constants";
import { PARTY_TYPE, PAYMENT_METHOD, ROLE, TONE_DOT, WEIGHT_SOURCE } from "@/lib/constants";
import { maskIdCard, money, orDash, percent, price as fmtPrice, ratioText, shiftDay, todayISO, weight } from "@/lib/format";
import { csvName, downloadCsv } from "@/lib/csv";
import { RANGE_PRESETS, resolveRange } from "@/lib/date-range";
import { useHotkey } from "@/hooks/useHotkey";
import { useStation, useStaffNames } from "@/hooks/useLookups";
import { useSession } from "@/store/session";
import { ReceiptPrintPreview } from "@/components/print/receipt/ReceiptPrintPreview";
import { BarList, MiniBars, RatioBar, SplitBar, StatCard } from "@/components/business/StatCard";
import { DataTable, type Column } from "@/components/business/DataTable";
import { ToneBadge, WeightSourceBadge } from "@/components/business/badges";
import { CallOut, EmptyState, InfoGrid, PageHeader, SectionTitle } from "@/components/business/layout";
import { QuickDetailLink } from "@/components/business/QuickDetailSheet";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Label } from "@/components/ui/label";
import { cn } from "cn";

export type ReportKind = "ledger" | "daily" | "quality" | "parties" | "staff";

const KINDS: { key: ReportKind; label: string; desc: string }[] = [
  { key: "ledger", label: "收购明细台账", desc: "逐单全字段，报送与稽查用" },
  { key: "daily", label: "日报", desc: "按品种汇总，同比环比" },
  { key: "quality", label: "质量分析", desc: "水分杂质分布、等级占比" },
  { key: "parties", label: "农户排行", desc: "售粮排行与未付对账" },
  { key: "staff", label: "作业量与异常", desc: "手录占比、作废补打" },
];

export function ReportsPage({ kind }: { kind: ReportKind }) {
  const current = KINDS.find((k) => k.key === kind);
  // 报表名打错时重定向到台账，避免页头与正文对不上号（与 MastersPage 同一口径）
  if (!current) return <Navigate to="/reports/$kind" params={{ kind: KINDS[0].key }} replace />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="台账报表"
        description={`${current.label} · ${current.desc}`}
        tabs={
          <nav className="flex flex-wrap gap-1 pb-1 text-sm">
            {KINDS.map((k) => (
              <Link
                key={k.key}
                to="/reports/$kind"
                params={{ kind: k.key }}
                className={
                  k.key === kind
                    ? "border border-b-background bg-background px-2.5 py-1 font-medium"
                    : "border border-transparent px-2.5 py-1 text-muted-foreground hover:text-foreground"
                }
              >
                {k.label}
              </Link>
            ))}
          </nav>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {kind === "ledger" && <LedgerReport />}
        {kind === "daily" && <DailyReportView />}
        {kind === "quality" && <QualityReportView />}
        {kind === "parties" && <PartyRankReport />}
        {kind === "staff" && <StaffLoadReport />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ 公共零件 */

/** 期间选择：区间报表用单个 range 日期控件（快捷预设内置在下拉里）；
 *  single 用于日报——它只看一天，保持单个日期选择，不摆成会让人误以为能选区间的控件 */
function RangeBar({
  from,
  to,
  onChange,
  extra,
  single = false,
  singleLabel = "业务日期",
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  extra?: ReactNode;
  single?: boolean;
  singleLabel?: string;
}) {
  const today = todayISO();
  // single 模式仍展示全部预设，点击回填同一天区间。
  const presets = RANGE_PRESETS.map((preset) => ({
    label: preset.label,
    range: [resolveRange(preset.key, today).from, resolveRange(preset.key, today).to] as [string, string],
  }));
  return (
    <div className="flex flex-wrap items-end gap-2 border bg-muted/20 p-2.5">
      {single ? (
        <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {singleLabel}
          <DatePicker value={from} onChange={(v) => onChange(v, v)} className="w-40" />
        </Label>
      ) : (
        <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
          统计期间
          <DateRangePicker value={{ from, to }} onChange={onChange} className="w-64" />
        </Label>
      )}
      {single && (
        <div className="flex flex-wrap gap-1 pb-1">
          {presets.map((p) => (
            <Button key={p.label} size="xs" variant={from === p.range[0] && to === p.range[1] ? "secondary" : "ghost"} onClick={() => onChange(...p.range)}>
              {p.label}
            </Button>
          ))}
        </div>
      )}
      {extra}
    </div>
  );
}

/** 打印：报表走系统打印对话框，不进 print_log（那张表只记三类单据） */
function printReport() {
  toast.info("已调用系统打印，请在对话框里选择打印机与纸张方向");
  window.print();
}

function useExportGuard() {
  const can = useSession((s) => s.can);
  return (headers: string[], rows: (string | number)[][], base: string) => {
    if (!can("data.export")) {
      toast.error("当前岗位没有导出权限（需 data.export）");
      return;
    }
    if (rows.length === 0) {
      toast.error("当前期间没有数据可导出");
      return;
    }
    const n = downloadCsv(csvName(base), headers, rows);
    toast.success(`已导出 ${n} 行到 CSV（Excel 双击即为中文）`);
  };
}

function Num({ children, tone, strike, className }: { children: ReactNode; tone?: Tone; strike?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "tnum tabular-nums",
        tone === "danger" && "text-destructive",
        tone === "warning" && "text-warning",
        tone === "success" && "text-success",
        strike && "text-muted-foreground line-through",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** 比率单元格：数值 + 色条，超过阈值才上色（05 §7：异常才给颜色，常态保持中性） */
function RateCell({ value, warn = 0.15, danger = 0.3 }: { value: number; warn?: number; danger?: number }) {
  const tone: Tone = value >= danger ? "danger" : value >= warn ? "warning" : "success";
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="w-12 text-right">
        <Num tone={tone === "success" ? undefined : tone}>{ratioText(value, 1)}</Num>
      </span>
      <span className="w-16">
        <RatioBar value={value} tone={tone} />
      </span>
    </span>
  );
}

/** 手录占比的红线：>20% 是拿不到读数才有的量级，>5% 就值得问一句 */
function toneOfRatio(r: number): Tone | undefined {
  return r > 0.2 ? "danger" : r > 0.05 ? "warning" : undefined;
}

/* --------------------------------------------------------- 收购明细台账 */

function LedgerReport() {
  const [from, setFrom] = useState(shiftDay(todayISO(), -6));
  const [to, setTo] = useState(todayISO());
  const exportGuard = useExportGuard();
  const { data: station } = useStation();
  const names = useStaffNames();
  const [ledgerPrint, setLedgerPrint] = useState(false);

  const { data = [], isPending } = useQuery({
    queryKey: ["report", "ledger", from, to],
    queryFn: () => api.reportLedger(from, to),
  });

  const sum = useMemo(
    () => ({
      net: data.reduce((n, r) => n + (r.net_weight_01kg ?? 0), 0),
      settle: data.reduce((n, r) => n + (r.settlement_weight_01kg ?? 0), 0),
      deduct: data.reduce((n, r) => n + r.deduct_total_01kg, 0),
      goods: data.reduce((n, r) => n + (r.goods_amount_fen ?? 0), 0),
      fee: data.reduce((n, r) => n + r.deduction_fee_fen, 0),
      payable: data.reduce((n, r) => n + (r.payable_amount_fen ?? 0), 0),
      paid: data.reduce((n, r) => n + r.paid_amount_fen, 0),
      credit: data.reduce((n, r) => n + r.credit_amount_fen, 0),
    }),
    [data],
  );

  const columns = useMemo<Column<LedgerRow>[]>(
    () => [
      { key: "seq", header: "序号", align: "right", cell: (r) => <Num>{r.seq}</Num> },
      { key: "date", header: "业务日期", cell: (r) => <Num>{r.business_date}</Num>, sortValue: (r) => r.business_date },
      {
        key: "no",
        header: "磅单号",
        cell: (r) => (
          <QuickDetailLink type="order" id={r.order_no} className="tnum font-medium text-primary">
            {r.order_no}
          </QuickDetailLink>
        ),
        sortValue: (r) => r.order_no,
      },
      { key: "party", header: "售粮人", cell: (r) => r.party_name, sortValue: (r) => r.party_name },
      { key: "ptype", header: "身份", cell: (r) => <span className="text-xs">{PARTY_TYPE[r.party_type]}</span> },
      { key: "id", header: "证件号", cell: (r) => <span className="tnum text-xs">{maskIdCard(r.id_card_no)}</span> },
      { key: "addr", header: "住址", cell: (r) => <span className="text-xs text-muted-foreground">{r.address}</span> },
      { key: "var", header: "品种", cell: (r) => r.variety_name, sortValue: (r) => r.variety_name },
      { key: "grade", header: "等级", cell: (r) => (r.grade ? <ToneBadge tone={GRADE_TONE[r.grade]}>{r.grade}</ToneBadge> : <span className="text-muted-foreground">未检</span>) },
      { key: "veh", header: "车号", cell: (r) => <span className="tnum text-xs">{orDash(r.vehicle_no)}</span> },
      { key: "wh", header: "仓房/货位", cell: (r) => <span className="text-xs">{orDash(r.warehouse_name)}</span> },
      { key: "gross", header: "毛重", align: "right", cell: (r) => <Num>{weight(r.gross_weight_01kg)}</Num> },
      { key: "tare", header: "皮重", align: "right", cell: (r) => <Num>{weight(r.tare_weight_01kg)}</Num> },
      {
        key: "net",
        header: "净重",
        align: "right",
        cell: (r) => <Num tone={r.net_weight_01kg != null && r.net_weight_01kg < 0 ? "danger" : undefined}>{weight(r.net_weight_01kg)}</Num>,
        sortValue: (r) => r.net_weight_01kg,
        footer: () => <Num>{weight(sum.net)}</Num>,
      },
      {
        key: "deduct",
        header: "扣量合计",
        align: "right",
        // 未结算行还没走完扣量环节，不能拿默认值 0 冒充“扣了 0 kg”，与毛/皮/净保持一致用 —
        cell: (r) => <Num>{weight(r.net_weight_01kg == null ? null : r.deduct_total_01kg)}</Num>,
        footer: () => <Num>{weight(sum.deduct)}</Num>,
      },
      { key: "settle", header: "结算重量", align: "right", cell: (r) => <Num>{weight(r.settlement_weight_01kg)}</Num>, footer: () => <Num>{weight(sum.settle)}</Num> },
      { key: "m", header: "水分", align: "right", cell: (r) => <Num>{percent(r.moisture_001pct, "")}</Num> },
      { key: "i", header: "杂质", align: "right", cell: (r) => <Num>{percent(r.impurity_001pct, "")}</Num> },
      { key: "price", header: "单价", align: "right", cell: (r) => <Num>{r.price_fen_per_ton ? fmtPrice(r.price_fen_per_ton).perTon : "—"}</Num> },
      { key: "goods", header: "粮款", align: "right", cell: (r) => <Num>{money(r.goods_amount_fen)}</Num>, footer: () => <Num>{money(sum.goods)}</Num> },
      { key: "fee", header: "扣款", align: "right", cell: (r) => <Num>{money(r.deduction_fee_fen)}</Num>, footer: () => <Num>{money(sum.fee)}</Num> },
      { key: "payable", header: "应付", align: "right", cell: (r) => <Num>{money(r.payable_amount_fen)}</Num>, footer: () => <Num>{money(sum.payable)}</Num> },
      { key: "paid", header: "已付", align: "right", cell: (r) => <Num tone="success">{money(r.paid_amount_fen)}</Num>, footer: () => <Num tone="success">{money(sum.paid)}</Num> },
      {
        key: "credit",
        header: "未付",
        align: "right",
        cell: (r) => <Num tone={r.credit_amount_fen > 0 ? "danger" : undefined}>{money(r.credit_amount_fen)}</Num>,
        footer: () => <Num tone={sum.credit > 0 ? "danger" : undefined}>{money(sum.credit)}</Num>,
      },
      { key: "method", header: "付款方式", cell: (r) => <span className="text-xs">{r.payment_method ? PAYMENT_METHOD[r.payment_method] : "—"}</span> },
      { key: "src", header: "称重来源", cell: (r) => <WeightSourceBadge source={r.weight_source} /> },
      { key: "weigher", header: "磅员", cell: (r) => <span className="text-xs">{r.weigher_name}</span> },
      { key: "insp", header: "化验员", cell: (r) => <span className="text-xs">{r.inspector_name}</span> },
      {
        key: "settled",
        header: "状态",
        cell: (r) => (r.settled ? <ToneBadge tone="info">已结算</ToneBadge> : <ToneBadge tone="neutral">未结算</ToneBadge>),
      },
    ],
    [sum],
  );

  function doExport() {
    exportGuard(
      ["序号", "业务日期", "磅单号", "售粮人", "身份", "证件号", "住址", "品种", "等级", "车号", "仓房/货位", "毛重kg", "皮重kg", "净重kg", "扣量kg", "结算重量kg", "水分%", "杂质%", "元/吨", "粮款元", "扣款元", "应付元", "已付元", "未付元", "付款方式", "称重来源", "磅员", "化验员", "状态"],
      data.map((r) => [
        r.seq,
        r.business_date,
        r.order_no,
        r.party_name,
        PARTY_TYPE[r.party_type],
        maskIdCard(r.id_card_no),
        r.address,
        r.variety_name,
        r.grade ?? "",
        r.vehicle_no ?? "",
        r.warehouse_name ?? "",
        (r.gross_weight_01kg ?? 0) / 10,
        (r.tare_weight_01kg ?? 0) / 10,
        (r.net_weight_01kg ?? 0) / 10,
        r.deduct_total_01kg / 10,
        (r.settlement_weight_01kg ?? 0) / 10,
        r.moisture_001pct == null ? "" : r.moisture_001pct / 100,
        r.impurity_001pct == null ? "" : r.impurity_001pct / 100,
        r.price_fen_per_ton == null ? "" : r.price_fen_per_ton / 100,
        (r.goods_amount_fen ?? 0) / 100,
        r.deduction_fee_fen / 100,
        (r.payable_amount_fen ?? 0) / 100,
        r.paid_amount_fen / 100,
        r.credit_amount_fen / 100,
        r.payment_method ? PAYMENT_METHOD[r.payment_method] : "",
        WEIGHT_SOURCE[r.weight_source].label,
        r.weigher_name,
        r.inspector_name,
        r.settled ? "已结算" : "未结算",
      ]),
      `收购台账_${from}_${to}`,
    );
  }

  useHotkey("ctrl+e", doExport, { allowInInput: true });

  const unsettled = data.filter((r) => !r.settled).length;

  return (
    <div className="flex flex-col gap-3">
      <RangeBar
        from={from}
        to={to}
        onChange={(f, t) => {
          setFrom(f);
          setTo(t);
        }}
        extra={
          <div className="ml-auto flex gap-2 pb-0.5">
            <Button size="sm" variant="outline" onClick={() => setLedgerPrint(true)} disabled={data.length === 0}>
              <PrinterIcon />
              打印
            </Button>
            <Button size="sm" variant="outline" onClick={doExport} disabled={data.length === 0}>
              <DownloadIcon />
              导出（Ctrl+E）
            </Button>
          </div>
        }
      />

      <InfoGrid
        cols={4}
        items={[
          { label: "台账行数", value: <Num>{data.length}</Num> },
          { label: "净重合计", value: <Num>{weight(sum.net)}</Num> },
          { label: "结算重量合计", value: <Num>{weight(sum.settle)}</Num> },
          { label: "扣量合计", value: <Num>{weight(sum.deduct)}</Num> },
          { label: "粮款合计", value: <Num>{money(sum.goods)}</Num> },
          { label: "应付合计", value: <Num>{money(sum.payable)}</Num> },
          { label: "已付合计", value: <Num tone="success">{money(sum.paid)}</Num> },
          { label: "未付合计", value: <Num tone={sum.credit > 0 ? "danger" : undefined}>{money(sum.credit)}</Num> },
        ]}
      />

      {unsettled > 0 && (
        <CallOut tone="info" title={`其中 ${unsettled} 单尚未结算`}>
          台账按业务日期归期，未结算的单也会出现在本期台账里，金额为空。日结前必须把它们结掉或作废，
          否则明天的台账和今天的现金对不上。
        </CallOut>
      )}

      <DataTable
        columns={columns}
        rows={data}
        rowKey={(r) => r.order_no}
        loading={isPending}
        rowClassName={(r) => (r.net_weight_01kg != null && r.net_weight_01kg < 0 ? "bg-destructive/5" : undefined)}
        empty={<EmptyState title="该期间没有收购记录" description="换一段日期，或先在工作台完成过磅与结算。" />}
        toolbar={
          <span className="text-xs text-muted-foreground">
            红冲单以负值参与合计，因此合计数就是本站该期间的真实净收购量；作废与拒收单不进台账。
            证件号已脱敏，向监管报送全号需现场另行导出。
          </span>
        }
      />

      {station && ledgerPrint && (
        <ReceiptPrintPreview
          open={ledgerPrint}
          onOpenChange={setLedgerPrint}
          scenario="ledger"
          context={{ station, names, ledgerRows: data }}
          docNo={`台账 ${from}_${to}`}
        />
      )}
    </div>
  );
}

/** 等级 → 语义色：一等最优、等外最差；图例里同时写数值，不靠颜色单独承载 */
const GRADE_TONE: Record<Grade, Tone> = {
  一等: "success",
  二等: "info",
  三等: "warning",
  四等: "warning",
  等外: "danger",
};

/* ----------------------------------------------------------------- 日报 */

type DailyRow = DailyReport["rows"][number];

function DailyReportView() {
  const [date, setDate] = useState(todayISO());
  const exportGuard = useExportGuard();
  const { data, isPending } = useQuery({ queryKey: ["report", "daily", date], queryFn: () => api.reportDaily(date) });
  const { data: station } = useStation();
  const names = useStaffNames();
  const [dailyPrint, setDailyPrint] = useState(false);

  const total = data?.total;
  const vsDay = delta(total?.net_01kg ?? 0, data?.prevDayNet_01kg ?? 0);
  const vsWeek = delta(total?.net_01kg ?? 0, data?.lastWeekNet_01kg ?? 0);

  const columns = useMemo<Column<DailyRow>[]>(
    () => [
      { key: "code", header: "品种", cell: (r) => <span className="font-medium">{r.variety_name}</span>, sortValue: (r) => r.variety_code },
      { key: "orders", header: "单数", align: "right", cell: (r) => <Num>{r.orders}</Num>, sortValue: (r) => r.orders, footer: (rows) => <Num>{rows.reduce((n, x) => n + x.orders, 0)}</Num> },
      { key: "parties", header: "售粮人数", align: "right", cell: (r) => <Num>{r.parties}</Num> },
      { key: "gross", header: "毛重", align: "right", cell: (r) => <Num>{weight(r.gross_01kg)}</Num> },
      { key: "tare", header: "皮重", align: "right", cell: (r) => <Num>{weight(r.tare_01kg)}</Num> },
      { key: "net", header: "净重", align: "right", cell: (r) => <Num>{weight(r.net_01kg)}</Num>, sortValue: (r) => r.net_01kg, footer: (rows) => <Num>{weight(rows.reduce((n, x) => n + x.net_01kg, 0))}</Num> },
      { key: "deduct", header: "扣量", align: "right", cell: (r) => <Num>{weight(r.deduct_01kg)}</Num> },
      { key: "settle", header: "结算重量", align: "right", cell: (r) => <Num>{weight(r.settle_01kg)}</Num> },
      { key: "m", header: "平均水分", align: "right", cell: (r) => <Num>{percent(r.avg_moisture_001pct, "")}</Num> },
      { key: "goods", header: "粮款", align: "right", cell: (r) => <Num>{money(r.goods_fen)}</Num>, footer: (rows) => <Num>{money(rows.reduce((n, x) => n + x.goods_fen, 0))}</Num> },
      { key: "fee", header: "扣款", align: "right", cell: (r) => <Num>{money(r.deduction_fee_fen)}</Num> },
      { key: "payable", header: "应付", align: "right", cell: (r) => <Num>{money(r.payable_fen)}</Num>, footer: (rows) => <Num>{money(rows.reduce((n, x) => n + x.payable_fen, 0))}</Num> },
      { key: "paid", header: "已付", align: "right", cell: (r) => <Num tone="success">{money(r.paid_fen)}</Num> },
      { key: "credit", header: "挂账", align: "right", cell: (r) => <Num tone={r.credit_fen > 0 ? "danger" : undefined}>{money(r.credit_fen)}</Num> },
      { key: "manual", header: "手录", align: "right", cell: (r) => <Num tone={r.manual_count > 0 ? "warning" : undefined}>{r.manual_count}</Num> },
      { key: "reject", header: "拒收", align: "right", cell: (r) => <Num tone={r.reject_count > 0 ? "danger" : undefined}>{r.reject_count}</Num> },
    ],
    [],
  );

  function doExport() {
    if (!data) return;
    exportGuard(
      ["品种", "单数", "售粮人数", "毛重kg", "皮重kg", "净重kg", "扣量kg", "结算重量kg", "平均水分%", "粮款元", "扣款元", "应付元", "已付元", "挂账元", "手录单数", "拒收单数"],
      data.rows.map((r) => [
        r.variety_name,
        r.orders,
        r.parties,
        r.gross_01kg / 10,
        r.tare_01kg / 10,
        r.net_01kg / 10,
        r.deduct_01kg / 10,
        r.settle_01kg / 10,
        r.avg_moisture_001pct == null ? "" : r.avg_moisture_001pct / 100,
        r.goods_fen / 100,
        r.deduction_fee_fen / 100,
        r.payable_fen / 100,
        r.paid_fen / 100,
        r.credit_fen / 100,
        r.manual_count,
        r.reject_count,
      ]),
      `日报_${date}`,
    );
  }

  useHotkey("ctrl+e", doExport, { allowInInput: true });

  return (
    <div className="flex flex-col gap-3">
      <RangeBar
        single
        from={date}
        to={date}
        onChange={(f) => setDate(f)}
        extra={
          <div className="ml-auto flex gap-2 pb-0.5">
            <Button size="sm" variant="outline" onClick={() => setDailyPrint(true)} disabled={!data || data.rows.length === 0}>
              <PrinterIcon />
              打印
            </Button>
            <Button size="sm" variant="outline" onClick={doExport} disabled={!data || data.rows.length === 0}>
              <DownloadIcon />
              导出（Ctrl+E）
            </Button>
          </div>
        }
      />
      {isPending || !total ? (
        <p className="text-sm text-muted-foreground">正在汇总…</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="净重"
              value={weight(total.net_01kg, false)}
              unit="kg"
              hint={`${total.orders} 单 / ${total.parties} 人`}
              delta={vsDay.text ? { text: `较昨日 ${vsDay.text}`, dir: vsDay.dir } : undefined}
            />
            <StatCard label="结算重量" value={weight(total.settle_01kg, false)} unit="kg" hint={`扣量 ${weight(total.net_01kg - total.settle_01kg, false)} kg`} />
            <StatCard
              label="粮款"
              value={money(total.goods_fen, false)}
              unit="元"
              hint={`均价 ${total.settle_01kg ? fmtPrice(Math.round(total.goods_fen / (total.settle_01kg / 10000))).perTon : "—"}`}
              delta={vsWeek.text ? { text: `净重较上周同期 ${vsWeek.text}`, dir: vsWeek.dir } : undefined}
            />
            <StatCard
              label="挂账未付"
              value={money(total.credit_fen, false)}
              unit="元"
              tone={total.credit_fen > 0 ? "danger" : "success"}
              hint={total.credit_fen > 0 ? "日结前应催清或说明原因" : "当天货款已全部付清"}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <DataTable
              columns={columns}
              rows={data.rows}
              rowKey={(r) => r.variety_code}
              empty={<EmptyState title="当天没有收购记录" description="换一个日期，或确认业务日期归属（跨天单登记在过磅完成日）。" />}
              toolbar={<span className="text-xs text-muted-foreground">合计行为当日全品种汇总，含红冲负值。</span>}
            />
            <section className="border bg-card">
              <SectionTitle>品种净重占比</SectionTitle>
              <div className="mt-2">
                {data.rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">无数据。</p>
                ) : (
                  <BarList items={data.rows.map((r) => ({ label: r.variety_name, value: r.net_01kg }))} formatter={(v) => weight(v)} />
                )}
              </div>
            </section>
          </div>
        </>
      )}
      {station && dailyPrint && (
        <ReceiptPrintPreview
          open={dailyPrint}
          onOpenChange={setDailyPrint}
          scenario="daily_report"
          context={{ station, names, daily: data }}
          docNo={`日报 ${date}`}
        />
      )}
    </div>
  );
}

function delta(cur: number, base: number): { text: string; dir: "up" | "down" | "flat" } {
  if (!base) return { text: "", dir: "flat" };
  const pct = ((cur - base) / base) * 100;
  const sign = pct > 0 ? "+" : "";
  return { text: `${sign}${pct.toFixed(1)}%`, dir: pct > 1 ? "up" : pct < -1 ? "down" : "flat" };
}

/* ------------------------------------------------------------- 质量分析 */

type QualityRow = QualityReport["byVariety"][number];

function QualityReportView() {
  const [from, setFrom] = useState(shiftDay(todayISO(), -29));
  const [to, setTo] = useState(todayISO());
  const exportGuard = useExportGuard();

  const { data } = useQuery({ queryKey: ["report", "quality", from, to], queryFn: () => api.reportQuality(from, to) });

  const columns = useMemo<Column<QualityRow>[]>(
    () => [
      { key: "v", header: "品种", cell: (r) => <span className="font-medium">{r.variety_name}</span> },
      {
        key: "o",
        header: "磅单",
        align: "right",
        cell: (r) => <Num>{r.orders}</Num>,
        footer: (rows) => <Num>{rows.reduce((n, x) => n + x.orders, 0)}</Num>,
      },
      {
        key: "n",
        header: "有效样本",
        align: "right",
        cell: (r) => <Num>{r.samples}</Num>,
        sortValue: (r) => r.samples,
        footer: (rows) => <Num>{rows.reduce((n, x) => n + x.samples, 0)}</Num>,
      },
      { key: "m", header: "平均水分", align: "right", cell: (r) => <Num>{percent(r.avg_moisture, "")}</Num>, sortValue: (r) => r.avg_moisture },
      { key: "i", header: "平均杂质", align: "right", cell: (r) => <Num>{percent(r.avg_impurity, "")}</Num> },
      { key: "u", header: "平均不完善粒", align: "right", cell: (r) => <Num>{percent(r.avg_unsound, "")}</Num> },
      {
        key: "oa",
        header: "超基准样本",
        align: "right",
        cell: (r) => (
          <Num tone={r.over_any > 0 ? "warning" : undefined}>
            {r.over_any}
            <span className="ml-1 text-[11px] text-muted-foreground">
              （水 {r.over_moisture} / 杂 {r.over_impurity}）
            </span>
          </Num>
        ),
        footer: (rows) => <Num>{rows.reduce((n, x) => n + x.over_any, 0)}</Num>,
      },
      {
        key: "orate",
        header: "超基准率",
        align: "right",
        cell: (r) => <RateCell value={r.samples ? r.over_any / r.samples : 0} />,
      },
      {
        key: "drate",
        header: "扣量率",
        align: "right",
        cell: (r) => <RateCell value={r.net_01kg > 0 ? r.deduct_01kg / r.net_01kg : 0} warn={0.12} danger={0.2} />,
      },
      {
        key: "rej",
        header: "拒收",
        align: "right",
        cell: (r) => <Num tone={r.reject > 0 ? "danger" : undefined}>{r.reject}</Num>,
        footer: (rows) => <Num>{rows.reduce((n, x) => n + x.reject, 0)}</Num>,
      },
      {
        key: "rrate",
        header: "拒收率",
        align: "right",
        cell: (r) => <RateCell value={r.orders ? r.reject / r.orders : 0} warn={0.05} danger={0.12} />,
      },
    ],
    [],
  );

  function doExport() {
    if (!data) return;
    exportGuard(
      ["品种", "磅单", "有效样本", "平均水分%", "平均杂质%", "平均不完善粒%", "超基准样本", "水分超基准", "杂质超基准", "超基准率%", "扣量率%", "拒收", "拒收率%"],
      data.byVariety.map((r) => [
        r.variety_name,
        r.orders,
        r.samples,
        r.avg_moisture == null ? "" : r.avg_moisture / 100,
        r.avg_impurity == null ? "" : r.avg_impurity / 100,
        r.avg_unsound == null ? "" : r.avg_unsound / 100,
        r.over_any,
        r.over_moisture,
        r.over_impurity,
        r.samples ? ((r.over_any / r.samples) * 100).toFixed(1) : "",
        r.net_01kg > 0 ? ((r.deduct_01kg / r.net_01kg) * 100).toFixed(1) : "",
        r.reject,
        r.orders ? ((r.reject / r.orders) * 100).toFixed(1) : "",
      ]),
      `质量分析_${from}_${to}`,
    );
  }

  useHotkey("ctrl+e", doExport, { allowInInput: true });

  const samples = data?.byVariety.reduce((n, r) => n + r.samples, 0) ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <RangeBar
        from={from}
        to={to}
        onChange={(f, t) => {
          setFrom(f);
          setTo(t);
        }}
        extra={
          <div className="ml-auto flex gap-2 pb-0.5">
            <Button size="sm" variant="outline" onClick={printReport} disabled={samples === 0}>
              <PrinterIcon />
              打印
            </Button>
            <Button size="sm" variant="outline" onClick={doExport} disabled={samples === 0}>
              <DownloadIcon />
              导出（Ctrl+E）
            </Button>
          </div>
        }
      />

      <DataTable
        columns={columns}
        rows={data?.byVariety ?? []}
        rowKey={(r) => r.variety_code}
        empty={<EmptyState title="该期间没有化验数据" description="先在磅房工作台完成扦样化验。" />}
        toolbar={<span className="text-xs text-muted-foreground">超基准率 = 任一指标超国标的样本 / 有效样本（复检生效则取代首检）；拒收率 = 拒收单 / 磅单；两者分母不同，不可相加。</span>}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="flex flex-col gap-3 border bg-card p-3">
          <SectionTitle>水分分布</SectionTitle>
          {data && data.moistureBuckets.some((b) => b.count > 0) ? (
            <MiniBars items={data.moistureBuckets.map((b) => ({ label: b.label, value: b.count }))} formatter={(v) => `${v} 样`} labelEvery={2} />
          ) : (
            <p className="text-sm text-muted-foreground">该期间没有可统计的水分样本。</p>
          )}
          <p className="text-xs text-muted-foreground">横轴为水分区间（%），纵轴为样本数；基准线以品种的国标值为准，见上表。</p>
        </section>

        <section className="flex flex-col gap-3 border bg-card p-3">
          <SectionTitle>等级占比</SectionTitle>
          {!data || data.gradeDist.every((g) => g.grades.every((x) => x.count === 0)) ? (
            <p className="text-sm text-muted-foreground">该期间没有定级记录。</p>
          ) : (
            <div className="flex flex-col gap-3">
              {data.gradeDist
                .filter((g) => g.grades.some((x) => x.count > 0))
                .map((g) => (
                  <div key={g.variety_name} className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium">{g.variety_name}</span>
                    <SplitBar
                      segments={g.grades.filter((x) => x.count > 0).map((x) => ({ label: x.grade, value: x.count, colorClass: TONE_DOT[GRADE_TONE[x.grade]] }))}
                      formatter={(v) => `${v} 单`}
                    />
                  </div>
                ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- 农户排行 */

function PartyRankReport() {
  const [from, setFrom] = useState(shiftDay(todayISO(), -29));
  const [to, setTo] = useState(todayISO());
  const [onlyCredit, setOnlyCredit] = useState(false);
  const exportGuard = useExportGuard();

  const { data = [] } = useQuery({ queryKey: ["report", "parties", from, to], queryFn: () => api.reportParties(from, to) });
  const rows = useMemo(() => (onlyCredit ? data.filter((r) => r.credit_fen > 0) : data), [data, onlyCredit]);

  const columns = useMemo<Column<PartyRankRow>[]>(
    () => [
      {
        key: "rank",
        header: "#",
        align: "right",
        cell: (r) => <Num className="text-muted-foreground">{rows.indexOf(r) + 1}</Num>,
      },
      {
        key: "name",
        header: "售粮人",
        cell: (r) => (
          <QuickDetailLink type="party" id={r.party_id} className="font-medium text-primary">
            {r.name}
          </QuickDetailLink>
        ),
        sortValue: (r) => r.name,
      },
      { key: "type", header: "身份", cell: (r) => <span className="text-xs">{PARTY_TYPE[r.party_type]}</span> },
      { key: "orders", header: "交粮次数", align: "right", cell: (r) => <Num>{r.orders}</Num>, sortValue: (r) => r.orders },
      { key: "net", header: "净重", align: "right", cell: (r) => <Num>{weight(r.net_01kg)}</Num>, sortValue: (r) => r.net_01kg, footer: (list) => <Num>{weight(list.reduce((n, x) => n + x.net_01kg, 0))}</Num> },
      { key: "goods", header: "粮款", align: "right", cell: (r) => <Num>{money(r.goods_fen)}</Num>, footer: (list) => <Num>{money(list.reduce((n, x) => n + x.goods_fen, 0))}</Num> },
      { key: "paid", header: "已付", align: "right", cell: (r) => <Num tone="success">{money(r.paid_fen)}</Num>, footer: (list) => <Num>{money(list.reduce((n, x) => n + x.paid_fen, 0))}</Num> },
      {
        key: "credit",
        header: "未付",
        align: "right",
        cell: (r) => <Num tone={r.credit_fen > 0 ? "danger" : undefined}>{money(r.credit_fen)}</Num>,
        sortValue: (r) => r.credit_fen,
        footer: (list) => <Num tone={list.reduce((n, x) => n + x.credit_fen, 0) > 0 ? "danger" : undefined}>{money(list.reduce((n, x) => n + x.credit_fen, 0))}</Num>,
      },
      { key: "last", header: "最近交粮", cell: (r) => <Num className="text-xs">{r.last_date}</Num>, sortValue: (r) => r.last_date },
      // 分母是全历史皮重均值（用于下次卸货时的偏差预判），与前面的“交粮次数”期间口径不同，列名必须区分开
      {
        key: "tare",
        header: "历史平均皮重",
        align: "right",
        title: "该售粮人全部历史过磅记录的皮重均值，不受上方日期区间影响",
        cell: (r) => <Num>{weight(r.avg_tare_01kg)}</Num>,
      },
    ],
    [rows],
  );

  function doExport() {
    exportGuard(
      ["售粮人", "身份", "交粮次数", "净重kg", "粮款元", "已付元", "未付元", "最近交粮", "历史平均皮重kg"],
      rows.map((r) => [
        r.name,
        PARTY_TYPE[r.party_type],
        r.orders,
        r.net_01kg / 10,
        r.goods_fen / 100,
        r.paid_fen / 100,
        r.credit_fen / 100,
        r.last_date,
        r.avg_tare_01kg == null ? "" : r.avg_tare_01kg / 10,
      ]),
      `售粮人排行_${from}_${to}`,
    );
  }

  useHotkey("ctrl+e", doExport, { allowInInput: true });

  const creditCount = data.filter((r) => r.credit_fen > 0).length;
  const top10 = rows.slice(0, 10);
  const totalNet = data.reduce((n, r) => n + r.net_01kg, 0);
  const top10Net = top10.reduce((n, r) => n + r.net_01kg, 0);

  return (
    <div className="flex flex-col gap-3">
      <RangeBar
        from={from}
        to={to}
        onChange={(f, t) => {
          setFrom(f);
          setTo(t);
        }}
        extra={
          <div className="ml-auto flex flex-wrap items-end gap-2 pb-0.5">
            <Button size="sm" variant={onlyCredit ? "default" : "outline"} onClick={() => setOnlyCredit((v) => !v)}>
              {onlyCredit ? "查看全部" : `只看有未付（${creditCount}）`}
            </Button>
            <Button size="sm" variant="outline" onClick={printReport} disabled={rows.length === 0}>
              <PrinterIcon />
              打印
            </Button>
            <Button size="sm" variant="outline" onClick={doExport} disabled={rows.length === 0}>
              <DownloadIcon />
              导出（Ctrl+E）
            </Button>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="售粮人数" value={String(data.length)} unit="人" hint={`期间净重合计 ${weight(totalNet)}`} />
        <StatCard label="前 10 名集中度" value={totalNet ? ratioText(top10Net / totalNet, 1) : "—"} hint="经纪人占比过高要留意转手粮" />
        <StatCard label="有未付余额" value={String(creditCount)} unit="人" tone={creditCount > 0 ? "danger" : "success"} hint="点上方按钮筛出待对账名单" />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.party_id}
        empty={
          <EmptyState
            title={onlyCredit ? "没有未付清的售粮人" : "该期间没有售粮记录"}
            description={onlyCredit ? "说明这段期间的货款都已当场结清。" : "换一段日期试试。"}
          />
        }
        toolbar={<span className="text-xs text-muted-foreground">排行按净重倒序（默认）；点姓名进入该售粮人履历，可核对历次皮重是否稳定。</span>}
      />
    </div>
  );
}

/* -------------------------------------------------- 作业量与异常统计 */

function StaffLoadReport() {
  const [from, setFrom] = useState(shiftDay(todayISO(), -13));
  const [to, setTo] = useState(todayISO());
  const exportGuard = useExportGuard();

  const { data = [] } = useQuery({ queryKey: ["report", "staff", from, to], queryFn: () => api.reportStaff(from, to) });

  const columns = useMemo<Column<StaffLoadRow>[]>(
    () => [
      { key: "name", header: "员工", cell: (r) => <span className="font-medium">{r.name}</span>, sortValue: (r) => r.name },
      { key: "role", header: "岗位", cell: (r) => <span className="text-xs text-muted-foreground">{ROLE[r.role]}</span> },
      { key: "orders", header: "经手单数", align: "right", cell: (r) => <Num>{r.orders}</Num>, sortValue: (r) => r.orders, footer: (rows) => <Num>{rows.reduce((n, x) => n + x.orders, 0)}</Num> },
      {
        key: "manual",
        header: "手录次数",
        align: "right",
        cell: (r) => <Num tone={r.manual_count > 0 ? "warning" : undefined}>{r.manual_count}</Num>,
        sortValue: (r) => r.manual_count,
        footer: (rows) => <Num>{rows.reduce((n, x) => n + x.manual_count, 0)}</Num>,
      },
      {
        key: "ratio",
        header: "手录占比",
        align: "right",
        cell: (r) => {
          const tone = toneOfRatio(r.manual_ratio);
          return (
            <span className="flex items-center justify-end gap-2">
              <span className="w-12 text-right">
                <Num tone={tone}>{ratioText(r.manual_ratio, 1)}</Num>
              </span>
              <span className="w-16">
                <RatioBar value={r.manual_ratio} tone={tone ?? "success"} />
              </span>
            </span>
          );
        },
        sortValue: (r) => r.manual_ratio,
        // 合计行用全局重算（总手录 / 总单数），而不是把各人占比加起来除人数
        footer: (rows) => {
          const o = rows.reduce((n, x) => n + x.orders, 0);
          const m = rows.reduce((n, x) => n + x.manual_count, 0);
          return <Num tone={toneOfRatio(o ? m / o : 0)}>{o ? ratioText(m / o, 1) : "—"}</Num>;
        },
      },
      {
        key: "void",
        header: "作废",
        align: "right",
        cell: (r) => <Num tone={r.void_count > 0 ? "danger" : undefined}>{r.void_count}</Num>,
        sortValue: (r) => r.void_count,
        footer: (rows) => <Num>{rows.reduce((n, x) => n + x.void_count, 0)}</Num>,
      },
      {
        key: "override",
        header: "皮重授权",
        align: "right",
        cell: (r) => <Num tone={r.override_count > 0 ? "warning" : undefined}>{r.override_count}</Num>,
        sortValue: (r) => r.override_count,
        footer: (rows) => <Num>{rows.reduce((n, x) => n + x.override_count, 0)}</Num>,
      },
      {
        key: "reprint",
        header: "补打",
        align: "right",
        cell: (r) => <Num tone={r.reprint_count > 2 ? "warning" : undefined}>{r.reprint_count}</Num>,
        sortValue: (r) => r.reprint_count,
        footer: (rows) => <Num>{rows.reduce((n, x) => n + x.reprint_count, 0)}</Num>,
      },
    ],
    [],
  );

  function doExport() {
    exportGuard(
      ["员工", "岗位", "经手单数", "手录次数", "手录占比%", "作废", "皮重授权", "补打"],
      data.map((r) => [r.name, ROLE[r.role], r.orders, r.manual_count, Math.round(r.manual_ratio * 1000) / 10, r.void_count, r.override_count, r.reprint_count]),
      `作业量与异常_${from}_${to}`,
    );
  }

  useHotkey("ctrl+e", doExport, { allowInInput: true });

  const totalOrders = data.reduce((n, r) => n + r.orders, 0);
  const totalManual = data.reduce((n, r) => n + r.manual_count, 0);
  const worst = data.reduce<StaffLoadRow | null>((acc, r) => (!acc || r.manual_ratio > acc.manual_ratio ? r : acc), null);

  return (
    <div className="flex flex-col gap-3">
      <RangeBar
        from={from}
        to={to}
        onChange={(f, t) => {
          setFrom(f);
          setTo(t);
        }}
        extra={
          <div className="ml-auto flex gap-2 pb-0.5">
            <Button size="sm" variant="outline" onClick={printReport} disabled={data.length === 0}>
              <PrinterIcon />
              打印
            </Button>
            <Button size="sm" variant="outline" onClick={doExport} disabled={data.length === 0}>
              <DownloadIcon />
              导出（Ctrl+E）
            </Button>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="期间经手单数" value={String(totalOrders)} unit="单" hint={`${data.length} 人参与作业`} />
        <StatCard
          label="手录总量"
          value={String(totalManual)}
          unit="次"
          tone={totalManual > 0 ? "warning" : "success"}
          hint={totalManual > 0 ? "地磅正常时手录必须逐单说明原因" : "全部来自地磅读数"}
        />
        <StatCard
          label="手录占比最高"
          value={worst && worst.manual_ratio > 0 ? ratioText(worst.manual_ratio, 1) : "—"}
          hint={worst ? `${worst.name}（${ROLE[worst.role]}），共 ${worst.orders} 单` : "暂无数据"}
          tone={worst && worst.manual_ratio > 0.2 ? "danger" : "neutral"}
        />
      </div>

      <CallOut tone="info" title="这些数字不是考核，是异常线索">
        手录、皮重授权、补打、作废都属于"正常但需要能被解释"的动作。站长要看的是趋势与离群值，
        某个人某一周突然翻倍，通常意味着磅坏了或者有人在硬凑数据，应当去查那几天的具体单（
        <Link to="/orders" className="underline">
          磅单中心
        </Link>
        可按"称重来源=手录"筛选）。
      </CallOut>

      <DataTable
        columns={columns}
        rows={data}
        rowKey={(r) => r.user_id}
        empty={<EmptyState title="该期间没有作业记录" description="换一段日期试试。" />}
        toolbar={<span className="text-xs text-muted-foreground">经手单数按“磅员或登记员”归属统计，同一单两人各计一次，所以合计行会大于实际单数（看板上的“今日单量”才是去重后的值）。</span>}
      />
    </div>
  );
}
