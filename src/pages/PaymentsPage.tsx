/**
 * 付款与挂账（05 §3 `/payments`）。
 *
 * 出纳每天两件事：把今天的付款流水核对一遍，以及把挂账催回来。
 * 所以这页把「流水」和「挂账」并排，而不是一层一层的标签页。
 *
 * 挂账逾期口径来自站点参数 payment_due_warn_hours（analytics 里同样用它算 due_date），
 * 界面不自己减天数，避免与报表口径不一致（02 §F5.4）。
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DownloadIcon, PrinterIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { PaymentRecord } from "@/mock/types";
import { PAYMENT_METHOD, TONE_DOT } from "@/lib/constants";
import { dateTime, money, orDash, shiftDay, todayISO } from "@/lib/format";
import { csvName, downloadCsv } from "@/lib/csv";
import { useSetting, useStaffNames, useStation } from "@/hooks/useLookups";
import { useSilentReceiptPrint } from "@/components/print/receipt/useSilentPrint";
import { useHotkey } from "@/hooks/useHotkey";
import { useSession } from "@/store/session";
import { BarList, StatCard } from "@/components/business/StatCard";
import { DataTable, type Column } from "@/components/business/DataTable";
import { ToneBadge } from "@/components/business/badges";
import { CallOut, EmptyState, PageHeader } from "@/components/business/layout";
import { QuickDetailLink } from "@/components/business/QuickDetailSheet";
import { Button } from "@/components/ui/button";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Label } from "@/components/ui/label";
import { cn } from "cn";

export function PaymentsPage() {
  const names = useStaffNames();
  const { data: station } = useStation();
  /** 出票走与磅房工作台同一条路：无预览直打 → 失败才回退预览框，出纸口由设备中心台账决定 */
  const { print: printReceipt, preview: printFallback } = useSilentReceiptPrint();
  const can = useSession((s) => s.can);
  /** 库里存小时（72 = 3 天），页面与 analytics 的 due_date 都按天算，除一次就够 */
  const dueDays = useSetting("payment_due_warn_hours").num / 24;
  const allowCredit = useSetting("settlement_allow_part_pay").bool;

  const [from, setFrom] = useState(shiftDay(todayISO(), -13));
  const [to, setTo] = useState(todayISO());

  const { data: payments = [], isPending } = useQuery({
    queryKey: ["payments", from, to],
    queryFn: () => api.listPayments(from, to),
  });
  const { data: credits = [] } = useQuery({ queryKey: ["credits"], queryFn: () => api.credits() });
  const { data: dist = [] } = useQuery({
    queryKey: ["payment-method-dist", from, to],
    queryFn: () => api.paymentMethodDist(from, to),
  });

  const totalFen = useMemo(() => payments.filter((p) => p.reversed === 0).reduce((n, p) => n + p.amount_fen, 0), [payments]);
  const reversedFen = useMemo(() => payments.filter((p) => p.reversed === 1).reduce((n, p) => n + p.amount_fen, 0), [payments]);
  const creditTotal = credits.reduce((n, c) => n + c.unpaid_fen, 0);
  const overdueRows = credits.filter((c) => c.overdue_days > 0);

  const columns = useMemo<Column<PaymentRecord>[]>(
    () => [
      { key: "pay_no", header: "付款流水号", cell: (p) => <span className="tnum">{p.pay_no}</span>, sortValue: (p) => p.pay_no },
      { key: "at", header: "付款时间", cell: (p) => <span className="tnum">{dateTime(p.paid_at)}</span>, sortValue: (p) => p.paid_at },
      { key: "party", header: "收款人", cell: (p) => p.party_name, sortValue: (p) => p.party_name },
      {
        key: "amount",
        header: "金额",
        align: "right",
        cell: (p) => (
          <span className={cn(p.reversed === 1 ? "text-muted-foreground line-through" : "text-success")}>
            {money(p.amount_fen)}
          </span>
        ),
        sortValue: (p) => p.amount_fen,
        footer: (list) => <span className="tnum">{money(list.reduce((n, x) => n + (x.reversed === 1 ? 0 : x.amount_fen), 0))}</span>,
      },
      { key: "method", header: "方式", cell: (p) => PAYMENT_METHOD[p.method] },
      {
        key: "ref",
        header: "关联单据",
        cell: (p) =>
          p.settle_no ? (
            <QuickDetailLink type="settlement" id={p.settle_no} className="tnum font-medium text-primary">
              {p.settle_no}
            </QuickDetailLink>
          ) : p.order_no ? (
            <QuickDetailLink type="order" id={p.order_no} className="tnum font-medium text-primary">
              {p.order_no}
            </QuickDetailLink>
          ) : (
            "—"
          ),
      },
      { key: "trade", header: "交易流水", cell: (p) => <span className="tnum text-xs">{orDash(p.trade_no)}</span> },
      { key: "voucher", header: "凭证号", cell: (p) => <span className="tnum text-xs">{orDash(p.voucher_no)}</span> },
      { key: "operator", header: "经手人", cell: (p) => <span className="text-xs">{names(p.operator_id)}</span> },
      {
        key: "reversed",
        header: "状态",
        cell: (p) => (p.reversed === 1 ? <ToneBadge tone="danger">已冲销</ToneBadge> : <span className="text-xs text-muted-foreground">有效</span>),
      },
      {
        key: "print",
        header: "小票",
        cell: (p) => (
          <Button
            size="xs"
            variant="ghost"
            disabled={p.reversed === 1 || !station}
            aria-label="打印付款小票"
            onClick={() => {
              if (!station) return;
              void printReceipt({ scenario: "payment_receipt", docNo: p.pay_no, isReprint: true, context: { station, names, payment: p } });
            }}
          >
            <PrinterIcon />
          </Button>
        ),
      },
    ],
    [names, station, printReceipt],
  );

  function exportCsv() {
    if (payments.length === 0) {
      toast.error("当前期间没有付款流水");
      return;
    }
    const n = downloadCsv(
      csvName(`付款流水_${from}_${to}`),
      ["付款流水号", "付款时间", "收款人", "金额元", "方式", "结算单号", "磅单号", "交易流水", "凭证号", "经手人", "状态"],
      payments.map((p) => [
        p.pay_no,
        dateTime(p.paid_at),
        p.party_name,
        p.amount_fen / 100,
        PAYMENT_METHOD[p.method],
        p.settle_no ?? "",
        p.order_no ?? "",
        p.trade_no ?? "",
        p.voucher_no ?? "",
        names(p.operator_id),
        p.reversed === 1 ? "已冲销" : "有效",
      ]),
    );
    toast.success(`已导出 ${n} 行付款流水`);
  }

  useHotkey("ctrl+e", exportCsv, { allowInInput: true });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="付款与挂账"
        description={`${from} ~ ${to}：${payments.length} 笔流水共 ${money(totalFen)}${reversedFen ? `（另冲销 ${money(reversedFen)}）` : ""} · 未付清 ${credits.length} 张`}
        actions={
          <Button size="sm" variant="outline" onClick={exportCsv} disabled={payments.length === 0 || !can("data.export")}>
            <DownloadIcon />
            导出（Ctrl+E）
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="期间付款额" value={money(totalFen, false)} unit="元" hint={`${payments.length} 笔`} />
            <StatCard
              label="挂账未付"
              value={money(creditTotal, false)}
              unit="元"
              tone={creditTotal > 0 ? "warning" : "success"}
              hint={allowCredit ? `允许挂账，付款期限 ${dueDays} 天` : "已关闭挂账，出现未付即异常"}
            />
            <StatCard
              label="逾期笔数"
              value={String(overdueRows.length)}
              unit="张"
              tone={overdueRows.length > 0 ? "danger" : "success"}
              hint={overdueRows.length > 0 ? `最长逾期 ${overdueRows[0].overdue_days} 天` : "全部在期内"}
            />
            <StatCard
              label="现金占比"
              value={totalFen ? `${Math.round(((dist.find((d) => d.label === PAYMENT_METHOD.cash)?.fen ?? 0) / totalFen) * 100)}%` : "—"}
              hint="现金超三成会被税务与粮检关注"
            />
          </div>

          <div className="grid items-start gap-4 xl:grid-cols-2">
            <section className="border bg-card">
              <header className="border-b px-3 py-2 text-sm font-semibold">
                付款方式分布
                <span className="ml-2 text-xs font-normal text-muted-foreground">按期间内有效流水统计</span>
              </header>
              <div className="p-3">
                {dist.length === 0 ? (
                  <p className="text-sm text-muted-foreground">该期间没有付款记录。</p>
                ) : (
                  <BarList
                    items={dist.map((d) => ({ label: d.label, value: d.fen, colorClass: TONE_DOT[d.tone] }))}
                    formatter={(v) => money(v)}
                  />
                )}
              </div>
            </section>

            <section className="border bg-card">
              <header className="border-b px-3 py-2 text-sm font-semibold">
                挂账台账
                <span className="ml-2 text-xs font-normal text-muted-foreground">按逾期天数倒序，先看最久的</span>
              </header>
              <div className="max-h-72 overflow-y-auto p-3">
                {credits.length === 0 ? (
                  <EmptyState title="没有未付清的结算单" description="今天收的粮都当场结清了。" />
                ) : (
                  <ul className="flex flex-col gap-2">
                    {credits.map((c) => (
                      <li key={c.settlement.settle_no} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <QuickDetailLink
                          type="settlement"
                          id={c.settlement.settle_no}
                          className="tnum font-medium text-primary"
                        >
                          {c.settlement.settle_no}
                        </QuickDetailLink>
                        <span className="text-xs text-muted-foreground">{c.settlement.payee_name}</span>
                        <span className="tnum">{money(c.unpaid_fen)}</span>
                        <span className="tnum text-xs text-muted-foreground">到期 {c.due_date}</span>
                        {c.overdue_days > 0 ? (
                          <ToneBadge tone="danger">逾期 {c.overdue_days} 天</ToneBadge>
                        ) : (
                          <ToneBadge tone="neutral">在期</ToneBadge>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>

          {!allowCredit && creditTotal > 0 && (
            <CallOut tone="danger" title="站点参数已关闭挂账，但仍有未付清的结算单">
              这些单是在关闭挂账之前产生的。要么付款结清，要么把「允许挂账」重新打开，不要让未付清状态长期悬空。
            </CallOut>
          )}

          <div className="flex flex-wrap items-end gap-2 border bg-muted/20 p-2.5">
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              统计期间
              <DateRangePicker value={{ from, to }} onChange={(f, t) => { setFrom(f); setTo(t); }} className="w-64" />
            </Label>
          </div>

          <DataTable
            columns={columns}
            rows={payments}
            rowKey={(p) => p.pay_no}
            loading={isPending}
            rowClassName={(p) => (p.reversed === 1 ? "text-muted-foreground" : undefined)}
            empty={
              <EmptyState
                title="该期间没有付款流水"
                description="换一段日期试试；当场付款的单在结算单详情里登记后，这里立刻出现记录。"
              />
            }
            toolbar={
              <span className="text-xs text-muted-foreground">
                合计行只加有效流水，冲销的单独列出；付款一律挂在结算单上，避免同一个人两笔款对应不清。
              </span>
            }
          />

          {/* 直打失败时的兜底预览框：没发起过出票就是 null，不占 DOM */}
          {printFallback}
        </div>
      </div>
    </div>
  );
}
