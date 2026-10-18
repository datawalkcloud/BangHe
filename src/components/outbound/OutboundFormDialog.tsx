/**
 * 出库单表单（02 §M11 F11.1、05 §4）。新建与改草稿共用一张表单。
 *
 * 三条界面纪律跟着收购侧的老规矩走：
 *  1. **校验以后端为准**：这里只做「一眼能看出没填」的即时提示，真正拦下请求的是
 *     `outbound.rs::validate_save` 的中文短句，`onError` 原样透传（面板一律显示服务端原因，
 *     不自己编一句"保存失败"——现场要知道到底哪儿不对）。
 *  2. **超库存不在这里拦**：表单顶上一行账面结存只是给值仓看的参考数，
 *     不够也允许提交（完成出库时服务端记一句 `stock_warning`，绝不挡车）。
 *  3. 登记出库选中后单价格子直接禁用并清空——填了也会被后端拒绝，
 *     与其让人填完再被打回，不如那格子就不给填。
 *  4. **上过磅的单，净重那一格换成只读展示**（0029）：这一格从此有了第二个写入口
 *     （捕获路径按 毛 − 皮 算），两边都能写就是两份真相。提交时照原值回传，
 *     改不了也就盖不掉；后端 `outbound.rs::save` 那句拒绝是同一件事的硬的那一道。
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { amountFen } from "@/lib/calc";
import { GRADES, OUTBOUND_KIND, type OutboundKind } from "@/lib/constants";
import { fromKg, fromYuanPerKg, money, toYuanPerKg, ton, todayISO, weight } from "@/lib/format";
import { useSlots, useVarieties, useWarehouses } from "@/hooks/useLookups";
import { actorId } from "@/store/session";
import { Choose } from "@/components/business/Choose";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OutboundOrder } from "@/mock/types";

/** 表单态一律用「人看的单位」（kg / 元每公斤），提交时才换算成定点整数，避免两处 ÷1000 各算各的 */
type Draft = {
  kind: OutboundKind;
  business_date: string;
  party_id: string;
  counterparty_label: string;
  variety_id: string;
  grade: string;
  warehouse_id: string;
  slot_id: string;
  vehicle_no: string;
  net_kg: string;
  price_yuan_kg: string;
  remark: string;
};

const EMPTY: Draft = {
  kind: "sale",
  business_date: todayISO(),
  party_id: "",
  counterparty_label: "",
  variety_id: "",
  grade: "",
  warehouse_id: "",
  slot_id: "",
  vehicle_no: "",
  net_kg: "",
  price_yuan_kg: "",
  remark: "",
};

function draftOf(o: OutboundOrder | null): Draft {
  if (!o) return { ...EMPTY, business_date: todayISO() };
  return {
    kind: o.kind,
    business_date: o.business_date,
    party_id: o.party_id == null ? "" : String(o.party_id),
    counterparty_label: o.counterparty_label ?? "",
    variety_id: o.variety_id == null ? "" : String(o.variety_id),
    grade: o.grade ?? "",
    warehouse_id: String(o.warehouse_id),
    slot_id: o.slot_id == null ? "" : String(o.slot_id),
    vehicle_no: o.vehicle_no ?? "",
    net_kg: o.net_weight_01kg == null ? "" : String(o.net_weight_01kg / 10),
    price_yuan_kg: o.price_fen_per_ton == null ? "" : String(toYuanPerKg(o.price_fen_per_ton)),
    remark: o.remark ?? "",
  };
}

