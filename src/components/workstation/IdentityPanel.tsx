/**
 * ① 身份与制单 + ② 历史皮重（05 §4 左栏）。
 *
 * 制单前是一段"草稿态"（还没号），制单后同一栏退化为只读摘要 + 新建下一单，
 * 这样磅员的目光始终落在同一块位置，不必在两屏之间来回找。
 *
 * 读卡是可选路径：阅读器离线时必须能搜档案或手工输入，
 * 这是 05 §10-1「无外设也要能完成闭环」的硬要求。
 *
 * **流转卡不是可选的**（06 §4.0）：站点参数「制单必须绑卡」默认开着，点「取卡并制单」
 * 先弹刷卡框，读到一张可用的空闲卡才取号——读不到卡这张单就制不成。关掉该参数
 * （或本站压根不用流转卡）才回到"无卡制单、事后靠后台监听发卡"。
 *
 * **主按钮左边还有一颗「无卡制单」**（同一节，仅在本站强制绑卡而手上没卡时出现）：读卡器坏了、
 * 卡池见底这类现场救急，不该等站长去改全站参数。它只放开"必须刷到卡"这一道闸（品种、售粮人、
 * 卡在册/未注销/没挂着未完成单照旧），出来的单 `card_no` 为空并在审计里写明"无卡制单"，事后由
 * 磅单详情「补绑流转卡」或工作台后台监听发卡认领（06 §4.1）。岗位权限闸门暂未加，排在后面。
 *
 * **两刷一条流，中间那一下点击是多余的**（06 §4.0）：农户一手拿证一手拿卡站在窗口前，
 * 机器两次都读到了，缺的只是人最后去按那个按钮。所以卡一就位而售粮人还没定，本面板
 * 自己开始听身份证（`IdCardWatchHint` 行内那 15 秒，不再弹框），读到即往下走：
 *  1. 证号命中档案 → 带出售粮人，随即自动取号制单（停用档案照旧挡在门外）；这一刷顺手把这张
 *     档案的「未核验」升成「已核验」（02 §F3.1，判据与写入收在 `lib/party-verify`，见下面那条 effect）；
 *  2. 查无此证、且档案里也没有"同名 + 证号为空"的老档案 → **静默按卡面建档**（电话留空，
 *     得空去档案页补），建好直接用于本单（02 §F1.1）；
 *  3. 有同名且证号为空的老档案 → 弹「是否是同一人」：认下来就给那张老档案补证号
 *     （历史磅单照旧跟着它），不是本人就另建一张。这一个岔口机器不替人猜——
 *     同一个人建两张档案，对账时就是两个余额（`party_save` 的"一人一档"闸门同一条理由）。
 * 三条出路最终都回到同一句 `autoCreate`：卡与人都就位，号就取掉。
 *
 * **品种是必填的**：结算的单价要对回价目表、化验的指标集与扣量基准全来自品种档案，
 * 这两件事都等不起（车卸完了才发现没品种，价格已经错过一次对照）。所以品种与售粮人同级，
 * 缺了就不出号。沿用的上一张单的品种（`emptyDraft` 的初值，磅房最省手）覆盖绝大多数场合，
 * 只有当天第一单、或从顶栏直接开单时才要磅员动一下手。服务端 `orders.rs::create_order`
 * 有同一道闸兜底，别只靠这里。
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon, CreditCardIcon, SearchIcon, UserRoundPlusIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { announce } from "@/lib/voice-prompt";
import type { GrainVariety, Party, StorageSlot, Warehouse, WeighOrder } from "@/mock/types";
import { PARTY_TYPE, ROLE, isManualWeightSource, weightSourceLabel } from "@/lib/constants";
import { ton, weight } from "@/lib/format";
import { backfillPartyPhotoFromCard } from "@/lib/party-photo";
import { upgradeVerifiedFromCard } from "@/lib/party-verify";
import { enrollFromIdCard } from "@/lib/party-auto-register";
import { tareDev01kg, tareOverTolerance, tareRefRows, type TareRefRow } from "@/lib/tare-ref";
import { useDeviceStore, type IdCardResult } from "@/store/device";
import { useQuickOptions, useSetting } from "@/hooks/useLookups";
import { actorId, useActor, useSession } from "@/store/session";
import { Choose } from "@/components/business/Choose";
import { ComboBox } from "@/components/business/ComboBox";
import { IdCardText } from "@/components/business/IdCardText";
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
import { digitKeys, KeypadInput } from "@/components/ui/keypad";
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
  /** 「制单请放流转卡」弹窗：点「取卡并制单」时卡还没就位就弹它（06 §4.0） */
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
   * `draft.varietyId` 的镜像，与 `cardNoRef` 同一条理由：`enrollFromCard` 里那个 `await`
   * 之后、以及读卡那一路的副作用里，闭包拿到的可能是上一轮草稿。品种现在是出号的硬条件，
   * 判"此刻到底选没选"必须读现值的 ref。
   */
  const varietyIdRef = useRef<number | null>(draft.varietyId);
  varietyIdRef.current = draft.varietyId;
  /** 点过「取卡并制单」却还缺品种时把那一格标红：提示过一次之后才亮，不预先红着吓人 */
  const [varietyMissing, setVarietyMissing] = useState(false);
  // 品种一旦补上就撤掉红框。写在 effect 里是为了连"父层换草稿时直接塞进一个品种"
  // （`emptyDraft(lastVarietyId)`）也能撤——那条路不经过下拉的 onChange
  useEffect(() => {
    if (draft.varietyId != null) setVarietyMissing(false);
  }, [draft.varietyId]);
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
   *  1. 证号命中档案 → 带出这个人，并把这张档案顺手升级成「已核验」；
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
    /**
     * 读卡命中＝这一刷替这张档案做成了实名核验：当年手录证号留下的那行「未核验」当场升上去，
     * 不等磅员跑回档案页点一次保存（02 §F3.1）。演示卡不盖章、已经是 1 的不重写、卡面与档案的
     * 逐字比对由后端重算——三条闸门收在 `lib/party-verify`，与档案详情「读卡核对」共用同一份。
     * 一样是 fire-and-forget：标记没写成只是这一格没升级，绝不该拦住磅员取号（与补照片同一条判断）。
     */
    void upgradeVerifiedFromCard(card, hit, qc).then((r) => {
      if (r.kind === "upgraded") toast.success(`证号与卡面一致，档案「${hit.name}」已转为「已核验」`);
      else if (r.kind === "failed")
        toast.warning(`「已核验」没写进档案「${hit.name}」：${r.reason}`, {
          description: "本单照制，到档案详情再刷一次「读卡核对」。",
        });
    });
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
     * 卡号、售粮人、品种三样都走 mutation 变量：刷卡弹窗的回调里 `setCardNo` 还没生效、
     * 读卡那一路更是刚把档案挑出来，两种场合从闭包读 `draft` 都会拿到上一个人 / 上一个品种——
     * 取号不可逆，把上一个人的名字或上一个品种做成这一单，比制不出单严重得多。
     */
    mutationFn: (input: { card: string | null; party: Party; varietyId: number; allowNoCard?: boolean }) =>
      api.createOrder({
        party_id: input.party.id,
        // 品种是必填项（与 Rust `create_order` 同一道闸）：出号前一律先过 `createNow` 的齐备检查
        variety_id: input.varietyId,
        vehicle_no: draft.vehicleNo.trim() || null,
        warehouse_id: draft.warehouseId,
        slot_id: draft.slotId,
        remark: draft.remark.trim() || null,
        card_no: input.card,
        // 现场退路「无卡制单」：只放开本站"制单必须绑卡"这一道闸，其余闸门与刷到卡时一字不差
        allow_no_card: input.allowNoCard ?? false,
        registered_by: actorId(),
        weight_source: "scale",
      }),
    onSuccess: (o) => {
      toast.success(o.card_no ? `已取号 ${o.order_no} · 已绑卡 ${o.card_no}` : `已取号 ${o.order_no} · 本单未绑流转卡，记得补绑`);
      // 没卡的那张单在磅房里是靠卡往下走的（刷毛重、刷皮重、刷结算），念一句比在屏幕上多一行字管用
      announce(o.card_no ? "制单成功，请开车上磅" : "制单成功，请开车上磅，记得给这张单补一张卡");
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
   * 品种那一格还空着：把话说在眼前，光标也直接送到那个下拉上——不让人自己在一屏控件里
   * 找是哪儿没填。固定 toast id 去重：卡与人的自动流程跑起来会连着调它两次。
   */
  const needVariety = () => {
    setVarietyMissing(true);
    toast.warning("请先选收购品种：制单必填", { id: "ws-variety-required" });
    announce("请先选收购品种");
    document.getElementById("ws-variety")?.focus();
  };

  /**
   * 卡、人、品种三样齐了才出号，零点击（06 §4.0 两刷一条流）。缺哪样都不在本函数里代劳：
   * **卡不在位一律不动**——没刷到流转卡就自动出号，等于绕过本站的绑卡闸门；
   * **品种没选也只提示不动手**——品种是必填项，等磅员点一下那个下拉再按主按钮。
   */
  const autoCreate = (p: Party) => {
    const card = cardNoRef.current;
    if (!card) return;
    const varietyId = varietyIdRef.current;
    if (varietyId == null) {
      needVariety();
      return;
    }
    const key = `${card}:${p.id}`;
    if (autoFired.current === key) return; // 同一张卡反复压在读卡器上不该再吃一个号
    autoFired.current = key;
    create.mutate({ card, party: p, varietyId });
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
   * 制单闸门对按钮只有**岗位权限**一道：品种必填、售粮人由那一轮自动监听去拿，这两样
   * 都不该把按钮按死——按死了 F7 就变成"点了没反应的灰按钮"，只剩彻底静默失败。
   * 所以缺品种 / 缺人时按钮照常可点，点了会把缺的那一样说出声（见 `submit`）。
   */
  const blocked = !can("order.create")
    ? `当前岗位「${actor ? ROLE[actor.role] : "—"}」无权制单，需磅员、登记员或站长`
    : null;

  /**
   * 「取卡并制单」缺什么补什么，顺序按柜面上的先后：先看品种（形式最上面那一格，也是唯一
   * 板上钉钉的必填项），再要卡（本站强制绑卡而卡还没就位 → 弹刷卡框），再要人（人还没定 →
   * 起那一轮 15 秒行内监听，听不到才退回人工读卡 / 搜档案），三样都在才把这单制掉（06 §4.0）。
   *
   * `allowNoCard` 是左边那颗「无卡制单」：读卡器坏了、卡池见底时先把号取出来，卡事后补
   * （06 §4.0 的现场退路，不改全站参数）。它跳过的只有"弹绑卡框"那一步，**人这一格照旧要定**——
   * 那条 15 秒自动认人挂在"卡已就位"上，没卡就没有自动认人，这一路不替磅员猜售粮人是谁。
   */
  const submit = (opts: { allowNoCard?: boolean } = {}) => {
    if (blocked) {
      // 走到这儿多半是按了 F7：按钮是灰的、点了没反应，不念一句就是彻底的静默失败
      announce(blocked);
      return;
    }
    const varietyId = draft.varietyId;
    if (varietyId == null) {
      needVariety();
      return;
    }
    if (requireCard && !cardNo && !opts.allowNoCard) {
      setBindOpen(true);
      return;
    }
    if (!draft.party) {
      useDeviceStore.getState().reader.idcard.clear(); // 别把上一轮读到的旧卡当这一轮的证件
      setIdWatching(true);
      if (opts.allowNoCard) {
        // 主按钮那一路等人是靠"卡已经在手上"，这一路没有卡：话说在前面，否则人放完证不知道还要再点一次
        toast.info("无卡制单还差售粮人：请放身份证，或点「搜档案」挑一个，再点一次这颗按钮", { id: "ws-nocard-party" });
        announce("还差售粮人，请放身份证，选好以后再点一次无卡制单");
      }
      return;
    }
    create.mutate({ card: cardNo, party: draft.party, varietyId, allowNoCard: !!opts.allowNoCard });
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
    // 摘要态那一格电话取自档案列表（`WorkstationPage` 常驻的 `["parties", ""]`，无限量）。
    // 查不到只可能是档案已软删——那就整行不摆，不摆一个点了必然报错的控件骗人。
    const orderParty = parties.find((p) => p.id === order.party_id);
    return (
      <Card size="sm" className="py-0 gap-0">
        <CardHeader className="card-header-compact px-2.5">
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
              <span className="text-muted-foreground">证号 <IdCardText value={order.id_card_no} partyId={order.party_id} className="tnum text-foreground" /></span>
              <span className="text-muted-foreground">{PARTY_TYPE[order.party_type]}</span>
            </p>
            {/* 制单后才发现电话录错是现场常态——车牌与备注为此早就开了就地改的口子。摘要态
                不给这一格，等于把人赶回档案页，而档案页一走就丢了这张单的上下文。 */}
            {orderParty ? <PartyPhoneField key={orderParty.id} party={orderParty} editable={can("order.create")} /> : null}
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
      <CardHeader className="card-header-compact px-2.5">
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
              <IdCardText value={draft.party.id_card_no} partyId={draft.party.id} className="tnum text-xs text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{draft.party.address}</span>
              {/* 电话原本挂在住址后面那段灰字里：与住址同字号同灰度、没标签也没点击区，
                  磅员在强光下认不出那是电话号码，于是把它敲进了正下方唯一能写字的车牌框。
                  拆出来独立成一行、就地可改，填错格子这件事就没有了成因。 */}
              <PartyPhoneField
                key={draft.party.id}
                party={draft.party}
                editable={can("order.create")}
                onSaved={(p) => onDraft({ party: p })}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              尚未确定售粮人{idWatching ? "：请把身份证放到感应区" : "（支持读卡或搜档案）"}
            </p>
          )}
        </div>

        <div className="grid gap-1">
          <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            <span>收购品种 <span className="text-warning">*</span></span>
            {/* 沿用的上一张单的品种已经预填（`emptyDraft` 的初值），多数时候磅员不用动这一格 */}
            <Choose
              aria-label="收购品种"
              id="ws-variety"
              invalid={varietyMissing && draft.varietyId == null}
              value={String(draft.varietyId ?? "")}
              onChange={(v) => {
                const id = v ? Number(v) : null;
                setVarietyMissing(false);
                onDraft({ varietyId: id });
              }}
              options={[
                { value: "", label: "请选择品种" },
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
                  留空也能取号；这里选了只对本单生效，下一单沿用上一张的去向。
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
              <Button type="button" variant="link" size="xs" className="h-auto shrink-0 p-0 text-xs" onClick={() => setBindOpen(true)}>
                换卡
              </Button>
            </p>
          ) : requireCard ? (
            <p className="text-[11px] text-muted-foreground">
              本站制单要绑流转卡：把卡贴到感应区；读不出卡时可点「无卡制单」，卡事后补绑
            </p>
          ) : (
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() => setBindOpen(true)}
              disabled={!!blocked}
              className="h-auto w-fit p-0 text-[11px] font-normal text-muted-foreground enabled:hover:text-foreground enabled:hover:underline"
            >
              顺带刷一张流转卡（选填）
            </Button>
          )}
          {/* 卡就位而人还没定 → 那一轮 15 秒监听就挂在这一格里：不弹窗、不挡过磅，
              读完/超时/取消都由它自己收工，面板回到等下一张卡（06 §4.0 两刷一条流） */}
          {idWatching && <IdCardWatchHint onEnd={() => setIdWatching(false)} />}
          {/* 两颗按钮一左一右：右边那颗是正路（先刷到卡再出号）。左边「无卡制单」只在
              **本站强制绑卡、而此刻手上没有卡**时才摆出来——读卡器坏了、卡池见底这类现场救急，
              不该逼着站长先去改全站参数（06 §4.0）。卡已经就位、或本站压根不强制绑卡时它没有
              意义（主按钮这条路本身就出得了无卡单），一律不摆，不给磅员日常多一颗按钮 */}
          <div className="flex items-center gap-1.5">
            {requireCard && !cardNo && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => submit({ allowNoCard: true })}
                disabled={!!blocked || create.isPending}
                className="h-7 shrink-0 text-xs"
                title="读卡器读不出卡时的退路：先出号，卡事后在详情里补绑"
              >
                无卡制单
              </Button>
            )}
            <Button size="sm" onClick={() => submit()} disabled={!!blocked || create.isPending} className="h-7 min-w-0 flex-1 text-xs">
              取卡并制单（F7）
            </Button>
          </div>
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
          // 强制绑卡的站点：卡一就位就把这单制掉，省一次点击（弹窗文案就是这么说的）。
          // 品种还没选就退回主按钮那条路——由它先把缺的品种说出来，别在这儿闷着不响
          if (requireCard && draft.party) {
            const varietyId = varietyIdRef.current;
            if (varietyId == null) needVariety();
            else create.mutate({ card: sn, party: draft.party, varietyId });
          }
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
  error: "保存失败",
};

