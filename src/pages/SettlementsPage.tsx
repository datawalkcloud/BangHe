/**
 * 结算台账（05 §3 `/settlements`）。
 *
 * 结算单是"一张付款凭据对应若干磅单"的载体，也是挂账的落点：
 * 当场付清的单在这里立刻是 paid，挂账的单在这里停着等出纳核销。
 *
 * 顶部把「待结算池」单独列出，因为 to_settle 状态的磅单如果当天不清，
 * 第二天就变成了"粮已经进仓、钱还没算"的悬空数，是站长最该看见的东西。
 */
import { useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CircleDollarSignIcon, WalletIcon } from "lucide-react";
import { api } from "@/lib/api";
import type { Settlement } from "@/mock/types";
import { PAYMENT_METHOD, PAYMENT_STATUS } from "@/lib/constants";
import { dateTime, money, rmbUpper, weight } from "@/lib/format";
import { useSetting, useStaffNames } from "@/hooks/useLookups";
import { ALL, Choose } from "@/components/business/Choose";
import { DataTable, type Column } from "@/components/business/DataTable";
import { PaymentStatusBadge, ToneBadge } from "@/components/business/badges";
import { CallOut, EmptyState, PageHeader } from "@/components/business/layout";
import { StatCard } from "@/components/business/StatCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** 结算单的付款状态不含 not_required，所以这里不用 PaymentStatus 全集 */
type SettlePayStatus = "unpaid" | "partial" | "paid";

