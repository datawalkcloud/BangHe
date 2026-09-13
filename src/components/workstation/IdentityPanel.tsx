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
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon, CreditCardIcon, SearchIcon, UserRoundPlusIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { announce } from "@/lib/voice-prompt";
import type { GrainVariety, Party, StorageSlot, Warehouse, WeighOrder } from "@/mock/types";
import { PARTY_TYPE, ROLE, ORDER_REMARK_PRESETS } from "@/lib/constants";
import { maskIdCard, ton, validateIdCard, weight } from "@/lib/format";
import { backfillPartyPhotoFromCard } from "@/lib/party-photo";
import { useDeviceStore } from "@/store/device";
import { useSetting } from "@/hooks/useLookups";
import { actorId, useActor, useSession } from "@/store/session";
import { Choose } from "@/components/business/Choose";
import { PlateField } from "@/components/business/PlateField";
import { ReasonChips } from "@/components/business/ReasonChips";
import { CardScanDialog } from "@/components/business/CardScanDialog";
import { QuickDetailLink } from "@/components/business/quickDetail";
import { PartyPicker } from "@/components/workstation/PartyPicker";
import { CardBindDialog } from "@/components/workstation/CardBindDialog";
import { QuickPartyDialog } from "@/components/workstation/QuickPartyDialog";
import { OrderStatusBadge, ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  const reading = useDeviceStore((s) => s.reader.idcard.reading);
  const lastCard = useDeviceStore((s) => s.reader.idcard.last);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 「请放卡」监听弹窗：点读卡不再一次性点读，而是开弹窗连续寻卡（与档案页读卡建档同一套） */
  const [scanOpen, setScanOpen] = useState(false);
  /** 读卡读到的是没建过档的人：就地弹「无档案 · 快捷登记」，不把磅员赶回档案页重走一遍 */
  const [enrollOpen, setEnrollOpen] = useState(false);
  /** 「制单请放流转卡」弹窗：点「取号并制单」时卡还没就位就弹它（06 §4.0） */
  const [bindOpen, setBindOpen] = useState(false);
  /** 这次制单要绑的卡（刷到才非空）。绑卡与取号同一次事务，所以它只在号取成之前存在 */
  const [cardNo, setCardNo] = useState<string | null>(presetCardNo);
  // 卡已经贴在感应区上、由刷卡推进带进来：本框挂载即就位（换卡/失败清空后不回弹，见 create.onError）
  useEffect(() => {
    if (presetCardNo) setCardNo(presetCardNo);
  }, [presetCardNo]);
  /** 去向默认折起来：多数站点制单时不登记仓房/货位，不该占住磅员的主视线 */
  const [destOpen, setDestOpen] = useState(false);
  const qc = useQueryClient();

  // 本站制单是否必须先刷一张流转卡。库里没这个键时按"强制"走，与 create_order 的默认值同一口径
  const flowOn = (useSetting("card_flow_mode").raw ?? "auto") !== "off";
  const requireCard = flowOn && useSetting("card_required_on_create").raw !== "false";

  // 读卡结果回填：命中档案就带出姓名/证号/默认车牌，未命中就地开快捷登记框
  useEffect(() => {
    if (!lastCard) return;
    // 一律以证号为准：party_id 只是真机回查档案的附带结果，演示卡那个是 mock 序号，
    // 拿到真库档案里按 id 兜底会命中另一个无关的人
    const hit =
      parties.find((x) => x.id_card_no.trim().toUpperCase() === lastCard.id_card_no) ??
      (lastCard.real ? parties.find((x) => x.id === lastCard.party_id) : undefined);
    if (!hit) {
      // 只报一条 toast 等于把人赶回档案页：农户还站在读卡器前，姓名/证号/住址其实已经读到了。
      // 弹窗里补个电话就能建档，建好直接选为本单售粮人（02 §F1.1「无档案时不出现两次以上的手工输入」）
      setEnrollOpen(true);
      announce("没有这个人的档案，请补个电话先建个档");
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
    onDraft({ party: hit, vehicleNo: draft.vehicleNo || hit.default_vehicle_no || "" });
    toast.success(`读卡命中档案：${hit.name}`);
    announce("读卡成功");
    // 该带出的已经带出、该报的已经报完，这里才去补照片：档案还没有人像就把证件里这张写进去
    // （只补缺，已有照片不动）。异步 fire-and-forget——补得上补不上都不该拦住磅员取号（02 §F3.1）。
    void backfillPartyPhotoFromCard(lastCard, hit, qc);
    // 这一刷到此为止。`last` 是跨页面共享的缓存，不清的话下次进工作台挂载会把旧卡当新读卡，
    // 凭空替本单选中上一个人。没建过档的那条分支不能清——快捷登记弹窗还要拿它预填。
    useDeviceStore.getState().reader.idcard.clear();
    // draft.vehicleNo 不入依赖，否则每次输入都会重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCard]);

  const create = useMutation({
    // 卡号走 mutation 变量：刷卡弹窗的回调里 setCardNo 还没生效，闭包会拿到上一张
    mutationFn: (card: string | null) =>
      api.createOrder({
        party_id: draft.party!.id,
        variety_id: draft.varietyId!,
        vehicle_no: draft.vehicleNo.trim() || null,
        warehouse_id: draft.warehouseId,
        slot_id: draft.slotId,
        remark: draft.remark.trim() || null,
        card_no: card,
        registered_by: actorId(),
        weight_source: "scale",
      }),
    onSuccess: (o) => {
      toast.success(o.card_no ? `已取号 ${o.order_no} · 已绑卡 ${o.card_no}` : `已取号 ${o.order_no}`);
      announce("制单成功，请开车上磅");
      setCardNo(null);
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["open-orders"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["cards"] });
      onCreated(o.order_no);
    },
    // 真库闸门回的是人话（"该售粮人档案不存在或已删除，请先建档"），要原样送到磅员眼前
    onError: (e: Error) => {
      setCardNo(null); // 被服务端拦下的卡不许原地重试，重新刷一张（并发下它可能刚被别人发走）
      toast.error(`取号失败：${e.message || "请检查档案与品种是否齐全"}`);
      // 服务端原因带条款，念出来没人听得懂；只念"没取到号"+ 卡要重新刷这一条现场动作
      announce("这张单没能取到号，卡要重新刷一张");
    },
  });

  const blocked = !can("order.create")
    ? `当前岗位「${actor ? ROLE[actor.role] : "—"}」无权制单，需磅员、登记员或站长`
    : !draft.party
      ? "尚未确定售粮人（读卡、搜档案或手工登记三选一）"
      : !draft.varietyId
        ? "请选择收购品种"
        : draft.party && !validateIdCard(draft.party.id_card_no)
          ? "该档案身份证号校验位不通过，请到农户档案更正"
          : null;

  /** 「取号并制单」：本站要求绑卡而卡还没就位时先弹刷卡框，读到可用的卡由弹窗直接落这一单（06 §4.0） */
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
    create.mutate(cardNo);
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
              品种 <span className="text-foreground">{order.variety_name}</span>
              {order.grade ? <span className="text-foreground">{order.grade}</span> : null}
            </p>
            <p className="text-muted-foreground">
              车牌 <span className="tnum text-foreground">{order.vehicle_no ?? "—"}</span> · 去向{" "}
              <span className={orderDestination ? "text-foreground" : "text-muted-foreground"}>
                {orderDestination || "未登记"}
              </span>
            </p>
            <p className="text-muted-foreground">
              制单 <span className="tnum text-foreground">{order.registered_at.slice(5, 16).replace("T", " ")}</span>
            </p>
          </div>
          {order.remark && <p className="border-t pt-1 text-xs text-muted-foreground">备注：{order.remark}</p>}
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
            <p className="text-xs text-muted-foreground">尚未确定售粮人（支持读卡或搜档案）</p>
          )}
        </div>

        <div className="grid gap-1">
          <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            收购品种
            <Choose
              aria-label="收购品种"
              id="ws-variety"
              value={String(draft.varietyId ?? "")}
              onChange={(v) => onDraft({ varietyId: v ? Number(v) : null })}
              options={[
                { value: "", label: "请选择…" },
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
                      onChange={(v) => onDraft({ warehouseId: v ? Number(v) : null, slotId: null })}
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
            <Textarea
              rows={1}
              aria-label="备注"
              value={draft.remark}
              onChange={(e) => onDraft({ remark: e.target.value })}
              placeholder="点一条常用的，或自己写…"
              className="min-h-[28px] py-0.5 text-xs"
            />
            <ReasonChips aria-label="常用备注" presets={ORDER_REMARK_PRESETS} value={draft.remark} onChange={(v) => onDraft({ remark: v })} />
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

      {/* 制单绑卡（06 §4.0）：读到一张在册、空闲、没挂着未完成单的卡才算就位，随即取号写单 */}
      <CardBindDialog
        open={bindOpen}
        onOpenChange={setBindOpen}
        required={requireCard}
        onPicked={(sn) => {
          setBindOpen(false);
          setCardNo(sn);
          // 强制绑卡的站点：卡一就位就把这单制掉，省一次点击（弹窗文案就是这么说的）
          if (requireCard) create.mutate(sn);
        }}
        onSkip={() => {
          setBindOpen(false);
          submit(); // 走同一条校验：选填入口可能在售粮人还没选定时就开着
        }}
      />

      {/* 读到没建过档的证号：就地快捷登记，建好直接选为本单售粮人（02 §F1.1）。
          关框即清掉这张卡：不清的话下次点「制单」会拿这张旧卡再弹一遍，等于替上一个人建档 */}
      <QuickPartyDialog
        open={enrollOpen}
        onOpenChange={(v) => {
          setEnrollOpen(v);
          if (!v) useDeviceStore.getState().reader.idcard.clear();
        }}
        card={lastCard}
        parties={parties}
        onEnrolled={(p) => onDraft({ party: p, vehicleNo: draft.vehicleNo || p.default_vehicle_no || "" })}
        onSearchParty={() => setPickerOpen(true)}
      />
    </Card>
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
  paid: "货款已付清。",
  archived: "已归档，只读。",
  voided: "本单已作废，仅作留痕。",
  reversed: "本单已被红冲，请查红冲单。",
  rejected: "拒收退粮，不产生货款。",
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