/**
 * 档案联系电话的就地展示 + 维护。制单前的草稿态与制单后的摘要态共用这一只。
 *
 * 为什么单独占一行：电话原本挂在住址后面那段灰字里，与住址同字号同灰度、没标签也没点击
 * 区，磅员在强光下认不出那是电话号码；而它正下方唯一带标签、能敲字的格子叫「车牌号」。
 * 手机号被填进车牌框是界面引导出来的，不是操作失误。
 *
 * 为什么是显式「保存」而不是像车牌那样 700ms 防抖自动落库：`uk_party_phone` 在，防抖会把
 * `138` 这种半截号码也发出去，撞号的红条在输入中途炸出来，磅员不知道是哪一位惹的祸。车牌
 * 与备注能防抖，是因为那两列压根没有唯一约束。
 *
 * 改的是**共享档案**、不是本单：所以成功后既要把档案列表与详情作废（否则档案页还留着旧的），
 * 也要把新号回填给调用方——草稿态那一屏拿的是 `draft.party` 这份快照，不回填就会显示一个
 * 已经过期的号码。
 *
 * 输入态由本组件持有、不挂在 `party` 上：档案列表每次刷新都会传下一个新对象，输入框受控于
 * 它就会把正在打的半截号码连同光标位置一起冲掉（与 `OrderMetaEditor` 同一个理由）。
 *
 * 为什么不折叠：这一格出现的时机就是"磅员正要填它"——读卡带出空号后还要多点一次才能敲字，
 * 那一次点击每一户都要付一遍。号码有没有登记由框里有没有字说明，不必拿一行灰字先报一次状态。
 */
