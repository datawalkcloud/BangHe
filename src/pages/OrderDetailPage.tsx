/**
 * 磅单详情（05 §3 `/orders/$orderNo`）。
 *
 * 这张页面的存在理由只有一个：迎检与纠纷。所以它不做任何"美化"，
 * 而是把 谁在什么时间以什么来源留下了什么数字 完整摊开：
 *   基本信息 → 重量轨迹（含被弃用的读数）→ 化验指标 → 结算明细
 *   → 附件墙 → 打印记录 → 全链路时间轴
 *
 * 页面上只有两处写操作：「作废」不需要授权、只需填明事由留痕；「入仓去向」由值仓事后补录
 *  （制单时选填，见 03 §9.9），改派写 order.destination 审计、署名进 keeper_id。
 * 红冲（ reversals ）在 mock 层没有对应接口，因此这里只给出跳转与说明，
 * 绝不伪装成已完成的操作（02 §F6.3 要求红冲另立新单，接口未实现）。
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, ArrowLeftIcon, FlaskConicalIcon, MapPinIcon, PrinterIcon, ShieldAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { WeighRecord } from "@/mock/types";
import { INDICATORS, ORDER_STATUS, PARTY_TYPE, PAYMENT_METHOD, TEST_METHOD, TONE_DOT, VOID_REASON_MIN } from "@/lib/constants";
import { dateTime, maskIdCard, money, orDash, percent, price as fmtPrice, density, weight } from "@/lib/format";
import { useStaffNames, useStation, useWarehouses, useSlots } from "@/hooks/useLookups";
import { actorId, useSession } from "@/store/session";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/business/DataTable";
import { Choose } from "@/components/business/Choose";
import { VoidReasonField } from "@/components/business/VoidReasonField";
import { MoneyLine } from "@/components/business/NumField";
import { DocTimeline } from "@/components/business/DocTimeline";
import { OrderStatusBadge, PaymentStatusBadge, QcDecisionBadge, ToneBadge, WeightSourceBadge } from "@/components/business/badges";
import { CallOut, EmptyState, InfoGrid, PageHeader } from "@/components/business/layout";
import { ReceiptPrintPreview } from "@/components/print/receipt/ReceiptPrintPreview";
import { cn } from "cn";

/**
 * 详情页只读明细表的紧凑排版。
 *
 * shadcn Table 的默认节奏（表头 h-12、单元格 p-3、表头 font-medium 且继承 text-foreground）
 * 是给"列表页"用的；详情页里的这些表是嵌在卡片内的小明细，必须保持原先的
 * py-1.5 / 无左右内边距 / 表头随行取色，否则卡片会被撑开一大截。
 * 用后代选择器（[&_th] / [&_td]）而不是单元格上的 className，是因为前者的
 * 特异性高于组件内置的 p-3、h-12、text-foreground，能稳定压住。
 */
const DETAIL_TABLE =
  "border-collapse text-sm [&_th]:h-auto [&_th]:px-0 [&_th]:py-1.5 [&_th]:font-normal [&_th]:text-inherit [&_td]:px-0 [&_td]:py-1.5";

