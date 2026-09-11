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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CreditCardIcon, SearchIcon, UserRoundPlusIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { GrainVariety, Party, StorageSlot, Warehouse, WeighOrder } from "@/mock/types";
import { PARTY_TYPE, ROLE } from "@/lib/constants";
import { maskIdCard, ton, validateIdCard, weight } from "@/lib/format";
import { useDeviceStore } from "@/store/device";
import { useSession } from "@/store/session";
import { Choose } from "@/components/business/Choose";
import { PartyPicker } from "@/components/workstation/PartyPicker";
import { OrderStatusBadge, ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  const operator = useSession((s) => s.operator);
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
        registered_by: operator!.id,
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
    onError: () => toast.error("取号失败，请检查档案与品种是否齐全"),
  });

  const blocked = !operator
    ? "请先在左下角选择当前操作员"
    : !can("order.create")
      ? `当前岗位「${operator ? ROLE[operator.role] : "未选择"}」无权制单，需磅员、登记员或站长`
      : !draft.party
        ? "尚未确定售粮人（读卡、搜档案或手工登记三选一）"
        : !draft.varietyId
          ? "请选择收购品种"
          : draft.party && !validateIdCard(draft.party.id_card_no)
            ? "该档案身份证号校验位不通过，请到农户档案更正"
            : null;

  const slotPool = slots.filter((s) => draft.warehouseId == null || s.warehouse_id === draft.warehouseId);

  if (order) {
    return (
      <Card size="sm">
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 text-sm">
            ① 身份与制单
            <OrderStatusBadge status={order.status} />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-base font-semibold">{order.party_name}</span>
            <span className="tnum text-xs text-muted-foreground">{order.order_no}</span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-xs text-muted-foreground">证号</dt>
            <dd className="tnum">{maskIdCard(order.id_card_no)}</dd>
            <dt className="text-xs text-muted-foreground">身份</dt>
            <dd>{PARTY_TYPE[order.party_type]}</dd>
            <dt className="text-xs text-muted-foreground">品种</dt>
            <dd>
              {order.variety_name}
              {order.grade ? <span className="ml-1 text-xs text-muted-foreground">{order.grade}</span> : null}
            </dd>
            <dt className="text-xs text-muted-foreground">车牌</dt>
            <dd className="tnum">{order.vehicle_no ?? "—"}</dd>
            <dt className="text-xs text-muted-foreground">去向</dt>
            <dd>
              {order.warehouse_name ?? "—"}
              {order.slot_label ? ` / ${order.slot_label}` : ""}
            </dd>
            <dt className="text-xs text-muted-foreground">制单</dt>
            <dd className="text-xs text-muted-foreground">
              {order.registered_at.slice(0, 16).replace("T", " ")}
            </dd>
          </dl>
          {order.remark && <p className="border-t pt-2 text-xs text-muted-foreground">备注：{order.remark}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={onNewOrder} disabled={!can("order.create")}>
              <UserRoundPlusIcon />
              新建下一单（F7）
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
              <CreditCardIcon />
              读卡换人（F8）
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{ORDER_HINT[order.status]}</p>
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
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle className="text-sm">① 身份与制单</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void read()} disabled={reading || !can("order.create")}>
            <CreditCardIcon />
            {reading ? "读卡中…" : "读卡（F8）"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
            <SearchIcon />
            搜档案
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {mockOff ? "读卡器已断开（Mock 关闭），请改用搜档案手工确定售粮人。" : "读卡后自动带出姓名、证号与默认车牌，焦点跳到品种。"}
        </p>

        <div className="border bg-muted/30 p-2">
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
            <p className="text-xs text-muted-foreground">尚未确定售粮人</p>
          )}
        </div>

        <div className="grid gap-2">
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            收购品种
            <Choose
              aria-label="收购品种"
              id="ws-variety"
              value={String(draft.varietyId ?? "")}
              onChange={(v) => onDraft({ varietyId: v ? Number(v) : null })}
              options={[
                { value: "", label: "请选择…" },
                ...varieties.map((v) => ({ value: String(v.id), label: v.name })),
              ]}
            />
          </Label>
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            车牌号
            <Input
              value={draft.vehicleNo}
              onChange={(e) => onDraft({ vehicleNo: e.target.value.toUpperCase() })}
              placeholder="如 豫A12345，农用车可留空"
              className="h-8"
            />
          </Label>
          <div className="grid grid-cols-2 gap-2">
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              入库仓房
              <Choose
                aria-label="仓房"
                value={String(draft.warehouseId ?? "")}
                onChange={(v) => onDraft({ warehouseId: v ? Number(v) : null, slotId: null })}
                options={[
                  { value: "", label: "未定" },
                  ...warehouses.map((w) => ({ value: String(w.id), label: w.name })),
                ]}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
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
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            备注
            <Textarea
              rows={2}
              value={draft.remark}
              onChange={(e) => onDraft({ remark: e.target.value })}
              placeholder="如：带皮带、卸货慢、需复检"
              className="min-h-0 text-sm"
            />
          </Label>
        </div>

        <div className="flex flex-col gap-1.5 border-t pt-2">
          <Button size="sm" onClick={() => create.mutate()} disabled={!!blocked || create.isPending}>
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
 * ② 历史皮重。
 *
 * 只做"显示 + 偏差警示"，绝不拿历史值去替代实测皮重（03 §4.2）；
 * 偏差超容差时整块转警示态，真正的授权拦截发生在称重捕获那一步。
 */
export function TarePanel({
  recent,
  last01kg,
  mean01kg,
  tolerancePct,
  currentTare01kg,
  alert,
}: {
  recent: { date: string; tare_01kg: number; source: string }[];
  last01kg: number | null;
  mean01kg: number | null;
  tolerancePct: number;
  currentTare01kg: number | null;
  alert: boolean;
}) {
  const diff = currentTare01kg != null && mean01kg != null ? currentTare01kg - mean01kg : null;
  return (
    <Card size="sm" className={cn(alert && "ring-warning/60")}>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          ② 历史皮重
          {alert ? <ToneBadge tone="warning">偏差超容差</ToneBadge> : <ToneBadge tone="neutral">参考值</ToneBadge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">最近一次</span>
          <span className="tnum text-lg font-semibold">{weight(last01kg)}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">近 5 次均值</span>
          <span className="tnum text-lg">{mean01kg == null ? "—" : `${weight(mean01kg, false)}（${ton(mean01kg)}）`}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          容差 ±{tolerancePct}%{diff != null ? ` · 当前偏差 ${diff > 0 ? "+" : ""}${weight(diff, false)}` : ""}
        </p>
        {recent.length > 0 ? (
          <ul className="flex flex-col gap-0.5 border-t pt-1.5">
            {recent.map((r, i) => (
              <li key={i} className="flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">{r.date}</span>
                <span className={cn("tnum", r.source === "manual" && "text-warning")}>
                  {weight(r.tare_01kg)}
                  {r.source === "manual" && "（手录）"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="border-t pt-1.5 text-xs text-muted-foreground">暂无历史，首次过磅后自动累积。</p>
        )}
      </CardContent>
    </Card>
  );
}
