/**
 * ⑤ 结算与打印（05 §4 右栏）。
 *
 * 这一栏是整张单的钱口子，四条规矩必须看得见：
 *  1. 单价一律人工填写或从价目表带出，偏离价目表要写改价事由（计价引擎未做，02 §F4.4）
 *  2. 扣项全部人工录入，结算重量 = 净重 − 袋重 − 扣水 − 扣杂 − 其他扣，随输入即时重算
 *  3. 任一重量缺失时「结算」禁用，且把原因写在按钮旁边，不靠 tooltip
 *  4. 应付必须并列大写金额，农户不认阿拉伯数字
 *
 * 前端算出来的数只用于即时反馈，落库以 `api.settle()` 返回为准（同一组公式）。
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PrinterIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { GrainVariety, PriceList, QcReport, WeighOrder } from "@/mock/types";
import type { PaymentMethod } from "@/lib/constants";
import { PAYMENT_METHOD, TONE_DOT } from "@/lib/constants";
import { money, price as fmtPrice, rmbUpper, ton, weight } from "@/lib/format";
import { previewSettlement } from "@/lib/calc";
import { actorId, useSession } from "@/store/session";
import { useHotkey } from "@/hooks/useHotkey";
import { Choose } from "@/components/business/Choose";
import { MoneyField, MoneyLine, PriceField, WeightField } from "@/components/business/NumField";
import { PaymentStatusBadge, ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "cn";

/** 从价目表取现行价：先按品种+等级精确命中，命不中退回同品种最近生效的一条 */
function lookupPrice(prices: PriceList[], varietyId: number, grade: string | null, date: string): PriceList | null {
  const live = prices.filter((p) => p.variety_id === varietyId && p.effective_from <= date && p.effective_to >= date);
  if (live.length === 0) return null;
  if (grade) {
    const exact = live.find((p) => p.grade === grade);
    if (exact) return exact;
  }
  return live.slice().sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0] ?? null;
}

