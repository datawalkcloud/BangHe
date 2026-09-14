/**
 * ① 身份与制单 + ② 历史皮重（05 §4 左栏）。
 *
 * 制单前是一段"草稿态"（还没号），制单后同一栏退化为只读摘要 + 新建下一单，
 * 这样磅员的目光始终落在同一块位置，不必在两屏之间来回找。
 *
 * 读卡是可选路径：阅读器离线时必须能搜档案或手工输入，
 * 这是 05 §10-1「无外设也要能完成闭环」的硬要求。
 *
 * **流转卡不是可选的**（06 §4.0）：站点参数「制单必须绑卡」默认开着，点「取号并制单」
 * 先弹刷卡框，读到一张可用的空闲卡才取号——读不到卡这张单就制不成。关掉该参数
 * （或本站压根不用流转卡）才回到"无卡制单、事后靠后台监听发卡"。
 *
 * **两刷一条流，中间那一下点击是多余的**（06 §4.0）：农户一手拿证一手拿卡站在窗口前，
 * 机器两次都读到了，缺的只是人最后去按那个按钮。所以卡一就位而售粮人还没定，本面板
 * 自己开始听身份证（`IdCardWatchHint` 行内那 15 秒，不再弹框），读到即往下走：
 *  1. 证号命中档案 → 带出售粮人，随即自动取号制单（停用档案照旧挡在门外）；
 *  2. 查无此证、且档案里也没有"同名 + 证号为空"的老档案 → **静默按卡面建档**（电话留空，
 *     得空去档案页补），建好直接用于本单（02 §F1.1）；
 *  3. 有同名且证号为空的老档案 → 弹「是否是同一人」：认下来就给那张老档案补证号
 *     （历史磅单照旧跟着它），不是本人就另建一张。这一个岔口机器不替人猜——
 *     同一个人建两张档案，对账时就是两个余额（`party_save` 的"一人一档"闸门同一条理由）。
 * 三条出路最终都回到同一句 `autoCreate`：卡与人都就位，号就取掉。
 *
 * **品种不挡制单**（迁移 0017）：制单只认「卡 + 售粮人」，品种可以空着取号，
 * 结算与录化验前再定（那两处各自有硬闸门，见 `orders.rs` 的 settle / save_qc）。
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon, CreditCardIcon, SearchIcon, UserRoundPlusIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { announce } from "@/lib/voice-prompt";
import type { GrainVariety, Party, StorageSlot, Warehouse, WeighOrder } from "@/mock/types";
import { PARTY_TYPE, ROLE } from "@/lib/constants";
import { maskIdCard, ton, weight } from "@/lib/format";
import { backfillPartyPhotoFromCard } from "@/lib/party-photo";
import { enrollFromIdCard } from "@/lib/party-auto-register";
import { useDeviceStore, type IdCardResult } from "@/store/device";
import { useQuickOptions, useSetting } from "@/hooks/useLookups";
import { actorId, useActor, useSession } from "@/store/session";
import { Choose } from "@/components/business/Choose";
import { ComboBox } from "@/components/business/ComboBox";
import { PlateField } from "@/components/business/PlateField";
import { CardScanDialog } from "@/components/business/CardScanDialog";
import { QuickDetailLink } from "@/components/business/quickDetail";
import { PartyPicker } from "@/components/workstation/PartyPicker";
import { CardBindDialog } from "@/components/workstation/CardBindDialog";
import { IdCardWatchHint } from "@/components/workstation/IdCardWatchHint";
import { QuickPartyDialog } from "@/components/workstation/QuickPartyDialog";
import { SamePartyDialog } from "@/components/workstation/SamePartyDialog";
import { OrderStatusBadge, ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "cn";

/** 制单前的草稿。放在这里导出，页面与面板共用同一份形状 */
export interface OrderDraft {
  party: Party | null;
  varietyId: number | null;
  vehicleNo: string;
  warehouseId: number | null;
  slotId: number | null;
  remark: string;
}

export function emptyDraft(varietyId: number | null = null): OrderDraft {
  return { party: null, varietyId, vehicleNo: "", warehouseId: null, slotId: null, remark: "" };
}

/** 从上一张单沿用品种/去向，是磅房最省手的默认值来源（05 §4 ①） */
export function draftFromOrder(o: WeighOrder): OrderDraft {
  return {
    party: null,
    varietyId: o.variety_id,
    vehicleNo: o.vehicle_no ?? "",
    warehouseId: o.warehouse_id,
    slotId: o.slot_id,
    remark: "",
  };
}

