/**
 * 磅房工作台（05 §4 核心界面）。
 *
 * 交互已从"点按钮"改成"刷卡推进"（06 篇）：新人来料直接在常驻的「身份与制单」格里读卡、选品种、
 * 取号制单（刷到一张空闲流转卡而库里没有在途单时，也走这一格就地制单、制即绑卡，不再弹制单框）；
 * 需要更聚焦地填单时才点「制单」/F7 弹出同一份 `IdentityPanel` 的弹窗版 → 关框。
 * 之后一张流转卡刷一次推进一步——①刷捕毛重 ②刷捕皮重并自动出码单 ③刷弹结算框（复用 SettleForm）
 * 选付款方式完成结算。工作台后台常听 IC（`useIcWorkflow` 唯一收口），弹窗读身份证时让出设备锁。
 * 读卡器故障 / 关掉流转卡时，称重/结算面板仍可应急手点（05 §10-1 无外设闭环）。
 *
 * 结算另有一条入口：客户拿着打过码单的票回来，在工作台用扫码枪扫票面码（`BH1:`）即就地弹同一个
 * 结算框（`useScannerCapture` 常驻捕获，与 `/scan-settle` 共用 `settle-gate.ts` 的判定与话术），
 * 扫进来的若是质检单/结算凭证/付款凭证/作废/已结单，当场用人话说清"这是什么、该上哪儿去"。
 *
 * 排布按登录账号存进 §9.25，磅员/化验员/站长共用一台机互不影响（05 §4.1）。「身份与制单」
 * 已按最初的版本回归常驻格子（05 §4 ①），「制单」弹窗那条路也在：两者是同一个 `IdentityPanel`，
 * 弹窗开着时这一格让位，读卡回读只被一个实例认领。
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
import { useScannerCapture } from "@/hooks/useScannerCapture";
import { parseScannedCode, settleable } from "@/lib/ticket-code";
import { scanRejectNote, settleGateOf } from "@/lib/settle-gate";
import { announce } from "@/lib/voice-prompt";
import { useDeviceStore } from "@/store/device";
import { useSession } from "@/store/session";
import { date, weight, varietyLabel } from "@/lib/format";
import { IdentityPanel, TarePanel, draftFromOrder, emptyDraft, type OrderDraft } from "@/components/workstation/IdentityPanel";
import { WeighPanel } from "@/components/workstation/WeighPanel";
import { QcPanel } from "@/components/workstation/QcPanel";
import { OpenOrdersBar } from "@/components/workstation/OpenOrdersBar";
import { CameraPanel } from "@/components/workstation/CameraPanel";
import { localCameraSpec } from "@/lib/local-camera";
import { ipCameraSpec } from "@/components/business/IpCameraLive";
import { PanelTile, WorkstationGrid } from "@/components/workstation/WorkstationGrid";
import { useWorkstationLayout } from "@/components/workstation/layout";
import type { PanelId } from "@/components/workstation/layout";
import { RegistrationDialog } from "@/components/workstation/RegistrationDialog";
import { useIcWorkflow } from "@/components/workstation/useIcWorkflow";
import { SettleForm } from "@/components/settlement/SettleForm";
import { TicketPrintSection } from "@/components/settlement/TicketPrintSection";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSilentReceiptPrint } from "@/components/print/receipt/useSilentPrint";
import { useQuickDetail } from "@/components/business/quickDetail";
import { DeviceStatusStrip } from "@/components/business/DeviceStatusBar";
import { Kbd, PageHeader } from "@/components/business/layout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function WorkstationPage() {
  const { orderNo } = useSearch({ from: "/workstation" });
  const navigate = useNavigate();
  const qcClient = useQueryClient();
  const openQuickDetail = useQuickDetail((s) => s.open);
  const maySettle = useSession((s) => s.can("settle.create"));
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

  const tolerancePct = useSetting("tare_tolerance_pct").num / 100;
  const division01kg = useSetting("scale_division_01kg").num || 100;
  const allowCredit = useSetting("settlement_allow_part_pay").bool;

  /**
   * 制单草稿：左栏「身份与制单」面板自己的表单状态（没单时是草稿，取号成功即切成摘要态）。
   * 「制单」弹窗另存一份本地草稿（`RegistrationDialog`），两边不共享——共享就会互相改掉对方
   * 正填的品种/车牌，而读卡回读本来就一次只该被一个实例认领（06 §1.2）。
   */
  const [draft, setDraft] = useState<OrderDraft>(() => emptyDraft(null));
  const setDraftPatch = useCallback((patch: Partial<OrderDraft>) => setDraft((d) => ({ ...d, ...patch })), []);

  /** 制单弹窗 */
  const [regOpen, setRegOpen] = useState(false);
  /** 刷卡带进来的那张卡：刷到空闲卡却没有在途单时由 `useIcWorkflow` 交下来，制单即绑它 */
  const [regCard, setRegCard] = useState<string | null>(null);
  /** 第三刷要结算的单号（null = 结算框关着） */
  const [settleNo, setSettleNo] = useState<string | null>(null);
  /** 打印目标：自动出码单时是被称的那张单，手动打印时是当前单；null 回落到当前 order */
  const [printTarget, setPrintTarget] = useState<string | null>(null);
  /**
   * 「直打」触发器：第二刷皮重后自动出码单、F9、结算弹窗的「凭票打印」与顶部按钮共用这一条路——
   * 无预览直接打（silent.ts 按模板纸型分流热敏直连 / 打印队列直打，纸张随打印机配置），
   * 只有真打不出去（浏览器演示、设备离线、队列报错）才回退弹预览框。
   * 这条路与磅单详情的补打共用 `useSilentReceiptPrint`，出纸口解析只有一份实现。
   */
  const [directPrint, setDirectPrint] = useState(false);
  const { print: printReceipt, preview: printFallback } = useSilentReceiptPrint();
  const printedFor = useRef<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [editing, setEditing] = useState(false);
  const board = useWorkstationLayout();
  const showCam = !board.hidden.includes("camera");

  const goOrder = useCallback(
    (no: string | null) => void navigate({ to: "/workstation", search: { orderNo: no ?? undefined } }),
    [navigate],
  );

  /** 「新建下一单」：草稿沿用刚那张单的品种/车牌/去向（磅房最省手），然后把当前单清空回到制单态 */
  const newOrder = useCallback(() => {
    if (order) setDraft(draftFromOrder(order));
    goOrder(null);
  }, [order, goOrder]);

  // 弹窗开着时让出读卡器（06 §1.2）：自己的制单弹窗用 regOpen 即时 pause；
  // 顶部工具条「新建过磅单」开的是同一张弹窗，通过 regHolding 让位；结算框展示期间同样不起 IC 监听
  const regHolding = useDeviceStore((s) => s.regHolding);
  // 常驻面板自己弹读卡/绑卡框时占用共用读卡器：只让后台 IC 常听让位，不换占位卡（否则连带卸载开框的面板本身）
  const panelHolding = useDeviceStore((s) => s.panelHolding);
  // 抓拍机（04 §4）：可用性判据与 CameraPanel「这格能不能出画面」逐字对齐——本机 USB 摄像头看
  // WebView2 能不能开那条流（localCameraSpec），内网 IP 机看台账里 host 有没有填（ipCameraSpec，
  // Mock 档已在里面排除），二者都不成立时退回 last_status 兜底。
  // 三条都不能少：只认 last_status 会把「海康自动检测没跑联机测试」的活机误判成离线（RTSP 画面
  // 明明在动，服务端却跳过抓拍，两次捕获都无照片）；只认 config.host 又会让 Mock 档被拉去等 3 秒。
  // 必须在 useIcWorkflow 之前算出来——捕获瞬间的取帧回传归它管。
  // 参与过磅抓拍的是台账里勾了 `config.captureOnWeigh` 的相机，最多 3 台（默认优先、按 id 序，
  // 与真库 `camera::list_capture_cameras` 同口径）；CameraPanel 的画面墙仍按全部启用相机显示。
  const cameras = useMemo(() => devices.filter((d) => d.kind === "camera" && d.is_enabled === 1), [devices]);
  const captureCams = useMemo(
    () =>
      cameras
        .filter((c) => c.config?.captureOnWeigh === true)
        .slice()
        .sort((a, b) => (b.is_default - a.is_default) || (a.id - b.id))
        .slice(0, 3),
    [cameras],
  );
  const anyCamOnline = captureCams.some(
    (c) => localCameraSpec(c) != null || ipCameraSpec(c) != null || c.last_status === "online",
  );
  useIcWorkflow({
    paused: regOpen || settleNo != null || regHolding || panelHolding,
    captureCams,
    anyCamOnline,
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
    onRequestRegister: (card) => {
      // 卡还在感应区上：不再弹制单框，直接把工作台切回制单草稿态并把这张卡交给常驻面板，
      // IdentityPanel 经 presetCardNo 就位，选好售粮人点「取号并制单」即随单绑上（06 §4.0 同事务）
      goOrder(null);
      setRegCard(card);
    },
    // 刷到在途卡＝把整台工作台定位到这张卡绑的单，仪表离线/读数未稳也照样切：
    // 面板报的是"这一刷属于谁"，写库那一步自有闸门拦着（06 §4.2）。
    // 只在单号真的变了时导航——同一张卡反复刷不该往 history 里塞一串同样的 URL。
    onFocusOrder: (no) => {
      if (no !== orderNo) goOrder(no);
    },
  });

  /**
   * 扫票面码快速结算（02 §F1.4 的另一半入口）：与 `/scan-settle` 同一套判定与话术
   * （`settle-gate.ts`），扫到一张**可直接结算的码单**就地弹第三刷那个 `SettleForm` 结算框，
   * 省掉"过完磅还要切去结算窗口再扫一次"。判据、算钱、出票全共用同一份实现，两条入口
   * 对同一张票一定给出同一个结论。
   */
  const handleScan = useCallback(
    async (raw: string) => {
      const code = parseScannedCode(raw);
      // 不是一张能直接结算的码单（质检单 / 结算凭证 / 付款凭证 / 认不出）：说清楚这是什么、该上哪儿去
      if (!settleable(code)) {
        const note = scanRejectNote(code);
        if (note) {
          const msg = `${note.text}`;
          if (note.tone === "danger") toast.error(msg, { id: "ws-scan-reject" });
          else if (note.tone === "warning") toast.warning(msg, { id: "ws-scan-reject" });
          else toast.info(msg, { id: "ws-scan-reject" });
          announce("这张票在这儿结不了，请核对票面是不是收购码单", "ws-scan-reject");
        }
        return;
      }
      const no = code.docNo;
      let scanned;
      try {
        scanned = await api.getOrder(no);
      } catch {
        toast.error(`读不到磅单 ${no}，请到「磅单中心」核对单号`, { id: `ws-scan-read:${no}` });
        return;
      }
      // bill 传 null：工作台没预取结算单，"已结算"判据靠 settled_at/status 已足够准（见 settle-gate.ts）
      const gate = settleGateOf(scanned ?? null, null, maySettle, allowCredit);
      if (gate) {
        const msg = `${gate.title}：${gate.body}`;
        if (gate.tone === "danger") toast.error(msg, { id: `ws-scan-gate:${no}` });
        else if (gate.tone === "warning") toast.warning(msg, { id: `ws-scan-gate:${no}` });
        else toast.info(msg, { id: `ws-scan-gate:${no}` });
        announce(gate.title, `ws-scan-gate:${no}`);
        return;
      }
      goOrder(no);
      setSettleNo(no);
      if (!code.prefixed) toast.info(`按单号 ${no} 取单（没扫到票面码，可能是手输或旧版票）`);
      // 成功进结算框刻意不插话：接下来由结算框（SettleForm）自己念它的话术，与第三刷同一处理
    },
    [maySettle, allowCredit, goOrder],
  );

  // 弹窗/结算框开着时不捕获扫码：那会儿焦点在弹层里，扫进来的码不该把底下的单换掉。
  // 与扫码窗口同款后台常驻捕获（键盘枪免聚焦，`useScannerCapture` 已反向让位在输入框里打字的人）。
  useScannerCapture((raw) => void handleScan(raw), { enabled: !regOpen && settleNo == null });

  // F7（制单）已收进顶部工具条作全局键：任何页面都弹同一张 RegistrationDialog，
  // 这里不再重复绑定，避免一次按键叠出两层弹窗
  /**
   * 打某一张单的码单：不弹预览，直接打到默认打印机（热敏纸直连小票机，A4/针式进打印队列、
   * 纸张随打印机自身配置）。不传单号时打当前 URL 那张单（F9 / 顶部按钮），结算弹窗里的
   * 「凭票打印」则显式传入本单号。重复打同一张也算一次新的直打（补打场景），所以先清
   * printedFor 闸门；只有直打真失败时 effect 才回退弹预览框。
   */
  const triggerPrint = useCallback(
    (no?: string | null) => {
      const target = no ?? order?.order_no;
      if (!target) return;
      printedFor.current = null;
      setPrintTarget(target);
      setDirectPrint(true);
    },
    [order],
  );

  useHotkey("f9", () => triggerPrint());
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

  const partyId = order?.party_id ?? draft.party?.id ?? null;
  const { data: partyDetail } = useQuery({
    queryKey: ["party", partyId],
    queryFn: () => (partyId != null ? api.getParty(partyId) : Promise.resolve(null)),
    enabled: partyId != null,
  });
  const tareRecent = partyDetail?.tareHistory ?? partyDetail?.tare_history ?? [];
  const tareMean01kg = useMemo(() => {
    const r = tareRecent.slice(0, 5);
    return r.length === 0 ? null : Math.round(r.reduce((s, x) => s + x.tare_01kg, 0) / r.length);
  }, [tareRecent]);
  const currentTare01kg = order?.tare_weight_01kg ?? null;
  const tareAlert =
    currentTare01kg != null && tareMean01kg != null && tolerancePct > 0 &&
    Math.abs(currentTare01kg - tareMean01kg) > Math.round((tareMean01kg * tolerancePct) / 100);

  const variety = useMemo(
    () => varieties.find((v) => v.id === (order?.variety_id ?? draft.varietyId)) ?? null,
    [varieties, order?.variety_id, draft.varietyId],
  );
  const scaleDevice = devices.find((d) => d.kind === "scale");
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
    void printReceipt({
      scenario: "weigh_order",
      docNo: printTarget,
      isReprint: printTimes > 0,
      context: { station, names, order: printOrder, qc: printQc },
    });
    setDirectPrint(false);
  }, [directPrint, printTarget, station, printOrder, printQc, names, printTimes, printReceipt]);

  /** 面板本体按 id 收在这儿；凭票与打印进了结算弹窗，制单弹窗开着时「身份与制单」这一格让位 */
  const bodies: Record<PanelId, ReactNode> = {
    identity:
      regOpen || regHolding ? (
        <RegYieldCard />
      ) : (
        <IdentityPanel
          order={order ?? null}
          draft={draft}
          onDraft={setDraftPatch}
          parties={parties}
          varieties={varieties}
          warehouses={warehouses}
          slots={slots}
          presetCardNo={regCard}
          onCreated={(no) => {
            setRegCard(null); // 这张卡已随单绑上，别让它在下一张草稿里残留
            goOrder(no);
          }}
          onNewOrder={newOrder}
        />
      ),
    tare: <TarePanel recent={tareRecent.slice(0, 5)} last01kg={partyDetail?.last_tare_01kg ?? null} mean01kg={tareMean01kg} tolerancePct={tolerancePct} currentTare01kg={currentTare01kg} alert={tareAlert} partyId={partyId} />,
    camera: <CameraPanel cameras={cameras} order={order ?? null} photos={photos} />,
    weigh: <WeighPanel order={order ?? null} mean01kg={tareMean01kg} tolerancePct={tolerancePct} scalePort={String(scaleDevice?.config?.port ?? "COM1")} scaleDivision01kg={division01kg} anyCamOnline={anyCamOnline} captureCams={captureCams} />,
    qc: <QcPanel order={order ?? null} variety={variety} />,
  };

  const openOrdersHint = order
    ? `${varietyLabel(order.variety_name)}${order.grade ? ` · ${order.grade}` : ""}`
    : draft.party
      ? `${draft.party.name} · 未制单`
      : "未制单";

  return (
    <div className={focusMode ? "fixed inset-0 z-40 flex flex-col bg-background" : "flex min-h-0 flex-1 flex-col"}>
      {!focusMode && (
        <PageHeader
          title="磅房工作台"
          description={
            <>
              制单后一张流转卡<b className="font-semibold">刷一次推进一步</b>：毛重 → 皮重（自动出码单）→ 结算。
              客户拿码单回来<b className="font-semibold">直接扫票面码</b>就地结算，不必切去扫码窗口。
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
              <Button size="sm" variant="outline" onClick={() => triggerPrint()} disabled={!order}>
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
      {/* 专注层是 fixed inset-0，会把 AppShell 那条常驻设备状态条整个盖住；设备故障是现场最高频问题，
          抬头就得看见，所以覆盖层底部补挂一份纯展示的（闸门与读卡探测仍只有被盖住的那份在跑） */}
      {focusMode && <DeviceStatusStrip />}

      {/* 制单弹窗（身份与制单，05 §4.0） */}
      <RegistrationDialog
        open={regOpen}
        onOpenChange={(v) => {
          setRegOpen(v);
          if (!v) setRegCard(null); // 关框即丢掉那张卡，下次开窗不该带着上一张
        }}
        cardNo={regCard}
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
            <>
              <SettleForm
                order={settleOrder}
                variety={settleVariety}
                qc={settleQc}
                prices={prices}
                allowCredit={allowCredit}
                submitLabel="确认结算并付款"
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
              {/* 原右栏「凭票与打印」面板撤除，出票/补打入口收进本弹窗 */}
              <TicketPrintSection order={settleOrder} onPrint={() => triggerPrint(settleNo)} />
            </>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">读取磅单中…</p>
          )}
        </DialogContent>
      </Dialog>

      {/* 出码单：自动（第②刷）或手动（F9 / 顶部按钮 / 结算弹窗「凭票打印」），打的是 printOrder。
          直打失败时的兜底预览框由 hook 给出，没发起过出票就是 null */}
      {printFallback}

      {focusMode && (
        <div className="absolute right-3 top-3 z-50">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="outline"
                  className="bg-background/80 shadow-xs backdrop-blur-xs hover:bg-background"
                  onClick={toggleFocusMode}
                  aria-label="退出专注（Esc / F11）"
                />
              }
            >
              <Minimize2Icon />
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end">
              退出专注（Esc / F11）
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      <span className="sr-only">{`${openOrdersHint} ${date(order?.registered_at)} ${weight(order?.net_weight_01kg)}`}</span>
    </div>
  );
}

/**
 * 「身份与制单」让位卡：制单弹窗开着时那一格不挂第二份 `IdentityPanel`。
 * 读卡回读走的是跨页面共享的设备缓存，两个实例同时在场上会把同一张卡认领两次
 * （两条 toast、两声播报、两次补照片），而一次制单只该有一个主人。弹窗关掉即回到草稿态。
 */
function RegYieldCard() {
  return (
    <div className="flex h-full min-h-16 items-center justify-center rounded-2xl border border-dashed px-3 text-center text-xs text-muted-foreground">
      制单弹窗已打开：读卡与取号由那一框认领，关掉这里就回到草稿态
    </div>
  );
}
