/**
 * 磅房工作台（05 §4 核心界面）。
 *
 * 1280 px 下三栏：左「身份与制单 + 历史皮重」、中「称重 + 化验」、右「结算与打印」，
 * 底部一条在途作业。重量区优先占位，因为磅员 90% 的时间只盯那一串数字。
 *
 * 页面本身只做三件事：取数、把 URL 上的 orderNo 当"当前作业单"、注册 F7/F8/F9。
 * 具体动作与它自己的表单状态同处一个面板，就近注册快捷键。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, PrinterIcon } from "lucide-react";
import { api } from "@/lib/api";
import { useSetting, useStaff, useStaffNames, useStation, useVarieties, useWarehouses, useSlots, usePrices } from "@/hooks/useLookups";
import { useHotkey } from "@/hooks/useHotkey";
import { useDeviceStore } from "@/store/device";
import { date, weight } from "@/lib/format";
import { IdentityPanel, TarePanel, draftFromOrder, emptyDraft } from "@/components/workstation/IdentityPanel";
import type { OrderDraft } from "@/components/workstation/IdentityPanel";
import { WeighPanel } from "@/components/workstation/WeighPanel";
import { QcPanel } from "@/components/workstation/QcPanel";
import { SettlePanel } from "@/components/workstation/SettlePanel";
import { OpenOrdersBar } from "@/components/workstation/OpenOrdersBar";
import { PrintPreview } from "@/components/print/PrintPreview";
import { WeighOrderSheet } from "@/components/print/sheets";
import { EmptyState, Kbd, PageHeader } from "@/components/business/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function WorkstationPage() {
  const { orderNo } = useSearch({ from: "/workstation" });
  const navigate = useNavigate();
  const readCard = useDeviceStore((s) => s.idcard.read);
  const names = useStaffNames();
  const { data: staff = [] } = useStaff();
  const { data: varieties = [] } = useVarieties();
  const { data: warehouses = [] } = useWarehouses();
  const { data: slots = [] } = useSlots();
  const { data: prices = [] } = usePrices();
  const { data: station } = useStation();
  const { data: parties = [] } = useQuery({ queryKey: ["parties", ""], queryFn: () => api.listParties("") });
  const { data: devices = [] } = useQuery({ queryKey: ["devices"], queryFn: () => api.listDevices(), staleTime: 60_000 });

  const { data: order, isLoading } = useQuery({
    queryKey: ["order", orderNo],
    queryFn: () => (orderNo ? api.getOrder(orderNo) : Promise.resolve(null)),
    enabled: !!orderNo,
  });
  const { data: qcRows = [] } = useQuery({
    queryKey: ["qc-of-order", orderNo],
    queryFn: () => (orderNo ? api.listQc({ keyword: orderNo }) : Promise.resolve([])),
    enabled: !!orderNo,
  });

  const tolerancePct = useSetting("tare_tolerance_ratio").num;
  const division01kg = useSetting("scale_division_01kg").num || 100;
  const allowCredit = useSetting("allow_credit").bool;

  const [draft, setDraft] = useState<OrderDraft>(() => emptyDraft(null));
  const setDraftPatch = useCallback((patch: Partial<OrderDraft>) => setDraft((d) => ({ ...d, ...patch })), []);

  const [printOpen, setPrintOpen] = useState(false);
  const [hasPrinted, setHasPrinted] = useState(false);
  useEffect(() => setHasPrinted(false), [orderNo]);

  const partyId = order?.party_id ?? draft.party?.id ?? null;
  const { data: partyDetail } = useQuery({
    queryKey: ["party", partyId],
    queryFn: () => (partyId != null ? api.getParty(partyId) : Promise.resolve(null)),
    enabled: partyId != null,
  });

  const tareRecent = partyDetail?.tareHistory ?? [];
  const tareMean01kg = useMemo(() => {
    const r = tareRecent.slice(0, 5);
    if (r.length === 0) return null;
    return Math.round(r.reduce((s, x) => s + x.tare_01kg, 0) / r.length);
  }, [tareRecent]);
  const currentTare01kg = order?.tare_weight_01kg ?? null;
  const tareAlert =
    currentTare01kg != null &&
    tareMean01kg != null &&
    tolerancePct > 0 &&
    Math.abs(currentTare01kg - tareMean01kg) > Math.round((tareMean01kg * tolerancePct) / 100);

  const variety = useMemo(
    () => varieties.find((v) => v.id === (order?.variety_id ?? draft.varietyId)) ?? null,
    [varieties, order?.variety_id, draft.varietyId],
  );
  const qc = useMemo(
    () => (order?.qc_report_id != null ? (qcRows.find((r) => r.id === order.qc_report_id) ?? null) : null),
    [qcRows, order?.qc_report_id],
  );
  const scaleDevice = devices.find((d) => d.kind === "scale");
  const cameraDevice = devices.find((d) => d.kind === "camera");
  const cameraOnline = cameraDevice?.last_status === "online";

  const goOrder = useCallback(
    (no: string | null) => void navigate({ to: "/workstation", search: { orderNo: no ?? undefined } }),
    [navigate],
  );

  const newOrder = useCallback(() => {
    if (order) setDraft(draftFromOrder(order));
    goOrder(null);
  }, [order, goOrder]);

  useHotkey("f7", newOrder);
  useHotkey("f8", () => void readCard());
  useHotkey("f9", () => {
    if (!order) return;
    setPrintOpen(true);
  });

  const openOrdersHint = order
    ? `${order.variety_name}${order.grade ? ` · ${order.grade}` : ""}`
    : draft.party
      ? `${draft.party.name} · 未制单`
      : "未制单";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="磅房工作台"
        description={
          <>
            读卡 → 制单 → 称重 → 化验 → 结算 → 打印，全链路在一屏内完成。
            <Kbd>F7</Kbd> 新建 <Kbd>F8</Kbd> 读卡 <Kbd>空格</Kbd> 捕获 <Kbd>F5</Kbd> 化验 <Kbd>F10</Kbd> 结算
          </>
        }
        actions={
          <>
            <span className="text-xs text-muted-foreground">当前</span>
            <span className="tnum text-sm font-semibold">{order?.order_no ?? "（无）"}</span>
            {order && (
              <Link to="/orders/$orderNo" params={{ orderNo: order.order_no }}>
                <Button size="xs" variant="ghost">
                  <ExternalLinkIcon />
                  单证详情
                </Button>
              </Link>
            )}
            <Button size="sm" variant="outline" onClick={() => setPrintOpen(true)} disabled={!order}>
              <PrinterIcon />
              打印（F9）
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {isLoading ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(260px,1fr)_minmax(420px,1.5fr)_minmax(300px,1.1fr)]">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex flex-col gap-3">
                <Skeleton className="h-72" />
                <Skeleton className="h-48" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(260px,1fr)_minmax(420px,1.5fr)_minmax(300px,1.1fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              <IdentityPanel
                order={order ?? null}
                draft={draft}
                onDraft={setDraftPatch}
                parties={parties}
                varieties={varieties}
                warehouses={warehouses}
                slots={slots}
                onCreated={(no) => goOrder(no)}
                onNewOrder={newOrder}
              />
              <TarePanel
                recent={tareRecent.slice(0, 5)}
                last01kg={partyDetail?.last_tare_01kg ?? null}
                mean01kg={tareMean01kg}
                tolerancePct={tolerancePct}
                currentTare01kg={currentTare01kg}
                alert={tareAlert}
              />
            </div>

            <div className="flex min-w-0 flex-col gap-4">
              <WeighPanel
                order={order ?? null}
                mean01kg={tareMean01kg}
                tolerancePct={tolerancePct}
                staff={staff}
                scalePort={String(scaleDevice?.config?.port ?? "COM1")}
                scaleDivision01kg={division01kg}
                cameraOnline={cameraOnline}
              />
              <QcPanel order={order ?? null} variety={variety} />
            </div>

            <div className="flex min-w-0 flex-col gap-4">
              <SettlePanel
                order={order ?? null}
                variety={variety}
                qc={qc}
                prices={prices}
                allowCredit={allowCredit}
                onPrint={() => setPrintOpen(true)}
              />
              {order && (
                <Card size="sm">
                  <CardHeader className="border-b">
                    <CardTitle className="text-sm">本单抓拍与留痕</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-1 text-xs text-muted-foreground">
                    <p>
                      业务日期 {order.business_date} · 制单 {order.registered_at.slice(11, 16)} · 称重方式{" "}
                      {order.weight_source === "scale" ? "地磅读数" : "手录"}
                    </p>
                    <p className="tnum">
                      毛重 {weight(order.gross_weight_01kg)} · 皮重 {weight(order.tare_weight_01kg)} · 净重{" "}
                      {weight(order.net_weight_01kg)}
                    </p>
                    {order.void_reason && <p className="text-destructive">作废原因：{order.void_reason}</p>}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        )}
      </div>

      <OpenOrdersBar activeNo={orderNo} onPick={(no) => goOrder(no)} />

      {order && station ? (
        <PrintPreview
          open={printOpen}
          onOpenChange={(v) => {
            setPrintOpen(v);
            if (!v) setHasPrinted(true);
          }}
          docType="weigh_order"
          docNo={order.order_no}
          isReprint={hasPrinted}
        >
          <WeighOrderSheet order={order} station={station} qc={qc} reprint={hasPrinted} names={names} />
        </PrintPreview>
      ) : (
        printOpen && (
          <EmptyState title="还没有可打印的磅单" description="请先取号制单并完成称重。" />
        )
      )}

      {/* 展示模式（F2）已在全局注册，这里把当前单的摘要嗝在标题里，便于核对 */}
      <span className="sr-only">{`${openOrdersHint} ${date(order?.registered_at)} ${weight(order?.net_weight_01kg)}`}</span>
    </div>
  );
}
