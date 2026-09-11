/**
 * ① 身份与制单 + ② 历史皮重（05 §4 左栏）。
 *
 * 制单前是一段"草稿态"（还没号），制单后同一栏退化为只读摘要 + 新建下一单，
 * 这样磅员的目光始终落在同一块位置，不必在两屏之间来回找。
 *
 * 读卡是可选路径：阅读器离线（mockOff）时必须能搜档案或手工输入，
 * 这是 05 §10-1「无外设也要能完成闭环」的硬要求。
 */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CreditCardIcon, SearchIcon, UserRoundPlusIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { GrainVariety, Party, StorageSlot, Warehouse, WeighOrder } from "@/mock/types";
import { PARTY_TYPE, ROLE } from "@/lib/constants";
import { maskIdCard, ton, validateIdCard, weight } from "@/lib/format";
import { useDeviceStore } from "@/store/device";
import { actorId, useActor, useSession } from "@/store/session";
import { Choose } from "@/components/business/Choose";
import { QuickDetailLink } from "@/components/business/QuickDetailSheet";
import { PartyPicker } from "@/components/workstation/PartyPicker";
import { OrderStatusBadge, ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  onCreated: (orderNo: string) => void;
  onNewOrder: () => void;
}) {
  const actor = useActor();
  const can = useSession((s) => s.can);
  const mockOff = useDeviceStore((s) => s.mockOff);
  const reading = useDeviceStore((s) => s.idcard.reading);
  const cardError = useDeviceStore((s) => s.idcard.error);
  const read = useDeviceStore((s) => s.idcard.read);
  const lastCard = useDeviceStore((s) => s.idcard.last);
  const [pickerOpen, setPickerOpen] = useState(false);
  const qc = useQueryClient();

  // 读卡结果回填：命中档案就带出姓名/证号/默认车牌，未命中提示去建档
  useEffect(() => {
    if (!lastCard) return;
    const p = parties.find((x) => x.id === lastCard.party_id);
    if (p) {
      onDraft({ party: p, vehicleNo: draft.vehicleNo || p.default_vehicle_no || "" });
      toast.success(`读卡命中档案：${p.name}`);
    } else {
      toast.warning(`读到证号 ${maskIdCard(lastCard.id_card_no)}，但系统内没有对应档案，请先建档`);
    }
    // draft.vehicleNo 不入依赖，否则每次输入都会重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCard]);

  useEffect(() => {
    if (cardError) toast.error(cardError);
  }, [cardError]);

  const create = useMutation({
    mutationFn: () =>
      api.createOrder({
        party_id: draft.party!.id,
        variety_id: draft.varietyId!,
        vehicle_no: draft.vehicleNo.trim() || null,
        warehouse_id: draft.warehouseId,
        slot_id: draft.slotId,
        remark: draft.remark.trim() || null,
        registered_by: actorId(),
        // 外设关掉后只能手录，来源标记必须诚实（05 §6.1）
        weight_source: mockOff ? "manual" : "scale",
      }),
    onSuccess: (o) => {
      toast.success(`已取号 ${o.order_no}`);
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["open-orders"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      onCreated(o.order_no);
    },
    // 真库闸门回的是人话（"该售粮人档案不存在或已删除，请先建档"），要原样送到磅员眼前
    onError: (e: Error) => toast.error(`取号失败：${e.message || "请检查档案与品种是否齐全"}`),
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

  /** 停用只挡住新单：制单下拉一律排除 is_active = 0 的档案，历史磅单上仍按当时快照显示 */
  const activeVarieties = varieties.filter((v) => v.is_active !== 0);
  const activeWarehouses = warehouses.filter((w) => w.is_active !== 0);
  const activeSlots = slots.filter((s) => s.is_active !== 0);
  const slotPool = activeSlots.filter((s) => draft.warehouseId == null || s.warehouse_id === draft.warehouseId);

  if (order) {
    return (
      <Card size="sm" className="py-0 gap-0">
        <CardHeader className="border-b py-1 px-2.5">
          <CardTitle className="flex items-center gap-2 text-xs font-semibold">
            ① 身份与制单
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
              <span className="text-foreground">
                {order.warehouse_name ?? "—"}
                {order.slot_label ? ` / ${order.slot_label}` : ""}
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
      <CardHeader className="border-b py-1 px-2.5">
        <CardTitle className="text-xs font-semibold">① 身份与制单</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 p-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" onClick={() => void read()} disabled={reading || !can("order.create")} className="h-7 text-xs">
            <CreditCardIcon />
            {reading ? "读卡中…" : "读卡（F8）"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)} className="h-7 text-xs">
            <SearchIcon />
            搜档案
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
          <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            车牌号
            <Input
              value={draft.vehicleNo}
              onChange={(e) => onDraft({ vehicleNo: e.target.value.toUpperCase() })}
              placeholder="如 豫A12345，农用车可留空"
              className="h-7 text-xs"
            />
          </Label>
          <div className="grid grid-cols-2 gap-1.5">
            <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              入库仓房
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
          <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            备注
            <Textarea
              rows={1}
              value={draft.remark}
              onChange={(e) => onDraft({ remark: e.target.value })}
              placeholder="如：带皮带、需复检"
              className="min-h-[28px] py-0.5 text-xs"
            />
          </Label>
        </div>

        <div className="flex flex-col gap-1 border-t pt-1">
          <Button size="sm" onClick={() => create.mutate()} disabled={!!blocked || create.isPending} className="h-7 text-xs">
            取号并制单（F7）
          </Button>
          {blocked && <p className="text-xs text-warning">{blocked}</p>}
        </div>
      </CardContent>

      <PartyPicker open={pickerOpen} onOpenChange={setPickerOpen} onPick={(p) => onDraft({ party: p, vehicleNo: p.default_vehicle_no ?? draft.vehicleNo })} />
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
 * 偏差超容差时整块转警示态，真正的授权拦截发生在称重捕获那一步。
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
      <CardHeader className="grid-cols-[1fr_auto] items-center border-b py-1 px-2.5">
        <CardTitle className="text-xs font-semibold">② 皮重参考</CardTitle>
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
        {alert && <p className="text-xs text-warning">捕获皮重时会拦下要求站长授权；历史值只作参考，不替代实测。</p>}
      </CardContent>
    </Card>
  );
}
