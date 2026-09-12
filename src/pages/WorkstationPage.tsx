/**
 * 磅房工作台（05 §4 核心界面）。
 *
 * 交互已从"点按钮"改成"刷卡推进"（06 篇）：来新人点「制单」弹窗读卡制单 → 关框；
 * 之后一张流转卡刷一次推进一步——①刷捕毛重 ②刷捕皮重并自动出码单 ③刷弹结算框（复用 SettleForm）
 * 选付款方式完成结算。工作台后台常听 IC（`useIcWorkflow` 唯一收口），弹窗读身份证时让出设备锁。
 * 读卡器故障 / 关掉流转卡时，称重/结算面板仍可应急手点（05 §10-1 无外设闭环）。
 *
 * 排布按登录账号存进 §9.25，磅员/化验员/站长共用一台机互不影响（05 §4.1）；身份与制单不再是面板。
 * 低频留痕（称重轨迹、原始帧、历史皮重）不常驻，只在「单证详情 / 农户档案」里看。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLinkIcon, PrinterIcon, CctvIcon, Maximize2Icon, Minimize2Icon, LayoutGridIcon, PanelTopIcon, RotateCcwIcon, UserRoundPlusIcon } from "lucide-react";
import { api } from "@/lib/api";
import { useSetting, useStaffNames, useStation, useVarieties, useWarehouses, useSlots, usePrices } from "@/hooks/useLookups";
import { useHotkey } from "@/hooks/useHotkey";
import { useDeviceStore } from "@/store/device";
import { date, weight } from "@/lib/format";
import { TarePanel } from "@/components/workstation/IdentityPanel";
import { WeighPanel } from "@/components/workstation/WeighPanel";
import { QcPanel } from "@/components/workstation/QcPanel";
import { PrintPanel } from "@/components/workstation/PrintPanel";
import { OpenOrdersBar } from "@/components/workstation/OpenOrdersBar";
import { CameraPanel } from "@/components/workstation/CameraPanel";
import { PanelTile, WorkstationGrid } from "@/components/workstation/WorkstationGrid";
import { useWorkstationLayout } from "@/components/workstation/layout";
import type { PanelId } from "@/components/workstation/layout";
import { RegistrationDialog } from "@/components/workstation/RegistrationDialog";
import { useIcWorkflow } from "@/components/workstation/useIcWorkflow";
import { SettleForm } from "@/components/settlement/SettleForm";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ReceiptPrintPreview } from "@/components/print/receipt/ReceiptPrintPreview";
import { printReceiptSilently } from "@/components/print/receipt/silent";
import { useQuickDetail } from "@/components/business/QuickDetailSheet";
import { EmptyState, Kbd, PageHeader } from "@/components/business/layout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function WorkstationPage() {
  const { orderNo } = useSearch({ from: "/workstation" });
  const navigate = useNavigate();
  const qcClient = useQueryClient();
  const mockOff = useDeviceStore((s) => s.mockOff);
  const openQuickDetail = useQuickDetail((s) => s.open);
  const names = useStaffNames();
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

  const tolerancePct = useSetting("tare_tolerance_pct").num / 100;
  const division01kg = useSetting("scale_division_01kg").num || 100;
  const allowCredit = useSetting("settlement_allow_part_pay").bool;

  /** 制单弹窗 */
  const [regOpen, setRegOpen] = useState(false);
  /** 第三刷要结算的单号（null = 结算框关着） */
  const [settleNo, setSettleNo] = useState<string | null>(null);
  /** 打印目标：自动出码单时是被称的那张单，手动打印时是当前单；null 回落到当前 order */
  const [printTarget, setPrintTarget] = useState<string | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  /**
   * 「直打」触发器：第二刷皮重后自动出码单、F9、凭票面板与顶部按钮共用这一条路——
   * 无预览直接打（silent.ts 按模板纸型分流热敏直连 / 打印队列直打，纸张随打印机配置），
   * 只有真打不出去（浏览器演示、设备离线、队列报错）才回退弹预览框。
   */
  const [directPrint, setDirectPrint] = useState(false);
  const printedFor = useRef<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [editing, setEditing] = useState(false);
  const board = useWorkstationLayout();
  const showCam = !board.hidden.includes("camera");

  const goOrder = useCallback(
    (no: string | null) => void navigate({ to: "/workstation", search: { orderNo: no ?? undefined } }),
    [navigate],
  );

  // 弹窗开着时让出读卡器（06 §1.2）：自己的制单弹窗用 regOpen 即时 pause；
  // 顶部工具条「新建过磅单」开的是同一张弹窗，通过 regHolding 让位；结算框展示期间同样不起 IC 监听
  const regHolding = useDeviceStore((s) => s.regHolding);
  useIcWorkflow({
    paused: regOpen || settleNo != null || regHolding,
    onRequestSettle: (no) => {
      goOrder(no);
      setSettleNo(no);
    },
    onWeighed: (o) => {
      // 皮重即净重已定 → 触发自动出码单（06 §2.2 硬规矩 2）；真正是否无感由下方 effect 判
      printedFor.current = null;
      setPrintTarget(o.order_no);
      setDirectPrint(true);
    },
  });

  // F7（制单）已收进顶部工具条作全局键：任何页面都弹同一张 RegistrationDialog，
  // 这里不再重复绑定，避免一次按键叠出两层弹窗
  /**
   * 打当前单的码单：不弹预览，直接打到默认打印机（热敏纸直连小票机，A4/针式进打印队列、
   * 纸张随打印机自身配置）。重复 F9 对同一张单也算一次新的直打（补打场景），所以先清
   * printedFor 闸门；只有直打真失败时 effect 才回退弹预览框。
   */
  const triggerPrint = useCallback(() => {
    if (!order) return;
    printedFor.current = null;
    setPrintTarget(order.order_no);
    setDirectPrint(true);
  }, [order]);

  useHotkey("f9", triggerPrint);
  /**
   * 专注态以「是不是真的全屏」为准回写。全屏里 ESC 被 WebView 自己拿去退出全屏，
   * 键盘事件根本到不了页面，不回写就会出现「全屏已退、界面还钉在 fixed inset-0」，
   * 只能摸回右上角那个按钮才能救回来。
   */
  useEffect(() => {
    const sync = () => setFocusMode(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const applyFocusMode = useCallback((next: boolean) => {
    setEditing(false);
    setFocusMode(next);
    if (next && !document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => undefined);
    // ESC 已经退掉全屏时这里可能再被调一次，对正在退出的窗口调 exitFullscreen 会 reject
    if (!next && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, []);
  const toggleFocusMode = useCallback(() => applyFocusMode(!focusMode), [applyFocusMode, focusMode]);
  useHotkey("f11", () => toggleFocusMode());
  // 覆盖层档（浏览器预览里 requestFullscreen 被拒）没有原生 ESC 可依，只能自己接一条
  useHotkey(
    "escape",
    () => {
      // 弹窗/抽屉开着时 ESC 该先关它们，不该顺手把专注态也退出
      if (document.querySelector('[data-slot="dialog-content"], [data-slot="sheet-content"]')) return;
      applyFocusMode(false);
    },
    { enabled: focusMode, allowInInput: true },
  );

  const partyId = order?.party_id ?? null;
  const { data: partyDetail } = useQuery({
    queryKey: ["party", partyId],
    queryFn: () => (partyId != null ? api.getParty(partyId) : Promise.resolve(null)),
    enabled: partyId != null,
  });
  const tareRecent = partyDetail?.tareHistory ?? [];
  const tareMean01kg = useMemo(() => {
    const r = tareRecent.slice(0, 5);
    return r.length === 0 ? null : Math.round(r.reduce((s, x) => s + x.tare_01kg, 0) / r.length);
  }, [tareRecent]);
  const currentTare01kg = order?.tare_weight_01kg ?? null;
  const tareAlert =
    currentTare01kg != null && tareMean01kg != null && tolerancePct > 0 &&
    Math.abs(currentTare01kg - tareMean01kg) > Math.round((tareMean01kg * tolerancePct) / 100);

  const variety = useMemo(() => varieties.find((v) => v.id === order?.variety_id) ?? null, [varieties, order?.variety_id]);
  const qc = useMemo(() => (order?.qc_report_id != null ? qcRows.find((r) => r.id === order.qc_report_id) ?? null : null), [qcRows, order?.qc_report_id]);
  const scaleDevice = devices.find((d) => d.kind === "scale");
  const cameras = useMemo(() => devices.filter((d) => d.kind === "camera" && d.is_enabled === 1), [devices]);
  const cameraDevice = cameras.find((c) => c.is_default === 1) ?? cameras[0] ?? null;
  const cameraOnline = !mockOff && cameraDevice?.last_status === "online";
  const photos = order?.photos ?? [];

  // ── 第三刷结算框：拿 settleNo 对应单的 order / variety / qc ──
  const { data: settleOrder } = useQuery({
    queryKey: ["order", settleNo],
    queryFn: () => (settleNo ? api.getOrder(settleNo) : Promise.resolve(null)),
    enabled: settleNo != null,
  });
  const { data: settleQcRows = [] } = useQuery({
    queryKey: ["qc-of-order", settleNo],
    queryFn: () => (settleNo ? api.listQc({ keyword: settleNo }) : Promise.resolve([])),
    enabled: settleNo != null,
  });
  const settleVariety = useMemo(() => varieties.find((v) => v.id === settleOrder?.variety_id) ?? null, [varieties, settleOrder?.variety_id]);
  const settleQc = useMemo(() => (settleOrder?.qc_report_id != null ? settleQcRows.find((r) => r.id === settleOrder.qc_report_id) ?? null : null), [settleQcRows, settleOrder?.qc_report_id]);

  // ── 打印目标（自动出码单可能是刚称那张，不是 URL 当前单） ──
  const { data: printOrder } = useQuery({
    queryKey: ["order", printTarget],
    queryFn: () => (printTarget ? api.getOrder(printTarget) : Promise.resolve(null)),
    enabled: printTarget != null,
  });
  const { data: printQcRows = [] } = useQuery({
    queryKey: ["qc-of-order", printTarget],
    queryFn: () => (printTarget ? api.listQc({ keyword: printTarget }) : Promise.resolve([])),
    enabled: printTarget != null,
  });
  const printQc = printOrder?.qc_report_id != null ? printQcRows.find((r) => r.id === printOrder.qc_report_id) ?? null : null;
  /** 只认 print_log 里成功的那几条（补打角标进监管台账，不能由"对话框开合过"决定） */
  const printTimes = (printOrder?.prints ?? []).filter((p) => p.doc_type === "weigh_order" && p.result === "success").length;

  /** 直打触发点（第二刷皮重后自动 / F9·按钮手动）：先无预览直打，失败（回 "preview"）才弹预览框兜底 */
  useEffect(() => {
    if (!directPrint || !printTarget || !station || !printOrder) return;
    if (printedFor.current === printTarget) return;
    printedFor.current = printTarget;
    void (async () => {
      const out = await printReceiptSilently({
        scenario: "weigh_order",
        docNo: printTarget,
        isReprint: printTimes > 0,
        context: { station, names, order: printOrder, qc: printQc },
        devices,
      });
      if (out === "preview") setPrintOpen(true);
      else qcClient.invalidateQueries({ queryKey: ["order", printTarget] });
      setDirectPrint(false);
    })();
  }, [directPrint, printTarget, station, printOrder, printQc, names, devices, printTimes, qcClient]);

  /** 面板本体按 id 收在这儿；身份与制单已移到弹窗，不在格子里 */
  const bodies: Record<PanelId, ReactNode> = {
    tare: <TarePanel recent={tareRecent.slice(0, 5)} last01kg={partyDetail?.last_tare_01kg ?? null} mean01kg={tareMean01kg} tolerancePct={tolerancePct} currentTare01kg={currentTare01kg} alert={tareAlert} partyId={partyId} />,
    camera: <CameraPanel cameras={cameras} order={order ?? null} photos={photos} mockOff={mockOff} />,
    weigh: <WeighPanel order={order ?? null} mean01kg={tareMean01kg} tolerancePct={tolerancePct} scalePort={String(scaleDevice?.config?.port ?? "COM1")} scaleDivision01kg={division01kg} cameraOnline={cameraOnline} />,
    qc: <QcPanel order={order ?? null} variety={variety} />,
    settle: <PrintPanel order={order ?? null} variety={variety} qc={qc} prices={prices} onPrint={triggerPrint} />,
  };

  const openOrdersHint = order ? `${order.variety_name}${order.grade ? ` · ${order.grade}` : ""}` : "未制单";

  return (
    <div className={focusMode ? "fixed inset-0 z-40 flex flex-col bg-background" : "flex min-h-0 flex-1 flex-col"}>
      {!focusMode && (
        <PageHeader
          title="磅房工作台"
          description={
            <>
              制单后一张流转卡<b className="font-semibold">刷一次推进一步</b>：毛重 → 皮重（自动出码单）→ 结算。
              <Kbd>F7</Kbd> 制单 <Kbd>空格</Kbd>/<Kbd>P</Kbd> 应急手点捕获 <Kbd>F5</Kbd> 化验 <Kbd>F9</Kbd> 打印
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
              <Button size="sm" onClick={() => setRegOpen(true)}>
                <UserRoundPlusIcon />
                制单（F7）
              </Button>
              <Button size="sm" variant="outline" onClick={() => board.togglePanel("camera", showCam)}>
                <CctvIcon />
                {showCam ? "隐藏画面" : "过磅画面"}
              </Button>
              <Button size="sm" variant="outline" onClick={triggerPrint} disabled={!order}>
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
                  board.flush();
                  setEditing((v) => !v);
                }}
              >
                <LayoutGridIcon />
                {editing ? "完成" : "自定义布局"}
              </Button>
              <Button size="sm" variant="outline" onClick={toggleFocusMode}>
                <Maximize2Icon />
                全屏专注（F11）
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
          <WorkstationGrid items={board.items} editing={editing} onLayout={board.applyLayout} onCommit={board.flush}>
            {board.tiles.map(({ spec }) => (
              <PanelTile key={spec.id} spec={spec} editing={editing} onHide={() => board.togglePanel(spec.id, true)}>
                {bodies[spec.id]}
              </PanelTile>
            ))}
          </WorkstationGrid>
        )}
      </div>

      {!focusMode && <OpenOrdersBar activeNo={orderNo} onPick={(no) => goOrder(no)} />}

      {/* 制单弹窗（身份与制单，05 §4.0） */}
      <RegistrationDialog
        open={regOpen}
        onOpenChange={setRegOpen}
        parties={parties}
        varieties={varieties}
        warehouses={warehouses}
        slots={slots}
        lastVarietyId={variety?.id ?? null}
        onCreated={(no) => goOrder(no)}
      />

      {/* 第三刷结算框：复用 SettleForm（与 /scan-settle 同一条算钱口径，06 §6.3） */}
      <Dialog open={settleNo != null} onOpenChange={(v) => !v && setSettleNo(null)}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">结算 {settleNo ?? ""}</DialogTitle>
          </DialogHeader>
          {settleOrder ? (
            <SettleForm
              order={settleOrder}
              variety={settleVariety}
              qc={settleQc}
              prices={prices}
              allowCredit={allowCredit}
              submitLabel="确认结算并收款"
              submitHotkey={null}
              onSettled={(r) => {
                toast.success(`已结算 ${r.order.order_no}，本单卡自动回池`);
                qcClient.invalidateQueries({ queryKey: ["order", r.order.order_no] });
                qcClient.invalidateQueries({ queryKey: ["orders"] });
                qcClient.invalidateQueries({ queryKey: ["open-orders"] });
                qcClient.invalidateQueries({ queryKey: ["settlements"] });
                qcClient.invalidateQueries({ queryKey: ["dashboard"] });
                setSettleNo(null);
              }}
            />
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">读取磅单中…</p>
          )}
        </DialogContent>
      </Dialog>

      {/* 出码单：自动（第②刷）或手动（F9 / 凭票面板），打的是 printOrder */}
      {printOrder && station ? (
        <ReceiptPrintPreview
          open={printOpen}
          onOpenChange={(v) => {
            setPrintOpen(v);
            if (!v) setPrintTarget(null);
          }}
          scenario="weigh_order"
          context={{ station, names, order: printOrder, qc: printQc, reprint: printTimes > 0 }}
          isReprint={printTimes > 0}
          docNo={printOrder.order_no}
          onPrinted={() => qcClient.invalidateQueries({ queryKey: ["order", printOrder.order_no] })}
        />
      ) : (
        printOpen && <EmptyState title="还没有可打印的磅单" description="请先取号制单并完成称重。" />
      )}

      {focusMode && (
        <div className="absolute right-4 top-4 z-50">
          <Button size="sm" variant="outline" onClick={toggleFocusMode}>
            <Minimize2Icon />
            退出专注（Esc / F11）
          </Button>
        </div>
      )}

      <span className="sr-only">{`${openOrdersHint} ${date(order?.registered_at)} ${weight(order?.net_weight_01kg)}`}</span>
    </div>
  );
}
