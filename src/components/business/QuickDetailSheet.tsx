import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import {
  AlertTriangleIcon,
  BanknoteIcon,
  FlaskConicalIcon,
  PrinterIcon,
  ShieldAlertIcon,
  UserIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { WeighRecord } from "@/mock/types";
import {
  GRADES,
  INDICATORS,
  ORDER_STATUS,
  PARTY_TYPE,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  TEST_METHOD,
  WEIGHT_SOURCE,
} from "@/lib/constants";
import {
  dateTime,
  maskIdCard,
  money,
  orDash,
  percent,
  price as fmtPrice,
  weight,
} from "@/lib/format";
import { useSetting, useStaffNames, useStation } from "@/hooks/useLookups";
import { actorId, useSession } from "@/store/session";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DataTable, type Column } from "@/components/business/DataTable";
import { Choose } from "@/components/business/Choose";
import { MoneyLine } from "@/components/business/NumField";
import { DocTimeline } from "@/components/business/DocTimeline";
import {
  OrderStatusBadge,
  PaymentStatusBadge,
  QcDecisionBadge,
  ToneBadge,
  WeightSourceBadge,
} from "@/components/business/badges";
import { CallOut, EmptyState, InfoGrid } from "@/components/business/layout";
import { PrintPreview } from "@/components/print/PrintPreview";
import { QcReportSheet, SettlementVoucherSheet, WeighOrderSheet } from "@/components/print/sheets";
import { cn } from "cn";

export type QuickDetailType = "order" | "party" | "qc" | "settlement";

interface QuickDetailTarget {
  type: QuickDetailType;
  id: string;
}

interface QuickDetailStore {
  target: QuickDetailTarget | null;
  open: (type: QuickDetailType, id: string | number) => void;
  close: () => void;
}

export const useQuickDetail = create<QuickDetailStore>((set) => ({
  target: null,
  open: (type, id) => set({ target: { type, id: String(id) } }),
  close: () => set({ target: null }),
}));

export function QuickDetailLink({
  type,
  id,
  children,
  className,
}: {
  type: QuickDetailType;
  id: string | number;
  children: React.ReactNode;
  className?: string;
}) {
  const open = useQuickDetail((s) => s.open);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        open(type, id);
      }}
      className={cn("cursor-pointer underline underline-offset-2 hover:opacity-80", className)}
    >
      {children}
    </button>
  );
}

