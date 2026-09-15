/**
 * 结算计价与付款表单（02 §F1.4「结算与打印」拆出来的"结算"那一半）。
 *
 * 为什么单独成文件：结算的入口从工作台挪到了扫码窗口（先打票、后凭码集中算钱），
 * 但算钱的规则一条都没变——单价来自价目表或手填、偏离必留事由、扣重四项、
 * 应付不得为负、挂账要站点放行。这套判定在前端只能有一份，否则工作台和结算窗口
 * 会出现"同一张单算出两个应付"，而那正是红冲要处理的现场事故。
 *
 * 前端的数只用于即时反馈，落库一律以 `api.settle()` 返回为准（Rust 同口径重算一遍）。
 *
 * **品种在制单那一刻就定了**（2026-09-14 起必填），所以这一行多数时候只是把本单品种显示出来、
 * 供"磅单上写错了要改判"用。价目表的价只有"品种 + 等级"两个锚，没有品种就没有现价可言，
 * 于是结算框顶部留了一行「收购品种」——就地改判走 `order_set_variety`，
 * 换完按新品种重带单价与袋重。服务端在 `settle` 里同样拦一道（前端的闸门只是让人少跑一步），
 * 存量单没品种时也靠它补上。
 *
 * **等级那一格叫「结算等级」**（不叫「等级」）：磅单上跑着两条互不相干的等级线，化验单那个是
 * 化验员按国标的判定（`qc_report.grade`，永不改写），这里这个是"这一车按几等结钱"
 * （`weigh_order.grade`，随结算落库）。工作台的化验区要是也写「等级」，现场就会以为同一个东西填两遍。
 *
 * **扣水 / 扣杂的出处同样要说在脸上**：计算单打开时按 `order.x || qc.x` 铺过初值，但
 * `qc_report.*_deduct_01kg` 在库里只是"化验给出的建议"（见 0001_init 注释），结算只把本表的值
 * UPDATE 进磅单、**不回写化验单**。所以两格都标出化验单的来源值，现场改动后再补一句差异说明——
 * 否则化验员录一遍、出纳再录一遍，事后谁也说不清哪份算数。
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheckIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { announce } from "@/lib/voice-prompt";
import type { GrainVariety, PriceList, QcReport, Settlement, WeighOrder } from "@/mock/types";
import type { PaymentMethod } from "@/lib/constants";
import { GRADES, PAYMENT_METHOD } from "@/lib/constants";
import { money, price as fmtPrice, rmbUpper, ton, weight } from "@/lib/format";
import { previewSettlement } from "@/lib/calc";
import { lookupPrice, settleDefaults } from "@/lib/settle-defaults";
import { actorId, useSession } from "@/store/session";
import { useHotkey } from "@/hooks/useHotkey";
import { useQuickOptions, useVarieties } from "@/hooks/useLookups";
import { Choose } from "@/components/business/Choose";
import { ComboBox } from "@/components/business/ComboBox";
import { MoneyField, MoneyLine, PriceField, WeightField } from "@/components/business/NumField";
import { ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

/** 结算成功的返回：磅单与结算单同时回来，调用方据此刷新与提示 */
export interface SettleOutcome {
  order: WeighOrder;
  settlement: Settlement;
}

/**
 * 价目表取现行价的实现已移到 `lib/settle-defaults.ts`：工作台在净重刚定那一刻的
 * **自动挂账结算**也要用它，而自动结算与这个框必须算出同一笔钱（同一张单出现两个应付
 * 正是红冲要收拾的现场事故）。这里原样再导出一份，老的引用路径不必跟着改。
 */
export { lookupPrice };

