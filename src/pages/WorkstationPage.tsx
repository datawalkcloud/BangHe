/**
 * 磅房工作台（05 §4 核心界面）。
 *
 * 默认排布是 1280 px 下的三栏：左「身份与制单 + 皮重参考」、中「过磅画面 + 称重 + 化验」、
 * 右「结算与打印」，底部一条在途作业。磅员 90% 的时间只盯读数与车上磅画面，所以这两块
 * 默认摆在中栏顶部——但摆哪儿是他的事：「自定义布局」里拖把手换位、拖右缘/下缘/右下角改大小、
 * 收掉不看的块，排布按登录账号存进 §9.25，磅员/化验员/站长共用一台机也互不影响（05 §4.1）。
 *
 * 低频与留痕类信息不在这里常驻，只留入口：称重轨迹/原始帧/抓拍原图看「单证详情」，
 * 历史皮重明细看「农户档案」。删除只会让人少看一块，收起来才叫省地方。
 *
 * 页面本身只做三件事：取数、把 URL 上的 orderNo 当"当前作业单"、注册 F7/F8/F9。
 * 具体动作与它自己的表单状态同处一个面板，就近注册快捷键。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, PrinterIcon, CctvIcon, Maximize2Icon, Minimize2Icon, LayoutGridIcon, PanelTopIcon, RotateCcwIcon } from "lucide-react";
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
import { CameraPanel } from "@/components/workstation/CameraPanel";
import { PanelTile, WorkstationGrid } from "@/components/workstation/WorkstationGrid";
import { useWorkstationLayout } from "@/components/workstation/layout";
import type { PanelId } from "@/components/workstation/layout";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ReceiptPrintPreview } from "@/components/print/receipt/ReceiptPrintPreview";
import { useQuickDetail } from "@/components/business/QuickDetailSheet";
import { EmptyState, Kbd, PageHeader } from "@/components/business/layout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function WorkstationPage() {
  const { orderNo } = useSearch({ from: "/workstation" });
  const navigate = useNavigate();
  const readCard = useDeviceStore((s) => s.reader.idcard.read);
  const mockOff = useDeviceStore((s) => s.mockOff);
  const openQuickDetail = useQuickDetail((s) => s.open);
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

  /** 库里 `tare_tolerance_pct` 是 0.01%（300 = 3.00%），下游组件一律按百分数用，在这里除一次 */
  const tolerancePct = useSetting("tare_tolerance_pct").num / 100;
  const division01kg = useSetting("scale_division_01kg").num || 100;
  const allowCredit = useSetting("settlement_allow_part_pay").bool;

  const [draft, setDraft] = useState<OrderDraft>(() => emptyDraft(null));
  const setDraftPatch = useCallback((patch: Partial<OrderDraft>) => setDraft((d) => ({ ...d, ...patch })), []);

  const [printOpen, setPrintOpen] = useState(false);
  const [hasPrinted, setHasPrinted] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  /** 编辑态：只有开着它格子才能被拖走。日常界面不留"手一抖布局就变"的入口 */
  const [editing, setEditing] = useState(false);
  const board = useWorkstationLayout();
  /** 「过磅画面」按钮从此就是相机面板的显隐，改动进他本人那份布局，不再是刷新即失的本地开关 */
  const showCam = !board.hidden.includes("camera");
  useEffect(() => setHasPrinted(false), [orderNo]);

  const toggleFocusMode = useCallback(async () => {
    const next = !focusMode;
    setEditing(false); // 专注模式是给磅员盯读数用的，不留可拖拽界面
    setFocusMode(next);
    if (document.fullscreenElement && !next) {
      await document.exitFullscreen();
      return;
    }
    if (!document.fullscreenElement && next) {
      await document.documentElement.requestFullscreen().catch(() => undefined);
    }
  }, [focusMode]);

  useEffect(() => {
    const onFsChange = () => setFocusMode(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  useHotkey("f11", () => {
    void toggleFocusMode();
  });

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
  const cameras = useMemo(() => devices.filter((d) => d.kind === "camera" && d.is_enabled === 1), [devices]);
  const cameraDevice = cameras.find((c) => c.is_default === 1) ?? cameras[0] ?? null;
  const cameraOnline = !mockOff && cameraDevice?.last_status === "online";
  const photos = order?.photos ?? [];

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

  /**
   * 面板本体按 id 收在这儿：网格只管谁占哪几格，取数与参数一处都不因为它挪了位置而改。
   * 只是建元素不调用，收起的面板不会挂载。
   */
  const bodies: Record<PanelId, ReactNode> = {
    identity: (
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
    ),
    tare: (
      <TarePanel
        recent={tareRecent.slice(0, 5)}
        last01kg={partyDetail?.last_tare_01kg ?? null}
        mean01kg={tareMean01kg}
        tolerancePct={tolerancePct}
        currentTare01kg={currentTare01kg}
        alert={tareAlert}
        partyId={partyId}
      />
    ),
    camera: <CameraPanel cameras={cameras} order={order ?? null} photos={photos} mockOff={mockOff} />,
    weigh: (
      <WeighPanel
        order={order ?? null}
        mean01kg={tareMean01kg}
        tolerancePct={tolerancePct}
        staff={staff}
        scalePort={String(scaleDevice?.config?.port ?? "COM1")}
        scaleDivision01kg={division01kg}
        cameraOnline={cameraOnline}
      />
    ),
    qc: <QcPanel order={order ?? null} variety={variety} />,
    settle: (
      <SettlePanel
        order={order ?? null}
        variety={variety}
        qc={qc}
        prices={prices}
        allowCredit={allowCredit}
        onPrint={() => setPrintOpen(true)}
      />
    ),
  };

  return (
    <div className={focusMode ? "fixed inset-0 z-40 flex flex-col bg-background" : "flex min-h-0 flex-1 flex-col"}>
      {!focusMode && (
        <PageHeader
          title="磅房工作台"
          description={
            <>
              读卡 → 制单 → 称重 → 化验 → 结算 → 打印，一屏完成。<Kbd>F7</Kbd> 新建 <Kbd>F8</Kbd> 读卡{" "}
              <Kbd>空格</Kbd> 捕获 <Kbd>F5</Kbd> 化验 <Kbd>F10</Kbd> 结算
            </>
          }
          actions={
            <>
              <span className="text-xs text-muted-foreground">当前</span>
              <span className="tnum text-sm font-semibold">{order?.order_no ?? "（无）"}</span>
              {order && (
                <Button size="xs" variant="ghost" onClick={() => openQuickDetail("order", order.order_no)}>
                  <ExternalLinkIcon />
                  单证详情
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => board.togglePanel("camera", showCam)}>
                <CctvIcon />
                {showCam ? "隐藏画面" : "过磅画面"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPrintOpen(true)} disabled={!order}>
                <PrinterIcon />
                打印（F9）
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
                  <PanelTopIcon />
                  面板
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>显示哪些区块</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {board.specs.map((s) => (
                    <DropdownMenuCheckboxItem
                      key={s.id}
                      checked={s.shown}
                      onCheckedChange={(v) => board.togglePanel(s.id, v !== true)}
                      disabled={s.shown && board.specs.filter((x) => x.shown).length === 1}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{s.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{s.hint}</span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {editing && (
                <Button size="sm" variant="outline" onClick={board.reset}>
                  <RotateCcwIcon />
                  恢复默认
                </Button>
              )}
              <Button
                size="sm"
                variant={editing ? "default" : "outline"}
                onClick={() => {
                  board.flush(); // 退出编辑态前把防抖里欠的那次保存补上
                  setEditing((v) => !v);
                }}
              >
                <LayoutGridIcon />
                {editing ? "完成" : "自定义布局"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void toggleFocusMode()}>
                {focusMode ? <Minimize2Icon /> : <Maximize2Icon />}
                {focusMode ? "退出专注" : "全屏专注（F11）"}
              </Button>
            </>
          }
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {order?.void_reason && (
          <p className="mx-2 mt-1.5 border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
            本单已作废：{order.void_reason}（仅作留痕，如需继续作业请新建下一单）
          </p>
        )}
        {editing && (
          <p className="mx-2 mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            排布存在你本人账号上，换台磅房机登录也是这一套。
            {board.saving && <span className="shrink-0 text-primary">保存中…</span>}
          </p>
        )}
        {!board.ready || isLoading ? (
          <div className="grid flex-1 grid-cols-1 gap-3 px-2.5 py-2 xl:grid-cols-[minmax(230px,0.85fr)_minmax(430px,1.8fr)_minmax(290px,1.1fr)]">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex flex-col gap-3">
                <Skeleton className="h-72" />
                <Skeleton className="h-48" />
              </div>
            ))}
          </div>
        ) : (
          <WorkstationGrid
            items={board.items}
            editing={editing}
            onLayout={board.applyLayout}
            onCommit={board.flush}
          >
            {board.tiles.map(({ spec }) => (
              <PanelTile key={spec.id} spec={spec} editing={editing} onHide={() => board.togglePanel(spec.id, true)}>
                {bodies[spec.id]}
              </PanelTile>
            ))}
          </WorkstationGrid>
        )}
      </div>

      {!focusMode && <OpenOrdersBar activeNo={orderNo} onPick={(no) => goOrder(no)} />}

      {order && station ? (
        <ReceiptPrintPreview
          open={printOpen}
          onOpenChange={(v) => {
            setPrintOpen(v);
            if (!v) setHasPrinted(true);
          }}
          scenario="weigh_order"
          context={{ station, names, order, qc, reprint: hasPrinted }}
          isReprint={hasPrinted}
          docNo={order.order_no}
        />
      ) : (
        printOpen && (
          <EmptyState title="还没有可打印的磅单" description="请先取号制单并完成称重。" />
        )
      )}

      {focusMode && (
        <div className="absolute right-4 top-4 z-50">
          <Button size="sm" variant="outline" onClick={() => void toggleFocusMode()}>
            {focusMode ? <Minimize2Icon /> : <Maximize2Icon />}
            {focusMode ? "退出专注" : "全屏专注"}
          </Button>
        </div>
      )}

      {/* 展示模式（F2）已在全局注册，这里把当前单的摘要嗝在标题里，便于核对 */}
      <span className="sr-only">{`${openOrdersHint} ${date(order?.registered_at)} ${weight(order?.net_weight_01kg)}`}</span>
    </div>
  );
}