export function OutboundFormDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** null＝新建 */
  editing: OutboundOrder | null;
}) {
  const qc = useQueryClient();
  const { data: varieties = [] } = useVarieties();
  const { data: warehouses = [] } = useWarehouses();
  const { data: slots = [] } = useSlots();
  const activeWh = useMemo(() => warehouses.filter((w) => w.is_active === 1), [warehouses]);
  /**
   * 领出方候选：不限类型，第二参数一律不传。
   * 别写 `listParties("", "all")`——"all" 是界面筛选项的兜底值，真库侧 `list_parties`
   * 会拿它去比对 `party_type`，库里没有叫 all 的类型，查出来就是一张空表（建档页
   * `PartiesPage` 传的是 undefined，正是这个原因）。
   */
  const partiesQ = useQuery({ queryKey: ["parties", "outbound"], queryFn: () => api.listParties("") });
  const parties = useMemo(() => (partiesQ.data ?? []).filter((p) => p.status === "active"), [partiesQ.data]);

  const [d, setD] = useState<Draft>(EMPTY);
  const patch = (p: Partial<Draft>) => setD((v) => ({ ...v, ...p }));
  // 每次打开都按当前编辑对象重置：改单和新建复用同一份表单，留着上一次的残值是串单的头号来源
  useEffect(() => {
    if (open) setD(draftOf(editing));
  }, [open, editing]);

  const isSale = d.kind === "sale";
  const whId = Number(d.warehouse_id) || null;
  const varId = Number(d.variety_id) || null;
  const net01 = d.net_kg.trim() === "" ? null : Math.round(fromKg(d.net_kg));
  const priceFen = d.price_yuan_kg.trim() === "" ? null : Math.round(fromYuanPerKg(d.price_yuan_kg));
  const goods = isSale && net01 != null && priceFen != null ? amountFen(net01, priceFen) : null;

  /**
   * 本单是否已过地磅（0029）。判据是**毛/皮任一非空**，不是 `weight_source === 'scale'`：
   * 手录那一捕也会留下毛/皮（来源标 manual），那时候这一格同样不该再让人手改——
   * 轨迹里已经有一行秤/人的读数了对着它，手改就等于凭空多出第三份数字。
   */
  const weighed = editing?.gross_weight_01kg != null || editing?.tare_weight_01kg != null;
  const scaleGross = editing?.gross_weight_01kg == null ? "—" : weight(editing.gross_weight_01kg);
  const scaleTare = editing?.tare_weight_01kg == null ? "—" : weight(editing.tare_weight_01kg);

  /** 参考数：该仓房该品种的账面结存。查不到就整行不显示，不拿 0 唬人。 */
  const balanceQ = useQuery({
    queryKey: ["stock-balance"],
    queryFn: () => api.stockBalance(),
    enabled: open && whId != null && varId != null,
  });
  const cell = useMemo(() => {
    if (whId == null || varId == null) return null;
    const rows = balanceQ.data ?? [];
    return rows.find((b) => b.warehouse_id === whId && b.variety_id === varId) ?? null;
  }, [balanceQ.data, whId, varId]);

  const save = useMutation({
    mutationFn: () =>
      api.saveOutbound({
        order_no: editing?.order_no ?? null,
        kind: d.kind,
        business_date: d.business_date,
        party_id: isSale ? Number(d.party_id) : d.party_id ? Number(d.party_id) : null,
        counterparty_label: d.counterparty_label.trim() || null,
        variety_id: varId,
        grade: d.grade || null,
        warehouse_id: Number(d.warehouse_id),
        slot_id: d.slot_id ? Number(d.slot_id) : null,
        vehicle_no: d.vehicle_no.trim() || null,
        net_weight_01kg: net01,
        price_fen_per_ton: isSale ? priceFen : null,
        remark: d.remark.trim() || null,
        operator_id: actorId(),
      }),
    onSuccess: (row) => {
      toast.success(`${editing ? "已修改" : "已制单"} ${row.order_no}`);
      qc.invalidateQueries({ queryKey: ["outbound"] });
      onOpenChange(false);
    },
    // 服务端原因原样透传：Rust 回的都是"登记出库不计价，单价请留空"这种人话
    onError: (e: Error) => toast.error(e.message),
  });

  const canSubmit =
    d.warehouse_id !== "" && d.variety_id !== "" && (isSale ? d.party_id !== "" : true) && !save.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `修改出库单 ${editing.order_no}` : "新建出库单"}</DialogTitle>
          <DialogDescription>
            {weighed
              ? "本单重量已过地磅，这一格改不了。"
              : "净重可先手填，也可到详情页「地磅称重」现取；只有点「完成出库」才扣库存、算货款。"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            出库性质
            <Choose
              aria-label="出库性质"
              value={d.kind}
              onChange={(v) => {
                const kind = v as OutboundKind;
                // 切到登记出库就清掉单价：留着数字只会让「完成出库」被后端打回
                patch(kind === "record" ? { kind, price_yuan_kg: "" } : { kind });
              }}
              options={(Object.keys(OUTBOUND_KIND) as OutboundKind[]).map((k) => ({
                value: k,
                label: OUTBOUND_KIND[k].label,
              }))}
            />
          </Label>
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            业务日期
            <DatePicker value={d.business_date} onChange={(v) => patch({ business_date: v })} aria-label="业务日期" />
          </Label>

          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {isSale ? "领出方（售粮人档案）" : "领出方（可只填下方文字）"}
            <Choose
              aria-label="领出方"
              value={d.party_id}
              onChange={(v) => patch({ party_id: v })}
              options={[
                {
                  value: "",
                  // 空表要说清是"还没加载"还是"真没有"，不然现场只当是卡住了
                  label: partiesQ.isPending
                    ? "档案加载中…"
                    : parties.length === 0
                      ? "暂无可用档案（先到往来单位建档）"
                      : isSale
                        ? "请选择"
                        : "不挂档案",
                },
                ...parties.map((p) => ({ value: String(p.id), label: `${p.name}（${p.party_type === "company" ? "企业" : p.party_type === "broker" ? "经纪人" : "个人"}）` })),
              ]}
            />
          </Label>
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            领用方 / 用途对象
            <Input
              value={d.counterparty_label}
              onChange={(e) => patch({ counterparty_label: e.target.value })}
              placeholder={isSale ? "可不填；销售以档案为准" : "如：饲养组、职工食堂"}
            />
          </Label>

          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            品种
            <Choose
              aria-label="品种"
              value={d.variety_id}
              onChange={(v) => patch({ variety_id: v })}
              options={[
                { value: "", label: "请选择" },
                ...varieties.filter((v) => v.is_active === 1).map((v) => ({ value: String(v.id), label: v.name })),
              ]}
            />
          </Label>
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            等级
            <Choose
              aria-label="等级"
              value={d.grade}
              onChange={(v) => patch({ grade: v })}
              options={[{ value: "", label: "未定级" }, ...GRADES.map((g) => ({ value: g, label: g }))]}
            />
          </Label>

          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            出仓仓房
            <Choose
              aria-label="出仓仓房"
              value={d.warehouse_id}
              onChange={(v) => patch({ warehouse_id: v, slot_id: "" })}
              options={[
                { value: "", label: "请选择" },
                ...activeWh.map((w) => ({ value: String(w.id), label: `${w.code} ${w.name}` })),
              ]}
            />
          </Label>
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            货位（选填）
            <Choose
              aria-label="货位"
              value={d.slot_id}
              onChange={(v) => patch({ slot_id: v })}
              disabled={whId == null}
              options={[
                { value: "", label: whId == null ? "先选仓房" : "不指定" },
                ...slots.filter((s) => s.warehouse_id === whId && s.is_active === 1).map((s) => ({ value: String(s.id), label: s.label })),
              ]}
            />
          </Label>

          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            出库净重（kg）
            {/*
              **上过磅的单这一格不给手改**（0029，与 `outbound.rs::save` 那句拒绝同一条规矩）：
              净重从此有了第二个写入口——捕获路径按 毛 − 皮 算它。两边都能写就是两份真相，
              而且秤取那份会被静默洗成手填、来源还留着"地磅"，那是迎检查出来最难看的不一致。
              这里不给输入框，只把这一单现在记着的数摊开（毛/皮/净 + 来源），并指回称重那块；
              表单提交时照原值回传，改不了也就盖不掉。
            */}
            {weighed ? (
              <div className="flex h-8 items-center justify-between gap-2 border bg-muted/30 px-2">
                <span className="tnum font-medium">{net01 == null ? "—" : weight(net01)}</span>
                <span className="tnum text-[11px] text-muted-foreground">
                  毛 {scaleGross} − 皮 {scaleTare}
                </span>
              </div>
            ) : (
              <Input
                inputMode="decimal"
                className="tnum"
                value={d.net_kg}
                onChange={(e) => patch({ net_kg: e.target.value })}
                placeholder={net01 == null ? "如 12500" : weight(net01)}
              />
            )}
            {weighed && (
              <span className="text-[11px] text-warning">
                要改重量请保存后到详情页「地磅称重」重新捕获；仪表离线可手录。
              </span>
            )}
          </Label>
          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            单价（元/公斤）
            <Input
              inputMode="decimal"
              className="tnum"
              disabled={!isSale}
              value={d.price_yuan_kg}
              onChange={(e) => patch({ price_yuan_kg: e.target.value })}
              placeholder={isSale ? "如 2.60" : "登记出库不计价"}
            />
          </Label>

          <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
            车牌（选填）
            <Input value={d.vehicle_no} onChange={(e) => patch({ vehicle_no: e.target.value })} className="tnum" placeholder="如 豫PA1234" />
          </Label>
          <div className="flex flex-col justify-end gap-1 text-xs">
            <span className="text-muted-foreground">货款试算</span>
            <span className="tnum text-base font-medium">{goods == null ? "—" : money(goods)}</span>
            <span className="text-muted-foreground">
              {cell ? (
                <>
                  账面结存 {ton(cell.balance_01kg)}
                  {cell.balance_01kg < (net01 ?? 0) ? <span className="ml-1 text-amber-600">（不够出，仍可提交）</span> : null}
                </>
              ) : (
                "选定仓房与品种后可看账面结存"
              )}
            </span>
          </div>

          <Label className="col-span-2 flex flex-col gap-1 text-xs text-muted-foreground">
            备注
            <Input value={d.remark} onChange={(e) => patch({ remark: e.target.value })} placeholder="出库依据、审批人、用途说明等" />
          </Label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            取消
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSubmit}>
            {save.isPending ? "保存中…" : editing ? "保存修改" : "制单"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