export function SettlePanel({
  order,
  variety,
  qc,
  prices,
  allowCredit,
  onPrint,
}: {
  order: WeighOrder | null;
  variety: GrainVariety | null;
  qc: QcReport | null;
  prices: PriceList[];
  allowCredit: boolean;
  onPrint: () => void;
}) {
  const can = useSession((s) => s.can);
  const qcClient = useQueryClient();

  const [priceFenPerTon, setPrice] = useState<number | null>(null);
  const [pkg, setPkg] = useState<number>(0);
  const [moisture, setMoisture] = useState<number>(0);
  const [impurity, setImpurity] = useState<number>(0);
  const [other, setOther] = useState<number>(0);
  const [feeFen, setFeeFen] = useState<number>(0);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [payNow, setPayNow] = useState(true);
  const [signed, setSigned] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  const grade = order?.grade ?? qc?.grade ?? null;
  const listed = useMemo(
    () => (order ? lookupPrice(prices, order.variety_id, grade, order.business_date) : null),
    [prices, order, grade],
  );

  // 换单时把默认值铺好：价目表价、品种袋重、化验单扣水扣杂
  useEffect(() => {
    if (!order) return;
    const l = lookupPrice(prices, order.variety_id, order.grade ?? qc?.grade ?? null, order.business_date);
    setPrice(order.price_fen_per_ton ?? l?.price_fen_per_ton ?? null);
    setPkg(order.package_deduct_01kg ?? variety?.default_package_deduct_01kg ?? 0);
    setMoisture(order.moisture_deduct_01kg || qc?.moisture_deduct_01kg || 0);
    setImpurity(order.impurity_deduct_01kg || qc?.impurity_deduct_01kg || 0);
    setOther(order.other_deduct_01kg ?? 0);
    setFeeFen(order.deduction_fee_fen ?? 0);
    setOverrideReason(order.price_override_reason ?? "");
    setSigned(order.payment_status === "paid");
    // qc 与 prices 在同一张单的生命周期内基本同步到位，不必列依赖避免反复覆盖输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.order_no, order?.settled_at]);

  const deviates = listed != null && priceFenPerTon != null && priceFenPerTon !== listed.price_fen_per_ton;

  const preview = previewSettlement({
    net_weight_01kg: order?.net_weight_01kg ?? null,
    package_deduct_01kg: pkg,
    moisture_deduct_01kg: moisture,
    impurity_deduct_01kg: impurity,
    other_deduct_01kg: other,
    price_fen_per_ton: priceFenPerTon,
    deduction_fee_fen: feeFen,
  });

  const settled = order?.settlement_weight_01kg != null && order.price_fen_per_ton != null;

  const settle = useMutation({
    mutationFn: () =>
      api.settle({
        order_no: order!.order_no,
        price_fen_per_ton: priceFenPerTon!,
        package_deduct_01kg: pkg,
        moisture_deduct_01kg: moisture,
        impurity_deduct_01kg: impurity,
        other_deduct_01kg: other,
        deduction_fee_fen: feeFen,
        pay_now: payNow,
        payment_method: method,
        settler_id: actorId(),
        price_list_id: !deviates && listed ? listed.id : null,
        price_override_reason: deviates ? overrideReason.trim() : null,
        party_signed: signed,
      }),
    onSuccess: (r) => {
      if (!r) {
        toast.error("结算失败：净重缺失或扣重后重量不大于 0");
        return;
      }
      toast.success(`已结算 ${r.order.order_no}，应付 ${money(r.settlement.payable_fen)}`);
      qcClient.invalidateQueries({ queryKey: ["order", r.order.order_no] });
      qcClient.invalidateQueries({ queryKey: ["orders"] });
      qcClient.invalidateQueries({ queryKey: ["open-orders"] });
      qcClient.invalidateQueries({ queryKey: ["settlements"] });
      qcClient.invalidateQueries({ queryKey: ["dashboard"] });
      onPrint();
    },
    onError: () => toast.error("结算失败，请重试；已录入内容不会丢"),
  });

  const blocked = !order
    ? "尚未制单"
    : !can("settle.create")
      ? "当前岗位无权结算，需出纳或站长"
      : preview.blocked
        ? preview.blocked
        : priceFenPerTon == null
          ? "请填写单价，或按 F6 从价目表带出"
          : deviates && overrideReason.trim().length < 4
            ? "偏离价目表，必须填写改价事由"
            : payNow
              ? null
              : !allowCredit
                ? "站点参数已关闭「允许挂账」，只能当场付清"
                : null;

  function pickFromList() {
    if (!listed) {
      toast.error("该品种该等级当前没有生效价，请到「收购价目表」维护");
      return;
    }
    setPrice(listed.price_fen_per_ton);
    toast.success(`已带出 ${listed.grade} ${money(listed.price_fen_per_ton)}/吨（生效至 ${listed.effective_to}）`);
  }

  useHotkey("f6", pickFromList, { enabled: !!order && !settled });
  useHotkey("f10", () => {
    if (settled) onPrint();
    else if (!blocked) settle.mutate();
    else toast.error(blocked);
  });

  const photos = order?.photos ?? [];

  return (
    <Card size="sm" className="min-w-0">
      <CardHeader className="flex-row items-center justify-between border-b">
        <CardTitle className="text-sm">⑤ 结算与打印</CardTitle>
        {settled ? (
          <ToneBadge tone="success">已结算</ToneBadge>
        ) : (
          <span className="text-xs text-muted-foreground">未结算，以下为重算预览</span>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <PriceField
            label="单价"
            valueFenPerTon={priceFenPerTon}
            onChange={setPrice}
            disabled={settled}
            hint={deviates ? "已偏离价目表现行价" : undefined}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {listed ? `价目表：${listed.grade} · ${money(listed.price_fen_per_ton)}/吨 · 至 ${listed.effective_to}` : "价目表无现行价"}
            </span>
            <Button size="xs" variant="outline" onClick={pickFromList} disabled={settled || !listed}>
              从价目带出（F6）
            </Button>
          </div>
          {deviates && (
            <Label className="flex flex-col gap-1 text-xs text-warning">
              改价事由（迎检必查）
              <Input
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="如：水分超基准 1.2%，议价下调 40 元/吨"
                className="h-8 border-warning/50 text-sm"
                disabled={settled}
              />
            </Label>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 border-y py-2.5">
          <WeightField label="袋重" value01kg={pkg || null} onChange={(v) => setPkg(v ?? 0)} disabled={settled} hint="含包装、绳网" />
          <WeightField label="扣水" value01kg={moisture || null} onChange={(v) => setMoisture(v ?? 0)} disabled={settled} hint="化验员给定" />
          <WeightField label="扣杂" value01kg={impurity || null} onChange={(v) => setImpurity(v ?? 0)} disabled={settled} />
          <WeightField label="其他扣" value01kg={other || null} onChange={(v) => setOther(v ?? 0)} disabled={settled} hint="如损耗、代扣" />
          <div className="col-span-2">
            <MoneyField label="费用扣款" valueFen={feeFen} onChange={setFeeFen} disabled={settled} hint="卸车费、袋钱等，非重量扣" />
          </div>
        </div>

        <div className="flex flex-col gap-1 bg-muted/25 p-2">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-muted-foreground">扣重合计</span>
            <span className="tnum text-sm">{weight(settled ? order!.deduct_total_01kg : preview.deductTotal01kg)}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold">结算重量</span>
            <span className="tnum text-xl font-bold">
              {weight(settled ? order!.settlement_weight_01kg : preview.settlementWeight01kg)}
            </span>
          </div>
          <span className="tnum text-right text-xs text-muted-foreground">
            {ton(settled ? order!.settlement_weight_01kg : preview.settlementWeight01kg)}
          </span>
          <MoneyLine
            label="货款"
            valueFen={settled ? order!.goods_amount_fen : preview.goodsAmountFen}
            hint={fmtPrice(settled ? order!.price_fen_per_ton : priceFenPerTon).perJin}
          />
          <MoneyLine label="扣款" valueFen={settled ? order!.deduction_fee_fen : feeFen} />
          <MoneyLine
            label="应付"
            emphasis
            valueFen={settled ? order!.payable_amount_fen : preview.payableAmountFen}
            hint={rmbUpper(settled ? order!.payable_amount_fen : preview.payableAmountFen)}
          />
        </div>

        {!settled && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 items-end gap-2">
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                支付方式
                <Choose
                  aria-label="支付方式"
                  value={method}
                  onChange={(v) => setMethod(v)}
                  disabled={payNow === false}
                  options={(Object.keys(PAYMENT_METHOD) as PaymentMethod[])
                    .filter((k) => k !== "credit_writeoff")
                    .map((k) => ({ value: k, label: PAYMENT_METHOD[k] }))}
                />
              </Label>
              <div className="flex flex-col gap-1.5 pb-0.5">
                <Label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={payNow} onCheckedChange={(v) => setPayNow(v === true)} disabled={!allowCredit} />
                  当场已付
                </Label>
                <Label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={signed} onCheckedChange={(v) => setSigned(v === true)} />
                  售粮人已签字（纸质拍照）
                </Label>
              </div>
            </div>
            {!payNow && !allowCredit && <p className="text-xs text-warning">站点参数已关闭挂账，本单必须当场付清。</p>}
            {payNow && !can("pay.record") && (
              <p className="text-xs text-warning">当场付款需要出纳或站长岗位登记，当前操作员只能挂账。</p>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Button
            size="lg"
            onClick={() => (settled ? onPrint() : settle.mutate())}
            disabled={settled ? false : !!blocked || settle.isPending}
          >
            <PrinterIcon />
            {settled ? "打印码单（F9）" : "结算并打印码单（F10）"}
          </Button>
          {blocked && !settled && <p className="text-xs text-warning">{blocked}</p>}
          {settled && order && (
            <div className="flex flex-wrap items-center gap-2 border-t pt-2 text-xs">
              <PaymentStatusBadge status={order.payment_status} />
              <span className="tnum text-muted-foreground">已付 {money(order.paid_amount_fen)}</span>
              {order.payable_amount_fen != null && order.payable_amount_fen - order.paid_amount_fen > 0 && (
                <ToneBadge tone="warning">未付 {money(order.payable_amount_fen - order.paid_amount_fen)}</ToneBadge>
              )}
              <span className="text-muted-foreground">付款走「结算中心 / 付款与挂账」</span>
            </div>
          )}
        </div>

        <div className="border-t pt-2">
          <p className="mb-1 text-xs text-muted-foreground">
            抓拍：{photos.length > 0 ? `${photos.length} 张` : "无（摄像机离线或未触发，磅单将标「无抓拍」）"}
          </p>
          {photos.length > 0 && (
            <div className="grid grid-cols-3 gap-1">
              {photos.map((p) => (
                <div key={p.id} className="flex flex-col gap-0.5">
                  <div className={cn("flex h-12 items-end p-1 text-[10px] text-white/90", TONE_DOT[p.missing ? "danger" : "neutral"])}>
                    {p.missing ? "缺失" : p.label}
                  </div>
                  <span className="tnum truncate text-[10px] text-muted-foreground">{p.captured_at.slice(5, 16).replace("T", " ")}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