export function SettlementsPage() {
  const navigate = useNavigate();
  const names = useStaffNames();
  const allowCredit = useSetting("settlement_allow_part_pay").bool;

  const [status, setStatus] = useState<SettlePayStatus | "all">("all");
  const [kw, setKw] = useState("");
  const [applied, setApplied] = useState("");

  const { data: rows = [], isPending } = useQuery({
    queryKey: ["settlements", status, applied],
    queryFn: () => api.listSettlements({ paymentStatus: status === "all" ? undefined : status, keyword: applied }),
  });
  const { data: pool = [] } = useQuery({
    queryKey: ["pending-settlements"],
    queryFn: () => api.pendingSettlements(),
    refetchInterval: 30_000,
  });
  const { data: credits = [] } = useQuery({ queryKey: ["credits"], queryFn: () => api.credits() });

  const totals = useMemo(() => {
    // 列表合计走服务端同源数据：这里 rows 已是筛选后的全集（mock 一次返回不分页）
    const statable = (s: Settlement) => s.status === "normal";
    const list = rows.filter(statable);
    return {
      payable: list.reduce((n, s) => n + s.payable_fen, 0),
      paid: list.reduce((n, s) => n + s.paid_fen, 0),
      unpaid: list.reduce((n, s) => n + (s.payable_fen - s.paid_fen), 0),
      settle_01kg: list.reduce((n, s) => n + s.total_settle_01kg, 0),
      orders: list.reduce((n, s) => n + s.order_count, 0),
    };
  }, [rows]);

  const overdue = credits.filter((c) => c.overdue_days > 0);
  const poolOrders = pool.reduce((n, g) => n + g.rows.length, 0);
  const poolFen = pool.reduce(
    (n, g) => n + g.rows.reduce((m, o) => m + (o.payable_amount_fen ?? 0), 0),
    0,
  );

  const columns = useMemo<Column<Settlement>[]>(
    () => [
      {
        key: "settle_no",
        header: "结算单号",
        cell: (s) => <span className="tnum font-medium">{s.settle_no}</span>,
        sortValue: (s) => s.settle_no,
      },
      { key: "party", header: "售粮人", cell: (s) => s.payee_name, sortValue: (s) => s.payee_name },
      {
        key: "period",
        header: "覆盖期间",
        cell: (s) => (
          <span className="tnum text-xs">
            {s.period_from} ~ {s.period_to}
          </span>
        ),
      },
      { key: "count", header: "磅单数", align: "right", cell: (s) => <span className="tnum">{s.order_count}</span>, sortValue: (s) => s.order_count },
      {
        key: "settle",
        header: "结算重量",
        align: "right",
        cell: (s) => <span className="tnum">{weight(s.total_settle_01kg)}</span>,
        sortValue: (s) => s.total_settle_01kg,
        footer: (list) => <span className="tnum">{weight(list.reduce((n, s) => n + s.total_settle_01kg, 0))}</span>,
      },
      {
        key: "goods",
        header: "货款",
        align: "right",
        cell: (s) => <span className="tnum">{money(s.total_goods_fen)}</span>,
        footer: (list) => <span className="tnum">{money(list.reduce((n, s) => n + s.total_goods_fen, 0))}</span>,
      },
      {
        key: "payable",
        header: "应付",
        align: "right",
        cell: (s) => <span className="tnum font-medium">{money(s.payable_fen)}</span>,
        sortValue: (s) => s.payable_fen,
        footer: () => <span className="tnum">{money(totals.payable)}</span>,
      },
      {
        key: "paid",
        header: "已付",
        align: "right",
        cell: (s) => <span className="tnum">{money(s.paid_fen)}</span>,
        footer: () => <span className="tnum">{money(totals.paid)}</span>,
      },
      {
        key: "unpaid",
        header: "未付",
        align: "right",
        cell: (s) => {
          const v = s.payable_fen - s.paid_fen;
          return <span className={cnNumber(v)}>{v > 0 ? money(v) : "—"}</span>;
        },
        sortValue: (s) => s.payable_fen - s.paid_fen,
        footer: () => <span className="tnum">{money(totals.unpaid)}</span>,
      },
      { key: "method", header: "付款方式", cell: (s) => (s.main_method ? PAYMENT_METHOD[s.main_method] : "—") },
      { key: "status", header: "付款状态", cell: (s) => <PaymentStatusBadge status={s.payment_status} />, sortValue: (s) => s.payment_status },
      {
        key: "signed",
        header: "签收",
        cell: (s) =>
          s.signed_by_party === 1 ? (
            <span className="text-xs">售粮人已签</span>
          ) : (
            <ToneBadge tone="warning">未签收</ToneBadge>
          ),
      },
      { key: "settler", header: "结算人", cell: (s) => <span className="text-xs">{names(s.settler_id)}</span> },
      { key: "at", header: "结算时间", cell: (s) => <span className="tnum text-xs">{dateTime(s.settled_at)}</span>, sortValue: (s) => s.settled_at },
    ],
    [names, totals],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="结算台账"
        description={`共 ${rows.length} 张结算单 · 应付 ${money(totals.payable)} · 未付 ${money(totals.unpaid)}`}
        actions={
          <>
            <Button size="sm" variant="outline" render={<Link to="/payments" />}>
              <WalletIcon />
              付款与挂账
            </Button>
            <Button size="sm" render={<Link to="/workstation" />}>
              <CircleDollarSignIcon />
              去工作台结算
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="筛选后应付合计" value={money(totals.payable, false)} unit="元" hint={rmbUpper(totals.payable)} />
            <StatCard label="已付合计" value={money(totals.paid, false)} unit="元" tone="success" />
            <StatCard
              label="未付合计"
              value={money(totals.unpaid, false)}
              unit="元"
              tone={totals.unpaid > 0 ? "warning" : "success"}
              hint={allowCredit ? "站点允许挂账" : "站点已关闭挂账"}
            />
            <StatCard label="覆盖磅单" value={String(totals.orders)} unit="张" hint={`结算重量 ${weight(totals.settle_01kg)}`} />
          </div>

          {overdue.length > 0 && (
            <CallOut tone="danger" title={`${overdue.length} 张结算单已逾期未付`}>
              最长逾期 {overdue[0].overdue_days} 天（{overdue[0].settlement.payee_name}，未付 {money(overdue[0].unpaid_fen)}）。
              逾期口径来自站点参数「付款期限天数」，请到付款挂账页逐笔核销。
              <Link to="/payments" className="ml-1 underline underline-offset-2">
                前往处理
              </Link>
            </CallOut>
          )}

          {poolOrders > 0 && (
            <CallOut
              tone="warning"
              title={`待结算池里还压着 ${poolOrders} 张磅单（约 ${money(poolFen)}）`}
              action={
                <Button size="xs" variant="outline" onClick={() => void navigate({ to: "/workstation" })}>
                  去结算
                </Button>
              }
            >
              {pool
                .slice(0, 4)
                .map((g) => `${g.party.name} ${g.rows.length} 张`)
                .join("、")
                .concat(pool.length > 4 ? ` 等 ${pool.length} 人` : "")}
              。粮已进仓、钱未算清，当天必须结完，否则日对账不平。
            </CallOut>
          )}

          <div className="flex flex-wrap items-end gap-2 border bg-muted/20 p-2.5">
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              付款状态
              <Choose
                aria-label="付款状态"
                className="w-32"
                value={status === "all" ? ALL : status}
                onChange={(v) => setStatus(v === ALL ? "all" : (v as SettlePayStatus))}
                options={[
                  { value: ALL, label: "全部" },
                  ...(Object.keys(PAYMENT_STATUS) as SettlePayStatus[]).map((k) => ({ value: k, label: PAYMENT_STATUS[k].label })),
                ]}
              />
            </Label>
            <Label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
              关键字
              <Input
                value={kw}
                onChange={(e) => setKw(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setApplied(kw);
                }}
                placeholder="结算单号 / 售粮人，回车查询"
                className="h-8 text-sm"
              />
            </Label>
            <Button size="sm" onClick={() => setApplied(kw)}>
              查询
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setKw("");
                setApplied("");
                setStatus("all");
              }}
            >
              重置
            </Button>
          </div>

          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(s) => s.settle_no}
            loading={isPending}
            rowHref={(s) => `/settlements/${s.settle_no}`}
            onRowClick={(s) => void navigate({ to: "/settlements/$settleNo", params: { settleNo: s.settle_no } })}
            rowClassName={(s) => (s.status === "revoked" ? "text-muted-foreground line-through decoration-1" : undefined)}
            empty={
              <EmptyState
                title="没有符合条件的结算单"
                description="结算单在工作台按 F10 完成计价后生成；挂账的会停在未付款状态。"
              />
            }
            toolbar={
              <span className="text-xs text-muted-foreground">
                合计行来自当前筛选的全集，不是本页 50 条之和；撤销的结算单保留划线记录，不物理删除。
              </span>
            }
          />
        </div>
      </div>
    </div>
  );
}

function cnNumber(v: number): string {
  return v > 0 ? "tnum font-medium text-warning" : "tnum text-muted-foreground";
}