export function SettleForm({
  order,
  variety,
  qc,
  prices,
  allowCredit,
  onSettled,
  submitLabel = "确认结算并付款（F10）",
  submitHotkey = "f10",
  defaultUnpaid = false,
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
  /**
   * 开框时按「未付款（挂账）」起步。
   *
   * 只有工作台那条路会传：皮重刚捕完就把结算框弹出来，现场节奏是"过完磅就走、钱回头再算"，
   * 默认按当场已付等于每单都要人多按一下取消，还会让人误以为这笔钱已经付出去了。
   * 扫码窗口与补录付款保持默认（当场付清）——那是"客户递票来拿钱"的场合，勾反了是事故。
   *
   * 站点关掉挂账（`settlement_allow_part_pay`）时这里自动失效：那种站只能当场付清，
   * 而那个勾选框在关着挂账时是禁用的——真按未付款起步，人会"看着不对却改不回来"。
   */
  defaultUnpaid?: boolean;
}) {
  const can = useSession((s) => s.can);
  const queryClient = useQueryClient();
  const { data: allVarieties = [] } = useVarieties();

  /** 真的按未付款起步吗（见上面 `defaultUnpaid` 的说明） */
  const startUnpaid = defaultUnpaid && allowCredit;
  /**
   * 能不能把这张单结掉。`settle.create`（出纳/站长）含当场付款；`settle.credit` 是磅员那条
   * ——**只能挂账、不动现金**，下面"当场已付"那一支仍然要 `pay.record`。磅员这条权只在
   * 磅房过磅流程里用得上（皮重捕完自动推进到这一框），兑付窗口那道门由 `settle-gate.ts` 守。
   */
  const canSettle = can("settle.create") || can("settle.credit");

  const [grade, setGrade] = useState<string>("");
  const [priceFenPerTon, setPrice] = useState<number | null>(null);
  const [pkg, setPkg] = useState<number>(0);
  const [moisture, setMoisture] = useState<number>(0);
  const [impurity, setImpurity] = useState<number>(0);
  const [other, setOther] = useState<number>(0);
  const [feeFen, setFeeFen] = useState<number>(0);
  /**
   * 支付方式**刻意不预选**（空串＝还没选）。原来默认停在「现金」上，等于替出纳认了一笔
   * 付款渠道：十单里有九单照默认走，月底的付款方式分布就成了"现金"，那个统计再没人敢信。
   * 空值只在「当场已付」那一刻是卡点（见下面 `gate`），挂账那一支这个下拉是禁用的、值本就是空，
   * 服务端那一刻也不写这一列（`orders.rs::settle` 的值域校验同样只在不挂账时生效）。
   */
  const [method, setMethod] = useState<PaymentMethod | "">("");
  const [payNow, setPayNow] = useState(!startUnpaid);
  const [signed, setSigned] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const { options: priceOptions } = useQuickOptions("price");
  /**
   * 当场实付金额（分）。`null`＝没动过＝按应付全额付清（与改造前一模一样）；
   * 填小即为部分付款，差额由服务端落成 `partial` 并进挂账台账（02 §F5.2）。
   */
  const [paidFen, setPaidFen] = useState<number | null>(null);

  // 等级是**结算时**定的：化验单上的判定只是建议，现场常按实际议价改判，
  // 所以这里存的是本单要按几等结钱，改了就随结算落库（化验报告本身永不改写）。
  const listed = useMemo(
    () => lookupPrice(prices, order.variety_id, grade || null, order.business_date),
    [prices, order.variety_id, grade, order.business_date],
  );

  // 换单时把默认值铺好：等级、价目表价、品种袋重、化验单扣水扣杂。
  // 这一组值不在本组件里现算，统一走 `settleDefaults()`——工作台在净重刚定那一刻的
  // 自动挂账结算用的是同一个函数，两条路铺出来的必须是同一组数，否则同一张单会在
  // "自动结掉的数"与"框里显示的数"之间打架，而钱是以后者给人看的。
  useEffect(() => {
    const d = settleDefaults(order, variety, qc, prices);
    setGrade(d.grade);
    setPrice(d.price_fen_per_ton);
    setPkg(d.package_deduct_01kg);
    setMoisture(d.moisture_deduct_01kg);
    setImpurity(d.impurity_deduct_01kg);
    setOther(d.other_deduct_01kg);
    setFeeFen(d.deduction_fee_fen);
    setOverrideReason(d.price_override_reason);
    setSigned(order.payment_status === "paid");
    // 换单要连付款意图一起复位：上一单改成"挂账"的意图留着，下一单会默默挂出另一笔账
    setPayNow(!startUnpaid);
    // 支付方式同样不跨单带过去：上一单怎么付是上一单的事，留着等于又替下一单认了一遍
    setMethod("");
    // 换单必清实付金额：留着上一单填的数额，下一单会莫名其妙挂一笔账
    setPaidFen(null);
    // qc 与 prices 在同一张单的生命周期内基本同步到位，不必列依赖避免反复覆盖输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.order_no, order.settled_at]);

  // 只有「现行价目原价取值」才算命中价目表；否则一律是手填价
  const matchesList = listed != null && priceFenPerTon != null && priceFenPerTon === listed.price_fen_per_ton;
  const deviates = listed != null && priceFenPerTon != null && priceFenPerTon !== listed.price_fen_per_ton;
  // 无生效价目（`listed == null` → matchesList 为假）/偏离价目时把改价事由字段露出来。
  // 它**不是提交闸门**：改价事由是选填（2026-09-14 起改为选填，与后端 `orders.rs::settle` 同一口径），
  // 写了就随结算落库留痕，不写也放行——收粮结账这一刻不该因为少敲一句话就结不了。
  const showReason = priceFenPerTon != null && !matchesList;

  const preview = previewSettlement({
    net_weight_01kg: order.net_weight_01kg,
    package_deduct_01kg: pkg,
    moisture_deduct_01kg: moisture,
    impurity_deduct_01kg: impurity,
    other_deduct_01kg: other,
    price_fen_per_ton: priceFenPerTon,
    deduction_fee_fen: feeFen,
  });

  /** 本次实付（分）：没动过＝按应付全额付清；填小即为部分付款 */
  const payAmountFen = paidFen ?? preview.payableAmountFen ?? 0;
  /** 还欠多少：>0 就是这一单结算完要挂上去的账（`/payments` 挂账台账、看板告警同一口径） */
  const creditFen = preview.payableAmountFen == null ? null : preview.payableAmountFen - payAmountFen;
  /** 能不能把实付改小＝部分付款。它与整单挂账是同一个站点参数（名字里的"部分付款"就是这个），关掉只能全额付清 */
  const canPartPay = allowCredit && payNow;

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
        // 关着挂账时永远传 null（＝全额付清），与"部分付款"入口露不露出来是同一个开关
        paid_amount_fen: payNow && allowCredit ? payAmountFen : null,
        // 挂账那一支这个值是空串：那一刻服务端不写这一列，值域校验也不生效（见上面的 `method`）
        payment_method: method,
        settler_id: actorId(),
        price_list_id: matchesList && listed ? listed.id : null,
        price_override_reason: showReason ? overrideReason.trim() : null,
        party_signed: signed,
        grade: grade || null,
      }),
    onSuccess: (r) => {
      if (!r) {
        toast.error("结算失败：净重缺失或扣重后重量不大于 0");
        announce("结算没有成功，这张单的净重或扣重不对", `settle-bad:${order.order_no}`);
        return;
      }
      // 收尾这一声最值钱：钱在手里、票在打，屏幕上那行绿字没人回头确认。
      // 以服务端返回的结算单为准——实付与应付差多少，只有落库后的数算数。
      const leftFen = r.settlement.payable_fen - r.settlement.paid_fen;
      announce(
        leftFen <= 0
          ? "结算完成，款已付清"
          : r.settlement.paid_fen > 0
            ? "结算完成，这一单只付了一部分，剩下的挂账"
            : "结算完成，这一单全额挂账，凭证留好",
        `settle:${order.order_no}`,
      );
      onSettled(r);
    },
    // 重复结算、无品种等闸门原因要原样送到操作员眼前，不许翻译成"操作失败"
    onError: (e: Error) => {
      toast.error(`结算失败：${e.message || "请重试；已录入内容不会丢"}`);
      // 服务端原因带单号与条款（"本单已于…结算"），念出来没人听得懂，只念结论与"内容没丢"
      announce("结算没有成功，填的内容没有丢，可以再结一次", `settle-fail:${order.order_no}`);
    },
  });

  /**
   * 就地改本单品种（新单制单时已定；这里管"写错了要改判"与存量单补定，服务端 `settle`
   * 另有一道"没品种不许结算"的硬闸兜底）。
   *
   * 换完立刻按新品种重带单价与袋重：原来那个价是"上一个品种的现价"，那个袋重是"上一个品种的
   * 默认扣量"，留着不动等于把两种粮的钱算在一张单上。这会冲掉手填过的价，所以必须出声说一句
   * "单价已按新品种重新带出"（05 §6.5：改数的动作要能追溯到那一下操作）。
   */
  const setVariety = useMutation({
    mutationFn: (variety_id: number | null) =>
      api.setOrderVariety({ order_no: order.order_no, variety_id, reason: "", operator_id: actorId() }),
    onSuccess: (o) => {
      if (!o) {
        toast.error("这张单已经不在系统里了，请刷新后再看");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["order", o.order_no] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["open-orders"] });
      queryClient.invalidateQueries({ queryKey: ["audits"] });
      const next = allVarieties.find((v) => v.id === o.variety_id) ?? null;
      const l = lookupPrice(prices, o.variety_id, grade || null, o.business_date);
      setPrice(l?.price_fen_per_ton ?? null);
      setPkg(o.package_deduct_01kg ?? next?.default_package_deduct_01kg ?? 0);
      toast.success(
        `品种已改为「${o.variety_name ?? "未定品种"}」，${
          l ? `单价按价目表重带为 ${fmtPrice(l.price_fen_per_ton)}` : "该品种当前没有生效价，单价已清空、请手工填价"
        }`,
      );
      announce("品种改了，单价已按新品种重新带出", `settle-variety:${o.order_no}`);
    },
    // 真库闸门回的是人话（"已结算的单改品种请先由站长红冲"），原样送到眼前
    onError: (e: Error) => toast.error(`品种没改成：${e.message || "请重试"}`),
  });

  /**
   * 下拉里的品种：停用只挡新建（与制单下拉同一条口径），但本单已经定下的那个即便事后被停用
   * 也要露出来——不然一张定过品种的单会在界面上显示成"没定品种"，那是把数据显示错了。
   */
  const varietyPool = allVarieties.filter((v) => v.is_active !== 0 || v.id === order.variety_id);

  /**
   * 不放行的原因，null = 可以提交。顺序即"卡在哪儿"的优先级，同一份文案也用在提交提示语音里。
   * `field` 标出这条原因卡在哪个表单项：有归属的错误直接红框+红字标在控件上，不在按钮下方重复。
   */
  const gate: { msg: string; field?: "variety" | "price" | "method" | "payAmount" } | null =
    order.variety_id == null
      ? { msg: "本单还没有定收购品种：请先在上面的「收购品种」里选定，才有价可依", field: "variety" }
      : order.net_weight_01kg == null
        ? { msg: "本单净重未确定，还没完成过磅" }
        : !canSettle
          ? { msg: "当前岗位无权结算，需磅员、出纳或站长" }
          : preview.blocked
            ? { msg: preview.blocked }
            : priceFenPerTon == null
              ? { msg: "请填写单价，或点「从价目带出」", field: "price" }
              : payNow
                  ? !can("pay.record")
                    ? { msg: "当场付款需要出纳或站长登记，当前操作员只能挂账" }
                    : // 支付方式不预选，就必得有人真选一下：钱从哪条渠道出去是台账要认的，
                      // 与"作废必须写清为什么"同一条道理——凡是能事后被追问的数，不许由默认值代答
                      method === ""
                      ? { msg: "请选择支付方式：当场付款要记明这笔钱是怎么付的", field: "method" }
                      : preview.payableAmountFen != null && payAmountFen > preview.payableAmountFen
                        ? { msg: "本次实付大于应付，付款不能超过应付金额", field: "payAmount" }
                        : preview.payableAmountFen != null && preview.payableAmountFen > 0 && payAmountFen <= 0
                          ? { msg: "本次实付必须大于 0；一分钱都不付就取消「当场已付」改走挂账", field: "payAmount" }
                          : null
                  : !allowCredit
                    ? { msg: "站点参数已关闭「允许挂账」，只能当场付清" }
                    : null;
  /** 不放行的文案（提交闸门与语音共用）；字段级的还会长在对应控件上 */
  const blocked = gate?.msg ?? null;

  /**
   * 化验单上的扣量（"建议值"）。它不是扣重的来源，只是计算单铺初值的依据，所以只在
   * 标签上标出出处、改动了再补一句差异——不标的话，化验区与计算单会看着像同一个字段填两遍。
   */
  const qcMoisture = qc?.moisture_deduct_01kg ?? null;
  const qcImpurity = qc?.impurity_deduct_01kg ?? null;
  /** 「扣水（化验 12.5 kg）」；化验单没这项就退回朴素标签 */
  const withQcSource = (name: string, from: number | null) =>
    from == null ? name : `${name}（化验 ${weight(from)}）`;
  /** 现场改过了才提示：说明本单与化验单不同，且化验单不会被回写 */
  const changedFromQc = (now: number, from: number | null) =>
    from == null || now === from
      ? undefined
      : `已改动：化验单是 ${weight(from)}，结算与票面一律按本单算（化验单保持原值）`;

  /** 改等级：价目表带出的价跟着新等级走；手填/已偏离的价不动——那通常是现场议价的结果 */
  function changeGrade(next: string) {
    setGrade(next);
    if (!matchesList) return;
    const nextListed = lookupPrice(prices, order.variety_id, next || null, order.business_date);
    if (nextListed && nextListed.price_fen_per_ton !== priceFenPerTon) {
      setPrice(nextListed.price_fen_per_ton);
      toast.success(`等级改为 ${next || "未定级"}，单价跟进价目表 ${fmtPrice(nextListed.price_fen_per_ton)}`);
      // 只报"跟着改了"：新单价归屏幕与码单（05 §6.5 规矩①）
      announce("等级改了，单价已按新等级带出", `settle-grade:${order.order_no}`);
    }
  }

  function pickFromList() {
    if (!listed) {
      toast.error("该品种该等级当前没有生效价，请到「收购价目表」维护");
      announce("这个品种这个等级没有生效价，要手填单价", "settle-noprice");
      return;
    }
    setPrice(listed.price_fen_per_ton);
    toast.success(`已带出 ${listed.grade} ${fmtPrice(listed.price_fen_per_ton)}（生效至 ${listed.effective_to}）`);
    // 只报"带出来了"，价格数字归屏幕与码单（05 §6.5 规矩①）
    announce("已带出价目表的现价", `settle-priced:${order.order_no}`);
  }

  // 光标停在改价事由、本次实付这些框里也得能按——结算这一下就是本窗口的收尾动作
  function submit() {
    if (blocked) {
      toast.error(blocked);
      // 这些原因本身就是一句人话（不带单号与金额），照整句话去重：原因换了就该重念一句
      announce(blocked);
      return;
    }
    if (!settle.isPending) settle.mutate();
  }

  useHotkey(submitHotkey ?? "", submit, {
    enabled: !!submitHotkey,
    allowInInput: true,
  });
  // F6 带价目表现价，跟着结算一起搬过来（原先在工作台上）
  useHotkey("f6", pickFromList, { allowInInput: true });

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-0.5">
        <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          收购品种（本单按此品种计价）
          <Choose
            aria-label="收购品种"
            invalid={gate?.field === "variety"}
            value={String(order.variety_id ?? "")}
            onChange={(v) => setVariety.mutate(v ? Number(v) : null)}
            options={[
              ...varietyPool.map((v) => ({ value: String(v.id), label: v.name })),
            ]}
          />
        </Label>
        {/* 品种是价目表唯一的锚：没定品种时不说清"为什么带不出价"，磅员会以为是价目表没维护 */}
        {order.variety_id == null && (
          <p className="text-xs text-destructive">
            这张单制单时没定品种。单价、袋重、化验指标都跟着品种走，先在这里选定才能结算。
          </p>
        )}
      </div>

      <div className="flex flex-col gap-0.5">
        <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          结算等级（本单按此计价）
          <Choose
            aria-label="结算等级"
            value={grade}
            onChange={changeGrade}
            options={[{ value: "", label: "未定级" }, ...GRADES.map((g) => ({ value: g, label: g }))]}
          />
        </Label>
        {qc?.grade && qc.grade !== grade && (
          <p className="text-xs text-warning">
            化验定级 {qc.grade}，本单按 {grade || "未定级"} 结算（留痕可查）
          </p>
        )}
      </div>

      <div className="flex flex-col gap-0.5">
        <PriceField
          label="单价"
          keypad
          valueFenPerTon={priceFenPerTon}
          onChange={setPrice}
          invalid={gate?.field === "price"}
          hint={
            gate?.field === "price"
              ? gate.msg
              : deviates
                ? "已偏离价目表现行价"
                : listed == null && priceFenPerTon != null
                  ? "无生效价目，手工定价"
                  : undefined
          }
        />
        <div className="flex items-center justify-between gap-1">
          <span className="text-[11px] text-muted-foreground truncate">
            {listed ? `价目表：${listed.grade} · ${fmtPrice(listed.price_fen_per_ton)}` : "价目表无现行价"}
          </span>
          <Button size="xs" variant="outline" onClick={pickFromList} disabled={!listed} className="h-5 px-1.5 text-[10px] shrink-0">
            从价目带出
          </Button>
        </div>
        {showReason && (
          <div className="flex flex-col gap-1 text-xs text-warning">
            <span>改价事由（选填，写了才随结算留痕）</span>
            <ComboBox
              aria-label="改价事由"
              presets={priceOptions}
              value={overrideReason}
              onChange={setOverrideReason}
              placeholder="选一条常用的，或写清楚为什么改价…"
              className="h-7 border-warning/50 text-xs"
            />
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-1 border-y py-1">
        <WeightField label="袋重（含绳网）" keypad value01kg={pkg || null} onChange={(v) => setPkg(v ?? 0)} />
        <WeightField
          label={withQcSource("扣水", qcMoisture)}
          keypad
          value01kg={moisture || null}
          onChange={(v) => setMoisture(v ?? 0)}
          hint={changedFromQc(moisture, qcMoisture)}
        />
        <WeightField
          label={withQcSource("扣杂", qcImpurity)}
          keypad
          value01kg={impurity || null}
          onChange={(v) => setImpurity(v ?? 0)}
          hint={changedFromQc(impurity, qcImpurity)}
        />
        <WeightField label="其他扣" keypad value01kg={other || null} onChange={(v) => setOther(v ?? 0)} />
        <div className="col-span-2">
          <MoneyField label="费用扣款（卸车费、袋钱等）" keypad valueFen={feeFen} onChange={setFeeFen} />
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
        <MoneyLine label="粮款" valueFen={preview.goodsAmountFen} />
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
              invalid={gate?.field === "method"}
              options={[
                // 未选就是一枚真选项（空串），不是"没渲染出来的值"：原生 select 找不到匹配项时
                // 会自顾自显示第一项，那就又变成了"默认现金"
                { value: "", label: "请选择" },
                ...(Object.keys(PAYMENT_METHOD) as PaymentMethod[])
                  .filter((k) => k !== "credit_writeoff")
                  .map((k) => ({ value: k, label: PAYMENT_METHOD[k] })),
              ]}
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
        {/* 支付方式是 `Choose`（原生 select），没有 MoneyField 那样的 `hint` 位，卡点就挨着它写一行 */}
        {gate?.field === "method" && <p className="text-xs text-destructive">{gate.msg}</p>}
        {!payNow && !allowCredit && <p className="text-xs text-warning">站点参数已关闭挂账，本单必须当场付清。</p>}
        {canPartPay && preview.payableAmountFen != null && preview.payableAmountFen > 0 && (
          <div className="flex flex-col gap-0.5">
            <MoneyField
              label="本次实付（改小即为部分付款）"
              keypad
              valueFen={payAmountFen}
              onChange={setPaidFen}
              invalid={gate?.field === "payAmount"}
              hint={gate?.field === "payAmount" ? gate.msg : undefined}
            />
            <div className="flex items-center justify-between gap-1 text-[11px]">
              <span className="text-muted-foreground">
                应付 <span className="tnum">{money(preview.payableAmountFen)}</span>，默认一次付清
              </span>
              {paidFen != null && (
                <button type="button" className="text-primary hover:underline" onClick={() => setPaidFen(null)}>
                  改回全额
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <Button
          size="default"
          onClick={submit}
          disabled={!!blocked || settle.isPending}
          className="h-8 text-xs"
        >
          <CircleCheckIcon />
          {settle.isPending ? "结算中…" : submitLabel}
        </Button>
        {/* 字段级的卡点（品种/单价/实付）已红框+红字长在控件上，这里只说不属于任何一格的原因 */}
        {blocked && gate?.field == null && <p className="text-xs text-warning">{blocked}</p>}
        {!payNow && allowCredit && <ToneBadge tone="warning">本单将全额挂账，之后凭结算凭证核销</ToneBadge>}
        {payNow && creditFen != null && creditFen > 0 && (
          <ToneBadge tone="warning">
            本单实付 <span className="tnum">{money(payAmountFen)}</span>，尚欠 <span className="tnum">{money(creditFen)}</span>{" "}
            挂账，之后凭结算凭证核销
          </ToneBadge>
        )}
      </div>
    </div>
  );
}
