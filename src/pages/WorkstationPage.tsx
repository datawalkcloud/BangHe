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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLinkIcon, PrinterIcon, CctvIcon, Maximize2Icon, Minimize2Icon, LayoutGridIcon, PanelTopIcon, RotateCcwIcon, UserRoundPlusIcon } from "lucide-react";
import { api } from "@/lib/api";
import { useSetting, useStaffNames, useStation, useVarieties, useWarehouses, useSlots, usePrices } from "@/hooks/useLookups";
import { useHotkey } from "@/hooks/useHotkey";
import { useScannerCapture } from "@/hooks/useScannerCapture";
import { parseScannedCode, settleable } from "@/lib/ticket-code";
import { scanRejectNote, settleGateOf } from "@/lib/settle-gate";
import { announce } from "@/lib/voice-prompt";
import { postWeighAction, settleDefaults } from "@/lib/settle-defaults";
import type { QcReport, WeighOrder } from "@/mock/types";
import { useDeviceStore } from "@/store/device";
import { actorId, useSession } from "@/store/session";
import { date, money, weight, varietyLabel } from "@/lib/format";
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
  /**
   * 兑付窗口那条路（扫票、`/scan-settle`）：结算要出纳或站长。与 `settle-gate.ts` 同一口径，
   * 磅员**不在**这条上——他的挂账权只够覆盖磅房过磅流程里那一步，不够替客户算钱。
   */
  const maySettle = useSession((s) => s.can("settle.create"));
  /**
   * 磅房过磅那条路：磅员也能把刚称完的单挂上账（`settle.credit`），但**只挂账、不碰现金**
   * ——当场付款那一支在结算框里另要 `pay.record`。净重刚定那一步按未付款走，所以两条权
   * 任有一条就够推进（见下方 `handleNetDetermined`）。
   */
  const mayCreditSettle = useSession((s) => s.can("settle.credit"));
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
    async (no?: string | null) => {
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
    [order, qcClient],
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
        void triggerPrint(o.order_no);
        goOrder(o.order_no);
        setSettleUnpaid(true);
        setSettleNo(o.order_no);
        return;
      }
      toast.success(`已过磅并按未付款挂账 ${r.order.order_no}`, {
        description: `应付 ${money(r.settlement.payable_fen)}，结算单 ${r.settlement.settle_no}：客户拿好票，之后到「付款与挂账」凭它核销。`,
      });
      announce("过磅完成，这一单已挂账，请拿好票", `ws-auto-settle:${r.order.order_no}`);
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
      void triggerPrint(r.order.order_no);
    },
    // 自动那条路走不通就退回人工：把人放到结算框前，别让他对着一个没结上的单猜原因。
    // 票仍要出——捕获是有效的，客户手里不能空着手上路，只是金额按化验建议标「预估」。
    onError: (e: Error, o) => {
      toast.warning(`自动挂账没有成功：${e.message || "请手动结算这一单"}`);
      announce("自动挂账没有成功，请手动结算这一单", `ws-auto-fail:${o.order_no}`);
      void triggerPrint(o.order_no);
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
        void triggerPrint(o.order_no);
        goOrder(o.order_no);
        setSettleUnpaid(true);
        setSettleNo(o.order_no);
        // 三个理由都是"为什么没自动结掉"，得当场说清；接下来由结算框自己念它的话
        const why =
          action.reason === "no-price"
            ? "本单还没有单价（该品种制单时没有生效价目）：请在结算框填单价，可点「从价目带出」"
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

  /**
   * 把一张单交给结算框：刷卡站点的第③刷、扫票、以及称重区那个「去结算」按钮共用这一条。
   *
   * 三个入口必须走同一套（定位 + 开框 + 默认当场付清）：`settleUnpaid` 是**粘住的状态**，
   * 少一处显式复位，"上一单挂账的意图"就会悄悄挂到下一单上（见它声明处的注释）。
   */
  const requestSettle = useCallback(
    (no: string) => {
      goOrder(no);
      // 这三个入口都是"客户站在窗口上要算钱"的场合：回到默认的当场付清
      setSettleUnpaid(false);
      setSettleNo(no);
    },
    [goOrder],
  );
  useIcWorkflow({
    paused: regOpen || settleNo != null || regHolding || panelHolding,
    captureCams,
    anyCamOnline,
    onRequestSettle: requestSettle,
    onNetDetermined: handleNetDetermined,
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
      // 扫票来的客户是"递票来拿钱"的场合：与第③刷、称重区那个按钮走同一个 `requestSettle`
      requestSettle(no);
      if (!code.prefixed) toast.info(`按单号 ${no} 取单（没扫到票面码，可能是手输或旧版票）`);
      // 成功进结算框刻意不插话：接下来由结算框（SettleForm）自己念它的话术，与第三刷同一处理
    },
    [maySettle, allowCredit, requestSettle],
  );

  // 弹窗/结算框开着时不捕获扫码：那会儿焦点在弹层里，扫进来的码不该把底下的单换掉。
  // 与扫码窗口同款后台常驻捕获（键盘枪免聚焦，`useScannerCapture` 已反向让位在输入框里打字的人）。
  useScannerCapture((raw) => void handleScan(raw), { enabled: !regOpen && settleNo == null });

  // F7（制单）已收进顶部工具条作全局键：任何页面都弹同一张 RegistrationDialog，
  // 这里不再重复绑定，避免一次按键叠出两层弹窗
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
    tare: <TarePanel recent={tareRecent.slice(0, 5)} last01kg={partyDetail?.last_tare_01kg ?? null} mean01kg={tareMean01kg} tolerancePct={tolerancePct} currentTare01kg={currentTare01kg} alert={tareAlert} partyId={partyId} />,
    camera: <CameraPanel cameras={cameras} order={order ?? null} photos={photos} />,
    weigh: (
      <WeighPanel
        order={order ?? null}
        mean01kg={tareMean01kg}
        tolerancePct={tolerancePct}
        scalePort={String(scaleDevice?.config?.port ?? "COM1")}
        scaleDivision01kg={division01kg}
        anyCamOnline={anyCamOnline}
        captureCams={captureCams}
        allowCredit={allowCredit}
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
            <>
              制单后一张流转卡<b className="font-semibold">刷一次推进一步</b>：毛重 → 皮重（自动出码单，
              已有单价即按未付款挂账、没价才弹结算框）→ 要收钱再刷一次当场结清。
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

      {/* 第三刷结算框：复用 SettleForm（与 /scan-settle 同一条算钱口径，06 §6.3）。
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