export function IdentityPanel({
  order,
  draft,
  onDraft,
  parties,
  varieties,
  warehouses,
  slots,
  presetCardNo = null,
  onCreated,
  onNewOrder,
}: {
  order: WeighOrder | null;
  draft: OrderDraft;
  onDraft: (patch: Partial<OrderDraft>) => void;
  parties: Party[];
  varieties: GrainVariety[];
  warehouses: Warehouse[];
  slots: StorageSlot[];
  /** 刷卡带进来的卡（后台常听发现没有在途单可发时）：就位即取号，不必再刷一次 */
  presetCardNo?: string | null;
  onCreated: (orderNo: string) => void;
  onNewOrder: () => void;
}) {
  const actor = useActor();
  const can = useSession((s) => s.can);
  const { options: remarkOptions } = useQuickOptions("remark");
  const reading = useDeviceStore((s) => s.reader.idcard.reading);
  const lastCard = useDeviceStore((s) => s.reader.idcard.last);
  const setPanelHolding = useDeviceStore((s) => s.setPanelHolding);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 「请放卡」监听弹窗：点读卡不再一次性点读，而是开弹窗连续寻卡（与档案页读卡建档同一套） */
  const [scanOpen, setScanOpen] = useState(false);
  /** 读卡读到的是没建过档的人：就地弹「无档案 · 快捷登记」，不把磅员赶回档案页重走一遍 */
  const [enrollOpen, setEnrollOpen] = useState(false);
  /** 「制单请放流转卡」弹窗：点「取号并制单」时卡还没就位就弹它（06 §4.0） */
  const [bindOpen, setBindOpen] = useState(false);
  /** 行内那 15 秒身份证监听的窗口是否开着（`IdCardWatchHint` 挂载即开、收工即关） */
  const [idWatching, setIdWatching] = useState(false);
  /** 「是否是同一人」确认框：读到没档案的证号、但档案里有同名且证号为空的老档案时才开 */
  const [mergeOpen, setMergeOpen] = useState(false);
  /**
   * 这一轮那张证的快照：`lastCard` 是跨页面共享的缓存，处理完必须立刻 `clear()`，
   * 而确认框／快捷登记框开着期间还要拿它预填与写库，所以开框前先把这张卡留一份。
   */
  const [pendingCard, setPendingCard] = useState<IdCardResult | null>(null);
  /** 这次制单要绑的卡（刷到才非空）。绑卡与取号同一次事务，所以它只在号取成之前存在 */
  const [cardNo, setCardNo] = useState<string | null>(presetCardNo);
  /**
   * `cardNo` 的镜像：读卡那一路的副作用只依赖 `lastCard`，闭包里的 `cardNo` 可能是旧的。
   * 自动制单要以"此刻这张卡在不在位"为准，所以从 ref 读，不从闭包读。
   */
  const cardNoRef = useRef<string | null>(presetCardNo);
  cardNoRef.current = cardNo;
  /**
   * 同一次「卡 + 人」只自动发一个号：读卡回写、草稿重跑都可能把同一对组合再送进来一次，
   * 而取号是不可逆的（`order_no` 一天一个序列）。制单成功或失败即复位，换卡/换人自然算新一轮。
   */
  const autoFired = useRef<string | null>(null);
  // 卡已经贴在感应区上、由刷卡推进带进来：本框挂载即就位（换卡/失败清空后不回弹，见 create.onError）
  useEffect(() => {
    if (presetCardNo) setCardNo(presetCardNo);
  }, [presetCardNo]);
  /**
   * 本面板自己弹的读卡框 / 绑卡框、以及**行内那 15 秒身份证监听**都要用那台共用读卡器
   * （06 §1.2：一台读卡器一次只解一种介质）。
   * 常驻在网格里的这一份没有 `regHolding` 兜底（复用它会连带把开框的面板自己卸载成占位卡），
   * 所以由面板自己挂 `panelHolding` 让工作台的后台 IC 常听让出设备锁。
   * 拆成两个效果：设值只看这几处的开合，复位只在卸载那一次跑——避免依赖变化时上一轮 cleanup
   * 抢先把标记打回 false、让 watch 抖一下，把正压在感应区上那一轮 `read` 判废。
   */
  useEffect(() => {
    setPanelHolding(scanOpen || bindOpen || idWatching || mergeOpen);
  }, [scanOpen, bindOpen, idWatching, mergeOpen, setPanelHolding]);
  useEffect(() => () => setPanelHolding(false), [setPanelHolding]);
  /** 去向默认折起来：多数站点制单时不登记仓房/货位，不该占住磅员的主视线 */
  const [destOpen, setDestOpen] = useState(false);
  const qc = useQueryClient();

  // 本站制单是否必须先刷一张流转卡。库里没这个键时按"强制"走，与 create_order 的默认值同一口径
  const flowOn = (useSetting("card_flow_mode").raw ?? "auto") !== "off";
  const requireCard = flowOn && useSetting("card_required_on_create").raw !== "false";
  /** 多仓站的制单默认仓房（迁移 0018 的站点参数）；空/非法值＝不预设 */
  const defaultWarehouseId = Number(useSetting("default_warehouse_id").raw ?? "");

  /**
   * IC 卡已就位而售粮人还没定 → 面板自己起那一轮 15 秒身份证监听（06 §4.0 两刷一条流）。
   * 两条入口都算：后台常听刷到空闲卡带进来的 `presetCardNo`、「制单请放流转卡」框读到的卡。
   * 依赖只留这两个，是为了让"这一轮监听"只由**卡或人的变化**发起：监听自己收工（`onEnd`）
   * 不会把它重开，人按了「取消」也就此回到等下一张卡，不会在原地反复出声。
   */
  useEffect(() => {
    // 人一定下来这一轮监听就没有意义了：再让它读到一张证，会把磅员刚选好的人悄悄换成下一个人
    if (draft.party) setIdWatching(false);
    else if (cardNo) setIdWatching(true);
    // draft.party 只取其有无，不需要整个对象
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardNo, draft.party]);

  /**
   * 读到身份证后的**唯一**处置点，三条出路都收敛到"定人 →（卡已在位就）自动取号"：
   *  1. 证号命中档案 → 带出这个人；
   *  2. 查无此证、且没有"同名 + 证号为空"的老档案 → 照卡面静默建档；
   *  3. 有那样的老档案 → 交「是否是同一人」由人认，机器不猜。
   */
  useEffect(() => {
    if (!lastCard) return;
    const card = lastCard;
    // 一律以证号为准：party_id 只是真机回查档案的附带结果，演示卡那个是 mock 序号，
    // 拿到真库档案里按 id 兜底会命中另一个无关的人
    const hit =
      parties.find((x) => x.id_card_no.trim().toUpperCase() === card.id_card_no) ??
      (card.real ? parties.find((x) => x.id === card.party_id) : undefined);
    if (!hit) {
      /**
       * 同名**且证号那一格为空**才需要人来认（02 §F3.1 一人一档）：早年手工建档、
       * 或办证后改过号的农户就是这个样子。这时静默新建等于给同一个人开出两张档案、
       * 两份余额，对账时才是要命的事；但也不许把人家已填了证号的老档案卷进来——
       * 那要么是该去档案页改那一格，要么本来就是两个人。
       */
      const twins = parties.filter(
        (p) => p.status === "active" && p.id_card_no.trim() === "" && p.name.trim() === card.name.trim(),
      );
      if (twins.length > 0) {
        setPendingCard(card); // 先快照，再清共享缓存：确认框开着期间还要拿这张卡写库
        setMergeOpen(true);
        announce("系统里有同名档案，请在屏幕上确认是否是同一个人");
        useDeviceStore.getState().reader.idcard.clear();
        return;
      }
      // 连可比的名字都没有：农户还站在读卡器前，就地按卡面建一张，不把磅员赶回档案页（02 §F1.1）
      void enrollFromCard(card);
      useDeviceStore.getState().reader.idcard.clear();
      return;
    }
    // 读卡不能成为绕过停用的后门：停用档案只挡新单，历史磅单照旧可查
    if (hit.status !== "active") {
      toast.error(`档案「${hit.name}」已停用，不能制单；要续收粮请到农户档案重新启用`);
      // 姓名不进喇叭（07 H12 同一条合规线），但这一声必须出：不念出来人会以为卡没读到，反复重刷
      announce("这个人的档案已经停用，不能制单");
      useDeviceStore.getState().reader.idcard.clear();
      return;
    }
    chooseParty(hit);
    toast.success(`读卡命中档案：${hit.name}`);
    announce("读卡成功");
    // 该带出的已经带出、该报的已经报完，这里才去补照片：档案还没有人像就把证件里这张写进去
    // （只补缺，已有照片不动）。异步 fire-and-forget——补得上补不上都不该拦住磅员取号（02 §F3.1）。
    void backfillPartyPhotoFromCard(card, hit, qc);
    // 卡已经贴在感应区上等着了：这一刷读到的就是那单要卖粮的人，号顺手取掉，不再要人点一下
    autoCreate(hit);
    // 这一刷到此为止。`last` 是跨页面共享的缓存，不清的话下次进工作台挂载会把旧卡当新读卡，
    // 凭空替本单选中上一个人。
    useDeviceStore.getState().reader.idcard.clear();
    // draft.vehicleNo 不入依赖，否则每次输入都会重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCard]);

  const create = useMutation({
    /**
     * 卡号与售粮人都走 mutation 变量：刷卡弹窗的回调里 `setCardNo` 还没生效、读卡那一路
     * 更是刚把档案挑出来，两种场合从闭包读 `draft.party` 都会拿到上一个人——取号不可逆，
     * 把上一个人的名字做成这一单，比制不出单严重得多。
     */
    mutationFn: (input: { card: string | null; party: Party }) =>
      api.createOrder({
        party_id: input.party.id,
        // 品种可空（迁移 0017）：制单只认「卡 + 售粮人」，结算与录化验前再定
        variety_id: draft.varietyId,
        vehicle_no: draft.vehicleNo.trim() || null,
        warehouse_id: draft.warehouseId,
        slot_id: draft.slotId,
        remark: draft.remark.trim() || null,
        card_no: input.card,
        registered_by: actorId(),
        weight_source: "scale",
      }),
    onSuccess: (o) => {
      toast.success(o.card_no ? `已取号 ${o.order_no} · 已绑卡 ${o.card_no}` : `已取号 ${o.order_no}`);
      announce("制单成功，请开车上磅");
      setCardNo(null);
      setIdWatching(false);
      autoFired.current = null; // 这一轮到此为止：换下一张卡重新算一次"要不要自动发号"
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["open-orders"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["cards"] });
      onCreated(o.order_no);
    },
    // 真库闸门回的是人话（"该售粮人档案不存在或已删除，请先建档"），要原样送到磅员眼前
    onError: (e: Error) => {
      setCardNo(null); // 被服务端拦下的卡不许原地重试，重新刷一张（并发下它可能刚被别人发走）
      setIdWatching(false); // 同理，人也没定下来：监听窗口一起收，回到"等下一张卡"
      autoFired.current = null;
      toast.error(`取号失败：${e.message || "请检查档案与品种是否齐全"}`);
      // 服务端原因带条款，念出来没人听得懂；只念"没取到号"+ 卡要重新刷这一条现场动作
      announce("这张单没能取到号，卡要重新刷一张");
    },
  });

  /** 定为本单售粮人：带出档案里的默认车牌（磅员已经手打过的不覆盖） */
  const chooseParty = (p: Party) =>
    onDraft({ party: p, vehicleNo: draft.vehicleNo || p.default_vehicle_no || "" });

  /**
   * 卡与人都就位 → 把这单制掉，零点击（06 §4.0 两刷一条流）。
   * **卡不在位一律不动**：没刷到流转卡就自动出号，等于绕过本站的绑卡闸门；
   * 那种场合仍由人点「取号并制单」（或走后台发卡），本面板不替磅员决定。
   */
  const autoCreate = (p: Party) => {
    const card = cardNoRef.current;
    if (!card) return;
    const key = `${card}:${p.id}`;
    if (autoFired.current === key) return; // 同一张卡反复压在读卡器上不该再吃一个号
    autoFired.current = key;
    create.mutate({ card, party: p });
  };

  /** 查无此证时的默认出路：照卡面静默建档，建好直接用于本单；**建不成**才回落到手工登记框 */
  const enrollFromCard = async (card: IdCardResult) => {
    const r = await enrollFromIdCard(qc, card);
    if (!r.ok) {
      // 岗位无权 / 证号撞车 / 库锁都是"这一刻建不下来"，把人接回原来那条手工路，别把这一刷白废
      setPendingCard(card);
      setEnrollOpen(true);
      announce("没能自动建档，请在弹窗里手工登记");
      return;
    }
    chooseParty(r.party);
    autoCreate(r.party);
  };

  /**
   * 制单闸门只剩**岗位权限**一道：品种可空（迁移 0017）、售粮人由那一轮自动监听去拿，
   * 这两样都不该把按钮按死——按死了 F7 就变成"点了没反应的灰按钮"，只剩彻底静默失败。
   * 所以「还没选人」时按钮照常可点，点了是把身份证监听起起来（见 `submit`）。
   */
  const blocked = !can("order.create")
    ? `当前岗位「${actor ? ROLE[actor.role] : "—"}」无权制单，需磅员、登记员或站长`
    : null;

  /**
   * 「取号并制单」缺什么补什么，顺序就是农户手上的先后：先要卡（本站强制绑卡而卡还没就位 →
   * 弹刷卡框），再要人（人还没定 → 起那一轮 15 秒行内监听，听不到才退回人工读卡/搜档案），
   * 两样都在就把这单制掉（06 §4.0）。
   */
  const submit = () => {
    if (blocked) {
      // 走到这儿多半是按了 F7：按钮是灰的、点了没反应，不念一句就是彻底的静默失败
      announce(blocked);
      return;
    }
    if (requireCard && !cardNo) {
      setBindOpen(true);
      return;
    }
    if (!draft.party) {
      useDeviceStore.getState().reader.idcard.clear(); // 别把上一轮读到的旧卡当这一轮的证件
      setIdWatching(true);
      return;
    }
    create.mutate({ card: cardNo, party: draft.party });
  };

  /** 停用只挡住新单：制单下拉一律排除 is_active = 0 的档案，历史磅单上仍按当时快照显示 */
  const activeVarieties = varieties.filter((v) => v.is_active !== 0);
  const activeWarehouses = warehouses.filter((w) => w.is_active !== 0);
  const activeSlots = slots.filter((s) => s.is_active !== 0);
  const slotPool = activeSlots.filter((s) => draft.warehouseId == null || s.warehouse_id === draft.warehouseId);

  /** 折叠行上的去向摘要：只选到货位时按货位反查仓房，保证摘要与展开后的下拉说的是同一处 */
  const chosenSlot = activeSlots.find((s) => s.id === draft.slotId) ?? null;
  const chosenWarehouse =
    activeWarehouses.find((w) => w.id === draft.warehouseId) ??
    activeWarehouses.find((w) => w.id === chosenSlot?.warehouse_id) ??
    null;
  const destination = [chosenWarehouse?.name, chosenSlot?.label].filter(Boolean).join(" / ");

  /**
   * 制单自动选仓房（迁移 0018）：站里只有一处启用仓房 → 没有选择题，直接选中它；
   * 有多处 → 认站长在「站点参数」里预设的 `default_warehouse_id`，留空或预设仓房
   * 已停用/删除就仍留「未定」，与升级前行为一致。
   * 自动带出只是**草稿的初始值**：磅员手动动过仓房下拉（含选回「未定」）后，这一单
   * 不再回填；售粮人从有到无＝开了一张新草稿，重新起算。
   */
  const warehouseHandled = useRef(false);
  const prevPartyId = useRef<number | null>(null);
  useEffect(() => {
    const pid = draft.party?.id ?? null;
    if (prevPartyId.current != null && pid === null) warehouseHandled.current = false;
    prevPartyId.current = pid;
  }, [draft.party]);
  const autoWarehouseId =
    activeWarehouses.length === 1
      ? (activeWarehouses[0]?.id ?? null)
      : (activeWarehouses.find((w) => w.id === defaultWarehouseId)?.id ?? null);
  useEffect(() => {
    if (warehouseHandled.current || draft.warehouseId != null || autoWarehouseId == null) return;
    warehouseHandled.current = true;
    onDraft({ warehouseId: autoWarehouseId });
    // onDraft 只是父层 setState 的补丁；弹窗那份每渲染换身份，进依赖会自激重跑，故不进
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.warehouseId, autoWarehouseId]);

  /**
   * 「是否是同一人」的候选：与读卡那一路的判据同一条（同名 + 证号为空 + 在册），
   * 从 `pendingCard` 现算而不是把 effect 里筛好的数组存进 state——`parties` 会被
   * 建档/补录翻新，框开着的时候列表应当跟着最新的档案走，不留一份会过期的快照。
   */
  const twinCandidates = pendingCard
    ? parties
        .filter(
          (p) => p.status === "active" && p.id_card_no.trim() === "" && p.name.trim() === pendingCard.name.trim(),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
    : [];

  if (order) {
    const orderDestination = [order.warehouse_name, order.slot_label].filter(Boolean).join(" / ");
    return (
      <Card size="sm" className="py-0 gap-0">
        <CardHeader className="card-header-compact border-b px-2.5">
          <CardTitle className="flex items-center gap-2 text-xs font-semibold">
            身份与制单
            <OrderStatusBadge status={order.status} />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5 p-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold">{order.party_name}</span>
            <span className="tnum text-xs text-muted-foreground">{order.order_no}</span>
          </div>
          <div className="flex flex-col gap-0.5 text-xs">
            <p className="flex flex-wrap items-baseline gap-x-2.5">
              <span className="text-muted-foreground">证号 <span className="tnum text-foreground">{maskIdCard(order.id_card_no)}</span></span>
              <span className="text-muted-foreground">{PARTY_TYPE[order.party_type]}</span>
            </p>
            <p className="text-muted-foreground">
              品种{" "}
              <span className={order.variety_name ? "text-foreground" : undefined}>
                {order.variety_name ?? "未定品种"}
              </span>
              {order.grade ? <span className="text-foreground">{order.grade}</span> : null}
            </p>
            <p className="text-muted-foreground">
              去向{" "}
              <span className={orderDestination ? "text-foreground" : "text-muted-foreground"}>
                {orderDestination || "未登记"}
              </span>
            </p>
            <p className="text-muted-foreground">
              制单 <span className="tnum text-foreground">{order.registered_at.slice(5, 16).replace("T", " ")}</span>
            </p>
          </div>
          {/* 车牌与备注：制单成功后仍就地可改（过磅/结算时才发现没填车牌、要补备注是现场常态），
              输入停顿即自动落库并留痕——不碰钱也不碰状态，所以不设终态闸门 */}
          <OrderMetaEditor key={order.order_no} order={order} editable={can("order.create")} />
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <Button size="sm" variant="outline" onClick={onNewOrder} disabled={!can("order.create")} className="h-7 text-xs">
              <UserRoundPlusIcon />
              新建下一单（F7）
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)} className="h-7 text-xs">
              <CreditCardIcon />
              读卡换人（F8）
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{ORDER_HINT[order.status]}</p>
        </CardContent>

        <PartyPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          title="读卡换人：请选择新的售粮人"
          onPick={(p) => toast.info(`下一单请用「${p.name}」，先点「新建下一单」`)}
        />
      </Card>
    );
  }

  return (
    <Card size="sm" className="py-0 gap-0">
      <CardHeader className="card-header-compact border-b px-2.5">
        <CardTitle className="text-xs font-semibold">身份与制单</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 p-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            onClick={() => {
              // 清掉上一轮读卡在 store 里的残留（last/error 都长存不清）：
              // 不清的话弹窗一挂载就会把旧卡当"刚读到"回填、把旧错误当新故障重放
              useDeviceStore.getState().reader.idcard.clear();
              // 行内监听先收工再开框：一台读卡器容不下两条 watch，后开的那条会当场退让、
              // 于是格子里冒出一句"监听了 15 秒还没读到证件"的假超时
              setIdWatching(false);
              setScanOpen(true);
            }}
            disabled={reading || !can("order.create")}
            className="h-7 text-xs"
          >
            <CreditCardIcon />
            {reading ? "读卡中…" : "读卡（F8）"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)} className="h-7 text-xs">
            <SearchIcon />
            搜档案
          </Button>
          {/* 无外设 / 证号在档案里录错时的那条路：手录一张新档案，不用离开制单去档案页
              （05 §4.0 的"手录证号建档"靠这个按钮兑现） */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              useDeviceStore.getState().reader.idcard.clear();
              setIdWatching(false);
              setPendingCard(null); // 手工新建不带卡片，别把上一轮那张证的姓名住址预填进来
              setEnrollOpen(true);
            }}
            disabled={!can("order.create")}
            className="h-7 text-xs"
          >
            <UserRoundPlusIcon />
            新档案
          </Button>
        </div>

        <div className="border bg-muted/30 p-1.5">
          {draft.party ? (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">{draft.party.name}</span>
                <ToneBadge tone={draft.party.party_type === "farmer" ? "neutral" : "info"}>
                  {PARTY_TYPE[draft.party.party_type]}
                </ToneBadge>
              </div>
              <span className="tnum text-xs text-muted-foreground">{maskIdCard(draft.party.id_card_no)}</span>
              <span className="text-xs text-muted-foreground">
                {draft.party.address}
                {draft.party.phone ? ` · ${draft.party.phone}` : ""}
              </span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              尚未确定售粮人{idWatching ? "：请把身份证放到感应区" : "（支持读卡或搜档案）"}
            </p>
          )}
        </div>

        <div className="grid gap-1">
          <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            收购品种（选填，结算与化验前必填）
            <Choose
              aria-label="收购品种"
              id="ws-variety"
              value={String(draft.varietyId ?? "")}
              onChange={(v) => onDraft({ varietyId: v ? Number(v) : null })}
              options={[
                { value: "", label: "未定（结算前再选）" },
                ...activeVarieties.map((v) => ({ value: String(v.id), label: v.name })),
              ]}
            />
          </Label>
          <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            <span>车牌号</span>
            <PlateField
              aria-label="车牌号"
              value={draft.vehicleNo}
              onChange={(v) => onDraft({ vehicleNo: v })}
              inputClassName="h-7 text-xs"
            />
          </div>
          {/* 去向是可选登记项：默认折成一行，不跟品种/车牌抢主视线；填了就把值亮在行上，
              免得磅员不知道这单到底带没带去向 */}
          <div className="border-t pt-1">
            <button
              type="button"
              aria-expanded={destOpen}
              onClick={() => setDestOpen((v) => !v)}
              className="flex w-full items-center gap-1 text-left text-xs text-muted-foreground"
            >
              {destOpen ? (
                <ChevronDownIcon className="size-3 shrink-0" />
              ) : (
                <ChevronRightIcon className="size-3 shrink-0" />
              )}
              <span className="shrink-0">入仓去向</span>
              <span className={cn("min-w-0 flex-1 truncate", destination && "text-foreground")}>
                {destination || "未定（可不填）"}
              </span>
              <span className="shrink-0">{destOpen ? "收起" : destination ? "修改" : "选填"}</span>
            </button>
            {destOpen && (
              <>
                <div className="mt-1 grid grid-cols-2 gap-1.5">
                  <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                    仓房
                    <Choose
                      aria-label="仓房"
                      value={String(draft.warehouseId ?? "")}
                      onChange={(v) => {
                        warehouseHandled.current = true; // 人已动手（含选回「未定」），这一单不再自动回填
                        onDraft({ warehouseId: v ? Number(v) : null, slotId: null });
                      }}
                      options={[
                        { value: "", label: "未定" },
                        ...activeWarehouses.map((w) => ({ value: String(w.id), label: w.name })),
                      ]}
                    />
                  </Label>
                  <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                    货位
                    <Choose
                      aria-label="货位"
                      value={String(draft.slotId ?? "")}
                      onChange={(v) => onDraft({ slotId: v ? Number(v) : null })}
                      options={[
                        { value: "", label: "未定" },
                        ...slotPool.map((s) => ({ value: String(s.id), label: s.label })),
                      ]}
                    />
                  </Label>
                </div>
                <p className="pt-0.5 text-[11px] text-muted-foreground">
                  需要按去向统计的站点才登记，留空照样能取号制单；此处选了只对本单生效，下一单沿用上一张的去向。
                </p>
              </>
            )}
          </div>
          <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            <span>备注（选填）</span>
            <ComboBox
              aria-label="备注"
              presets={remarkOptions}
              value={draft.remark}
              onChange={(v) => onDraft({ remark: v })}
              placeholder="选一条常用的，或自己写…"
              className="h-8 py-0 text-xs"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1 border-t pt-1">
          {cardNo ? (
            <p className="flex items-center justify-between gap-1.5 text-xs">
              <span className="min-w-0 truncate text-muted-foreground">
                流转卡 <span className="tnum text-foreground">{cardNo}</span> · 随本单一起绑上
              </span>
              <button type="button" onClick={() => setBindOpen(true)} className="shrink-0 text-primary hover:underline">
                换卡
              </button>
            </p>
          ) : requireCard ? (
            <p className="text-[11px] text-muted-foreground">本站制单要绑流转卡：点下面的按钮会提示把 IC 卡贴到感应区</p>
          ) : (
            <button
              type="button"
              onClick={() => setBindOpen(true)}
              disabled={!!blocked}
              className="self-start text-[11px] text-muted-foreground enabled:hover:text-foreground enabled:hover:underline disabled:opacity-50"
            >
              想顺手把卡也发了？刷一张 IC 卡（选填）
            </button>
          )}
          {/* 卡就位而人还没定 → 那一轮 15 秒监听就挂在这一格里：不弹窗、不挡过磅，
              读完/超时/取消都由它自己收工，面板回到等下一张卡（06 §4.0 两刷一条流） */}
          {idWatching && <IdCardWatchHint onEnd={() => setIdWatching(false)} />}
          <Button size="sm" onClick={submit} disabled={!!blocked || create.isPending} className="h-7 text-xs">
            取号并制单（F7）
          </Button>
          {blocked && <p className="text-xs text-warning">{blocked}</p>}
        </div>
      </CardContent>

      <PartyPicker open={pickerOpen} onOpenChange={setPickerOpen} onPick={(p) => onDraft({ party: p, vehicleNo: p.default_vehicle_no ?? draft.vehicleNo })} />

      {/* 读卡弹窗：开着就连续寻卡，读到卡由上方 lastCard 副作用带出档案并自动关窗。
          退路是「搜档案」——复用同一个 PartyPicker，读不出卡也能继续制单 */}
      <CardScanDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        scene="order"
        onManualEntry={() => setPickerOpen(true)}
      />

      {/* 制单绑卡（06 §4.0）：读到一张在册、空闲、没挂着未完成单的卡才算就位。
          售粮人已经定了 → 卡一就位就把这单制掉；还没定 → 只把卡留下，由上面那条 effect
          接着起那一轮 15 秒身份证监听，等第二刷（两刷一条流，中间不再要人点击） */}
      <CardBindDialog
        open={bindOpen}
        onOpenChange={setBindOpen}
        required={requireCard}
        onPicked={(sn) => {
          setBindOpen(false);
          setCardNo(sn);
          // 强制绑卡的站点：卡一就位就把这单制掉，省一次点击（弹窗文案就是这么说的）
          if (requireCard && draft.party) create.mutate({ card: sn, party: draft.party });
        }}
        onSkip={() => {
          setBindOpen(false);
          submit(); // 走同一条校验：选填入口可能在售粮人还没选定时就开着
        }}
      />

      {/* 自动建档走不通时才到这里：手工快捷登记，建好直接选为本单售粮人（02 §F1.1）。
          卡片取 `pendingCard` 快照——`last` 在处理完那一刻就被清了（不清会把旧卡当新读卡重放）。
          关框即丢掉这份快照：不丢的话下次点「新档案」会拿上一个人的姓名住址预填 */}
      <QuickPartyDialog
        open={enrollOpen}
        onOpenChange={(v) => {
          setEnrollOpen(v);
          if (!v) {
            setPendingCard(null);
            useDeviceStore.getState().reader.idcard.clear();
          }
        }}
        card={pendingCard}
        parties={parties}
        onEnrolled={(p) => {
          chooseParty(p);
          autoCreate(p); // 卡早就贴在感应区上了：人一定下来就没必要再等那一下点击
        }}
        onSearchParty={() => setPickerOpen(true)}
      />

      {/* 读到没档案的证号、系统里却有同名且证号为空的老档案：认人这一步只能由人来点（02 §F3.1
          一人一档）。认下来给老档案补证号、沿用它的历史；不是本人就另建一张，两条都直接用于本单 */}
      <SamePartyDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        card={pendingCard}
        candidates={twinCandidates}
        onPick={(p) => {
          setPendingCard(null);
          chooseParty(p);
          autoCreate(p);
        }}
        // 新建这条路被闸门挡住（岗位无权 / 证号撞车 / 库锁）：快照留着，交回手工登记框接着办
        onNeedManual={() => setEnrollOpen(true)}
      />
    </Card>
  );
}

