/**
 * 结算单详情（05 §3 `/settlements/$settleNo`）。
 *
 * 出纳的付款动作在这里发生：一张结算单可以分几次付（农户先拿现金、
 * 余下走卡是常态），所以付款表单默认金额 = 未付余额但允许改小，
 * 每次登记都追加一条 payment_record，绝不覆盖已付数（01 §F5.2）。
 *
 * 三条与"这单结清了没有"绑在一起的呈现（2026-09-14）：
 *  - 每次登记付款成功都**自动出一张结算凭证**（无预览直打，失败才回退预览框）——
 *    与磅房工作台同一条 `useSilentReceiptPrint`，出纸口也由同一份设备台账决定；
 *  - **未付余额清零那一刻，「登记付款」卡片整块收起**——留着它只会让人对着
 *    "本单已结清，无需再登记"那行字反复点；
 *  - 结清的单在「结算信息」右下角压一枚大的「全额付清」印记，两米外一眼可辨。
 *
 * 右栏那张登记付款表单不在本页，而在 `components/settlement/PayForm.tsx`：磅房工作台
 * 扫结算凭证（或第③刷命中挂账单）弹的补付框用的是同一份，校验与出票口径不许两边各写一遍。
 */
import { useMemo, type ReactNode } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, PrinterIcon } from "lucide-react";
import { api } from "@/lib/api";
import { PAYMENT_METHOD, PAYMENT_STATUS } from "@/lib/constants";
import { dateTime, money, orDash, priceNumber, rmbUpper, weight, varietyLabel } from "@/lib/format";
import { unpaidFen } from "@/lib/settle-gate";
import { useStaffNames, useStation } from "@/hooks/useLookups";
import { useSession } from "@/store/session";
import { DataTable, type Column } from "@/components/ui/data-table";
import { OrderStatusBadge, PaymentStatusBadge, ToneBadge } from "@/components/business/badges";
import { CallOut, EmptyState, InfoGrid, PageHeader } from "@/components/business/layout";
import { detailColumn } from "@/components/business/quickDetail";
import { MoneyLine } from "@/components/business/NumField";
import { PaidStamp } from "@/components/business/PaidStamp";
import { PayForm } from "@/components/settlement/PayForm";
import { useSilentReceiptPrint } from "@/components/print/receipt/useSilentPrint";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { PaymentRecord } from "@/mock/types";
import { cn } from "cn";

/**
 * 结算单正文（整页与详情抽屉共用）。
 *
 * `embedded` 是给抽屉用的：右上角那枚关闭按钮是 Sheet 自带的，标题条要主动让开；
 * 「返回台账」这种属于整页导航的按钮在抽屉里没有意义，由整页通过 `headerExtra` 传进来。
 */
