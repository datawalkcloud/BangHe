/**
 * 出库单详情（05 §3 `/outbound/$no`）。
 *
 * 与磅单详情同一个存在理由：迎检与纠纷。所以不做美化，把
 * **谁在什么时间以什么来源留下了什么数字** 完整摊开：
 *   基本信息 → 超库存警示 → 这张单在库存账上留下的流水 → 单据时间轴
 *
 * 页面上三处写操作：改草稿、完成出库、作废 / 红冲。状态机判据只在 Rust 一份，
 * 这里按 `status` 决定哪些按钮可用，被拦下时原样显示服务端那句中文原因。
 *
 * 库存流水那一栏刻意显示带符号的变动量并保留被红冲的原始出库行——
 * 「账本不涂改」这件事必须在界面上看得见，否则下一个来查账的人会以为红冲删了记录。
 */
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, ArrowLeftIcon, PrinterIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { OUTBOUND_KIND, OUTBOUND_STATUS } from "@/lib/constants";
import { dateTime, money, orDash, price, ton, weight } from "@/lib/format";
import { useStaffNames, useStation } from "@/hooks/useLookups";
import { actorId, useSession } from "@/store/session";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { DocTimeline } from "@/components/business/DocTimeline";
import { CallOut, InfoGrid, PageHeader } from "@/components/business/layout";
import { PaymentStatusBadge, ToneBadge, WeightSourceBadge } from "@/components/business/badges";
import { OutboundFormDialog } from "@/components/outbound/OutboundFormDialog";
import { OutboundWeighPanel } from "@/components/outbound/OutboundWeighPanel";
import { CloseOutboundDialog } from "@/components/outbound/CloseOutboundDialog";
import { useSilentReceiptPrint } from "@/components/print/receipt/useSilentPrint";
import { cn } from "cn";
import type { StockMovementRow, TimelineEvent } from "@/mock/types";