function PartyPhoneField({
  party,
  editable,
  onSaved,
}: {
  party: Party;
  editable: boolean;
  /** 保存后的档案行（真库回的是重读出来的那一行）。摘要态不传：它跟着 `["parties"]` 作废刷新 */
  onSaved?: (party: Party) => void;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState(party.phone);
  const [failed, setFailed] = useState(false);

  /** 与后端 `phone_key`、mock `phoneKey` 同一口径：空白与 `-` 都不算号码的一部分 */
  const norm = (s: string) => s.replace(/[\s-]/g, "").toUpperCase();
  const dirty = norm(value) !== norm(party.phone);

  const save = useMutation({
    mutationFn: () => api.setPartyPhone({ party_id: party.id, phone: value, operator_id: actorId() }),
    onSuccess: (p) => {
      setValue(p.phone);
      setFailed(false);
      onSaved?.(p);
      qc.invalidateQueries({ queryKey: ["parties"] });
      qc.invalidateQueries({ queryKey: ["party", p.id] });
      qc.invalidateQueries({ queryKey: ["audits"] });
    },
    // 真库闸门回的是人话（"该手机号已是档案「张三」的号码…"），原样送到眼前，绝不吞成固定文案
    onError: (e: Error) => {
      setFailed(true);
      toast.error(`电话没保存上：${e.message || "请重试"}`);
    },
  });

  // 无权改（非磅房工位）时退回只读文本——不摆一个点了会报错的输入框骗人
  if (!editable) {
    return (
      <p className="text-muted-foreground">
        联系电话{" "}
        <span className={cn("tnum", party.phone ? "text-foreground" : undefined)}>{party.phone || "未登记"}</span>
      </p>
    );
  }

  return (
    <div className="border-t pt-1">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-xs text-muted-foreground">联系电话</span>
        <KeypadInput
          aria-label="联系电话"
          value={value}
          onChangeValue={(v) => {
            setValue(v);
            setFailed(false);
          }}
          keys={digitKeys()}
          columns={6}
          maxLength={20}
          toggleLabel="数字"
          inputMode="tel"
          autoComplete="off"
          placeholder="选填"
          className="min-w-0 flex-1"
          inputClassName="tnum h-7 text-xs"
        />
        <Button
          type="button"
          size="sm"
          onClick={() => save.mutate()}
          disabled={save.isPending || !dirty}
          className="h-7 shrink-0 text-xs"
        >
          {save.isPending ? "保存中…" : "保存"}
        </Button>
      </div>
      <p className={cn("pt-0.5 text-[11px]", failed ? "text-warning" : "text-muted-foreground")}>
        {failed
          ? "没保存上，改完再点一次保存。"
          : "改的是这张档案，不跟着本单走；清空即不再登记。"}
      </p>
    </div>
  );
}

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
 * 磅员要的是"差多少、有没有超"，所以最近一次／均值／容差／偏差压成一行；
 * 底下再把**近 5 次明细**摊开成一行一条（日期·皮重·来源·与均值偏差）——
 * 一串数字对不上"是哪一车"，而窗口里最常问的就是"他上次也是这么轻吗"。
 * 均值与超差的判据不在这里算，单源在 `lib/tare-ref`（与档案页、捕获那一捕同一条）。
 * 更早的历史仍看农户档案页（「档案明细」）。
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
  recent: TareRefRow[];
  last01kg: number | null;
  mean01kg: number | null;
  tolerancePct: number;
  currentTare01kg: number | null;
  alert: boolean;
  partyId: number | null;
}) {
  const diff = tareDev01kg(currentTare01kg, mean01kg);
  /** 调用方已经按窗口切过，这里再切一次是幂等的——面板不该依赖调用方记得切 */
  const rows = tareRefRows(recent);
  /** 带符号偏差的写法与档案页「皮重档案」那一列逐字一致（正负号 + 绝对值，0.1kg → kg） */
  const devText = (d: number) => `${d >= 0 ? "+" : "−"}${weight(Math.abs(d), false)}`;
  return (
    <Card size="sm" className={cn("py-0 gap-0", alert && "ring-warning/60")}>
      <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center px-2.5">
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
              当前偏差 {devText(diff)}
            </span>
          )}
        </p>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无历史，首次过磅后自动累积。</p>
        ) : (
          <div className="flex flex-col gap-0.5 border-t border-border/60 pt-1">
            <p className="text-[10px] text-muted-foreground">近 {rows.length} 次明细 · 皮重 kg · 与均值偏差</p>
            <ul className="flex flex-col gap-0.5">
              {rows.map((r, i) => {
                const rowDev = tareDev01kg(r.tare_01kg, mean01kg);
                const over = tareOverTolerance(r.tare_01kg, mean01kg, tolerancePct);
                const manual = isManualWeightSource(r.source);
                return (
                  <li key={`${r.date}-${i}`} className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
                    <span className="tnum text-muted-foreground">{r.date}</span>
                    <span className="tnum ml-auto font-semibold text-foreground">{weight(r.tare_01kg, false)}</span>
                    <span className={cn("tnum min-w-[3.6em] text-right", over && "font-semibold text-warning")}>
                      {rowDev == null ? "—" : devText(rowDev)}
                    </span>
                    {over && <span className="shrink-0 text-[10px] font-medium text-warning">超容差</span>}
                    {/* 手录用文字标，不靠颜色：它是迎检必查项，也不进均值（lib/tare-ref 篇首） */}
                    {manual && (
                      <span className="shrink-0 text-[10px] font-medium text-warning" title="手录皮重不进均值">
                        {weightSourceLabel(r.source)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {partyId != null && (
          <p className="text-xs text-muted-foreground">
            更早的历史
            <QuickDetailLink type="party" id={partyId} className="ml-1 text-primary">
              档案明细
            </QuickDetailLink>
          </p>
        )}
        {alert && <p className="text-xs text-warning">捕获时只提醒不拦单，磅单留记号；历史值仅供参考，不替代实测。</p>}
      </CardContent>
    </Card>
  );
}