/**
 * 制单成功后车牌 / 备注的就地编辑 + 自动保存。
 *
 * 单抽一个组件是为了让它持有**自己的输入态**：`order` 每次被订单查询刷新都会传下一个新对象，
 * 直接把输入框受控于 `order`，正在输入时那一刷就把光标位置 / 还没落库的半截字冲掉。这里只在
 * 挂载时（按 order_no 换单，见调用处 `key`）以 `order` 播种，之后以本地态为准，落库成功再回填基线。
 *
 * 落库走 `api.updateOrder`（真库 order_update / 浏览器 mock）：输入停顿 700ms 自动保存一次，
 * 卸载时（切单、让位成占位卡）把还没发出去的改动补发一次，绝不吞。岗位无权改（非磅房工位）时
 * 退回只读文本——不摆一个点了会报错的输入框骗人。
 */
function OrderMetaEditor({ order, editable }: { order: WeighOrder; editable: boolean }) {
  const qc = useQueryClient();
  const { options: remarkOptions } = useQuickOptions("remark");
  const [vehicleNo, setVehicleNo] = useState(order.vehicle_no ?? "");
  const [remark, setRemark] = useState(order.remark ?? "");
  const [status, setStatus] = useState<SaveStatus>("idle");

  // 最新值放 ref，供防抖与卸载补发读到，避免 setTimeout / cleanup 闭包拿到旧值
  const cur = useRef({ vehicleNo, remark });
  cur.current = { vehicleNo, remark };
  // 已落库基线（trim 后比较，避免尾部空格抖动反复写库）
  const saved = useRef({ vehicleNo: order.vehicle_no ?? "", remark: order.remark ?? "" });
  const isDirty = () =>
    cur.current.vehicleNo.trim() !== saved.current.vehicleNo.trim() ||
    cur.current.remark.trim() !== saved.current.remark.trim();

  const save = useMutation({
    mutationFn: () =>
      api.updateOrder({
        order_no: order.order_no,
        vehicle_no: cur.current.vehicleNo.trim() || null,
        remark: cur.current.remark.trim() || null,
        operator_id: actorId(),
      }),
    onMutate: () => setStatus("saving"),
    onSuccess: () => {
      saved.current = { vehicleNo: cur.current.vehicleNo, remark: cur.current.remark };
      setStatus("saved");
      qc.invalidateQueries({ queryKey: ["order", order.order_no] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["open-orders"] });
    },
    // 与面板其余写操作同一口径：真库闸门回的是人话，原样送到眼前，绝不静默失败
    onError: (e: Error) => {
      setStatus("error");
      toast.error(`没保存上：${e.message || "请重试"}`);
    },
  });

  const dirty = vehicleNo.trim() !== saved.current.vehicleNo.trim() || remark.trim() !== saved.current.remark.trim();

  // 输入停顿 700ms 自动落库；期间再改就重新计时（save/dirty 用最新闭包，不列依赖以免自触发）
  useEffect(() => {
    if (!dirty) return;
    const t = window.setTimeout(() => save.mutate(), 700);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleNo, remark, dirty]);

  // 卸载 / 切单时把还没发出去的改动补发一次（不 setState，避免对已卸载组件回写）
  useEffect(
    () => () => {
      if (!isDirty()) return;
      void api
        .updateOrder({
          order_no: order.order_no,
          vehicle_no: cur.current.vehicleNo.trim() || null,
          remark: cur.current.remark.trim() || null,
          operator_id: actorId(),
        })
        .then(() => qc.invalidateQueries({ queryKey: ["order", order.order_no] }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  if (!editable) {
    return (
      <div className="flex flex-col gap-0.5 border-t pt-1 text-xs text-muted-foreground">
        <p>
          车牌 <span className="tnum text-foreground">{order.vehicle_no ?? "—"}</span>
        </p>
        {order.remark ? <p>备注：{order.remark}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 border-t pt-1">
      <div className="grid grid-cols-2 items-end gap-1.5">
        <div className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
          <span>车牌号</span>
          <PlateField aria-label="车牌号" value={vehicleNo} onChange={setVehicleNo} inputClassName="h-7 text-xs" />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
          <span>备注（选填）</span>
          <ComboBox
            aria-label="备注"
            presets={remarkOptions}
            value={remark}
            onChange={setRemark}
            placeholder="选一条常用的，或自己写…"
            className="h-8 py-0 text-xs"
          />
        </div>
      </div>
      {status !== "idle" && (
        <p className={cn("text-[11px]", status === "error" ? "text-warning" : "text-muted-foreground")}>
          {SAVE_STATE[status]}
        </p>
      )}
    </div>
  );
}

/** 自动保存的三种反馈态（idle 不占行，故不进 SAVE_STATE） */
type SaveStatus = "idle" | "saving" | "saved" | "error";
const SAVE_STATE: Record<Exclude<SaveStatus, "idle">, string> = {
  saving: "保存中…",
  saved: "已自动保存",
  error: "保存失败，正在等你重改",
};

/** 状态 → 下一步动作提示，避免"卡在中间态不知道该干什么" */
const ORDER_HINT: Record<WeighOrder["status"], string> = {
  draft: "已取号，尚未确定重量与化验。",
  registered: "等待过磅或化验。",
  qc_done: "化验已录，待过磅取重。",
  gross_weighed: "已取毛重，卸货后请捕皮重。",
  tare_weighed: "已取皮重，重车上榜后捕毛重。",
  reweigh: "复称中，净重可能调整。",
  to_settle: "净重已定，请到右侧结算。",
  settled: "已结算，可打印码单；付款走结算中心。",
  paid: "粮款已付清。",
  archived: "已归档，只读。",
  voided: "本单已作废，仅作留痕。",
  reversed: "本单已被红冲，请查红冲单。",
  rejected: "拒收退粮，不产生粮款。",
};

/**
 * ② 皮重参考。
 *
 * 只做"显示 + 偏差警示"，绝不拿历史值去替代实测皮重（03 §4.2）；
 * 偏差超容差时整块转警示态，捕获那一步只给警告并照常入账（磅单留醒目提醒）。
 * 磅员要的是"差多少、有没有超"，所以最近一次／均值／容差／偏差压成一行，
 * 近 5 次明细以数字串保留在同一行内，完整历史看农户档案页。
 */
export function TarePanel({
  recent,
  last01kg,
  mean01kg,
  tolerancePct,
  currentTare01kg,
  alert,
  partyId,
}: {
  recent: { date: string; tare_01kg: number; source: string }[];
  last01kg: number | null;
  mean01kg: number | null;
  tolerancePct: number;
  currentTare01kg: number | null;
  alert: boolean;
  partyId: number | null;
}) {
  const diff = currentTare01kg != null && mean01kg != null ? currentTare01kg - mean01kg : null;
  return (
    <Card size="sm" className={cn("py-0 gap-0", alert && "ring-warning/60")}>
      <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center border-b px-2.5">
        <CardTitle className="text-xs font-semibold">皮重参考</CardTitle>
        <CardAction className="self-center">
          {alert ? <ToneBadge tone="warning">偏差超容差</ToneBadge> : <ToneBadge tone="neutral">参考值</ToneBadge>}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 p-2">
        <p className="flex flex-wrap items-baseline gap-x-2.5 text-xs">
          <span className="text-muted-foreground">
            最近一次 <span className="tnum text-sm font-semibold text-foreground">{weight(last01kg)}</span>
          </span>
          <span className="text-muted-foreground">
            近 5 次均值{" "}
            <span className="tnum text-sm">{mean01kg == null ? "—" : `${weight(mean01kg, false)}（${ton(mean01kg)}）`}</span>
          </span>
          <span className="text-muted-foreground">容差 ±{tolerancePct}%</span>
          {diff != null && (
            <span className={cn("tnum", alert ? "font-semibold text-warning" : "text-muted-foreground")}>
              当前偏差 {diff > 0 ? "+" : ""}
              {weight(diff, false)}
            </span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {recent.length === 0
            ? "暂无历史，首次过磅后自动累积。"
            : `近 5 次 ${recent.map((r) => `${weight(r.tare_01kg, false)}${r.source === "manual" ? "手" : ""}`).join(" / ")} kg`}
          {partyId != null && (
            <QuickDetailLink type="party" id={partyId} className="ml-1 text-primary">
              档案明细
            </QuickDetailLink>
          )}
        </p>
        {alert && <p className="text-xs text-warning">捕获时会给出超差警告并照常入账，磅单上留醒目提醒；历史值只作参考，不替代实测。</p>}
      </CardContent>
    </Card>
  );
}