// ---------------- 1. 磅单详情抽屉 ----------------
function OrderQuickDetailContent({ orderNo }: { orderNo: string }) {
  const queryClient = useQueryClient();
  const names = useStaffNames();
  const can = useSession((s) => s.can);
  const { data: station } = useStation();
  const { data: staff = [] } = useQuery({ queryKey: ["staff"], queryFn: () => api.staff() });
  const openQuickDetail = useQuickDetail((s) => s.open);

  const [printDoc, setPrintDoc] = useState<"weigh_order" | "quality_report" | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [voidAuth, setVoidAuth] = useState("");

  const { data: order, isLoading } = useQuery({
    queryKey: ["order", orderNo],
    queryFn: () => api.getOrder(orderNo),
  });
  const { data: qcRows = [] } = useQuery({
    queryKey: ["qc-of-order", orderNo],
    queryFn: () => api.listQc({ keyword: orderNo }),
    enabled: !!orderNo,
  });
  const { data: settlement } = useQuery({
    queryKey: ["settlement-of-order", orderNo],
    queryFn: () => api.settlementOfOrderNo(orderNo),
    enabled: !!orderNo,
  });
  const { data: partyDetail } = useQuery({
    queryKey: ["party", order?.party_id],
    queryFn: () => (order ? api.getParty(order.party_id) : Promise.resolve(null)),
    enabled: !!order,
  });

  const qc = useMemo(
    () => (order?.qc_report_id != null ? (qcRows.find((r) => r.id === order.qc_report_id) ?? null) : null),
    [qcRows, order?.qc_report_id],
  );

  const masters = useMemo(() => staff.filter((u) => u.role === "station_master" && u.is_active === 1), [staff]);
  const authId = Number(voidAuth) || null;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["order", orderNo] });
    void queryClient.invalidateQueries({ queryKey: ["orders"] });
    void queryClient.invalidateQueries({ queryKey: ["openOrders"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    void queryClient.invalidateQueries({ queryKey: ["audits"] });
  };

  const voidMut = useMutation({
    mutationFn: () =>
      api.voidOrder({ order_no: orderNo, reason: voidReason.trim(), operator_id: actorId(), authorized_by: authId ?? 0 }),
    onSuccess: (o) => {
      if (!o) {
        toast.error("作废失败：未找到该磅单");
        return;
      }
      toast.success(`磅单 ${o.order_no} 已作废`);
      setVoidOpen(false);
      setVoidReason("");
      setVoidAuth("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "作废失败，请重试"),
  });

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (!order) return <EmptyState title={`找不到磅单 ${orderNo}`} />;

  const records = order.records ?? [];
  const photos = order.photos ?? [];
  const prints = order.prints ?? [];
  const timeline = order.timeline ?? [];
  const locked = order.status === "voided" || order.status === "rejected";
  const manual = order.weight_source === "manual";
  const statusDesc = ORDER_STATUS[order.status].desc;

  const recordCols: Column<WeighRecord>[] = [
    { key: "seq", header: "序号", cell: (r) => <span className="tnum">{r.seq}</span> },
    { key: "weigh_type", header: "称重项", cell: (r) => (r.weigh_type === "gross" ? "毛重" : "皮重") },
    { key: "weight", header: "读数", align: "right", cell: (r) => <span className="tnum">{weight(r.weight_01kg)}</span> },
    { key: "stable", header: "稳定", cell: (r) => (r.stable === 1 ? <ToneBadge tone="success">稳定</ToneBadge> : <ToneBadge tone="warning">不稳定</ToneBadge>) },
    { key: "source", header: "来源", cell: (r) => <WeightSourceBadge source={r.source} /> },
    { key: "adopted", header: "是否采用", cell: (r) => (r.is_adopted === 1 ? <span className="text-xs">采用</span> : <span className="text-xs text-muted-foreground">弃用</span>) },
    { key: "at", header: "时间", cell: (r) => <span className="tnum text-xs">{dateTime(r.captured_at)}</span> },
    { key: "op", header: "经手", cell: (r) => <span className="text-xs">{names(r.operator_id)}</span> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="tnum text-lg font-semibold">{order.order_no}</span>
            <OrderStatusBadge status={order.status} />
            <PaymentStatusBadge status={order.payment_status} />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {order.business_date} · {order.party_name} · {order.variety_name}{order.grade ? ` ${order.grade}` : ""} · {statusDesc}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" onClick={() => setPrintDoc("quality_report")} disabled={!qc || !can("print")}>
            <FlaskConicalIcon /> 质检单
          </Button>
          <Button size="xs" variant="outline" onClick={() => setPrintDoc("weigh_order")} disabled={!can("print")}>
            <PrinterIcon /> 补打码单
          </Button>
          {!locked && can("order.void") && (
            <Button size="xs" variant="destructive" onClick={() => setVoidOpen(true)}>
              <ShieldAlertIcon /> 作废
            </Button>
          )}
        </div>
      </div>

      {order.status === "voided" && (
        <CallOut tone="danger" title="本磅单已作废">
          作废原因：{orDash(order.void_reason)}（授权人：{names(order.authorized_by ?? null)}）。作废单据保留档案供审计，不计入任何结算与交班汇总。
        </CallOut>
      )}

      {manual && (
        <CallOut tone="warning" title="本单含人工手录重量">
          现场设备掉线或复核更正时允许手录，手录动作已记录二次授权日志。
        </CallOut>
      )}

      <InfoGrid
        cols={3}
        items={[
          {
            label: "售粮人 / 单位",
            value: (
              <button
                type="button"
                onClick={() => openQuickDetail("party", order.party_id)}
                className="text-primary underline underline-offset-2"
              >
                {order.party_name}
              </button>
            ),
          },
          { label: "车牌号", value: <span className="tnum font-medium">{orDash(order.vehicle_no)}</span> },
          { label: "称重模式", value: <WeightSourceBadge source={order.weight_source} /> },
          { label: "毛重", value: <span className="tnum">{weight(order.gross_weight_01kg)}</span> },
          { label: "皮重", value: <span className="tnum">{weight(order.tare_weight_01kg)}</span> },
          { label: "净重", value: <span className="tnum font-semibold">{weight(order.net_weight_01kg)}</span> },
          { label: "扣重", value: <span className="tnum text-warning">{weight(order.deduction_weight_01kg)}</span> },
          { label: "结算重量", value: <span className="tnum font-bold text-primary">{weight(order.settlement_weight_01kg)}</span> },
          { label: "结算单价", value: <span className="tnum">{fmtPrice(order.unit_price_fen)}</span> },
          { label: "应付金额", value: <span className="tnum font-bold text-base text-primary">{money(order.payable_amount_fen)}</span> },
          {
            label: "化验结果",
            value: qc ? (
              <button
                type="button"
                onClick={() => openQuickDetail("qc", qc.report_no)}
                className="inline-flex items-center gap-1.5 text-primary underline underline-offset-2"
              >
                <QcDecisionBadge decision={qc.decision} />
                <span className="tnum">{qc.report_no}</span>
              </button>
            ) : (
              "无质检"
            ),
          },
          {
            label: "结算单号",
            value: settlement ? (
              <button
                type="button"
                onClick={() => openQuickDetail("settlement", settlement.settlement.settle_no)}
                className="tnum text-primary underline underline-offset-2"
              >
                {settlement.settlement.settle_no}
              </button>
            ) : (
              "未结算"
            ),
          },
        ]}
      />

      <div className="space-y-2 border-t pt-3">
        <h4 className="text-xs font-semibold">称重轨迹（共 {records.length} 次读数）</h4>
        <DataTable data={records} columns={recordCols} rowKey={(r) => `${r.seq}-${r.captured_at}`} compact />
      </div>

      {photos.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <h4 className="text-xs font-semibold">抓拍图像（{photos.length} 张）</h4>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {photos.map((p, idx) => (
              <div key={idx} className="border bg-muted p-1 text-center">
                <img src={p.url} alt={p.label} className="h-24 w-full object-cover" />
                <span className="text-[10px] text-muted-foreground">{p.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {timeline.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <h4 className="text-xs font-semibold">全链路时间轴</h4>
          <DocTimeline events={timeline} />
        </div>
      )}

      <PrintPreview
        open={!!printDoc}
        onOpenChange={(open) => !open && setPrintDoc(null)}
        title={printDoc === "weigh_order" ? `过磅单 ${order.order_no}` : `质检单 ${qc?.report_no ?? ""}`}
        docType={printDoc ?? "weigh_order"}
      >
        {printDoc === "weigh_order" && station && (
          <WeighOrderSheet order={order} station={station} operatorName={names(order.operator_id)} />
        )}
        {printDoc === "quality_report" && qc && station && (
          <QcReportSheet report={qc} station={station} inspectorName={names(qc.inspector_id)} />
        )}
      </PrintPreview>

      <AlertDialog open={voidOpen} onOpenChange={setVoidOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认作废磅单 {orderNo}？</AlertDialogTitle>
            <AlertDialogDescription>
              作废不可撤销。废单原因与授权人将留存迎检审计日志。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 py-2 text-xs">
            <div>
              <Label className="text-xs">站长二次授权</Label>
              <Choose
                value={voidAuth}
                onChange={setVoidAuth}
                options={masters.map((m) => ({ label: m.name, value: String(m.id) }))}
                placeholder="选择授权站长…"
              />
            </div>
            <div>
              <Label className="text-xs">作废原因</Label>
              <Textarea
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder="请如实输入作废事由…"
                rows={3}
              />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void voidMut.mutate()}
              disabled={!voidAuth || !voidReason.trim() || voidMut.isPending}
            >
              确定作废
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------- 2. 农户档案详情抽屉 ----------------
function PartyQuickDetailContent({ partyId }: { partyId: number }) {
  const openQuickDetail = useQuickDetail((s) => s.open);
  const { data: detail, isLoading } = useQuery({
    queryKey: ["party", partyId],
    queryFn: () => api.getParty(partyId),
    enabled: Number.isFinite(partyId),
  });
  const { data: credits = [] } = useQuery({ queryKey: ["credits"], queryFn: () => api.credits() });

  const myCredits = useMemo(() => credits.filter((c) => c.settlement.party_id === partyId), [credits, partyId]);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (!detail) return <EmptyState title={`找不到编号 ${partyId} 的档案`} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="border-b pb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold">{detail.name}</span>
          <ToneBadge tone="neutral">{PARTY_TYPE[detail.party_type]}</ToneBadge>
          {detail.status === "disabled" && <ToneBadge tone="danger">已停用</ToneBadge>}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {detail.code} · 建档 {detail.created_at.slice(0, 10)} · 证号 {maskIdCard(detail.id_card_no)}
        </p>
      </div>

      <InfoGrid
        cols={2}
        items={[
          { label: "联系电话", value: <span className="tnum">{orDash(detail.phone)}</span> },
          { label: "地址", value: detail.address || "未填写" },
          { label: "银行账号", value: <span className="tnum font-mono">{orDash(detail.bank_account)}</span> },
          { label: "开户行", value: detail.bank_name || "未填写" },
        ]}
      />

      <div className="grid grid-cols-2 gap-3 border-t pt-3">
        <div className="border p-3 bg-card">
          <div className="text-xs text-muted-foreground">累计交售</div>
          <div className="tnum text-lg font-bold">{weight(detail.summary.total_net_weight_01kg)}</div>
          <div className="text-[11px] text-muted-foreground">共 {detail.summary.total_orders} 车次</div>
        </div>
        <div className="border p-3 bg-card">
          <div className="text-xs text-muted-foreground">累计应付金额</div>
          <div className="tnum text-lg font-bold text-primary">{money(detail.summary.total_payable_fen)}</div>
          <div className="text-[11px] text-muted-foreground">未付余额：{money(detail.summary.unpaid_fen)}</div>
        </div>
      </div>

      {myCredits.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <h4 className="text-xs font-semibold text-warning">未结清挂账 ({myCredits.length} 笔)</h4>
          <div className="space-y-2">
            {myCredits.map((c) => (
              <div key={c.settlement.settle_no} className="flex items-center justify-between border p-2 text-xs">
                <div>
                  <button
                    type="button"
                    onClick={() => openQuickDetail("settlement", c.settlement.settle_no)}
                    className="tnum font-medium text-primary underline"
                  >
                    {c.settlement.settle_no}
                  </button>
                  <span className="text-muted-foreground ml-2">{c.settlement.settle_date}</span>
                </div>
                <div className="tnum font-bold text-destructive">未付：{money(c.unpaid_fen)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {detail.recentOrders.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <h4 className="text-xs font-semibold">近期交售记录</h4>
          <div className="max-h-60 overflow-y-auto space-y-1">
            {detail.recentOrders.slice(0, 10).map((r) => (
              <div key={r.order_no} className="flex items-center justify-between border-b py-1.5 text-xs last:border-b-0">
                <div>
                  <button
                    type="button"
                    onClick={() => openQuickDetail("order", r.order_no)}
                    className="tnum font-medium text-primary underline"
                  >
                    {r.order_no}
                  </button>
                  <span className="text-muted-foreground ml-2">{r.business_date} · {r.variety_name}</span>
                </div>
                <div className="text-right">
                  <span className="tnum font-medium">{weight(r.net_weight_01kg)}</span>
                  <span className="tnum text-muted-foreground ml-2">{money(r.payable_amount_fen)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- 3. 化验质检单详情抽屉 ----------------
function QcQuickDetailContent({ reportNo }: { reportNo: string }) {
  const names = useStaffNames();
  const openQuickDetail = useQuickDetail((s) => s.open);

  const { data, isLoading } = useQuery({
    queryKey: ["qc-report", reportNo],
    queryFn: () => api.getQc(reportNo),
  });

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (!data) return <EmptyState title={`找不到质检单 ${reportNo}`} />;

  const { report, first } = data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="tnum text-lg font-semibold">{report.report_no}</span>
            <QcDecisionBadge decision={report.decision} />
            {report.is_recheck === 1 && <ToneBadge tone="info">复检</ToneBadge>}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {report.party_name} · 样品 {report.sample_no} · {TEST_METHOD[report.test_method]} · {dateTime(report.inspected_at)}
          </p>
        </div>
        <Button size="xs" onClick={() => openQuickDetail("order", report.order_no)}>
          对应磅单
        </Button>
      </div>

      <InfoGrid
        cols={2}
        items={[
          { label: "关联磅单号", value: <span className="tnum">{report.order_no}</span> },
          { label: "判定等级", value: <span className="font-semibold">{report.grade ? `${report.grade}等` : "不确定"}</span> },
          { label: "化验员", value: names(report.inspector_id) },
          { label: "测定方法", value: TEST_METHOD[report.test_method] },
        ]}
      />

      <div className="space-y-2 border-t pt-3">
        <h4 className="text-xs font-semibold">化验指标明细</h4>
        <div className="grid grid-cols-2 gap-2 text-xs">
          {Object.entries(INDICATORS).map(([key, item]) => {
            const val = report.items[key as keyof typeof report.items];
            return (
              <div key={key} className="flex justify-between border p-2 bg-card">
                <span className="text-muted-foreground">{item.name}</span>
                <span className="tnum font-medium">
                  {val != null ? (item.unit === "%" ? percent(val as number) : String(val)) : "-"}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {report.decision === "reject" && (
        <CallOut tone="danger" title="判定结果：拒收">
          拒收原因：{orDash(report.reject_reason)}
        </CallOut>
      )}
    </div>
  );
}

// ---------------- 4. 结算单详情抽屉 ----------------
function SettlementQuickDetailContent({ settleNo }: { settleNo: string }) {
  const names = useStaffNames();
  const openQuickDetail = useQuickDetail((s) => s.open);

  const { data, isLoading } = useQuery({
    queryKey: ["settlement", settleNo],
    queryFn: () => api.settlementOf(settleNo),
  });

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (!data) return <EmptyState title={`找不到结算单 ${settleNo}`} />;

  const { settlement: s, orders, payments } = data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="tnum text-lg font-semibold">{s.settle_no}</span>
            <PaymentStatusBadge status={s.payment_status} />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {s.settle_date} · {s.party_name} · 共 {s.order_count} 笔过磅单
          </p>
        </div>
        <Button size="xs" variant="outline" onClick={() => openQuickDetail("party", s.party_id)}>
          查看农户档案
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="border p-2 bg-card">
          <div className="text-[11px] text-muted-foreground">应付总额</div>
          <div className="tnum text-base font-bold">{money(s.payable_fen)}</div>
        </div>
        <div className="border p-2 bg-card">
          <div className="text-[11px] text-muted-foreground">已付总额</div>
          <div className="tnum text-base font-bold text-success">{money(s.paid_fen)}</div>
        </div>
        <div className="border p-2 bg-card">
          <div className="text-[11px] text-muted-foreground">未付余额</div>
          <div className="tnum text-base font-bold text-destructive">{money(s.payable_fen - s.paid_fen)}</div>
        </div>
      </div>

      <div className="space-y-2 border-t pt-3">
        <h4 className="text-xs font-semibold">包含过磅单 ({orders.length} 笔)</h4>
        <div className="max-h-52 overflow-y-auto space-y-1">
          {orders.map((o) => (
            <div key={o.order_no} className="flex items-center justify-between border-b py-1.5 text-xs last:border-b-0">
              <div>
                <button
                  type="button"
                  onClick={() => openQuickDetail("order", o.order_no)}
                  className="tnum font-medium text-primary underline"
                >
                  {o.order_no}
                </button>
                <span className="text-muted-foreground ml-2">{o.variety_name}</span>
              </div>
              <div className="text-right">
                <span className="tnum">{weight(o.settlement_weight_01kg)}</span>
                <span className="tnum font-semibold ml-2">{money(o.payable_amount_fen)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {payments.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <h4 className="text-xs font-semibold">付款流水 ({payments.length} 笔)</h4>
          <div className="space-y-1">
            {payments.map((p, idx) => (
              <div key={idx} className="flex items-center justify-between border p-2 text-xs">
                <div>
                  <span className="font-medium">{PAYMENT_METHOD[p.method]}</span>
                  <span className="tnum text-muted-foreground ml-2">{dateTime(p.paid_at)}</span>
                  {p.trade_no && <span className="tnum text-muted-foreground ml-2">流水号: {p.trade_no}</span>}
                </div>
                <div className="tnum font-bold text-success">+{money(p.amount_fen)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- 5. 统一 QuickDetailSheet 容器 ----------------
export function QuickDetailSheet() {
  const { target, close } = useQuickDetail();

  const title = useMemo(() => {
    if (!target) return "";
    switch (target.type) {
      case "order":
        return `磅单详情 · ${target.id}`;
      case "party":
        return `售粮人档案详情`;
      case "qc":
        return `质检单详情 · ${target.id}`;
      case "settlement":
        return `结算单详情 · ${target.id}`;
    }
  }, [target]);

  return (
    <Sheet open={!!target} onOpenChange={(open) => !open && close()}>
      <SheetContent side="right" className="w-[90vw] sm:max-w-2xl overflow-y-auto p-6">
        <SheetHeader className="mb-4 pb-2 border-b">
          <SheetTitle className="text-base">{title}</SheetTitle>
          <SheetDescription className="text-xs text-muted-foreground">
            抽屉弹窗预览，不离开当前业务页面
          </SheetDescription>
        </SheetHeader>

        {target?.type === "order" && <OrderQuickDetailContent orderNo={target.id} />}
        {target?.type === "party" && <PartyQuickDetailContent partyId={Number(target.id)} />}
        {target?.type === "qc" && <QcQuickDetailContent reportNo={target.id} />}
        {target?.type === "settlement" && <SettlementQuickDetailContent settleNo={target.id} />}
      </SheetContent>
    </Sheet>
  );
}