const MOVE_COLUMNS: Column<StockMovementRow>[] = [
  { key: "at", header: "记账时间", cell: (r) => <span className="tnum text-xs">{dateTime(r.operated_at)}</span> },
  {
    key: "kind",
    header: "方向",
    cell: (r) => (
      <span className={cn("font-medium", r.kind === "in" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
        {r.kind === "in" ? (r.reversal_of_id ? "红冲回仓" : "入仓") : "出仓"}
      </span>
    ),
  },
  { key: "wh", header: "仓房", cell: (r) => orDash(r.warehouse_name) },
  {
    key: "qty",
    header: "变动量",
    align: "right",
    cell: (r) => (
      <span className={cn("tnum", r.signed_01kg < 0 && "text-destructive")}>
        {r.signed_01kg > 0 ? "+" : ""}
        {ton(r.signed_01kg)}
      </span>
    ),
  },
  { key: "amount", header: "金额", align: "right", cell: (r) => <span className="tnum">{r.amount_fen == null ? "—" : money(r.amount_fen)}</span> },
  { key: "operator", header: "经办", cell: (r) => orDash(r.operator_name) },
  { key: "remark", header: "备注", cell: (r) => <span className="text-xs text-muted-foreground">{orDash(r.remark)}</span> },
];

export function OutboundDetailPage() {
  const { no } = useParams({ from: "/outbound/$no" });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useSession((s) => s.can);
  const [editOpen, setEditOpen] = useState(false);
  const [closeMode, setCloseMode] = useState<"void" | "reverse" | null>(null);
  const { data: station } = useStation();
  const names = useStaffNames();
  /**
   * 出库码单走与磅单同一条打印路（无预览直打 → 失败才弹预览框，出纸口由设备中心台账定，
   * 06 §2.2）。刷新键传 `["outbound"]`：`prints` 挂在这张单的详情查询上，
   * 用 hook 的缺省值（磅单那条）打完「已打 N 张」不会动，下一次还当首打。
   */
  const { print: printReceipt, preview: printFallback } = useSilentReceiptPrint();

  const query = useQuery({ queryKey: ["outbound", no], queryFn: () => api.getOutbound(no) });
  const doc = query.data ?? null;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["outbound"] });
    qc.invalidateQueries({ queryKey: ["stock-balance"] });
    qc.invalidateQueries({ queryKey: ["stock-movements"] });
  };

  const complete = useMutation({
    mutationFn: () => api.completeOutbound({ order_no: no, operator_id: actorId() }),
    onSuccess: (row) => {
      if (row.stock_warning) toast.warning(row.stock_warning, { duration: 9000 });
      else toast.success(`已出库，库存扣减 ${ton(row.net_weight_01kg)}`);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /**
   * 已打几张只看 `print_log` 里真出过纸的那几条（`result === 'success'`），与磅单同一口径：
   * 「框开合过」不等于「纸上印过」，靠前者判断会让取消预览的那次也算成一张。
   */
  const printed = (doc?.prints ?? []).filter((p) => p.result === "success").length;

  const printTicket = () => {
    if (!doc || !station) return;
    void printReceipt({
      scenario: "outbound_order",
      docNo: doc.order_no,
      isReprint: printed > 0,
      context: { station, names, outbound: doc },
      invalidate: ["outbound"],
    });
  };

  /**
   * 时间轴的节点全部来自单据自身与它的库存流水（两者都是真库里的行），
   * 不从前端的操作记录里拼——刷新一次就丢的东西不能当凭据。
   * 作废没有专门的时间列，取 `updated_at`（作废必然写这一列）。
   */
  const events = useMemo<TimelineEvent[]>(() => {
    if (!doc) return [];
    const out: TimelineEvent[] = [
      { at: doc.created_at, action: "outbound.create", label: "制单", actor: doc.created_name, tone: "neutral" },
    ];
    if (doc.status === "done" || doc.status === "reversed") {
      out.push({
        at: doc.completed_at ?? doc.updated_at ?? doc.created_at,
        action: "outbound.complete",
        label: "完成出库",
        actor: doc.completed_name ?? "—",
        tone: "success",
        detail: `扣减 ${ton(doc.net_weight_01kg)}${doc.goods_amount_fen != null ? ` · 货款 ${money(doc.goods_amount_fen)}` : ""}`,
      });
    }
    if (doc.status === "voided") {
      out.push({
        at: doc.updated_at ?? doc.created_at,
        action: "outbound.void",
        label: "作废",
        actor: "—",
        tone: "danger",
        detail: doc.void_reason ?? undefined,
      });
    }
    for (const m of doc.movements.filter((x) => x.reversal_of_id != null)) {
      out.push({
        at: m.operated_at,
        action: "outbound.reverse",
        label: "红冲回仓",
        actor: m.operator_name,
        tone: "warning",
        detail: `补一条对称入库 ${ton(m.weight_01kg)}，原出库流水保留`,
      });
    }
    if (doc.stock_warning) {
      out.push({
        at: doc.completed_at ?? doc.updated_at ?? doc.created_at,
        action: "outbound.stock_warning",
        label: "超库存警示",
        actor: "系统复算",
        tone: "warning",
        detail: doc.stock_warning,
      });
    }
    // 每一次出纸都上时间轴（0030）：纸上有没有「补打」角标、谁在什么时候又打了一张，
    // 是纠纷与迎检要回答的两件事，只藏在按钮那句「已打 N 张」里等于看得见数、看不见来路。
    for (const p of doc.prints) {
      out.push({
        at: p.printed_at,
        action: p.is_reprint ? "reprint" : "print",
        label: p.is_reprint ? "补打码单" : "打印码单",
        actor: names(p.operator_id),
        tone: p.result === "success" ? "neutral" : "danger",
        detail: `${p.printer_name} · ${p.paper} · ${p.result === "success" ? "已出纸" : `失败：${p.error_msg ?? "原因未记"}`}`,
      });
    }
    return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    // `names` 每次渲染都是新闭包（`useStaffNames` 现算一张 id→姓名表），带上它等于这条 memo
    // 每轮都重算——数组只有几个节点，不心疼；漏了它才是真错：打印记录上会留着一串经办人编号。
  }, [doc, names]);

  if (query.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
        <p className="text-sm">出库单 {no} 不存在</p>
        <Button size="sm" variant="outline" onClick={() => navigate({ to: "/outbound" })}>
          返回出库单中心
        </Button>
      </div>
    );
  }

  const draft = doc.status === "draft";
  const closed = doc.status === "voided" || doc.status === "reversed";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            出库单 {doc.order_no}
            <ToneBadge tone={OUTBOUND_STATUS[doc.status].tone}>{OUTBOUND_STATUS[doc.status].label}</ToneBadge>
          </span>
        }
        description={`${OUTBOUND_KIND[doc.kind].label} · ${doc.business_date} · ${orDash(doc.party_name ?? doc.counterparty_label)} · ${orDash(doc.variety_name)}`}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => navigate({ to: "/outbound" })}>
              <ArrowLeftIcon />
              返回列表
            </Button>
            {/*
              打印码单。岗位闸与磅单详情同一条（`print`），不另设新权；首打与补打是同一个按钮，
              差别只写进 `isReprint`（票面补打角标由它决定）。
              没有净重就打不出有意义的票，所以那格空着时禁用并说明原因（05 §5「禁用必须带文字」）。
            */}
            <Button
              size="sm"
              variant="outline"
              disabled={!can("print") || !station || doc.net_weight_01kg == null}
              title={
                !can("print")
                  ? "当前岗位无打印权限"
                  : doc.net_weight_01kg == null
                    ? "本单还没有出库净重，票面印出来是一张空单；请先称重或改单填净重"
                    : printed > 0
                      ? `已打 ${printed} 张，本次将带「补打」角标`
                      : undefined
              }
              onClick={printTicket}
            >
              <PrinterIcon />
              {printed > 0 ? `补打码单（已打 ${printed} 张）` : "打印码单"}
            </Button>
            {draft ? (
              <>
                <Button size="sm" variant="outline" disabled={!can("outbound.create")} onClick={() => setEditOpen(true)}>
                  修改
                </Button>
                <Button size="sm" disabled={!can("outbound.create") || complete.isPending} onClick={() => complete.mutate()}>
                  {complete.isPending ? "过账中…" : "完成出库"}
                </Button>
                <Button size="sm" variant="outline" disabled={!can("outbound.void")} onClick={() => setCloseMode("void")}>
                  作废
                </Button>
              </>
            ) : null}
            {doc.status === "done" ? (
              <Button size="sm" variant="destructive" disabled={!can("outbound.reverse")} onClick={() => setCloseMode("reverse")}>
                红冲
              </Button>
            ) : null}
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-col gap-4">
          {doc.stock_warning ? (
            <CallOut tone="warning" title="本单出库时账面结存不够" icon={<AlertTriangleIcon className="size-4" />}>
              {doc.stock_warning}
              <span className="mt-1 block text-xs text-muted-foreground">
                出库已照常放行（现场先出粮、后补单是常态，拦下来只会逼人改数字）。这句话由服务端复算写入单据，票面与审计同步留痕。
              </span>
            </CallOut>
          ) : null}
          {closed ? (
            <CallOut tone={doc.status === "voided" ? "danger" : "warning"} title={`本单已${OUTBOUND_STATUS[doc.status].label}`}>
              {orDash(doc.void_reason)}
            </CallOut>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">单据信息</CardTitle>
            </CardHeader>
            <CardContent>
              <InfoGrid
                cols={4}
                items={[
                  { label: "出库性质", value: OUTBOUND_KIND[doc.kind].label },
                  { label: "业务日期", value: <span className="tnum">{doc.business_date}</span> },
                  { label: "领出方", value: orDash(doc.party_name ?? doc.counterparty_label) },
                  { label: "车牌", value: <span className="tnum">{orDash(doc.vehicle_no)}</span> },
                  { label: "品种", value: orDash(doc.variety_name) },
                  { label: "等级", value: orDash(doc.grade) },
                  { label: "出仓仓房 / 货位", value: orDash(doc.slot_label ? `${doc.warehouse_name} / ${doc.slot_label}` : doc.warehouse_name) },
                  { label: "重量来源", value: <WeightSourceBadge source={doc.weight_source} /> },
                  {
                    label: "毛重",
                    value: <span className="tnum">{doc.gross_weight_01kg == null ? "—" : weight(doc.gross_weight_01kg)}</span>,
                  },
                  {
                    label: "皮重",
                    value: <span className="tnum">{doc.tare_weight_01kg == null ? "—" : weight(doc.tare_weight_01kg)}</span>,
                  },
                  { label: "出库净重", value: <span className="tnum font-medium">{doc.net_weight_01kg == null ? "—" : weight(doc.net_weight_01kg)}</span> },
                  { label: "单价", value: <span className="tnum">{price(doc.price_fen_per_ton)}</span> },
                  { label: "货款", value: <span className="tnum font-medium">{doc.goods_amount_fen == null ? "—" : money(doc.goods_amount_fen)}</span> },
                  { label: "付款状态", value: <PaymentStatusBadge status={doc.payment_status} /> },
                  { label: "制单", value: `${doc.created_name} · ${dateTime(doc.created_at)}`, span: 2 },
                  { label: "完成出库", value: doc.completed_at ? `${doc.completed_name ?? "—"} · ${dateTime(doc.completed_at)}` : "—", span: 2 },
                  { label: "备注", value: orDash(doc.remark), span: 4 },
                ]}
              />
            </CardContent>
          </Card>

          {/*
            地磅称重：这一页的三处写操作之外的第四处（改草稿 / 称重 / 完成出库 / 作废红冲）。
            常驻而不是只在草稿态出现——已过账的单照样要看得到毛皮两个采用值与复称轨迹，
            「谁在什么时间以什么来源留下了什么数字」这句话对本页的每一种状态都成立。
          */}
          <OutboundWeighPanel order={doc} />

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">库存账流水</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={MOVE_COLUMNS}
                rows={doc.movements}
                rowKey={(r) => `${r.kind}-${r.id}`}
                dense
                empty={
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    {draft ? "草稿还没过账，库存账上暂时不留记录。" : "本单没有对应的库存流水，请让站长核查数据。"}
                  </p>
                }
              />
              <p className="mt-2 text-xs text-muted-foreground">
                本栏就是结存的来源：出库写一条「出仓」，红冲另补一条「红冲回仓」，
                <b>被冲掉的那条出仓记录按账本规矩保留、不涂改</b>。想核对整个仓房的账，去
                <Link to="/stock" className="mx-1 underline underline-offset-2">库存账</Link>
                按仓房与品种下钻。
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">操作时间轴</CardTitle>
            </CardHeader>
            <CardContent>
              <DocTimeline events={events} />
            </CardContent>
          </Card>
        </div>
      </div>

      <OutboundFormDialog open={editOpen} onOpenChange={setEditOpen} editing={doc} />
      {printFallback}
      <CloseOutboundDialog
        open={closeMode != null}
        onOpenChange={(v) => {
          if (!v) setCloseMode(null);
        }}
        order={doc}
        mode={closeMode ?? "void"}
      />
    </div>
  );
}
