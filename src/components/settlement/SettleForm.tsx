/**
 * 结算计价与收款表单（02 §F1.4「结算与打印」拆出来的"结算"那一半）。
 *
 * 为什么单独成文件：结算的入口从工作台挪到了扫码窗口（先打票、后凭码集中算钱），
 * 但算钱的规则一条都没变——单价来自价目表或手填、偏离必留事由、扣重四项、
 * 应付不得为负、挂账要站点放行。这套判定在前端只能有一份，否则工作台和结算窗口
 * 会出现"同一张单算出两个应付"，而那正是红冲要处理的现场事故。
 *
 * 前端的数只用于即时反馈，落库一律以 `api.settle()` 返回为准（Rust 同口径重算一遍）。
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CircleCheckIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { announce } from "@/lib/voice-prompt";
import type { GrainVariety, PriceList, QcReport, Settlement, WeighOrder } from "@/mock/types";
import type { PaymentMethod } from "@/lib/constants";
import { PAYMENT_METHOD } from "@/lib/constants";
import { money, price as fmtPrice, rmbUpper, ton, weight } from "@/lib/format";
import { previewSettlement } from "@/lib/calc";
import { actorId, useSession } from "@/store/session";
import { useHotkey } from "@/hooks/useHotkey";
import { Choose } from "@/components/business/Choose";
import { MoneyField, MoneyLine, PriceField, WeightField } from "@/components/business/NumField";
import { ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** 结算成功的返回：磅单与结算单同时回来，调用方据此刷新与提示 */
export interface SettleOutcome {
  order: WeighOrder;
  settlement: Settlement;
}

/** 从价目表取现行价：先按品种+等级精确命中，命不中退回同品种最近生效的一条 */
export function lookupPrice(prices: PriceList[], varietyId: number, grade: string | null, date: string): PriceList | null {
  const live = prices.filter((p) => p.variety_id === varietyId && p.effective_from <= date && p.effective_to >= date);
  if (live.length === 0) return null;
  if (grade) {
    const exact = live.find((p) => p.grade === grade);
    if (exact) return exact;
  }
  return live.slice().sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0] ?? null;
}

