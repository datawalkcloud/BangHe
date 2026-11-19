/**
 * 磅房工作台（05 §4 核心界面）。
 *
 * 交互已从"点按钮"改成"刷卡推进"（06 篇）：新人来料直接在常驻的「身份与制单」格里读卡、选品种、
 * 取号制单（刷到一张空闲流转卡而库里没有在途单时，也走这一格就地制单、制即绑卡，不再弹制单框）；
 * 需要更聚焦地填单时才点「制单」/F7 弹出同一份 `IdentityPanel` 的弹窗版 → 关框。
 * 之后一张流转卡刷一次推进一步——①刷捕毛重 ②刷捕皮重，净重一到位就自动出码单，
 * **同时把结算这一步一并走掉**：磅单上已经有价就直接按未付款挂账结掉，没有价才弹结算框
 * （默认未支付）让人现场定价；③需要收钱的场合再刷一次卡，弹同一个结算框（复用 SettleForm）
 * 选付款方式当场结清。这一步的判定只有一份（`lib/settle-defaults.ts::postWeighAction`），
 * 手点捕获与刷卡捕获走的是同一个出口，否则同一次过磅会因"是刷的还是点的"得出两种结果。
 * 工作台后台常听 IC（`useIcWorkflow` 唯一收口），弹窗读身份证时让出设备锁。
 * 读卡器故障 / 关掉流转卡时，称重/结算面板仍可应急手点（05 §10-1 无外设闭环）。
 *
 * **页头可切「出库」模式**（偏好键 `workstation.mode`，默认入库）：出库那张桌子不摆身份、
 * 化验、抓拍与在途条，左边是草稿出库队列、右边是选中单的摘要与 `OutboundWeighPanel`；
 * 扫出库码单只定位那一张，称毛重 → 皮重 → 「完成出库」扣库存并算货款（02 §M11 F11.6/F11.7）。
 * 出库不过结算窗口、不推流转卡，也不听 IC（`useIcWorkflow` 在出库模式整条让位）——
 * 出库单不绑流转卡，让后台继续听卡只会在出库板面上把某张在途磅单悄悄定位出来。
 * 两条模式各认各的纸：入库只认磅单码，出库只认出库码，撞号时当场说破。
 *
 * 客户拿着打过码单的票回来，就在工作台用扫码枪扫票面码（02 §F1.4）就地走到钱那一步
 * （`useScannerCapture` 常驻捕获，判定与话术收在 `settle-gate.ts`，与第三刷、称重区
 * 「去结算」共用一份）。**入库模式下磅房作业只认磅单码**：本版的码里装的就是票面那行单号，扫进来
 * 按磅单查库——查到就分给两个框之一（还没算钱 → `SettleForm` 当场算清；算过钱、钱没付完 →
 * 补付框 `PayDialog`，里面就是那份 `PayForm`）。分派收在 `requestSettle` 这一条上，
 * 框体本身也与「磅单详情」卡片底部那枚「付款」共用（`components/settlement/PayDialog.tsx`）。
 * 结算凭证从前也带一枚能扫的"凭单码（挂账核销时扫）"，随本版一起退役：那张纸上的钱改在
 * 「结算台账」点开那张结算单、或从磅单详情那枚「付款」进同一个框登记——**同一份判定同一个框**，
 * 少掉的只是"把纸递到枪底下"这一下。递错纸（质检单 / 付款凭证 / 出库单）与认不出的码，
 * 当场用人话说清"这是什么、该上哪儿去"。
 *
 * 排布按登录账号存进 §9.25，磅员/化验员/站长共用一台机互不影响（05 §4.1）。「身份与制单」
 * 已按最初的版本回归常驻格子（05 §4 ①），「制单」弹窗那条路也在：两者是同一个 `IdentityPanel`，
 * 弹窗开着时这一格让位，读卡回读只被一个实例认领。
 * 低频留痕（称重轨迹、原始帧、历史皮重）不常驻，只在「单证详情 / 农户档案」里看。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLinkIcon, PrinterIcon, CctvIcon, Maximize2Icon, Minimize2Icon, LayoutGridIcon, PanelTopIcon, PlusIcon, RotateCcwIcon, UserRoundPlusIcon } from "lucide-react";
import { api } from "@/lib/api";
import { useSetting, useStaffNames, useStation, useVarieties, useWarehouses, useSlots, usePrices } from "@/hooks/useLookups";
import { useHotkey } from "@/hooks/useHotkey";
import { useScannerCapture } from "@/hooks/useScannerCapture";
import { parseScannedCode, settleable, type ScannedCode } from "@/lib/ticket-code";
import { tareMean01kg as tareMeanOf, tareOverTolerance, tareRefRows } from "@/lib/tare-ref";
import { awaitingPayment, creditPayGate, scanRejectNote, settleGateOf, unpaidFen, type GateTone, type SettleGate } from "@/lib/settle-gate";
import { announce } from "@/lib/voice-prompt";
import { postWeighAction, settleDefaults } from "@/lib/settle-defaults";
import type { OutboundDetail, QcReport, WeighOrder } from "@/mock/types";
import { OUTBOUND_STATUS } from "@/lib/constants";
import { useDeviceStore, selectScale } from "@/store/device";
import { actorId, useSession } from "@/store/session";
import { date, money, ton, weight, varietyLabel } from "@/lib/format";
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
import { ScanTestBar } from "@/components/workstation/ScanTestBar";
import { OutboundBoard } from "@/components/workstation/OutboundBoard";
import { OutboundFormDialog } from "@/components/outbound/OutboundFormDialog";
import { useWorkstationMode } from "@/hooks/useWorkstationMode";
import { useIcWorkflow } from "@/components/workstation/useIcWorkflow";
import { SettleForm } from "@/components/settlement/SettleForm";
import { PayDialog } from "@/components/settlement/PayDialog";
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
  /**
   * 扫票面码与第三刷那条路：结算要出纳或站长。与 `settle-gate.ts` 同一口径，
   * 磅员**不在**这条上——他的挂账权只够覆盖磅房过磅流程里那一步，不够替客户算钱。
   */
  const maySettle = useSession((s) => s.can("settle.create"));
  /**
   * 磅房过磅那条路：磅员也能把刚称完的单挂上账（`settle.credit`），但**只挂账、不碰现金**
   * ——当场付款那一支在结算框里另要 `pay.record`。净重刚定那一步按未付款走，所以两条权
   * 任有一条就够推进（见下方 `handleNetDetermined`）。
   */
  const mayCreditSettle = useSession((s) => s.can("settle.credit"));
  /**
   * 收钱这一格（挂账补付）：出纳或站长（`pay.record`，与 `settle.create` 同两人，但它是
   * 另一把钥匙——补付不需要结算权，红冲后重结那类场合两者也不是一回事）。
   */
  const mayPay = useSession((s) => s.can("pay.record"));
  /** 出库侧那几枚按钮与出库详情页同一把钥匙（`outbound.create` / `print`），不另立新权 */
  const can = useSession((s) => s.can);
  const names = useStaffNames();
  const { data: varieties = [] } = useVarieties();
  const { data: warehouses = [] } = useWarehouses();
  const { data: slots = [] } = useSlots();
  const { data: prices = [] } = usePrices();
  const { data: station } = useStation();
  const { data: parties = [] } = useQuery({ queryKey: ["parties", ""], queryFn: () => api.listParties("") });
  const { data: devices = [] } = useQuery({ queryKey: ["devices"], queryFn: () => api.listDevices(), staleTime: 60_000 });

  /**
   * 工作模式（入库 / 出库），按账号存 §9.25 `workstation.mode`。默认入库：升级后第一眼
   * 还是原来那张桌子；模式开关在页头，切过去只换板面，不切库、不切会话。
   */
  const { mode, loading: modeLoading, set: setModePref } = useWorkstationMode();
  const outboundMode = mode === "out";
  /**
   * 出库模式的当前单据与表单。单号存页面本地：出库没有"在途条点卡片接着干"那样的外链入口，
   * 不需要占 URL；离开这一页再回来即从草稿队列重新选。
   */
  const [outboundNo, setOutboundNo] = useState<string | null>(null);
  const [outboundForm, setOutboundForm] = useState<{ open: boolean; editing: OutboundDetail | null }>({ open: false, editing: null });

  const { data: order, isLoading } = useQuery({
    queryKey: ["order", orderNo],
    queryFn: () => (orderNo ? api.getOrder(orderNo) : Promise.resolve(null)),
    enabled: !!orderNo,
  });

  /**
   * 出库模式的当前单与草稿队列。两条查询都只在出库模式下才发——入库那一侧一条不多拉。
   * 队列只取 `status='draft'`：已过账的单不能再称重，留在队列里只会让人点了才发现。
   */
  const outboundQuery = useQuery({
    queryKey: ["outbound", outboundNo],
    queryFn: () => (outboundNo ? api.getOutbound(outboundNo) : Promise.resolve(null)),
    enabled: outboundMode && outboundNo != null,
  });
  const outboundDoc = outboundQuery.data ?? null;
  const draftsQuery = useQuery({
    queryKey: ["outbound", "workbench-drafts"],
    queryFn: () => api.listOutbound({ status: "draft", page_size: 200 }),
    enabled: outboundMode,
  });
  const outboundDrafts = draftsQuery.data?.rows ?? [];
  /** 已打几张只看 `print_log` 里真出过纸的那几条，与详情页同一口径 */
  const outboundPrinted = (outboundDoc?.prints ?? []).filter((p) => p.result === "success").length;

  const tolerancePct = useSetting("tare_tolerance_pct").num / 100;
  // 分度值不走站点参数（`scale_division_01kg` 已由 0032 退役）：它是设备属性，
  // 称重区那一格直接读后端随帧下发的 `scale.division01kg`，与落库取整同源。
  const allowCredit = useSetting("settlement_allow_part_pay").bool;
  /**
   * 站点参数 `scan_test_input`（**默认关**）：没有扫码枪的机器（还没接枪、枪坏了、
   * 浏览器演示）在工作台底部挂一个测试扫码框。关掉时那一整条不渲染，界面与从前逐字一致。
   */
  const scanTestInput = useSetting("scan_test_input").bool;
  // 自动出码单默认开：参数还没读回来时 raw 是 undefined，不能按"缺省关"把升级后的
  // 第一趟过磅静默吞掉（与 useVoicePrompt 同一条道理），只认显式的 "false"
  const autoPrintWeigh = useSetting("auto_print_weigh_order").raw !== "false";

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
  /**
   * 窗口上那张**补付框**要收钱的结算单号（null = 框关着）。
   *
   * 与 `settleNo` 是两个框、两笔动作：`settleNo` 那一框在算钱（`api.settle`，库里没结过的单才进得去），
   * 这一框在收钱（`api.recordPayment`，钱已经算过、还没付完的单才进得去）。两条路的判据、
   * 话术与出票各自单源（`settle-gate.ts` / `PayForm.tsx`），合成一个框迟早让人对着
   * 一张已结算的单再算一遍钱——那正是不变式 6 在库里拦的东西。
   */
  const [payNo, setPayNo] = useState<string | null>(null);
  /**
   * 这次开结算框按「未付款（挂账）」起步吗。
   *
   * 只有"净重刚定、磅单上又没价"那一条路给 true（现场节奏：过完磅就走、钱回头再算）。
   * 第三刷与扫票保持默认的当场付清。这是个粘住的状态，所以**每一处开框都要显式给值**——
   * 上一单留下的"未付款"意图会让下一单莫名其妙挂出一笔账。
   */
  const [settleUnpaid, setSettleUnpaid] = useState(false);
  /** 同一次过磅只推进一次：手点捕获与刷卡捕获是两条出口，可能几乎同时到达 */
  const advancedFor = useRef<string | null>(null);
  /** 打印目标：自动出码单时是被称的那张单，手动打印时是当前单；null 回落到当前 order */
  const [printTarget, setPrintTarget] = useState<string | null>(null);
  /**
   * 「直打」触发器：第二刷皮重后自动出码单、F9、结算弹窗的「凭票打印」与顶部按钮共用这一条路——
   * 无预览直接打（silent.ts 按模板纸型分流热敏直连 / 打印队列直打，纸张随打印机配置），
   * 只有真打不出去（浏览器演示、设备离线、队列报错）才回退弹预览框。
   * 这条路与磅单详情的补打共用 `useSilentReceiptPrint`，出纸口解析只有一份实现。
   *
   * 记的是**自增序号**而不是 `boolean`：`setState(同值)` 不引发重渲染，而"目标单号没变、
   * 布尔量又已经在位"恰恰是常态（连续两车之间不导航、同一张单再打一次），那时整个
   * `triggerPrint` 会退化成空操作，直打 effect 不重跑，票就静默不出来。序号保证每一次出票
   * 意图都是一次真实的状态变化；重复出票仍由 `printedFor` 那道闸门管。
   */
  const [printSeq, setPrintSeq] = useState(0);
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
  // 顶部工具条「新建过磅单」开的是同一张弹窗，通过 regHolding 让位；结算框与补付框展示期间同样不起 IC 监听
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
  /**
   * 台账里可用的真磅（启用 + 非 Mock）。两台以上时称重区头部给「切换当前磅」下拉——
   * 现场配了两台秤、车开上哪台就称哪台的站点靠它切（`store/device.ts::selectScale`）。
   * 只有一台时那一格不渲染，界面与从前逐字一致。
   */
  const scales = useMemo(
    () => devices.filter((d) => d.kind === "scale" && d.is_enabled === 1 && d.is_mock === 0),
    [devices],
  );
  /** 帧里的 code：读数此刻真正属于哪台磅（比台账的 default 更近事实） */
  const liveScaleCode = useDeviceStore((s) => s.scale.code);
  /**
   * 切换当前磅：台账与读数流一起挪（判定与顺序收在 `selectScale` 里）。
   * 失败也要刷新台账——台账那一步可能已经切过去了，只有串口没打开；
   * 不刷新会让"该开哪台"和界面上的候选各说各话。
   */
  const switchScale = useMutation({
    mutationFn: async (code: string) => {
      const err = await selectScale(code);
      if (err) throw new Error(err);
    },
    onSuccess: (_r, code) => {
      const name = scales.find((d) => d.code === code)?.name ?? code;
      toast.success(`已切换到「${name}」：读数、落库归属与整量化都跟着这台磅`);
      announce(`已切换到${name}`, `ws-scale:${code}`);
    },
    onError: (e: Error) => toast.error(`切换地磅失败：${e.message}`),
    onSettled: () => void qcClient.invalidateQueries({ queryKey: ["devices"] }),
  });
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

  /**
   * 打某一张单的码单：不弹预览，直接打到默认打印机（热敏纸直连小票机，A4/针式进打印队列、
   * 纸张随打印机自身配置）。不传单号时打当前 URL 那张单（F9 / 顶部按钮），结算弹窗里的
   * 「凭票打印」则显式传入本单号。重复打同一张也算一次新的直打（补打场景），所以先清
   * printedFor 闸门；只有直打真失败时 effect 才回退弹预览框。
   *
   * 声明位置比 F9 那条热键靠前：净重刚定时要立刻出票（见 `handleNetDetermined`），
   * 而那段逻辑必须排在 `useIcWorkflow` 之前——刷卡捕获的出口要调它。
   *
   * **出票前先把这一单拉成最新的**。出票几乎总紧跟在一次写库之后（刚捕完一捕重量、刚结算完），
   * 而 `["order", 单号]` 这份缓存此刻还是**写之前**那一份：捕获的 `onSuccess` 是"先出票、
   * 再失效查询"，`printOrder` 读到的就是旧快照——票面上刚捕的那一栏印的是"待捕"或旧值
   * （皮重捕完印出来皮重还是空的，正是这个）。等这一单换回写之后那一行再出票，
   * 票面才是库里那张单的真值；取不到（离线 / 单被删）就照缓存印，宁可旧一点也不能不出票。
   */
  const triggerPrint = useCallback(
    async (no?: string | null, opts?: { auto?: boolean }) => {
      // 站点关掉自动出码单时只拦"过完磅自己出纸"那一路；F9 / 顶部按钮 / 凭票打印不带 auto，照打
      if (opts?.auto && !autoPrintWeigh) return;
      const target = no ?? order?.order_no;
      if (!target) return;
      try {
        // type: "all" 不能省。默认只重取 active 的查询：补打一张**当前没显示**的单
        // （磅单详情里点直打、结算框给别的单出票）时，那份缓存是 inactive 的，默认档位
        // 会原样放着旧数据不动——又回到"印旧快照"那条老路上去。
        await qcClient.refetchQueries({ queryKey: ["order", target], type: "all" });
      } catch {
        /* 取不到新值就照缓存那一份印，不拦这一票 */
      }
      // 净重还没定的单不出票：票上连重量都没有，客户拿回去结不了钱。与凭票打印区
      // （`TicketPrintSection` 的 `canPrint`）同一道闸，只是这里连 F9 与自动那两条路一起管住。
      const fresh = qcClient.getQueryData<WeighOrder | null>(["order", target]);
      if (fresh && fresh.net_weight_01kg == null) {
        toast.warning(`${target} 还没过完磅（净重未定），先不出票`);
        announce("这一单还没过完磅，先不出票", `ws-print-nonet:${target}`);
        return;
      }
      printedFor.current = null;
      setPrintTarget(target);
      setPrintSeq((n) => n + 1);
    },
    [order, qcClient, autoPrintWeigh],
  );

  /**
   * 出库模式打当前那张出库码单。走的是与磅单、与出库详情页同一条 `useSilentReceiptPrint`
   * （无预览直打 → 失败才回退预览框），刷新键传 `["outbound"]`——`prints` 挂在这张单的
   * 详情查询上，用缺省值（磅单那条）打完「已打 N 张」不会动。
   *
   * 出票前先把这一单重取一遍：刚捕完毛/皮就按 F9 的场合，缓存里还是写之前那份，
   * 票面会把刚称到的那一栏印成空的。取不到就照缓存印，宁可旧一点也不能不出票。
   */
  const printOutbound = useCallback(async () => {
    const target = outboundDoc?.order_no;
    if (!target || !station) return;
    try {
      await qcClient.refetchQueries({ queryKey: ["outbound", target], type: "all" });
    } catch {
      /* 取不到新值就照缓存那一份印 */
    }
    const fresh = qcClient.getQueryData<OutboundDetail | null>(["outbound", target]);
    if (!fresh) {
      toast.error(`读不到出库单 ${target}，请到「库存与出库」核对单号`);
      return;
    }
    if (fresh.net_weight_01kg == null) {
      toast.warning(`${target} 还没有出库净重，先不出票`);
      announce("这一单还没有出库净重，先不出票", `ws-ob-print-nonet:${target}`);
      return;
    }
    const printed = (fresh.prints ?? []).filter((p) => p.result === "success").length;
    void printReceipt({
      scenario: "outbound_order",
      docNo: target,
      isReprint: printed > 0,
      context: { station, names, outbound: fresh },
      invalidate: ["outbound"],
    });
  }, [outboundDoc?.order_no, station, names, qcClient, printReceipt]);

  /** 打印按钮灰掉的原因（05 §5：禁用必须带文字）。null＝可以打 */
  const printBlockedReason = !can("print")
    ? "当前岗位无打印权限"
    : !station
      ? "站点信息还没加载"
      : !outboundDoc
        ? "先在左边队列选一张出库单，或扫出库码单"
        : outboundDoc.net_weight_01kg == null
          ? "本单还没有出库净重，打不出有效票据；请先称重或改单填净重"
          : null;

  /**
   * 完成出库：算货款、判超库存（只警示不拦）、同事务写库存流水。判据全在
   * `outbound::complete`，这里只负责把服务端那句中文原因原样透传。
   */
  const completeOutbound = useMutation({
    mutationFn: (no: string) => api.completeOutbound({ order_no: no, operator_id: actorId() }),
    onSuccess: (row) => {
      if (row.stock_warning) toast.warning(row.stock_warning, { duration: 9000 });
      else toast.success(`${row.order_no} 已出库，库存扣减 ${ton(row.net_weight_01kg)}`);
      qcClient.invalidateQueries({ queryKey: ["outbound"] });
      qcClient.invalidateQueries({ queryKey: ["stock-balance"] });
      qcClient.invalidateQueries({ queryKey: ["stock-movements"] });
      qcClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /**
   * 切换工作模式。切到出库时把入库那几层弹框收掉：结算框 / 补付框 / 制单框都是入库流程的，
   * 留在出库板面上既挡视线，也容易让人对着一张纸填到另一张单上。切回来不恢复它们——
   * 那几张框的由头（第三刷、扫票、净重刚定）都过去了，硬弹回来只会是错的一单。
   */
  const switchMode = useCallback(
    (next: "in" | "out") => {
      if (next === mode) return;
      if (next === "out") {
        setRegOpen(false);
        setRegCard(null);
        setSettleNo(null);
        setPayNo(null);
        setSettleUnpaid(false);
      }
      // 布局编辑态只属于入库那张网格，切走就退出，免得切回来时还挂着一套把手
      setEditing(false);
      setModePref(next);
    },
    [mode, setModePref],
  );

  /**
   * 净重刚定、磅单上已经有价 → 不必等人，直接按**未付款（挂账）**结掉（02 §F1.4）。
   *
   * 走的是 `api.settle` **同一条命令、同一组默认值**（`settleDefaults`）。这一点不能松：
   * 这条路没有人在框里盯着，两处实现分叉出来的偏差没有人会当场发现，只会变成月底对不上的账。
   * 落库失败一律退回结算框（见 onError）——自动那一步省的是手，不是责任。
   */
  const autoSettle = useMutation({
    mutationFn: async (o: WeighOrder) => {
      // 化验单只是扣水扣杂的兜底来源（磅单上没记时才拿它）。读不到不挡结算，与结算框同口径
      let qcReport: QcReport | null = null;
      if (o.qc_report_id != null) {
        try {
          qcReport = (await api.listQc({ keyword: o.order_no })).find((r) => r.id === o.qc_report_id) ?? null;
        } catch {
          qcReport = null;
        }
      }
      const d = settleDefaults(o, varieties.find((v) => v.id === o.variety_id) ?? null, qcReport, prices);
      const listed = d.listed;
      return api.settle({
        order_no: o.order_no,
        price_fen_per_ton: o.price_fen_per_ton!,
        package_deduct_01kg: d.package_deduct_01kg,
        moisture_deduct_01kg: d.moisture_deduct_01kg,
        impurity_deduct_01kg: d.impurity_deduct_01kg,
        other_deduct_01kg: d.other_deduct_01kg,
        deduction_fee_fen: d.deduction_fee_fen,
        // 未付款：这一支就是"过完磅就走、钱回头再算"，之后凭结算单到「付款与挂账」核销
        pay_now: false,
        paid_amount_fen: null,
        // 未付款（挂账）就没有付款方式可言：服务端不写这一列，此刻也不校它的值域（见 orders.rs）
        payment_method: "",
        settler_id: actorId(),
        // 原价取自价目表就记下来源；手填价与偏离留给人事后从票面和事由里追
        price_list_id: listed != null && d.price_fen_per_ton === listed.price_fen_per_ton ? listed.id : null,
        price_override_reason: d.price_override_reason.trim() || null,
        party_signed: false,
        grade: d.grade || null,
      });
    },
    onSuccess: async (r, o) => {
      if (!r) {
        // 服务端算不出这一单（扣重把净重吃光）才回 null。**票照出**——捕获是有效的，
        // 客户手里不能空着手上路，只是金额按化验建议标「预估」；再把人放到结算框前改扣项。
        toast.error("自动挂账没有成功：本单扣重吃光了净重，请手动结算这一单");
        announce("自动挂账没有成功，请手动结算这一单", `ws-auto-bad:${o.order_no}`);
        void triggerPrint(o.order_no, { auto: true });
        goOrder(o.order_no);
        setSettleUnpaid(true);
        setSettleNo(o.order_no);
        return;
      }
      toast.success(`已过磅并按未付款挂账 ${r.order.order_no}`, {
        description: `应付 ${money(r.settlement.payable_fen)}，结算单 ${r.settlement.settle_no}：客户拿好票，之后到「付款与挂账」凭它核销。`,
      });
      announce(autoPrintWeigh ? "过磅完成，这一单已挂账，请拿好票" : "过磅完成，这一单已挂账", `ws-auto-settle:${r.order.order_no}`);
      for (const key of [
        ["order", r.order.order_no],
        ["orders"],
        ["open-orders"],
        ["pending-settlements"],
        ["settlements"],
        ["dashboard"],
      ]) {
        qcClient.invalidateQueries({ queryKey: key });
      }
      // 票面要印的是**结算后的确定金额**：`triggerPrint` 自己会在出票前把这一单拉成最新的
      // （见那里的注释），这里不必再等一遍——出票永远印库里那一行，不印结算前的「预估」。
      void triggerPrint(r.order.order_no, { auto: true });
    },
    // 自动那条路走不通就退回人工：把人放到结算框前，别让他对着一个没结上的单猜原因。
    // 票仍要出——捕获是有效的，客户手里不能空着手上路，只是金额按化验建议标「预估」。
    onError: (e: Error, o) => {
      toast.warning(`自动挂账没有成功：${e.message || "请手动结算这一单"}`);
      announce("自动挂账没有成功，请手动结算这一单", `ws-auto-fail:${o.order_no}`);
      void triggerPrint(o.order_no, { auto: true });
      goOrder(o.order_no);
      setSettleUnpaid(true);
      setSettleNo(o.order_no);
    },
  });

  /**
   * 净重刚定的那一捕（手点捕获与刷卡捕获**共用这一个出口**）：过磅那一步的收尾只在这一处决定。
   *
   * 判定收在 `lib/settle-defaults.ts::postWeighAction`，三条路各自怎么收尾：
   *  - `auto`（磅单上已有单价）→ **先按未付款落账、再出票**。顺序不能反：反了票面印的
   *    就只能是结算前的「预估」金额，而同一个瞬间库里已经有确数了。
   *  - `dialog`（没价 / 岗位无权 / 站点关挂账）→ **先出票再开结算框**：票是客户手里的凭据，
   *    不能等人把价填完才给；票面金额按化验建议标「预估」，明写以结算为准。
   *    没价这一支如今很窄了——制单就带挂牌价，只有"该品种当时没有生效价目、且磅员也没在
   *    称重区点过「定价」"才会落到这里。
   *  - `none`（已结算 / 已作废拒收红冲）→ 什么都不做，**也不出票**：那两种场合要票属于"补打"，
   *    得走 F9 或磅单详情留下 print_log，不该在捕获的回执里静默印一张出来。
   *
   * 两件事，顺序就是现场的：**先让客户拿到纸**，再把钱那一步走掉。
   * 改造前这里只有出票，"算钱"要等第三刷——皮重捕完还必须把同一张卡再刷一次才走到钱那一步。
   */
  const handleNetDetermined = useCallback(
    (o: WeighOrder) => {
      // 两条出口可能几乎同时到达（复称、抓帧等待期间的重取）；同一次过磅只推进一次
      if (advancedFor.current === o.order_no) return;
      advancedFor.current = o.order_no;

      const action = postWeighAction(o, { canSettle: maySettle || mayCreditSettle, allowCredit });
      if (action.kind === "none") return;
      if (action.kind === "dialog") {
        void triggerPrint(o.order_no, { auto: true });
        goOrder(o.order_no);
        setSettleUnpaid(true);
        setSettleNo(o.order_no);
        // 三个理由都是"为什么没自动结掉"，得当场说清；接下来由结算框自己念它的话
        const why =
          action.reason === "no-price"
            ? "本单还没有单价：请在结算框填价，可点「从价目带出」"
            : action.reason === "credit-off"
              ? "本站已关闭挂账：这一单只能当场付清，请在结算框里完成"
              : "当前岗位不能结算：本单需要磅员、出纳或站长来结";
        toast.info(why, { id: `ws-post-weigh:${o.order_no}` });
        announce(action.reason === "no-price" ? "这一单还没定价，请结算" : "这一单需要人工结算", `ws-post-weigh:${o.order_no}`);
        return;
      }
      // auto：结算成功的回调里再出票。票面读的是库里那张单（`triggerPrint` 出票前自会重取），
      // 所以印出来的是结算后的确数，不是这一捕之前那份快照里的「预估」
      autoSettle.mutate(o);
    },
    [triggerPrint, maySettle, mayCreditSettle, allowCredit, goOrder, autoSettle],
  );

  /** 闸门结论上屏：三档语气各按颜色，语音只念结论（长原因留在屏幕上，念出来没人听得懂） */
  const showGate = useCallback((gate: SettleGate, id: string) => {
    const msg = `${gate.title}：${gate.body}`;
    if (gate.tone === "danger") toast.error(msg, { id });
    else if (gate.tone === "warning") toast.warning(msg, { id });
    else toast.info(msg, { id });
    announce(gate.title, id);
  }, []);

  /**
   * 把一张单交到窗口那一个位置：三个入口（第③刷、扫票面码、称重区那个「去结算」）
   * 都收在这一条上，进来之后按单据状态分给两个框之一——
   *  **还没算钱** → 结算框（`SettleForm`）；**算过钱、没付完** → 补付框（`PayDialog`）。
   *
   * 为什么分派放在这一条而不是各入口自己判：过磅那一捕如今默认就把单挂上账了
   * （`handleNetDetermined` 的 auto 支），所以"回来的单已经结过账"是常态而不是例外。
   * 少了这一步分派，第③刷与「去结算」会把人推进一个提交即被库里不变式 6 弹回来的结算框，
   * 现场只看得到"结算失败"。判据一份（`settle-gate.ts`），三条路对同一张票给同一个结论。
   *
   * `settleUnpaid` 是粘住的状态，任何一次开框前都显式给值（这三个入口都是"客户站在窗口上
   * 要钱"的场合：回到默认的当场付清），少一处复位，上一单挂账的意图就会悄悄挂到下一单上。
   */
  const requestSettle = useCallback(
    async (no: string, loaded?: WeighOrder | null) => {
      goOrder(no);
      setSettleUnpaid(false);
      // 调用方刚读过的这一行优先用它（扫票那条路手里就有）；其余场合重取一次，判据要用库里的值
      const o = loaded ?? (order && order.order_no === no ? order : await api.getOrder(no).catch(() => null));
      if (o && awaitingPayment(o)) {
        const bill = await api.settlementOfOrderNo(no).catch(() => null);
        const gate = creditPayGate(bill, mayPay);
        if (gate) showGate(gate, `ws-pay-gate:${no}`);
        else setPayNo(bill!.settle_no);
        return;
      }
      setSettleNo(no);
    },
    [goOrder, order, mayPay, showGate],
  );
  useIcWorkflow({
    // 出库模式让 IC 整条让位：出库单不绑流转卡，也没有"刷卡推进一步"这条路；
    // 不听卡才不会在出库板面上把某张在途磅单悄悄定位出来、甚至替它捕一捕重量。
    paused: regOpen || settleNo != null || payNo != null || regHolding || panelHolding || outboundMode,
    captureCams,
    anyCamOnline,
    onRequestSettle: requestSettle,
    onNetDetermined: handleNetDetermined,
    onRequestRegister: (card) => {
      // 卡还在感应区上：不再弹制单框，直接把工作台切回制单草稿态并把这张卡交给常驻面板，
      // IdentityPanel 经 presetCardNo 就位，选好售粮人点「取卡并制单」即随单绑上（06 §4.0 同事务）
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
   * 扫进来的不是一张磅单：三档语气各按 tone 上屏，语音只念一句结论（与 `showGate` 同一套分工）。
   * 吐司与语音都用同一个 id：连扫三次错纸不该在屏幕上摞三条。
   */
  const showScanReject = useCallback((note: { tone: GateTone; text: string }, spoken: string) => {
    if (note.tone === "danger") toast.error(note.text, { id: "ws-scan-reject" });
    else if (note.tone === "warning") toast.warning(note.text, { id: "ws-scan-reject" });
    else toast.info(note.text, { id: "ws-scan-reject" });
    announce(spoken, "ws-scan-reject");
  }, []);

  /**
   * 出库模式扫进来的那一串：**只认本版出库单**（02 §M11 F11.7）。
   *
   * 与入库侧同一条纪律，方向相反：一串号先按出库单查库，查到就选中这张草稿；
   * 查不到再按磅单查一次，是为了把"拿错纸"当场说清——同站同月里 CK#5 与 BD#5 是同一串
   * 数字，这个路口恰恰是两张纸最容易混的地方。老纸上带票种位的载荷（`15…` / `CK…`）
   * 能自己报出种类，报出来不是出库单的一律在本模式拒收，指回入库窗口。
   *
   * 出库模式**不推进状态、不出票、不算钱**：这里只做"定位 + 称重 + 完成出库"，
   * 收款核销仍在「付款与挂账」。所以这条路上没有结算框，也不可能把出库单结掉。
   */
  const handleOutboundScan = useCallback(
    async (code: ScannedCode | null, raw: string) => {
      const known = code && code.kind !== "unknown" ? code : null;
      if (known && known.kind !== "outbound") {
        toast.info(
          `递过来的是${known.label}（${known.docNo}）：出库模式只处理出库码单。要过磅 / 结算请先把工作台切回「入库」模式。`,
          { id: "ws-scan-reject" },
        );
        announce("这不是出库码单，请切回入库模式", "ws-scan-reject");
        return;
      }
      const no = code?.docNo;
      if (!no) {
        const note = scanRejectNote(null, raw);
        if (note) showScanReject(note, "这个码没认出来，请再扫一次");
        return;
      }
      let scanned: OutboundDetail | null;
      try {
        scanned = await api.getOutbound(no);
      } catch {
        toast.error(`读不到出库单 ${no}，请到「库存与出库」核对单号`, { id: `ws-ob-read:${no}` });
        return;
      }
      if (!scanned) {
        // 同号也是常见情形：客户手里那张可能是收购码单，只是号形与出库单一样
        const weigh = await api.getOrder(no).catch(() => null);
        if (weigh) {
          toast.info(`这串号 ${no} 是一张收购磅单：要过磅 / 结算请把工作台切回「入库」模式再扫。`, { id: `ws-ob-weigh:${no}` });
          announce("这是一张收购磅单，请切回入库模式", `ws-ob-weigh:${no}`);
          return;
        }
        toast.error(`查不到出库单 ${no}：可能不是本站的单，或码被压坏读错了单号。请到「库存与出库」核对。`, { id: `ws-ob-gone:${no}` });
        announce("查不到这张出库单，请核对票面单号", `ws-ob-gone:${no}`);
        return;
      }
      setOutboundNo(no);
      if (scanned.status !== "draft") {
        toast.info(`${no} 已是「${OUTBOUND_STATUS[scanned.status].label}」：这里只能查看和补打，称重与过账都不开放。`, {
          id: `ws-ob-status:${no}`,
        });
        return;
      }
      // 同号闸门的出库侧镜像：这串号也有一张磅单时，先说破再让人核对拿的哪张纸
      const twin = await api.getOrder(no).catch(() => null);
      if (twin) {
        toast.warning(
          `这串号 ${no} 同时也是一张收购磅单：这里打开的是出库单（${scanned.warehouse_name} · ${scanned.variety_name ?? "—"}）。拿的是收购码单请切回「入库」模式。`,
          { id: `ws-ob-twin:${no}` },
        );
        announce("这串号也有磅单，请核对拿的哪张纸", `ws-ob-twin:${no}`);
      }
    },
    [showScanReject],
  );

  /**
   * 扫票面码（02 §F1.4 的兑付那一步）：**入库模式下磅房只认磅单码**。
   *
   * 本版的码里装的就是票面那行单号，所以一串数字进来只做一件事——按磅单去查库：查到就交给
   * `requestSettle`（与第③刷、称重区那个「去结算」同一个分派：没算过钱的进结算框，算过钱、
   * 钱没付完的进补付框），查不到就说"查无此单"。**不在形状上猜种类**：同一站点同一月里磅单与
   * 结算单会排出同一串号，"这是不是一张磅单"的权威只有 `weigh_order` 里那一行。
   *
   * 老纸上那两种带前缀的载荷（`11`…`15` + 号、`BH1:` + 字母号）自己会把种类报出来
   * （`ticket-code.ts` 的 ②③ 两条读轨）。认出来不是磅单的一律拒收并说清该上哪儿去：
   * 结算凭证那枚凭单码本版已经不打，可客户手里那张老纸还在流通，扫到这儿绝不能顺手去开一张
   * 同号磅单的结算框——那是钱，不是提示一下就能了事的事。
   *
   * 出库单那张纸的消费口是页头的**「出库」模式**（`handleOutboundScan`）：那条路只定位与称重，
   * 永远不开结算框。两条口按当前模式分流，谁也不替对方接纸——在一张出库单上开结算框，
   * 或者把一张收购码单当成出库单过账，都是账面立刻错位的事。
   */
  const handleScan = useCallback(
    async (raw: string) => {
      const code = parseScannedCode(raw);
      // 出库模式走另一条出口：那里只按出库单查库，与下面的结算分派完全隔开
      if (outboundMode) {
        await handleOutboundScan(code, raw);
        return;
      }
      // 只有老纸上的载荷会报得出种类（本版的码＝单号本体，种类留给查库判）
      const known = code && code.kind !== "unknown" ? code : null;
      // ── 认得出种类、且认出来的不是磅单（质检单 / 付款凭证 / 出库单 / 老结算凭证）：打发走 ──
      if (known && !settleable(known)) {
        const note = scanRejectNote(known, raw);
        if (note) showScanReject(note, "这张票不是收购码单，请核对票面");
        return;
      }
      const no = code?.docNo;
      // ── 连单号形状都不是的一串（外来条码、被压坏只剩半截）：把原文递回眼前，那是排障的第一手证据 ──
      if (!no) {
        const note = scanRejectNote(null, raw);
        if (note) showScanReject(note, "这个码没认出来，请再扫一次");
        return;
      }
      let scanned;
      try {
        scanned = await api.getOrder(no);
      } catch {
        toast.error(`读不到磅单 ${no}，请到「磅单中心」核对单号`, { id: `ws-scan-read:${no}` });
        return;
      }
      // 查无此单：读得到连接、库里没有这一行（票是别家站的、单号被压坏读错、或码只进来半截）。
      // 这一条必须在开框之前拦下：`settleGateOf` 收到 null 是"还没读到"的放行语义（第三刷与
      // 称重区那一路靠它），拿它当"查无此单"的闸门等于没有闸门——窗口会弹出一个空结算框
      // 转圈，人在里面填好单价点提交，才发现单子根本不存在。
      if (!scanned) {
        toast.error(`查不到磅单 ${no}：可能不是本站的单，或码被压坏读错了单号。如果手里是出库码单，请把工作台切到「出库」模式再扫。`, {
          id: `ws-scan-gone:${no}`,
        });
        announce("查不到这张单，请核对票面单号", `ws-scan-gone:${no}`);
        return;
      }
      // **同号闸门**：出库单那张纸如今也带码（02 §M11 F11.7，值仓自己扫），而它的号形与磅单
      // 逐字相同——同一个 `next_no`，只是票种键一个是 CK、一个是 BD，两个计数器各自从 1 排起，
      // 同站同月里 CK#5 与 BD#5 就是同一串 14 位数字。从前载荷里那两位票种位替我们把这两张纸
      // 分开了；本版把前缀撤了（用户拍板：磅房只认磅单码），所以"一串号在磅单里查到了"不再等于
      // "客户递来的就是那张磅单"。撞号时当场说破、不开框：窗口里结错一张单是真金白银，
      // 而两可这件事只有库能回答，答完就得如实报出来。
      if (await api.getOutbound(no).catch(() => null)) {
        toast.error(`这串号 ${no} 既是一张磅单、也是一张出库单：要结算请到「磅单中心」点开那张磅单再「带到工作台」；出库那张请把工作台切到「出库」模式再扫，或到「库存与出库」处理。`, { id: `ws-scan-twin:${no}` });
        announce("这串号既是磅单也是出库单，请到界面里点开", `ws-scan-twin:${no}`);
        return;
      }
      // bill 传 null：工作台没预取结算单，"已结算"判据靠 settled_at/status 已足够准（见 settle-gate.ts）
      const gate = settleGateOf(scanned, null, maySettle);
      if (gate) {
        showGate(gate, `ws-scan-gate:${no}`);
        return;
      }
      // 扫票来的客户是"递票来拿钱"的场合：与第③刷、称重区那个按钮走同一个 `requestSettle`
      // （手里这份直接递过去；那张单若已结算未付清，那条会把它分到补付框）
      void requestSettle(no, scanned ?? null);
      // 成功进结算框刻意不插话：接下来由结算框（SettleForm）自己念它的话术，与第三刷同一处理
    },
    [maySettle, requestSettle, showGate, showScanReject, outboundMode, handleOutboundScan],
  );

  // 弹窗/结算框/补付框开着时不捕获扫码：那会儿焦点在弹层里，扫进来的码不该把底下的单换掉。
  // 后台常驻捕获（键盘枪免聚焦，`useScannerCapture` 已反向让位在输入框里打字的人）。
  useScannerCapture((raw) => void handleScan(raw), {
    enabled: !regOpen && settleNo == null && payNo == null && !outboundForm.open,
  });

  // F7（制单）已收进顶部工具条作全局键：任何页面都弹同一张 RegistrationDialog，
  // 这里不再重复绑定，避免一次按键叠出两层弹窗
  // F9 跟着当前模式走：入库打磅单码单，出库打当前那张出库码单——同一枚键，两个纸种各打各的
  useHotkey("f9", () => {
    if (outboundMode) void printOutbound();
    else triggerPrint();
  });
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
  /** 均值与超差判据单源在 `lib/tare-ref`：档案页、捕获那一捕算的必须是同一个数 */
  const tareMean01kg = useMemo(() => tareMeanOf(tareRecent), [tareRecent]);
  const currentTare01kg = order?.tare_weight_01kg ?? null;
  const tareAlert = tareOverTolerance(currentTare01kg, tareMean01kg, tolerancePct);

  const variety = useMemo(
    () => varieties.find((v) => v.id === (order?.variety_id ?? draft.varietyId)) ?? null,
    [varieties, order?.variety_id, draft.varietyId],
  );
  /**
   * 称重区标题栏显示哪台磅的串口：以帧里的 code 为准（读数真正来自哪条串口），
   * 还没收到帧时退回台账当前磅，最后才退回台账里第一台磅。
   * 从前这里直接 `devices.find(kind==='scale')` 取第一台，两台秤时会把 2 号磅的读数
   * 挂在 1 号磅的 COM 口上。
   */
  const scaleDevice =
    devices.find((d) => d.code === liveScaleCode) ??
    scales.find((d) => d.is_default === 1) ??
    devices.find((d) => d.kind === "scale");
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

  // ── 补付框（挂账核销）：那一行账由 `PayDialog` 自己按 settleNo 重取，工作台不再另存一份 ──

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

  /** 直打触发点（净重刚定自动 / F9·按钮手动）：先无预览直打，失败（hook 回 "preview"）才弹预览框兜底 */
  useEffect(() => {
    if (printSeq === 0 || !printTarget || !station || !printOrder) return;
    if (printedFor.current === printTarget) return;
    printedFor.current = printTarget;
    void printReceipt({
      scenario: "weigh_order",
      docNo: printTarget,
      isReprint: printTimes > 0,
      context: { station, names, order: printOrder, qc: printQc },
    });
    // 刻意不回头"清零" printSeq：它只表示"出票意图发生过第几次"，重复出票由上面的 `printedFor` 挡。
    // 清一个布尔量回来，反倒会把"目标单号已改、而 station/printOrder 还没就绪"的那一轮一起抹掉。
  }, [printSeq, printTarget, station, printOrder, printQc, names, printTimes, printReceipt]);

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
    tare: <TarePanel recent={tareRefRows(tareRecent)} last01kg={partyDetail?.last_tare_01kg ?? null} mean01kg={tareMean01kg} tolerancePct={tolerancePct} currentTare01kg={currentTare01kg} alert={tareAlert} partyId={partyId} />,
    camera: <CameraPanel cameras={cameras} order={order ?? null} photos={photos} />,
    weigh: (
      <WeighPanel
        order={order ?? null}
        mean01kg={tareMean01kg}
        tolerancePct={tolerancePct}
        scalePort={String(scaleDevice?.config?.port ?? "COM1")}
        scales={scales}
        onSelectScale={(code) => switchScale.mutate(code)}
        switchingScale={switchScale.isPending}
        anyCamOnline={anyCamOnline}
        captureCams={captureCams}
        onNetDetermined={handleNetDetermined}
        onRequestSettle={requestSettle}
      />
    ),
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
            outboundMode ? (
              <>
                出库模式：左边点一张草稿出库单（或<b className="font-semibold">扫出库码单</b>），称毛重 → 皮重，
                核对净重后<b className="font-semibold">「完成出库」</b>扣库存、算货款。出库不过结算窗口、不推流转卡；
                销售货款与收款核销在「付款与挂账」。<Kbd>F9</Kbd> 打印当前出库码单
              </>
            ) : (
              <>
                制单后一张流转卡<b className="font-semibold">刷一次推进一步</b>：毛重 → 皮重 → 要收钱再刷一次当场结清。
                客户拿码单回来<b className="font-semibold">直接扫票面码</b>就地结算；挂账的回头收尾款，
                在「结算台账」点开那张结算单登记付款。票没带或丢了，在上方在途条点中那张单再按「去结算」。
                <Kbd>F7</Kbd> 制单 <Kbd>空格</Kbd>/<Kbd>P</Kbd> 捕获 <Kbd>F5</Kbd> 化验 <Kbd>F9</Kbd> 打印
              </>
            )
          }
          actions={
            <>
              {/* 模式开关排在最前：先选这一台机现在是干什么的，后面的按钮与快捷键都跟着它变 */}
              <div className="flex overflow-hidden rounded-md border" role="group" aria-label="工作台模式">
                <Button
                  size="xs"
                  variant={outboundMode ? "ghost" : "default"}
                  className="rounded-none"
                  aria-pressed={!outboundMode}
                  onClick={() => switchMode("in")}
                >
                  入库
                </Button>
                <Button
                  size="xs"
                  variant={outboundMode ? "default" : "ghost"}
                  className="rounded-none"
                  aria-pressed={outboundMode}
                  onClick={() => switchMode("out")}
                >
                  出库
                </Button>
              </div>
              <span className="text-xs text-muted-foreground">当前</span>
              <span className="tnum text-sm font-semibold">
                {outboundMode ? (outboundNo ?? "（无）") : (order?.order_no ?? "（无）")}
              </span>
              {outboundMode
                ? outboundDoc && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void navigate({ to: "/outbound/$no", params: { no: outboundDoc.order_no } })}
                    >
                      <ExternalLinkIcon />
                      单证详情
                    </Button>
                  )
                : order && (
                    <Button size="xs" variant="ghost" onClick={() => openQuickDetail("order", order.order_no)}>
                      <ExternalLinkIcon />
                      单证详情
                    </Button>
                  )}
              {outboundMode ? (
                <Button size="sm" disabled={!can("outbound.create")} onClick={() => setOutboundForm({ open: true, editing: null })}>
                  <PlusIcon />
                  新建出库单
                </Button>
              ) : (
                <Button size="sm" onClick={() => setRegOpen(true)}>
                  <UserRoundPlusIcon />
                  制单（F7）
                </Button>
              )}
              {!outboundMode && (
                <Button size="sm" variant="outline" onClick={() => board.togglePanel("camera", showCam)}>
                  <CctvIcon />
                  {showCam ? "隐藏画面" : "过磅画面"}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (outboundMode) void printOutbound();
                  else triggerPrint();
                }}
                disabled={outboundMode ? printBlockedReason != null : !order}
                title={outboundMode ? (printBlockedReason ?? undefined) : undefined}
              >
                <PrinterIcon />
                {outboundMode && outboundPrinted > 0 ? `补打（已打 ${outboundPrinted} 张）` : "打印（F9）"}
              </Button>
              {/* 面板与布局是入库那张网格的排布，出库板面没有格子可排，整组不渲染 */}
              {!outboundMode && (
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
              )}
              {!outboundMode && editing && (
                <Button size="sm" variant="outline" onClick={board.reset}>
                  <RotateCcwIcon />
                  恢复默认
                </Button>
              )}
              {!outboundMode && (
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
              )}
              <Button size="sm" variant="outline" onClick={toggleFocusMode}>
                <Maximize2Icon />
                全屏专注（F11）
              </Button>
            </>
          }
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {!outboundMode && order?.void_reason && (
          <p className="mx-2 mt-1.5 border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
            本单已作废：{order.void_reason}（仅作留痕，要继续作业请新建下一单）
          </p>
        )}
        {!outboundMode && editing && (
          <p className="mx-2 mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            排布存在你本人账号上，换台磅房机登录也是这一套。
            {board.saving && <span className="shrink-0 text-primary">保存中…</span>}
          </p>
        )}
        {modeLoading ? (
          // 本人那份模式偏好还没读回来：先铺骨架，别让人看一眼入库桌子又跳成出库板面
          <div className="grid flex-1 grid-cols-1 gap-4 px-3.5 py-3 xl:grid-cols-[minmax(230px,0.85fr)_minmax(430px,1.8fr)_minmax(290px,1.1fr)]">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex flex-col gap-4">
                <Skeleton className="h-72" />
                <Skeleton className="h-48" />
              </div>
            ))}
          </div>
        ) : outboundMode ? (
          <OutboundBoard
            drafts={outboundDrafts}
            draftsLoading={draftsQuery.isPending}
            selectedNo={outboundNo}
            doc={outboundDoc}
            docLoading={outboundNo != null && outboundQuery.isPending}
            canCreate={can("outbound.create")}
            completing={completeOutbound.isPending}
            printBlockedReason={printBlockedReason}
            printedCount={outboundPrinted}
            scales={scales}
            switchingScale={switchScale.isPending}
            onSelectScale={(code) => switchScale.mutate(code)}
            onPick={setOutboundNo}
            onNew={() => setOutboundForm({ open: true, editing: null })}
            onEdit={() => setOutboundForm({ open: true, editing: outboundDoc })}
            onComplete={() => {
              if (outboundDoc) completeOutbound.mutate(outboundDoc.order_no);
            }}
            onPrint={() => void printOutbound()}
            onDetail={() => {
              if (outboundDoc) void navigate({ to: "/outbound/$no", params: { no: outboundDoc.order_no } });
            }}
          />
        ) : !board.ready || isLoading ? (
          <div className="grid flex-1 grid-cols-1 gap-4 px-3.5 py-3 xl:grid-cols-[minmax(230px,0.85fr)_minmax(430px,1.8fr)_minmax(290px,1.1fr)]">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex flex-col gap-4">
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

      {/* 在途条是入库流程的"点卡片接着干"，出库模式不摆在眼前；测试扫码框两边都留着 */}
      {!focusMode && !outboundMode && <OpenOrdersBar activeNo={orderNo} onPick={(no) => goOrder(no)} />}
      {/* 测试扫码框（站点参数 `scan_test_input`，默认关）：没有扫码枪的机器上贴一串票面码
          按回车，走的正是扫码枪那条同一个 `handleScan`；专注态里也留着，演示常在全屏档下讲流程 */}
      {scanTestInput && (
        <ScanTestBar onScan={(raw) => void handleScan(raw)} disabled={regOpen || settleNo != null || payNo != null || outboundForm.open} />
      )}
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

      {/* 出库制单 / 改草稿：与「库存与出库」那张表单同一份。新建成功就顺手选中，
          下一步直接是称重，不必再回队列里找一遍刚开的号 */}
      <OutboundFormDialog
        open={outboundForm.open}
        onOpenChange={(v) => setOutboundForm((s) => ({ ...s, open: v }))}
        editing={outboundForm.editing}
        onSaved={(row) => setOutboundNo(row.order_no)}
      />

      {/* 结算框：复用 SettleForm（第③刷 / 扫票 / 称重区「去结算」同一条算钱口径，06 §6.3）。
          开框的三种由头（第三刷 / 扫票 / 净重刚定而磅单上没价）各自给 defaultUnpaid，
          收在这里一次传下去——`settleUnpaid` 是粘的，关框时一并归零，别留给下一单 */}
      <Dialog
        open={settleNo != null}
        onOpenChange={(v) => {
          if (v) return;
          setSettleNo(null);
          setSettleUnpaid(false);
        }}
      >
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
                defaultUnpaid={settleUnpaid}
                onSettled={(r) => {
                  toast.success(`已结算 ${r.order.order_no}，本单流转卡已回卡池`);
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

      {/* 补付框：递上来的是**结算凭证**（JS），或一张已经算过钱、钱没付完的码单（第③刷 /
          「去结算」命中挂账单）时开这一框。框体与那一行账的取数在 `PayDialog`（与磅单详情
          卡片底部那枚「付款」同一份），收钱走 `api.recordPayment`，每登记一笔自动出一张结算凭证 */}
      <PayDialog
        settleNo={payNo}
        onClose={() => setPayNo(null)}
        onPaid={(paid, detail) => {
          // 余额清零与还挂着，是这一框唯一需要人改动作的结论；金额与单号归屏幕
          announce(
            unpaidFen(paid) <= 0 ? "款已收讫，这张单结清了" : "付款已登记，剩下的还挂着账",
            `ws-pay-done:${paid.settle_no}`,
          );
          // 磅单侧那一行的付款状态跟着变了：工作台当前单与在途条都要重取
          for (const row of detail.orders) void qcClient.invalidateQueries({ queryKey: ["order", row.order_no] });
          void qcClient.invalidateQueries({ queryKey: ["open-orders"] });
          void qcClient.invalidateQueries({ queryKey: ["order", orderNo] });
        }}
      />

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

      <span className="sr-only">
        {outboundMode
          ? `出库 ${outboundDoc?.order_no ?? "未选"} ${outboundDoc?.variety_name ?? ""} ${weight(outboundDoc?.net_weight_01kg ?? null)}`
          : `${openOrdersHint} ${date(order?.registered_at)} ${weight(order?.net_weight_01kg)}`}
      </span>
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
      制单弹窗已打开：读卡与取号在那个框里做，关掉后这里继续填写
    </div>
  );
}