export function SettlementDetailBody({
  settleNo,
  embedded = false,
  headerExtra,
}: {
  settleNo: string;
  embedded?: boolean;
  headerExtra?: ReactNode;
}) {
  const headerCls = embedded ? "pr-11" : undefined;
  const names = useStaffNames();
  const can = useSession((s) => s.can);
  const { data: station } = useStation();

  /** 出票走与磅房工作台同一条路：无预览直打 → 失败才回退预览框，出纸口由设备中心台账决定 */
  const { print: printReceipt, preview: printFallback } = useSilentReceiptPrint();

  const { data, isLoading } = useQuery({
    queryKey: ["settlement", settleNo],
    queryFn: () => api.settlementOf(settleNo),
  });

  /** 未付余额：口径单源在 `settle-gate.ts::unpaidFen`，与工作台那个补付框读的是同一个数 */
  const unpaid = useMemo(() => (data ? unpaidFen(data.settlement) : 0), [data]);

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="结算单" description="加载中…" className={headerCls} />
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
        <PageHeader title="结算单" className={headerCls} />
        <EmptyState
          title={`找不到结算单 ${settleNo}`}
          description="单号可能在别的电脑上，或该磅单尚未结算。"
          action={
            embedded ? undefined : (
              <Button size="sm" variant="outline" render={<Link to="/settlements" />}>
                返回结算台账
              </Button>
            )
          }
        />
      </div>
    );
  }

  const { settlement: s, orders, payments } = data;

  /** 未付余额清零 = 这一单结清了 */
  const fullyPaid = unpaid === 0;
  /** 撤销的单不盖"全额付清"印子：那枚印子会把"已撤销"这个事实盖住 */
  const showPaidStamp = fullyPaid && s.status === "normal";
  /** 最后一笔付款的时间：`paid_at` 就是 ISO 串，直接比大小取最大，不依赖服务端给的排序 */
  const lastPaidAt = payments.reduce<string | null>((acc, p) => (acc == null || p.paid_at > acc ? p.paid_at : acc), null);

  const orderCols: Column<(typeof orders)[number]>[] = [
    { key: "order_no", header: "磅单号", cell: (o) => <span className="tnum font-medium">{o.order_no}</span> },
    { key: "date", header: "业务日期", cell: (o) => <span className="tnum">{o.business_date}</span> },
    { key: "variety", header: "品种/等级", cell: (o) => `${varietyLabel(o.variety_name)}${o.grade ? ` ${o.grade}` : ""}` },
    { key: "settle", header: "结算重量", align: "right", cell: (o) => <span className="tnum">{weight(o.settlement_weight_01kg)}</span> },
    {
      key: "price",
      header: "单价（元/公斤）",
      align: "right",
      cell: (o) => <span className="tnum">{priceNumber(o.price_fen_per_ton)}</span>,
    },
    {
      key: "goods",
      header: "粮款",
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
    detailColumn("order", (o) => o.order_no),
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
        className={headerCls}
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
            {headerExtra}
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
          {s.status === "revoked" ? (
            /*
              已撤销 = 这张单名下的磅单被作废带走的（02 §F2.3：作废任何状态都行，废一张已结算的
              单同事务撤销它的结算单）。这里绝不能继续照"未付清还差多少钱"念：那笔钱已经不是
              谁欠的了，催下去就是拿一张作废的单向客户要钱。已付的那一截仍然摊开来——
              付款流水不删，钱要追回来得有人看得见它付过。
            */
            <CallOut tone="danger" title="本结算单已撤销">
              {`它名下的磅单已被作废，应付 ${money(s.payable_fen)} 与未付的 ${money(unpaid)} 都不再成立。要重做请另开磅单重新过磅结算。`}
              {s.paid_fen > 0 ? `已付的 ${money(s.paid_fen)} 流水仍可查，要追回走线下。` : ""}
            </CallOut>
          ) : (
            s.payment_status !== "paid" && (
              <CallOut tone={PAYMENT_STATUS[s.payment_status].tone} title={`${PAYMENT_STATUS[s.payment_status].label}：尚差 ${money(unpaid)}`}>
                {rmbUpper(unpaid)}。{s.payment_status === "unpaid" ? "本单尚未付过款。" : "已部分付款，余款按挂账处理。"}
              </CallOut>
            )
          )}

          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              <section className="relative border bg-card">
                <header className="px-3 py-2 text-sm font-semibold">结算信息</header>
                {/* 盖了印子就得给印子腾地方，否则最后一行（备注）会被压住 */}
                <div className={cn("p-3", showPaidStamp && "pb-20")}>
                  <InfoGrid
                    cols={2}
                    items={[
                      { label: "结算单号", value: <span className="tnum">{s.settle_no}</span> },
                      { label: "业务日期", value: <span className="tnum">{s.business_date}</span> },
                      { label: "售粮人", value: s.payee_name },
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
                {showPaidStamp && <PaidStamp label="全额付清" paidFen={s.paid_fen} paidAt={lastPaidAt} />}
              </section>

              <section className="border bg-card">
                <header className="px-3 py-2 text-sm font-semibold">
                  覆盖磅单
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{orders.length} 张，按结算顺序</span>
                </header>
                <DataTable columns={orderCols} rows={orders} rowKey={(o) => o.order_no} dense defaultPageSize={50} />
              </section>

              <section className="border bg-card">
                <header className="px-3 py-2 text-sm font-semibold">
                  付款流水
                  <span className="ml-2 text-xs font-normal text-muted-foreground">可分次付款，每次登记一条</span>
                </header>
                <DataTable
                  columns={payCols}
                  rows={payments}
                  rowKey={(p) => p.pay_no}
                  dense
                  empty={
                    <EmptyState
                      title="还没有付款记录"
                      description={unpaid > 0 ? "本单全额未付，右侧登记第一笔付款。" : "无需付款。"}
                    />
                  }
                />
              </section>
            </div>

            <div className="flex min-w-0 flex-col gap-4">
              <section className="border bg-card">
                <header className="px-3 py-2 text-sm font-semibold">金额汇总</header>
                <div className="flex flex-col gap-1.5 p-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-muted-foreground">净重合计</span>
                    <span className="tnum text-sm">{weight(s.total_net_01kg)}</span>
                  </div>
                  <MoneyLine label="粮款金额" valueFen={s.total_goods_fen} />
                  <MoneyLine label="各项扣款" valueFen={-s.total_deduction_fen} />
                  <MoneyLine label="预付款冲抵" valueFen={-s.total_advance_fen} />
                  <MoneyLine label="应付金额" valueFen={s.payable_fen} emphasis hint={rmbUpper(s.payable_fen)} />
                  <MoneyLine label="已付金额" valueFen={s.paid_fen} />
                  <MoneyLine label="未付余额" valueFen={unpaid} hint={rmbUpper(unpaid)} />
                </div>
              </section>

              {/*
                「登记付款」整块只在**未付余额还有钱**时露出来。结清之后这张卡片唯一能做的事
                就是显示"本单已结清，无需再登记"——留着它让人对着那颗灰按钮反复点，
                收起的理由与结果由「结算信息」右下角那枚「全额付清」印子交代。

                因此块内的"余额为 0"分支全是不可达的，这里一并去掉（不再写 `unpaid === 0`
                那种守着不可能发生的判断），免得后人以为零余额时还会渲染到这里。

                表单本体在 `PayForm`（与磅房工作台那个补付框共用一份）；无权限时整块压暗，
                与改造前一致——提交那一刀由服务端 `payment_add` 的岗位闸门落下。

                已撤销的单同样收起：它的余额是"作废带走的"，不是"还没收的"（02 §F2.3），
                留一张表单在这里就是逼人点一下才听见"本结算单已撤销，不能再登记付款"。
              */}
              {!fullyPaid && s.status !== "revoked" && (
                <section className={cn("border bg-card", !can("pay.record") && "opacity-70")}>
                  <header className="px-3 py-2 text-sm font-semibold">登记付款</header>
                  <div className="p-3">
                    <PayForm settlement={s} />
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 直打失败时的兜底预览框：没发起过出票就是 null，不占 DOM */}
      {printFallback}
    </div>
  );
}

/** 整页路由入口：深链与 Ctrl+点击新窗口仍走这里，正文与详情抽屉共用 */
export function SettlementDetailPage() {
  const { settleNo } = useParams({ from: "/settlements/$settleNo" });
  return (
    <SettlementDetailBody
      settleNo={settleNo}
      headerExtra={
        <Button size="sm" variant="outline" render={<Link to="/settlements" />}>
          <ArrowLeftIcon />
          返回台账
        </Button>
      }
    />
  );
}