export function SettleForm({
  order,
  variety,
  qc,
  prices,
  allowCredit,
  onSettled,
  submitLabel = "确认结算并收款（F10）",
  submitHotkey = "f10",
}: {
  order: WeighOrder;
  variety: GrainVariety | null;
  qc: QcReport | null;
  prices: PriceList[];
  /** 站点参数 settlement_allow_part_pay：关掉就只能当场付清，不允许挂账 */
  allowCredit: boolean;
  onSettled: (r: SettleOutcome) => void;
  /** 提交按钮文案，扫码窗口与快捷详情里各自不同 */
  submitLabel?: string;
  /** 提交快捷键，结算从工作台搬过来时键位一起搬；传 null 关掉 */
  submitHotkey?: string | null;
}) {
  const can = useSession((s) => s.can);

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
  /** 现金收款口算找零用，只在前端活着：入库的是应付，实收多少是出纳的手的事 */
  const [tenderedFen, setTenderedFen] = useState<number | null>(null);

  const grade = order.grade ?? qc?.grade ?? null;
  const listed = useMemo(
    () => lookupPrice(prices, order.variety_id, grade, order.business_date),
    [prices, order.variety_id, grade, order.business_date],
  );

  // 换单时把默认值铺好：价目表价、品种袋重、化验单扣水扣杂
  useEffect(() => {
    const l = lookupPrice(prices, order.variety_id, order.grade ?? qc?.grade ?? null, order.business_date);
    setPrice(order.price_fen_per_ton ?? l?.price_fen_per_ton ?? null);
    setPkg(order.package_deduct_01kg ?? variety?.default_package_deduct_01kg ?? 0);
    setMoisture(order.moisture_deduct_01kg || qc?.moisture_deduct_01kg || 0);
    setImpurity(order.impurity_deduct_01kg || qc?.impurity_deduct_01kg || 0);
    setOther(order.other_deduct_01kg ?? 0);
    setFeeFen(order.deduction_fee_fen ?? 0);
    setOverrideReason(order.price_override_reason ?? "");
    setSigned(order.payment_status === "paid");
    setTenderedFen(null);
    // qc 与 prices 在同一张单的生命周期内基本同步到位，不必列依赖避免反复覆盖输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.order_no, order.settled_at]);

  // 只有「现行价目原价取值」才算命中价目表；否则一律是手填价
  const matchesList = listed != null && priceFenPerTon != null && priceFenPerTon === listed.price_fen_per_ton;
  const deviates = listed != null && priceFenPerTon != null && priceFenPerTon !== listed.price_fen_per_ton;
  // 无生效价目时的手工定价与偏离价目同责，都必须留改价事由（01 §F2.3，与后端 settle 同口径）
  const needsReason = priceFenPerTon != null && !matchesList;

  const preview = previewSettlement({
    net_weight_01kg: order.net_weight_01kg,
    package_deduct_01kg: pkg,
    moisture_deduct_01kg: moisture,
    impurity_deduct_01kg: impurity,
    other_deduct_01kg: other,
    price_fen_per_ton: priceFenPerTon,
    deduction_fee_fen: feeFen,
  });

  const settle = useMutation({
    mutationFn: (): Promise<SettleOutcome | null> =>
      api.settle({
        order_no: order.order_no,
        price_fen_per_ton: priceFenPerTon!,
        package_deduct_01kg: pkg,
        moisture_deduct_01kg: moisture,
        impurity_deduct_01kg: impurity,
        other_deduct_01kg: other,
        deduction_fee_fen: feeFen,
        pay_now: payNow,
        payment_method: method,
        settler_id: actorId(),
        price_list_id: matchesList && listed ? listed.id : null,
        price_override_reason: needsReason ? overrideReason.trim() : null,
        party_signed: signed,
      }),
    onSuccess: (r) => {
      if (!r) {
        toast.error("结算失败：净重缺失或扣重后重量不大于 0");
        announce("结算没有成功，这张单的净重或扣重不对", `settle-bad:${order.order_no}`);
        return;
      }
      // 收尾这一声最值钱：钱在手里、票在打，屏幕上那行绿字没人回头确认
      announce(payNow ? "结算完成，钱已收清" : "结算完成，这一单挂账", `settle:${order.order_no}`);
      onSettled(r);
    },
    // 改价事由缺失、重复结算等闸门原因要原样送到操作员眼前，不许翻译成"操作失败"
    onError: (e: Error) => {
      toast.error(`结算失败：${e.message || "请重试；已录入内容不会丢"}`);
      // 服务端原因带单号与条款（"本单已于…结算"），念出来没人听得懂，只念结论与"内容没丢"
      announce("结算没有成功，填的内容没有丢，可以再结一次", `settle-fail:${order.order_no}`);
    },
  });

  /** 不放行的原因，null = 可以提交。顺序即"卡在哪儿"的优先级，同一份文案也写在按钮旁边 */
  const blocked =
    order.net_weight_01kg == null
      ? "本单净重未确定，还没完成过磅"
      : !can("settle.create")
        ? "当前岗位无权结算，需出纳或站长"
        : preview.blocked
          ? preview.blocked
          : priceFenPerTon == null
            ? "请填写单价，或点「从价目带出」"
            : needsReason && overrideReason.trim().length < 4
              ? deviates
                ? "偏离价目表，必须填写改价事由"
                : "当前无生效价目，手工定价必须填写改价事由"
              : payNow
                ? can("pay.record")
                  ? null
                  : "当场付款需要出纳或站长登记，当前操作员只能挂账"
                : !allowCredit
                  ? "站点参数已关闭「允许挂账」，只能当场付清"
                  : null;

  function pickFromList() {
    if (!listed) {
      toast.error("该品种该等级当前没有生效价，请到「收购价目表」维护");
      announce("这个品种这个等级没有生效价，要手填单价", "settle-noprice");
      return;
    }
    setPrice(listed.price_fen_per_ton);
    toast.success(`已带出 ${listed.grade} ${money(listed.price_fen_per_ton)}/吨（生效至 ${listed.effective_to}）`);
    // 只报"带出来了"，价格数字归屏幕与码单（05 §6.5 规矩①）
    announce("已带出价目表的现价", `settle-priced:${order.order_no}`);
  }

  const change =
    payNow && method === "cash" && tenderedFen != null && preview.payableAmountFen != null
      ? tenderedFen - preview.payableAmountFen
      : null;

  // 光标停在改价事由、实收现金这些框里也得能按——结算这一下就是本窗口的收尾动作
  useHotkey(
    submitHotkey ?? "",
    () => {
      if (blocked) {
        toast.error(blocked);
        // 这些原因本身就是一句人话（不带单号与金额），照整句话去重：原因换了就该重念一句
        announce(blocked);
        return;
      }
      if (!settle.isPending) settle.mutate();
    },
    { enabled: !!submitHotkey, allowInInput: true },
  );
  // F6 带价目表现价，跟着结算一起搬过来（原先在工作台上）
  useHotkey("f6", pickFromList, { allowInInput: true });

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-0.5">
        <PriceField
          label="单价"
          valueFenPerTon={priceFenPerTon}
          onChange={setPrice}
          hint={deviates ? "已偏离价目表现行价" : listed == null && priceFenPerTon != null ? "无生效价目，手工定价" : undefined}
        />
        <div className="flex items-center justify-between gap-1">
          <span className="text-[11px] text-muted-foreground truncate">
            {listed ? `价目表：${listed.grade} · ${money(listed.price_fen_per_ton)}/吨` : "价目表无现行价"}
          </span>
          <Button size="xs" variant="outline" onClick={pickFromList} disabled={!listed} className="h-5 px-1.5 text-[10px] shrink-0">
            从价目带出
          </Button>
        </div>
        {needsReason && (
          <Label className="flex flex-col gap-0.5 text-xs text-warning">
            改价事由（迎检必查）
            <Input
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="如：水分超基准 1.2%，议价下调 40 元/吨"
              className="h-7 border-warning/50 text-xs"
            />
          </Label>
        )}
      </div>

      <div className="grid grid-cols-2 gap-1 border-y py-1">
        <WeightField label="袋重（含绳网）" value01kg={pkg || null} onChange={(v) => setPkg(v ?? 0)} />
        <WeightField label="扣水（化验）" value01kg={moisture || null} onChange={(v) => setMoisture(v ?? 0)} />
        <WeightField label="扣杂" value01kg={impurity || null} onChange={(v) => setImpurity(v ?? 0)} />
        <WeightField label="其他扣" value01kg={other || null} onChange={(v) => setOther(v ?? 0)} />
        <div className="col-span-2">
          <MoneyField label="费用扣款（卸车费、袋钱等）" valueFen={feeFen} onChange={setFeeFen} />
        </div>
      </div>

      <div className="flex flex-col gap-0.5 bg-muted/25 p-1.5 text-xs">
        <div className="flex items-baseline justify-between">
          <span className="text-muted-foreground">净重</span>
          <span className="tnum">{weight(order.net_weight_01kg)}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-muted-foreground">扣重合计</span>
          <span className="tnum">{weight(preview.deductTotal01kg)}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="font-semibold">结算重量</span>
          <span className="tnum text-base font-bold">
            {weight(preview.settlementWeight01kg)}
            <span className="ml-1 text-xs font-normal text-muted-foreground">（{ton(preview.settlementWeight01kg)}）</span>
          </span>
        </div>
        <MoneyLine label="货款" valueFen={preview.goodsAmountFen} hint={fmtPrice(priceFenPerTon).perJin} />
        <MoneyLine label="扣款" valueFen={feeFen} />
        <MoneyLine label="应付" emphasis valueFen={preview.payableAmountFen} hint={rmbUpper(preview.payableAmountFen)} />
      </div>

      <div className="flex flex-col gap-1">
        <div className="grid grid-cols-2 items-end gap-1.5">
          <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            支付方式
            <Choose
              aria-label="支付方式"
              value={method}
              onChange={(v) => setMethod(v)}
              disabled={!payNow}
              options={(Object.keys(PAYMENT_METHOD) as PaymentMethod[])
                .filter((k) => k !== "credit_writeoff")
                .map((k) => ({ value: k, label: PAYMENT_METHOD[k] }))}
            />
          </Label>
          <div className="flex flex-col gap-1 pb-0.5 text-xs">
            <Label className="flex items-center gap-1 text-xs">
              <Checkbox checked={payNow} onCheckedChange={(v) => setPayNow(v === true)} disabled={!allowCredit} />
              当场已付
            </Label>
            <Label className="flex items-center gap-1 text-xs">
              <Checkbox checked={signed} onCheckedChange={(v) => setSigned(v === true)} />
              售粮人已签字
            </Label>
          </div>
        </div>
        {!payNow && !allowCredit && <p className="text-xs text-warning">站点参数已关闭挂账，本单必须当场付清。</p>}
        {payNow && method === "cash" && (
          <div className="flex items-end gap-1.5">
            <MoneyField label="实收现金（算找零用）" valueFen={tenderedFen ?? 0} onChange={setTenderedFen} />
            {change != null && (
              <span className={`tnum shrink-0 pb-1 text-xs ${change < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                {change < 0 ? `还差 ${money(-change)}` : `找零 ${money(change)}`}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <Button
          size="default"
          onClick={() => settle.mutate()}
          disabled={!!blocked || settle.isPending}
          className="h-8 text-xs"
        >
          <CircleCheckIcon />
          {settle.isPending ? "结算中…" : submitLabel}
        </Button>
        {blocked && <p className="text-xs text-warning">{blocked}</p>}
        {!payNow && allowCredit && <ToneBadge tone="warning">本单将挂账，之后凭结算凭证核销</ToneBadge>}
      </div>
    </div>
  );
}
