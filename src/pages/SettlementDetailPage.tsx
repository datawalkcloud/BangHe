/**
 * 结算单详情（05 §3 `/settlements/$settleNo`）。
 *
 * 出纳的付款动作在这里发生：一张结算单可以分几次付（农户先拿现金、
 * 余下走卡是常态），所以付款表单默认金额 = 未付余额但允许改小，
 * 每次登记都追加一条 payment_record，绝不覆盖已付数（01 §F5.2）。
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, BanknoteIcon, PrinterIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { PaymentMethod } from "@/lib/constants";
import { PAYMENT_METHOD, PAYMENT_STATUS } from "@/lib/constants";
import { dateTime, money, orDash, rmbUpper, weight } from "@/lib/format";
import { useStaffNames, useStation } from "@/hooks/useLookups";
import { actorId, useSession } from "@/store/session";
import { DataTable, type Column } from "@/components/business/DataTable";
import { OrderStatusBadge, PaymentStatusBadge, ToneBadge } from "@/components/business/badges";
import { CallOut, EmptyState, InfoGrid, PageHeader } from "@/components/business/layout";
import { QuickDetailLink } from "@/components/business/QuickDetailSheet";
import { MoneyLine } from "@/components/business/NumField";
import { useSilentReceiptPrint } from "@/components/print/receipt/useSilentPrint";
import { Button } from "@/components/ui/button";
import { Choose } from "@/components/business/Choose";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import type { PaymentRecord } from "@/mock/types";
import { cn } from "cn";

export function SettlementDetailPage() {
  const { settleNo } = useParams({ from: "/settlements/$settleNo" });
  const queryClient = useQueryClient();
  const names = useStaffNames();
  const can = useSession((s) => s.can);
  const { data: station } = useStation();

  const [amountYuan, setAmountYuan] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [tradeNo, setTradeNo] = useState("");
  /** 出票走与磅房工作台同一条路：无预览直打 → 失败才回退预览框，出纸口由设备中心台账决定 */
  const { print: printReceipt, preview: printFallback } = useSilentReceiptPrint();

  const { data, isLoading } = useQuery({
    queryKey: ["settlement", settleNo],
    queryFn: () => api.settlementOf(settleNo),
  });

  const unpaidFen = useMemo(() => {
    if (!data) return 0;
    return Math.max(0, data.settlement.payable_fen - data.settlement.paid_fen);
  }, [data]);

  const pay = useMutation({
    mutationFn: () =>
      api.recordPayment({
        settle_no: settleNo,
        amount_fen: Math.round((Number(amountYuan) || 0) * 100),
        method,
        operator_id: actorId(),
        trade_no: tradeNo.trim() || null,
      }),
    onSuccess: (s) => {
      if (!s) {
        toast.error("登记失败：未找到该结算单");
        return;
      }
      toast.success(`已登记付款 ${money(Math.round((Number(amountYuan) || 0) * 100))}（${PAYMENT_METHOD[method]}）`);
      setAmountYuan("");
      setTradeNo("");
      void queryClient.invalidateQueries({ queryKey: ["settlement", settleNo] });
      void queryClient.invalidateQueries({ queryKey: ["settlements"] });
      void queryClient.invalidateQueries({ queryKey: ["payments"] });
      void queryClient.invalidateQueries({ queryKey: ["credits"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: (e) => toast.error(e instanceof Error && e.message ? e.message : "登记失败，请重试"),
  });

  const amountFen = Math.round((Number(amountYuan) || 0) * 100);
  const payErrors: string[] = [];
  if (amountYuan.trim() === "") payErrors.push("请填写本次付款金额");
  else if (!Number.isFinite(amountFen) || amountFen <= 0) payErrors.push("金额必须是大于 0 的数字");
  else if (amountFen > unpaidFen) payErrors.push(`超出未付余额 ${money(unpaidFen)}`);
  if (method !== "cash" && tradeNo.trim() === "") payErrors.push("非现金付款请填交易流水号，便于对账");

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="结算单" description="加载中…" />
        <div className="grid gap-4 px-6 py-4 xl:grid-cols-2">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="结算单" />
        <EmptyState
          title={`找不到结算单 ${settleNo}`}
          description="单号可能在别的电脑上，或该磅单尚未结算。"
          action={
            <Button size="sm" variant="outline" render={<Link to="/settlements" />}>
              返回结算台账
            </Button>
          }
        />
      </div>
    );
  }

  const { settlement: s, orders, payments } = data;

  const orderCols: Column<(typeof orders)[number]>[] = [
    {
      key: "order_no",
      header: "磅单号",
      cell: (o) => (
        <QuickDetailLink type="order" id={o.order_no} className="tnum font-medium text-primary">
          {o.order_no}
        </QuickDetailLink>
      ),
    },
    { key: "date", header: "业务日期", cell: (o) => <span className="tnum">{o.business_date}</span> },
    { key: "variety", header: "品种/等级", cell: (o) => `${o.variety_name}${o.grade ? ` ${o.grade}` : ""}` },
    { key: "settle", header: "结算重量", align: "right", cell: (o) => <span className="tnum">{weight(o.settlement_weight_01kg)}</span> },
    {
      key: "price",
      header: "单价",
      align: "right",
      cell: (o) => <span className="tnum">{o.price_fen_per_ton == null ? "—" : (o.price_fen_per_ton / 100).toFixed(2)}</span>,
    },
    {
      key: "goods",
      header: "货款",
      align: "right",
      cell: (o) => <span className="tnum">{money(o.goods_amount_fen)}</span>,
      sortValue: (o) => o.goods_amount_fen ?? 0,
      footer: (list) => <span className="tnum">{money(list.reduce((n, o) => n + (o.goods_amount_fen ?? 0), 0))}</span>,
    },
    {
      key: "payable",
      header: "应付",
      align: "right",
      cell: (o) => <span className="tnum">{money(o.payable_amount_fen)}</span>,
      footer: (list) => <span className="tnum">{money(list.reduce((n, o) => n + (o.payable_amount_fen ?? 0), 0))}</span>,
    },
    { key: "status", header: "状态", cell: (o) => <OrderStatusBadge status={o.status} /> },
  ];

  const payCols: Column<PaymentRecord>[] = [
    { key: "pay_no", header: "付款流水号", cell: (p) => <span className="tnum text-xs">{p.pay_no}</span> },
    { key: "at", header: "时间", cell: (p) => <span className="tnum text-xs">{dateTime(p.paid_at)}</span> },
    { key: "amount", header: "金额", align: "right", cell: (p) => <span className="tnum">{money(p.amount_fen)}</span>, sortValue: (p) => p.amount_fen },
    { key: "method", header: "方式", cell: (p) => PAYMENT_METHOD[p.method] },
    { key: "trade", header: "交易流水", cell: (p) => <span className="tnum text-xs">{orDash(p.trade_no)}</span> },
    { key: "voucher", header: "凭证号", cell: (p) => <span className="tnum text-xs">{orDash(p.voucher_no)}</span> },
    { key: "operator", header: "经手", cell: (p) => <span className="text-xs">{names(p.operator_id)}</span> },
    {
      key: "reversed",
      header: "状态",
      cell: (p) => (p.reversed === 1 ? <ToneBadge tone="danger">已冲销</ToneBadge> : <span className="text-xs text-muted-foreground">有效</span>),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="tnum">{s.settle_no}</span>
            <PaymentStatusBadge status={s.payment_status} />
            {s.status === "revoked" && <ToneBadge tone="danger">已撤销</ToneBadge>}
          </span>
        }
        description={`${s.payee_name} · 期间 ${s.period_from} ~ ${s.period_to} · ${s.order_count} 张磅单 · 结算人 ${names(s.settler_id)}`}
        actions={
          <>
            <Button size="sm" variant="outline" render={<Link to="/settlements" />}>
              <ArrowLeftIcon />
              返回台账
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!can("print") || !station}
              onClick={() => {
                if (!station) return;
                void printReceipt({ scenario: "settlement_voucher", docNo: s.settle_no, isReprint: true, context: { station, names, settlement: s } });
              }}
            >
              <PrinterIcon />
              打印凭证
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-col gap-4">
          {s.payment_status !== "paid" && (
            <CallOut tone={PAYMENT_STATUS[s.payment_status].tone} title={`${PAYMENT_STATUS[s.payment_status].label}：尚差 ${money(unpaidFen)}`}>
              {rmbUpper(unpaidFen)}。{s.payment_status === "unpaid" ? "本单尚未付过款。" : "已部分付款，余款按挂账处理。"}
            </CallOut>
          )}

          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              <section className="border bg-card">
                <header className="border-b px-3 py-2 text-sm font-semibold">结算信息</header>
                <div className="p-3">
                  <InfoGrid
                    cols={2}
                    items={[
                      { label: "结算单号", value: <span className="tnum">{s.settle_no}</span> },
                      { label: "业务日期", value: <span className="tnum">{s.business_date}</span> },
                      { label: "收款人", value: s.payee_name },
                      { label: "售粮人编号", value: <span className="tnum">#{s.party_id}</span> },
                      { label: "覆盖期间", value: <span className="tnum">{`${s.period_from} ~ ${s.period_to}`}</span> },
                      { label: "主付款方式", value: s.main_method ? PAYMENT_METHOD[s.main_method] : "—" },
                      { label: "结算重量", value: <span className="tnum">{weight(s.total_settle_01kg)}</span> },
                      { label: "扣重合计", value: <span className="tnum">{weight(s.total_deduct_01kg)}</span> },
                      {
                        label: "售粮人签字",
                        value: s.signed_by_party === 1 ? <ToneBadge tone="success">已签字</ToneBadge> : <ToneBadge tone="warning">未签字</ToneBadge>,
                      },
                      { label: "结算时间", value: <span className="tnum">{dateTime(s.settled_at)}</span> },
                      { label: "备注", value: orDash(s.remark), span: 2 },
                    ]}
                  />
                </div>
              </section>

              <section className="border bg-card">
                <header className="border-b px-3 py-2 text-sm font-semibold">
                  覆盖磅单
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{orders.length} 张，按结算顺序</span>
                </header>
                <DataTable columns={orderCols} rows={orders} rowKey={(o) => o.order_no} dense defaultPageSize={50} />
              </section>

              <section className="border bg-card">
                <header className="border-b px-3 py-2 text-sm font-semibold">
                  付款流水
                  <span className="ml-2 text-xs font-normal text-muted-foreground">允许一笔结算单分次付款，每次追加一条</span>
                </header>
                <DataTable
                  columns={payCols}
                  rows={payments}
                  rowKey={(p) => p.pay_no}
                  dense
                  empty={
                    <EmptyState
                      title="还没有付款记录"
                      description={unpaidFen > 0 ? "本单全额未付，右侧登记第一笔付款。" : "无需付款。"}
                    />
                  }
                />
              </section>
            </div>

            <div className="flex min-w-0 flex-col gap-4">
              <section className="border bg-card">
                <header className="border-b px-3 py-2 text-sm font-semibold">金额汇总</header>
                <div className="flex flex-col gap-1.5 p-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-muted-foreground">净重合计</span>
                    <span className="tnum text-sm">{weight(s.total_net_01kg)}</span>
                  </div>
                  <MoneyLine label="货款金额" valueFen={s.total_goods_fen} />
                  <MoneyLine label="各项扣款" valueFen={-s.total_deduction_fen} />
                  <MoneyLine label="预付款冲抵" valueFen={-s.total_advance_fen} />
                  <MoneyLine label="应付金额" valueFen={s.payable_fen} emphasis hint={rmbUpper(s.payable_fen)} />
                  <MoneyLine label="已付金额" valueFen={s.paid_fen} />
                  <MoneyLine label="未付余额" valueFen={unpaidFen} hint={rmbUpper(unpaidFen)} />
                </div>
              </section>

              <section className={cn("border bg-card", !can("pay.record") && "opacity-70")}>
                <header className="border-b px-3 py-2 text-sm font-semibold">登记付款</header>
                <div className="flex flex-col gap-3 p-3">
                  <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    本次金额（元）
                    <Input
                      value={amountYuan}
                      onChange={(e) => setAmountYuan(e.target.value)}
                      inputMode="decimal"
                      placeholder={unpaidFen ? String(unpaidFen / 100) : "0"}
                      className="tnum text-sm"
                    />
                    {unpaidFen > 0 && (
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto self-start p-0 text-xs font-normal text-info underline underline-offset-2"
                        onClick={() => setAmountYuan(String(unpaidFen / 100))}
                      >
                        填为全部未付 {money(unpaidFen)}
                      </Button>
                    )}
                  </Label>
                  <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    付款方式
                    <Choose
                      aria-label="付款方式"
                      value={method}
                      onChange={(v) => setMethod(v as PaymentMethod)}
                      options={(Object.keys(PAYMENT_METHOD) as PaymentMethod[]).map((k) => ({
                        value: k,
                        label: PAYMENT_METHOD[k],
                        // 挂账核销只由财务流程产生，不在这里手工选
                        disabled: k === "credit_writeoff",
                      }))}
                    />
                  </Label>
                  <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    交易流水号 / 凭证号
                    <Input value={tradeNo} onChange={(e) => setTradeNo(e.target.value)} className="tnum text-sm" placeholder="现金可不填" />
                  </Label>
                  {payErrors.length > 0 && (
                    <ul className="list-disc pl-4 text-xs text-warning">
                      {payErrors.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  )}
                  <Button
                    size="sm"
                    disabled={payErrors.length > 0 || pay.isPending || unpaidFen === 0}
                    onClick={() => pay.mutate()}
                  >
                    <BanknoteIcon />
                    {pay.isPending ? "登记中…" : "确认付款"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {unpaidFen === 0
                      ? "本单已结清，无需再登记。"
                      : "付款后打印的凭证联交给售粮人作为收款依据，存根联财务留存。"}
                  </p>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>

      {/* 直打失败时的兜底预览框：没发起过出票就是 null，不占 DOM */}
      {printFallback}
    </div>
  );
}