export function OrderDetailPage() {
  const { orderNo } = useParams({ from: "/orders/$orderNo" });
  const queryClient = useQueryClient();
  const names = useStaffNames();
  const can = useSession((s) => s.can);
  const { data: station } = useStation();

  const [printDoc, setPrintDoc] = useState<"weigh_order" | "quality_report" | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  /** 去向弹窗：Choose 的 value 一律是字符串，"" 表示"未定"（清空也是合法写入） */
  const [destOpen, setDestOpen] = useState(false);
  const [destWh, setDestWh] = useState("");
  const [destSlot, setDestSlot] = useState("");

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
  /** 档案里的联系方式与账户，详情页不重复维护一份，只从档案读 */
  const { data: partyDetail } = useQuery({
    queryKey: ["party", order?.party_id],
    queryFn: () => (order ? api.getParty(order.party_id) : Promise.resolve(null)),
    enabled: !!order,
  });
  /** 去向候选（停用的仓房/货位不出列，与工作台同一口径） */
  const { data: warehouses = [] } = useWarehouses();
  const { data: slots = [] } = useSlots();

  const qc = useMemo(
    () => (order?.qc_report_id != null ? (qcRows.find((r) => r.id === order.qc_report_id) ?? null) : null),
    [qcRows, order?.qc_report_id],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["order", orderNo] });
    void queryClient.invalidateQueries({ queryKey: ["orders"] });
    void queryClient.invalidateQueries({ queryKey: ["openOrders"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    void queryClient.invalidateQueries({ queryKey: ["audits"] });
  };

  const voidMut = useMutation({
    mutationFn: () => api.voidOrder({ order_no: orderNo, reason: voidReason.trim(), operator_id: actorId() }),
    onSuccess: (o) => {
      if (!o) {
        toast.error("作废失败：未找到该磅单");
        return;
      }
      toast.success(`磅单 ${o.order_no} 已作废，原因与经办人已记入审计日志`);
      setVoidOpen(false);
      setVoidReason("");
      invalidate();
    },
    // 真库把"为什么不能废"说得很具体（已结算 / 已挂结算单 / 状态已是终态），
    // 固定文案会把原因吞掉——磅员站在磅房门口只看到"请重试"是最坏的结果
    onError: (e: Error) => toast.error(e.message || "作废失败，请重试"),
  });

  /** 打开时以本单现状为准：不预先清空，改派与补录走同一个入口 */
  const openDest = () => {
    setDestWh(String(order?.warehouse_id ?? ""));
    setDestSlot(String(order?.slot_id ?? ""));
    setDestOpen(true);
  };

  const destMut = useMutation({
    mutationFn: () =>
      api.assignOrderDestination({
        order_no: orderNo,
        warehouse_id: destWh ? Number(destWh) : null,
        slot_id: destSlot ? Number(destSlot) : null,
        operator_id: actorId(),
      }),
    onSuccess: (o) => {
      if (!o) {
        toast.error("登记失败：未找到该磅单");
        return;
      }
      const now = [o.warehouse_name, o.slot_label].filter(Boolean).join(" / ");
      toast.success(now ? `去向已登记：${now}` : "本单去向已清空");
      setDestOpen(false);
      invalidate();
    },
    // 真库说的是人话（"货位「C01-03」不在该仓房下"），固定文案会把原因吞掉
    onError: (e: Error) => toast.error(e.message || "去向登记失败，请重试"),
  });

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="磅单详情" description="加载中…" />
        <div className="grid gap-4 px-6 py-4 xl:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-52" />
          ))}
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="磅单详情" />
        <EmptyState
          title={`找不到磅单 ${orderNo}`}
          description="单号可能被手动改过，或这张单属于另一台电脑的数据。回列表按日期找一下。"
          action={
            <Button size="sm" variant="outline" render={<Link to="/orders" />}>
              返回磅单中心
            </Button>
          }
        />
      </div>
    );
  }

  const records = order.records ?? [];
  const photos = order.photos ?? [];
  const prints = order.prints ?? [];
  const timeline = order.timeline ?? [];
  const locked = order.status === "voided" || order.status === "rejected";
  const manual = order.weight_source === "manual";
  const statusDesc = ORDER_STATUS[order.status].desc;
  /** 停用只挡住新指定，历史单据上的去向照旧显示（与工作台同一口径） */
  const activeWarehouses = warehouses.filter((w) => w.is_active !== 0);
  const slotPool = slots
    .filter((s) => s.is_active !== 0)
    .filter((s) => !destWh || s.warehouse_id === Number(destWh));

  const recordCols: Column<WeighRecord>[] = [
    { key: "seq", header: "序号", cell: (r) => <span className="tnum">{r.seq}</span> },
    {
      key: "weigh_type",
      header: "称重项",
      cell: (r) => (r.weigh_type === "gross" ? "毛重" : "皮重"),
    },
    {
      key: "weight",
      header: "读数",
      align: "right",
      cell: (r) => <span className="tnum">{weight(r.weight_01kg)}</span>,
    },
    {
      key: "aligned",
      header: "整量化",
      align: "right",
      cell: (r) => <span className="tnum text-muted-foreground">{weight(r.aligned_weight_01kg)}</span>,
    },
    {
      key: "stable",
      header: "稳定",
      cell: (r) => (r.stable === 1 ? <ToneBadge tone="success">稳定</ToneBadge> : <ToneBadge tone="warning">不稳定</ToneBadge>),
    },
    { key: "source", header: "来源", cell: (r) => <WeightSourceBadge source={r.source} /> },
    {
      key: "adopted",
      header: "是否采用",
      cell: (r) =>
        r.is_adopted === 1 ? (
          <span className="text-xs">采用</span>
        ) : (
          <span className="text-xs text-muted-foreground">弃用{r.adopt_reason ? `（${r.adopt_reason}）` : ""}</span>
        ),
    },
    { key: "device", header: "设备", cell: (r) => <span className="tnum text-xs text-muted-foreground">{r.device_code}</span> },
    { key: "at", header: "时间", cell: (r) => <span className="tnum text-xs">{dateTime(r.captured_at)}</span> },
    {
      key: "raw",
      header: "原始帧",
      cell: (r) => <span className="font-mono text-[11px] text-muted-foreground">{orDash(r.raw_frame)}</span>,
    },
    { key: "op", header: "经手", cell: (r) => <span className="text-xs">{names(r.operator_id)}</span> },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="tnum">{order.order_no}</span>
            <OrderStatusBadge status={order.status} />
            <PaymentStatusBadge status={order.payment_status} />
          </span>
        }
        description={`${order.business_date} · ${order.party_name}（${PARTY_TYPE[order.party_type]}）· ${order.variety_name}${order.grade ? ` ${order.grade}` : ""} · ${statusDesc}`}
        actions={
          <>
            <Button size="sm" variant="outline" render={<Link to="/orders" />}>
              <ArrowLeftIcon />
              返回列表
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPrintDoc("quality_report")} disabled={!qc || !can("print")}>
              <FlaskConicalIcon />
              质检单
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPrintDoc("weigh_order")} disabled={!can("print")}>
              <PrinterIcon />
              补打码单
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={locked || !can("order.void")}
              title={locked ? "已作废/已拒收的单不能再作废" : !can("order.void") ? "当前岗位无作废权限" : undefined}
              onClick={() => setVoidOpen(true)}
            >
              <ShieldAlertIcon />
              作废
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-col gap-4">
          {/* 异常留痕前置：一进来就得看见这张单有没有"人工干预" */}
          {locked && (
            <CallOut tone="danger" title={`本单已${ORDER_STATUS[order.status].label}`} icon={<AlertTriangleIcon />}>
              {order.status === "voided"
                ? `作废原因：${orDash(order.void_reason)}；作废时间 ${orDash(order.voided_at && dateTime(order.voided_at))}。作废单不参与任何汇总统计。`
                : "化验判定为拒收，车辆已放行，本单不进入结算与付款。"}
            </CallOut>
          )}
          {manual && (
            <CallOut tone="warning" title="称重读数为手工录入" icon={<AlertTriangleIcon />}>
              仪表通讯异常时允许手录，但必须事后补上传仪表打印小票照片。迎检时此标记会作为重点核查项。
            </CallOut>
          )}
          {order.tare_override_reason && (
            <CallOut tone="warning" title="皮重偏差超容差（数据有效，醒目标记）" icon={<AlertTriangleIcon />}>
              {order.tare_override_reason}；本单已按现场读数捕获，请核对车辆与读数，如需更正走红冲后重录。
            </CallOut>
          )}
          {order.price_override_reason && (
            <CallOut tone="info" title={order.price_list_id != null ? "单价偏离价目表" : "手工定价（当时无生效价目）"}>
              {orDash(order.price_override_reason)}（执行单价 {fmtPrice(order.price_fen_per_ton).perTon}）
            </CallOut>
          )}
          {order.reversed_order_id != null && (
            <CallOut tone="danger" title="本单为红冲单">
              负值冲销原单 #{order.reversed_order_id}，与原单同时参与汇总，净额相互抵消。
            </CallOut>
          )}

          <div className="grid items-start gap-4 xl:grid-cols-2">
            <Card size="sm">
              <CardHeader className="border-b">
                <CardTitle className="text-sm">基本信息</CardTitle>
                {/* CardHeader 是 grid，右侧动作必须走 CardAction 槽位才不会被挤成整宽 */}
                <CardAction>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={openDest}
                    disabled={locked || !can("order.destination")}
                    title={
                      locked
                        ? "作废/拒收的单不再登记入仓去向"
                        : !can("order.destination")
                          ? "登记入仓去向需保管员或站长岗位（02 §11 权限矩阵）"
                          : undefined
                    }
                  >
                    <MapPinIcon />
                    {order.warehouse_id || order.slot_id ? "改派去向" : "登记去向"}
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <InfoGrid
                  cols={2}
                  items={[
                    { label: "磅单号", value: <span className="tnum font-medium">{order.order_no}</span> },
                    { label: "业务日期", value: <span className="tnum">{order.business_date}</span> },
                    { label: "售粮人", value: order.party_name },
                    { label: "身份类型", value: PARTY_TYPE[order.party_type] },
                    { label: "证件号", value: <span className="tnum">{maskIdCard(order.id_card_no)}</span> },
                    { label: "联系电话", value: <span className="tnum">{orDash(partyDetail?.phone)}</span> },
                    { label: "住址", value: orDash(partyDetail?.address), span: 2 },
                    {
                      label: "结算账户",
                      value: partyDetail?.bank_account
                        ? `${partyDetail.bank_name ?? "银行"} ${partyDetail.bank_account}（挂账额度 ${money(partyDetail.credit_limit_fen, false)} 元）`
                        : "未登记（只能现金或当场扫码）",
                      span: 2,
                    },
                    { label: "品种", value: `${order.variety_name}（${order.variety_code}）` },
                    { label: "等级", value: orDash(order.grade) },
                    { label: "车牌", value: <span className="tnum">{orDash(order.vehicle_no)}</span> },
                    { label: "驾驶员", value: orDash(order.driver_name) },
                    { label: "入仓房", value: orDash(order.warehouse_name) },
                    { label: "货位", value: orDash(order.slot_label) },
                    { label: "登记", value: `${names(order.registered_by)} · ${dateTime(order.registered_at)}` },
                    { label: "磅员", value: names(order.weigher_id) },
                    { label: "化验员", value: names(order.inspector_id) },
                    { label: "保管员", value: names(order.keeper_id) },
                    { label: "备注", value: orDash(order.remark), span: 2 },
                  ]}
                />
              </CardContent>
            </Card>

            <Card size="sm">
              <CardHeader className="border-b">
                <CardTitle className="text-sm flex items-center gap-2">
                  重量与扣重
                  <WeightSourceBadge source={order.weight_source} />
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <InfoGrid
                  cols={2}
                  items={[
                    { label: "毛重", value: <span className="tnum">{weight(order.gross_weight_01kg)}</span> },
                    { label: "皮重", value: <span className="tnum">{weight(order.tare_weight_01kg)}</span> },
                    { label: "净重", value: <span className="tnum font-semibold">{weight(order.net_weight_01kg)}</span> },
                    { label: "包装物", value: <span className="tnum">{weight(order.package_deduct_01kg)} × {order.package_count} 件</span> },
                    { label: "扣水", value: <span className="tnum">{weight(order.moisture_deduct_01kg)}</span> },
                    { label: "扣杂", value: <span className="tnum">{weight(order.impurity_deduct_01kg)}</span> },
                    { label: "其他扣重", value: <span className="tnum">{weight(order.other_deduct_01kg)}</span> },
                    { label: "扣重合计", value: <span className="tnum">{weight(order.deduct_total_01kg)}</span> },
                    {
                      label: "结算重量",
                      value: <span className="tnum text-sm font-semibold">{weight(order.settlement_weight_01kg)}</span>,
                      span: 2,
                    },
                  ]}
                />
                <p className="text-xs text-muted-foreground">
                  净重 = 毛重 − 皮重；结算重量 = 净重 − 扣重合计。首版不实现水分/杂质自动增扣量（02 §F4.4），
                  上表扣重均为人工录入值。
                </p>
              </CardContent>
            </Card>
          </div>

          <Card size="sm">
            <CardHeader className="border-b">
              <CardTitle className="flex items-center gap-2 text-sm">
                称重轨迹
                <span className="font-normal text-xs text-muted-foreground">
                  共 {records.length} 次读数，含被弃用记录；整量化按分度值取整
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <DataTable
                columns={recordCols}
                rows={records}
                rowKey={(r) => r.id}
                dense
                defaultPageSize={50}
                empty={<EmptyState title="本单尚无称重读数" description="若车辆已上过磅，说明读数未捕获成功，需在工作台重新捕获。" />}
              />
            </CardContent>
          </Card>

          <div className="grid items-start gap-4 xl:grid-cols-2">
            <Card size="sm">
              <CardHeader className="border-b">
                <CardTitle className="flex items-center gap-2 text-sm">
                  化验结果
                  {qc && <QcDecisionBadge decision={qc.decision} />}
                  {qc?.is_recheck === 1 && <ToneBadge tone="info">复检</ToneBadge>}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {!qc ? (
                  <p className="text-sm text-muted-foreground">
                    {order.qc_at ? "化验记录未随单返回，可在化验台账按单号查询。" : "本单未做化验登记。"}
                  </p>
                ) : (
                  <>
                    <InfoGrid
                      cols={2}
                      items={[
                        { label: "质检单号", value: <span className="tnum">{qc.report_no}</span> },
                        { label: "样品号", value: <span className="tnum">{qc.sample_no}</span> },
                        { label: "检测方法", value: TEST_METHOD[qc.test_method] },
                        { label: "定级", value: orDash(qc.grade) },
                        { label: "化验员", value: `${names(qc.inspector_id)} · ${dateTime(qc.inspected_at)}` },
                        { label: "留样", value: qc.retention_no ? `${qc.retention_no}（至 ${qc.retention_until}）` : "未留样" },
                        { label: "扣水", value: <span className="tnum">{weight(qc.moisture_deduct_01kg)}</span> },
                        { label: "扣杂", value: <span className="tnum">{weight(qc.impurity_deduct_01kg)}</span> },
                        {
                          label: "拒收原因",
                          value: <span className="text-destructive">{orDash(qc.reject_reason)}</span>,
                          span: 2,
                        },
                        { label: "备注", value: orDash(qc.remark), span: 2 },
                      ]}
                    />
                    <Table className={DETAIL_TABLE}>
                      <TableHeader>
                        <TableRow className="border-b text-xs text-muted-foreground hover:bg-transparent">
                          <TableHead>指标</TableHead>
                          <TableHead className="text-right">实测</TableHead>
                          <TableHead className="text-right">国标基准</TableHead>
                          <TableHead className="text-right">偏差</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {qc.indicators.map((it) => {
                          const meta = INDICATORS[it.code];
                          const shown =
                            it.unit === "text"
                              ? orDash(it.value_text)
                              : it.unit === "gL"
                                ? density(it.value_num)
                                : percent(it.value_num);
                          const std =
                            meta?.unit === "gL"
                              ? density(meta.std ?? null)
                              : meta?.unit === "text"
                                ? "—"
                                : percent(meta?.std ?? null);
                          const over = it.over_std === 1;
                          const delta =
                            meta && it.value_num != null && meta.std != null
                              ? `${meta.lowerBetter ? "↑ 超" : "↓ 低"} ${
                                  it.unit === "gL"
                                    ? `${Math.abs(it.value_num - meta.std)} g/L`
                                    : percent(Math.abs(it.value_num - meta.std), "")
                                }`
                              : null;
                          return (
                            <TableRow key={it.code} className={cn("border-b hover:bg-transparent", over && "bg-warning-bg")}>
                              <TableCell>{meta?.name ?? it.name}</TableCell>
                              <TableCell className={cn("tnum text-right", over && "font-medium text-warning")}>{shown}</TableCell>
                              <TableCell className="tnum text-right text-muted-foreground">{std}</TableCell>
                              <TableCell className="text-right text-xs">
                                {over ? delta ?? "超基准" : <span className="text-muted-foreground">合格</span>}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    <p className="text-xs text-muted-foreground">
                      基准值仅用于超标提示与定级参考，不参与扣量计算。
                    </p>
                  </>
                )}
              </CardContent>
            </Card>

            <Card size="sm">
              <CardHeader className="border-b">
                <CardTitle className="text-sm">结算与付款</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {order.settled_at == null ? (
                  <p className="text-sm text-muted-foreground">
                    本单尚未结算。{ORDER_STATUS[order.status].label}状态下应到工作台完成计价结算。
                  </p>
                ) : (
                  <>
                    <InfoGrid
                      cols={2}
                      items={[
                        { label: "结算时间", value: dateTime(order.settled_at) },
                        { label: "结算人", value: names(order.weigher_id) },
                        {
                          label: "执行单价",
                          value: (
                            <span className="tnum">
                              {fmtPrice(order.price_fen_per_ton).perTon}
                              <span className="ml-1 text-xs text-muted-foreground">
                                （{fmtPrice(order.price_fen_per_ton).perJin}）
                              </span>
                            </span>
                          ),
                        },
                        {
                          label: "计价依据",
                          value: order.price_list_id != null ? `价目表 #${order.price_list_id}` : "手工定价",
                        },
                        { label: "结算重量", value: <span className="tnum">{weight(order.settlement_weight_01kg)}</span> },
                        { label: "付款方式", value: order.payment_method ? PAYMENT_METHOD[order.payment_method] : "—" },
                      ]}
                    />
                    <div className="flex flex-col gap-1.5 border-t pt-3">
                      <MoneyLine label="货款金额" valueFen={order.goods_amount_fen} />
                      <MoneyLine label="各项扣款" valueFen={-order.deduction_fee_fen} hint="装卸费、代储费等" />
                      <MoneyLine label="预付款冲抵" valueFen={-order.advance_fee_fen} />
                      <MoneyLine label="应付金额" valueFen={order.payable_amount_fen} emphasis />
                      <MoneyLine label="已付金额" valueFen={order.paid_amount_fen} />
                      <MoneyLine
                        label="未付余额"
                        valueFen={Math.max(0, (order.payable_amount_fen ?? 0) - order.paid_amount_fen)}
                      />
                    </div>
                    {settlement && (
                      <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
                        <span className="text-muted-foreground">所属结算单</span>
                        <Link
                          to="/settlements/$settleNo"
                          params={{ settleNo: settlement.settle_no }}
                          className="tnum font-medium underline underline-offset-2"
                        >
                          {settlement.settle_no}
                        </Link>
                        <PaymentStatusBadge status={settlement.payment_status} />
                      </div>
                    )}
                  </>
                )}
                {order.status !== "voided" && order.status !== "rejected" && order.settled_at == null && (
                  <CallOut tone="info" title="下一步">
                    结算在「扫码结算」窗口做：凭这张码单上的二维码取单、现场计价收款，结完本页自动出现金额明细。
                    <Link to="/scan-settle" search={{ orderNo: order.order_no }} className="ml-1 underline underline-offset-2">
                      带去扫码结算
                    </Link>
                    {(order.prints ?? []).length === 0 && order.net_weight_01kg != null && (
                      <span className="ml-1 text-muted-foreground">
                        （这单还没打过码单，客户手里没有可扫的票——先回工作台打印，或直接让客户报姓名在窗口手输单号）
                      </span>
                    )}
                  </CallOut>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid items-start gap-4 xl:grid-cols-2">
            <Card size="sm">
              <CardHeader className="border-b">
                <CardTitle className="flex items-center gap-2 text-sm">
                  现场附件
                  <span className="font-normal text-xs text-muted-foreground">
                    {photos.length} 项 · 抓拍缺失只标文字，不用颜色单独表达
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {photos.length === 0 ? (
                  <p className="text-sm text-muted-foreground">本单没有现场照片，说明抓拍设备当时离线或被人工跳过。</p>
                ) : (
                  <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {photos.map((p) => (
                      <li key={p.id} className="flex min-w-0 flex-col gap-1">
                        <div
                          className={cn(
                            "flex aspect-[4/3] items-end p-1.5 text-[10px] text-white",
                            TONE_DOT[p.tone],
                            p.missing && "items-center justify-center opacity-60",
                          )}
                        >
                          {p.missing ? "无画面" : ""}
                        </div>
                        <span className="truncate text-xs">{p.label}</span>
                        <span className="tnum text-[11px] text-muted-foreground">
                          {p.missing ? "抓拍失败" : dateTime(p.captured_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card size="sm">
              <CardHeader className="border-b">
                <CardTitle className="text-sm">打印记录</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {prints.length === 0 ? (
                  <p className="text-sm text-muted-foreground">本单从未打印，码单联次未生成。</p>
                ) : (
                  <Table className={DETAIL_TABLE}>
                    <TableHeader>
                      <TableRow className="border-b text-xs text-muted-foreground hover:bg-transparent">
                        <TableHead>时间</TableHead>
                        <TableHead>纸型/通道</TableHead>
                        <TableHead>打印机</TableHead>
                        <TableHead>性质</TableHead>
                        <TableHead>操作人</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {prints.map((p) => (
                        <TableRow key={p.id} className="border-b hover:bg-transparent">
                          <TableCell className="tnum text-xs">{dateTime(p.printed_at)}</TableCell>
                          <TableCell className="text-xs">{p.paper}</TableCell>
                          <TableCell className="truncate text-xs">{p.printer_name}</TableCell>
                          <TableCell className="text-xs">
                            {p.is_reprint === 1 ? (
                              <ToneBadge tone="warning">补打</ToneBadge>
                            ) : (
                              <span className="text-muted-foreground">首次</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">{names(p.operator_id)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <p className="text-xs text-muted-foreground">
                  补打必须在纸上带「补打」字样并记录授权人，与首打联次区分（01 §F6.2）。
                </p>
              </CardContent>
            </Card>
          </div>

          <Card size="sm">
            <CardHeader className="border-b">
              <CardTitle className="text-sm">
                全链路时间轴
                <span className="ml-2 font-normal text-xs text-muted-foreground">每一步都带署名与时刻，用于回答"这张单谁在哪一步干了什么"</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DocTimeline events={timeline} />
            </CardContent>
          </Card>
        </div>
      </div>

      {station && (
        <ReceiptPrintPreview
          open={printDoc !== null}
          onOpenChange={(v) => !v && setPrintDoc(null)}
          scenario={printDoc === "quality_report" ? "quality_report" : "weigh_order"}
          context={
            printDoc === "quality_report" && qc
              ? { station, names, qc, reprint: true }
              : { station, names, order, qc, reprint: true }
          }
          isReprint
          docNo={printDoc === "quality_report" && qc ? qc.report_no : order.order_no}
        />
      )}

      <Dialog open={destOpen} onOpenChange={setDestOpen}>
        <DialogContent className="max-w-[460px]">
          <DialogHeader>
            <DialogTitle className="text-sm">入仓去向 · {order.order_no}</DialogTitle>
            <DialogDescription className="text-xs">
              去向在制单时是选填项，粮真进了仓由值仓在这里补登记；改派会记审计，并把保管员署名换成当前操作人。
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              仓房
              <Choose
                aria-label="仓房"
                value={destWh}
                onChange={(v) => {
                  setDestWh(v);
                  setDestSlot("");
                }}
                options={[
                  { value: "", label: "未定" },
                  ...activeWarehouses.map((w) => ({ value: String(w.id), label: w.name })),
                ]}
              />
            </Label>
            <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              货位
              <Choose
                aria-label="货位"
                value={destSlot}
                onChange={setDestSlot}
                options={[
                  { value: "", label: "未定" },
                  ...slotPool.map((s) => ({ value: String(s.id), label: s.label })),
                ]}
              />
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            两处都选「未定」即清空本单去向；只选货位时按货位反查仓房。停用的仓房与货位不进候选，历史单据上的去向照旧可查。
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDestOpen(false)}>
              取消
            </Button>
            <Button disabled={destMut.isPending} onClick={() => destMut.mutate()}>
              {destMut.isPending ? "保存中…" : "保存去向"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={voidOpen} onOpenChange={setVoidOpen}>
        <AlertDialogContent className="max-w-[520px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">作废磅单 {order.order_no}</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              作废后本单不再参与任何汇总统计，但记录永久保留、可查询。作废不需要站长授权，
              磅员填明事由即可废单，事由与经办人会写进审计日志。
              若已完成结算或付款，正确做法是<strong>另立红冲单</strong>而不是作废（02 §F6.3）——
              本版本尚未提供红冲接口，红冲需由站长在结算台账处理。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3">
            <VoidReasonField value={voidReason} onChange={setVoidReason} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-sm">取消</AlertDialogCancel>
            <AlertDialogAction
            className="text-sm"
            disabled={voidReason.trim().length < VOID_REASON_MIN || voidMut.isPending}
              onClick={(e) => {
                e.preventDefault();
                voidMut.mutate();
              }}
            >
              确认作废
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
