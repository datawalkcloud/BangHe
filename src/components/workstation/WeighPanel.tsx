/**
 * ③ 称重区（05 §4 中栏上）。
 *
 * 三条现场规则写死在这里：
 *  1. 读数不稳定不允许捕获——按钮禁用并说明原因（05 §5 要求禁用必须带文字）
 *  2. 仪表离线时必须能改手录，但手录会永久标记在磅单上，迎检必查
 *  3. 皮重与历史偏差超容差 → **不拦下这次捕获**：数据照常有效，只给一句警告，
 *     并在磅单上留醒目提醒（本面板醒目条、详情页、码单票面「皮重警示」栏、审计）
 *
 * 另有一条边界：这一捕把净重凑齐之后该干什么（出码单、自动挂账结算、还是弹结算框等人定价）
 * **不在这里决定**。本面板只把"净重刚定"这件事交给页面（`onNetDetermined`），判定与话术归
 * 页面与 `lib/settle-defaults.ts`——刷卡那条路（`useIcWorkflow`）要给出同一个结论，
 * 两处各写一份就会出现"同一次过磅、手点与刷卡走出两种结果"。
 *
 * **手录不是二等公民**（05 §4 ②、§10-1「无外设也要能完成闭环」）。仪表离线 / 读卡器故障的
 * 站点里，这一格是唯一能把一车走完的地方，所以手录在三个点上与刷卡**同权**：
 *  1. **入口**：仪表一离线，两个主按钮就直接变成「录入毛重 / 录入皮重」，空格 / P 同权提交
 *     录入框里的值，不必先开下面那个开关再点另一个按钮——现场不会为多一个开关多等一秒；
 *  2. **判据**：判"净重刚定"用的必须是**捕获前**那一份快照（`priorNet`），不能拿 `order`
 *     这个 prop 现读——它随时可能被后台重取覆盖成"已经含净重"的新值，判据会静默变 false，
 *     这一捕就既不出码单也不走结算。刷卡那条路没这个坑，因为它在捕获前自己 `api.getOrder`
 *     取一份快照来比；这里照同一口径办；
 *  3. **下一步**：净重齐了之后要能把这一单送去结算（`onRequestSettle`，等价于第③刷）。
 *     没卡的站点没有第三刷可刷，缺了这个入口，过完磅就卡在磅房走不到钱那一步。
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HandCoinsIcon, PenLineIcon, TagIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { announce } from "@/lib/voice-prompt";
import { settleGateOf } from "@/lib/settle-gate";
import { priceGateOf } from "@/lib/weigh-gate";
import type { DeviceConfig, WeighOrder } from "@/mock/types";
import { grabCaptureFrames } from "@/lib/local-camera";
import { dateTime, fromKg, nowLocalISO, price as fmtPrice, toKg, weight } from "@/lib/format";
import { useDeviceStore } from "@/store/device";
import { actorId, useSession } from "@/store/session";
import { useHotkey } from "@/hooks/useHotkey";
import { WeightDisplay } from "@/components/business/WeightDisplay";
import { NumField } from "@/components/business/NumField";
import { PriceDialog } from "@/components/business/PriceDialog";
import { ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "cn";

interface Pending {
  weight_01kg: number;
  source: "scale" | "manual";
}

export function WeighPanel({
  order,
  mean01kg,
  tolerancePct,
  scalePort,
  scaleDivision01kg,
  anyCamOnline,
  captureCams,
  allowCredit,
  onNetDetermined,
  onRequestSettle,
}: {
  order: WeighOrder | null;
  mean01kg: number | null;
  tolerancePct: number;
  scalePort: string;
  scaleDivision01kg: number;
  /**
   * 这一捕把净重凑齐了（无论补上的是毛重还是皮重）——交给页面决定接下来怎么收尾。
   *
   * 为什么判"净重刚定"而不是"捕的是皮重"：一次/二次称重顺序自由（02 §F1.2），先捕皮重后捕
   * 毛重的车，凑齐净重的是**毛重**那一捕。按类型判会让这种车走不到结算那一步。
   */
  onNetDetermined?: (o: WeighOrder) => void;
  /**
   * 把当前这一单送去结算（复用页面上第③刷那条路：定位 + 开结算框 + 默认当场付清）。
   *
   * 为什么称重区要有这个按钮：刷卡推进的站点里"两项都齐、未结算"那一刷自然会唤起结算框
   * （`useIcWorkflow` 的 `step === "settle"`），可**没卡的站点没有第三刷可刷**——关掉流转卡
   * 或读卡器坏了的磅房，过完磅就再没有入口往下走，卡在磅房走不到钱那一步（06 §4.4 C1）。
   */
  onRequestSettle?: (orderNo: string) => void;
  /** 站点参数 `settlement_allow_part_pay`：只影响"已结算未付清"那句出路的文案，判定本身在 `settle-gate.ts` */
  allowCredit: boolean;
  /** 参与过磅抓拍的相机里有没有至少一台此刻可用（本机流能开 / IP 台账在线）——决定是否值得让服务端去等那 3 秒抓图 */
  anyCamOnline: boolean;
  /** 台账里勾了「过磅抓拍」的相机（04 §4：一次最多 3 台，本机与 IP 可混）：捕获瞬间逐台就地取帧回传 */
  captureCams: DeviceConfig[];
}) {
  const scale = useDeviceStore((s) => s.scale);
  const setCamera = useDeviceStore((s) => s.setCamera);
  const can = useSession((s) => s.can);
  const qc = useQueryClient();

  const [manual, setManual] = useState(false);
  const [manualTare, setManualTare] = useState<number | null>(null);
  const [manualGross, setManualGross] = useState<number | null>(null);
  const [flash, setFlash] = useState<"gross" | "tare" | null>(null);
  /** 定价 / 改价框（`PriceDialog`）：价是成交前提，磅房这一格是它最该出现的地方 */
  const [priceOpen, setPriceOpen] = useState(false);
  /** 这一捕有没有真把本机摄像头的帧带出去（onSuccess 里决定时标与「无抓拍」口径），记成功取到的台数 */
  const frameOut = useRef(0);
  /** 录入框：手录态下热键提交空值时把光标送过去，免得人对着"没录入"四个字找框 */
  const manualGrossRef = useRef<HTMLInputElement>(null);
  const manualTareRef = useRef<HTMLInputElement>(null);

  /**
   * 捕获**之前**那张单的净重，判"净重刚定"的唯一依据（理由见文件头第 2 条）。
   *
   * 不能用 `order` 这个 prop 现读：它是 `["order", 单号]` 这条查询的结果，后台重取 / 窗口
   * 聚焦重取 / 上一捕失效引发的重取，任何一个都能在"发出捕获请求"到"回执到达"这段窗口里
   * 把它换成**已含净重**的新值，判据于是静默变成 false——票不出、结算不走，而且不报错。
   * 刷卡那条路（`useIcWorkflow.advance`）在捕获前 `api.getOrder` 自取快照来比，所以没这个坑；
   * 这里照同一口径：在 `mutationFn` 里取一份，落到 ref 交给 `onSuccess`。
   */
  const priorNet = useRef<number | null>(null);

  const scaleDown = !scale.connected;
  /**
   * 手录态：本人开了那个开关，或**仪表离线**（文件头第 1 条）。离线时不再要求"先开开关、
   * 再点另一个按钮"——两个主按钮直接变成「录入…」，空格 / P 同权提交录入框里的值。
   */
  const manualMode = manual || scaleDown;
  /**
   * 去结算这个按钮的那道闸：判定与话术复用 `settle-gate.ts`（与扫票、`/scan-settle` 同一份），
   * 本面板只负责把它渲染成一次点击。`bill` 传 null，与工作台扫票那条路同口径。
   */
  const settleGate = order ? settleGateOf(order, null, can("settle.create") || can("settle.credit"), allowCredit) : null;

  /** 待捕项：缺哪项就优先提示哪项，两项都有则为复称 */
  const next: "gross" | "tare" | null = !order
    ? null
    : order.gross_weight_01kg == null
      ? "gross"
      : order.tare_weight_01kg == null
        ? "tare"
        : null;

  /**
   * 换单即清空录入框。残值留在框里，下一单点一下「录入…」就把上一单的读数记进了这一单
   * ——手录最贵的事故就是这个，而且事后只在轨迹里看得出（那一行标着"手录"）。
   */
  useEffect(() => {
    setManualGross(null);
    setManualTare(null);
  }, [order?.order_no]);

  const capture = useMutation({
    mutationFn: async (args: Pending & { weigh_type: "gross" | "tare"; warning?: string | null }) => {
      const no = order!.order_no;
      // 本机摄像头：先就地取帧再提交——面板画面流常开时只是 snap 一帧（毫秒级）；面板被
      // 收起时冷开也各封顶 2.5 s（开流+等帧，与 IP 机"事务外等 3 s 抓图"同量级），取不到就按无抓拍提交。
      // 一次最多 3 台，逐台各取一帧（grabCaptureFrames 只处理本机 USB 相机，IP 机由服务端抓图）。
      //
      // 取帧与"捕获前快照"并发：快照是判"净重刚定"的唯一依据（见 `priorNet`），两者互不依赖，
      // 串起来只是白等一个来回。快照取不到就退回 prop 上的值——宁可漏推进一次，也不能在
      // 复称时凭空气泡出一张码单。
      const [before, frames] = await Promise.all([
        api.getOrder(no).catch(() => null),
        grabCaptureFrames(captureCams),
      ]);
      frameOut.current = frames.length;
      priorNet.current = before ? before.net_weight_01kg : (order?.net_weight_01kg ?? null);
      return api.capture({
        order_no: no,
        weigh_type: args.weigh_type,
        weight_01kg: args.weight_01kg,
        source: args.source,
        operator_id: actorId(),
        raw_frame:
          args.source === "scale"
            ? // 真机流的原帧是迎检时唯一能对回仪表报文的证据；只有模拟流才用合成句占位
              (scale.rawFrame ?? `=W${(args.weight_01kg / 10).toFixed(1)}kg ST`)
            : undefined,
        // 台账在线的 IP 机值得服务端去抓（即便本机一台没取到帧）；本机取到帧也照样想落
        has_photo: anyCamOnline,
        frames,
        tare_warning: args.warning ?? null,
      });
    },
    onSuccess: (o, args) => {
      if (!o) {
        toast.error("捕获失败：磅单不存在或已被他人修改");
        announce("捕获失败，这张单可能已经被改过", `ic-capture:${order?.order_no ?? "-"}`);
        return;
      }
      // 抓拍时间给下游用 dateTime 按字面切分展示，存 UTC 串会让时标少 8 小时
      if (anyCamOnline || frameOut.current > 0) setCamera({ lastCaptureAt: nowLocalISO() });
      setFlash(args.weigh_type);
      window.setTimeout(() => setFlash(null), 700);
      const manualTag = args.source === "manual" ? "（手录）" : "";
      // 超容差不拦这次捕获：以服务端复核结果为准给警告，警示文案同时已记在磅单上（醒目条/票面/审计）。
      // 只判皮重那一捕——毛重/复称时单上可能挂着更早留下的警示，别拿旧文案冒充这次的结论
      if (args.weigh_type === "tare" && o.tare_override_reason) {
        toast.warning(`皮重 ${weight(args.weight_01kg)} 已捕获${manualTag}：偏差超出容差，已在磅单醒目提醒`, {
          description: o.tare_override_reason,
        });
        announce("皮重偏差超出容差，请核对车上有没有留人", `ic-tare-tol:${o.order_no}`);
      } else {
        toast.success(`${args.weigh_type === "gross" ? "毛重" : "皮重"} ${weight(args.weight_01kg)} 已捕获${manualTag}`);
        // 去重键与后台刷卡那条路共用一套（useIcWorkflow 里同名单号），同一笔重量只念一次
        announce(
          args.weigh_type === "gross" ? "毛重已捕获，请卸货后再来一次" : "皮重已捕获，可以下磅了",
          `ic-weight:${o.order_no}:${args.weigh_type}`,
        );
      }
      // 手录那条：落库成功即清空录入框。不清的后果很具体——空格提交的是"待捕那一项"，
      // 皮重捕完框里还留着刚才那个数，下一车按一下就把上一车的读数当皮重记进去了。
      if (args.source === "manual") {
        if (args.weigh_type === "gross") setManualGross(null);
        else setManualTare(null);
      }
      // 这一捕把净重凑齐了（判据是捕获**前后**的对比，不是这一捕的类型）：
      // 复称与"已经在过磅的单"再按一次空格都不会再把它推进一遍。
      // 捕获前那一份取 `priorNet`（本面板自己在捕获前取的快照），**不取 `order`**——
      // 那个 prop 随时可能被并发重取覆盖成已含净重的新值，判据会静默变 false，
      // 这一捕就既不出码单也不走结算（见 `priorNet` 与文件头第 2 条）。
      if (priorNet.current == null && o.net_weight_01kg != null && o.settled_at == null) {
        onNetDetermined?.(o);
      }
      qc.invalidateQueries({ queryKey: ["order", o.order_no] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["open-orders"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["party", o.party_id] });
    },
    // Rust 闸门回的是人话（"本单当前为 settled，不能再称重"），吞掉就没法排障了
    onError: (e: Error) => {
      toast.error(`捕获失败：${e.message || "请重试；读数未丢，仪表仍在推送"}`);
      // 服务端原因带状态码与单号，念出来没人听得懂，只念结论与下一步
      announce("捕获失败，读数没有丢，再捕一次", `ic-catch:${order?.order_no ?? "-"}`);
    },
  });

  /**
   * 这一捕被价闸拦下时该说的话（02 §F1.4）。
   *
   * 判定与文案在 `lib/weigh-gate.ts`（刷卡那条路调同一份），这里只管"怎么把人送到填价的地方"：
   * 屏上留一句、喇叭出同一声，能定价的人**直接把定价框开在他面前**——这一捕是明确的操作意图，
   * 回他一个空档不如回他一个填价的地方。没定价权的岗位（化验员 / 出纳路过这台机）只提示：
   * 称重区那行红字已经说清"该找磅员或站长"，开一个他存不进去的框只会更乱。
   */
  function blockOnPrice(message: string) {
    toast.warning(message, { id: `ws-price-required:${order?.order_no ?? "-"}` });
    announce("这一单还没有单价，请先填好单价再捕毛重", `ws-price-required:${order?.order_no ?? "-"}`);
    if (can("price.override")) setPriceOpen(true);
  }

  function submit(type: "gross" | "tare", value01kg: number, source: "scale" | "manual") {
    if (!order) {
      toast.error("尚未制单，无法捕获读数");
      announce("还没有制单，先点制单再称重", "w-noorder");
      return;
    }
    if (!can("weigh.capture")) {
      toast.error("当前岗位无权捕获读数，需磅员或站长");
      announce("当前岗位不能称重，请换磅员或站长登录", "w-noperm");
      return;
    }
    if (source === "manual" && !can("weigh.manual")) {
      toast.error("手录重量需磅员或站长岗位");
      announce("手录重量需要磅员或站长岗位", "w-nomanual");
      return;
    }
    // 价是成交前提：毛重那一捕之前单上必须有价（02 §F1.4）。排在读数、容差两道闸之前——
    // 缺价是"这一单还不该收粮"，不是"这一次读数不合法"，先说前面那件事。
    const priceMsg = priceGateOf(order, type);
    if (priceMsg) {
      blockOnPrice(priceMsg);
      return;
    }
    if (value01kg <= 0) {
      toast.error("读数必须大于 0");
      announce("读数是零，这一笔不记账", `ic-zero:${order.order_no}`);
      return;
    }
    // 皮重容差（05 §4 ②）：超差只附上警示文案照常捕获，不再拦下要授权；判定以服务端复算为准
    if (type === "tare" && mean01kg != null && tolerancePct > 0) {
      const tol = Math.round((mean01kg * tolerancePct) / 100);
      const diff = value01kg - mean01kg;
      if (Math.abs(diff) > tol) {
        capture.mutate({
          weigh_type: type,
          weight_01kg: value01kg,
          source,
          warning: `偏差 ${diff > 0 ? "+" : "-"}${weight(Math.abs(diff), false)} kg（容差 ±${tolerancePct}%）`,
        });
        return;
      }
    }
    capture.mutate({ weigh_type: type, weight_01kg: value01kg, source });
  }

  /** 手录态下这个待捕项该用的读数；null = 还没录入 */
  function manualReading(type: "gross" | "tare"): number | null {
    return type === "gross" ? manualGross : manualTare;
  }

  function captureLive(type: "gross" | "tare") {
    // 手录态（本人开的开关，或仪表离线）：按钮与热键一律提交**录入框里的值**——这是
    // "离线时不必先开开关、再点另一个按钮"的兑现，也是与刷卡"一次动作落一条读数"对齐。
    // 空值不静默吞掉：提示 + 把光标送进那个框，操作员正拿着键盘，不该再让他去摸鼠标。
    if (manualMode) {
      const v = manualReading(type);
      if (v == null) {
        toast.warning(`请先录入${type === "gross" ? "毛重" : "皮重"}读数`);
        announce("还没录入读数，先录一个数", `w-manual-empty:${order?.order_no ?? "-"}`);
        (type === "gross" ? manualGrossRef : manualTareRef).current?.focus();
        return;
      }
      submit(type, v, "manual");
      return;
    }
    if (!scale.connected) {
      toast.error(scale.error ? `仪表离线：${scale.error}` : "仪表离线，请改用手工录入");
      announce("仪表离线，这一笔没记上，请改手录", `ic-scale:${order?.order_no ?? "-"}`);
      return;
    }
    if (!scale.stable) {
      toast.warning("读数未稳定，请等车辆停稳后再捕获");
      announce("读数还没稳定，等车停稳再捕", `ic-scale:${order?.order_no ?? "-"}`);
      return;
    }
    submit(type, scale.weight01kg, "scale");
  }

  /**
   * 把这一单送去结算（等价于刷卡站点的第③刷）。
   *
   * 闸门走 `settle-gate.ts` 那一份判定，话术也照抄扫票那条路：能进就进框，进不去就把
   * "为什么不行、该上哪儿去"当场说清楚——只回一句"不能结算"等于把人扔在窗口。
   * 这里不置灰按钮：磅房是触摸屏与键盘混用，灰掉的按钮说不出原因，点了会说话才留得住人。
   */
  function goSettle() {
    if (!order) return;
    if (settleGate) {
      const msg = `${settleGate.title}：${settleGate.body}`;
      if (settleGate.tone === "danger") toast.error(msg, { id: `w-settle-gate:${order.order_no}` });
      else if (settleGate.tone === "warning") toast.warning(msg, { id: `w-settle-gate:${order.order_no}` });
      else toast.info(msg, { id: `w-settle-gate:${order.order_no}` });
      announce(settleGate.title, `w-settle-gate:${order.order_no}`);
      return;
    }
    onRequestSettle?.(order.order_no);
  }

  // 空格捕当前待捕项；P 捕皮重（05 §5）
  useHotkey(" ", () => captureLive(next ?? "gross"), { enabled: !!order });
  useHotkey("p", () => captureLive("tare"), { enabled: !!order });

  const records = order?.records ?? [];
  const lastRecord = records[records.length - 1];

  return (
    <Card size="sm" className="min-w-0 py-0 gap-0">
      <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center border-b px-2.5">
        <CardTitle className="text-xs font-semibold">称重区</CardTitle>
        <CardAction className="flex items-center gap-1.5 self-center text-xs text-muted-foreground">
          分度 {weight(scaleDivision01kg, false)} · {scalePort}
          {!anyCamOnline && <ToneBadge tone="danger">无抓拍</ToneBadge>}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 p-2">
        <div
          className={cn(
            "flex flex-col sm:flex-row items-stretch justify-between gap-2 border bg-muted/20 p-2 transition-colors",
            flash && "border-success bg-success-bg",
            !scale.connected && "bg-muted/50",
          )}
        >
          {/* 左侧：地磅实时读数 */}
          <div className="flex min-w-0 flex-1 flex-col justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">地磅实时读数</span>
            <WeightDisplay
              value01kg={scale.connected ? scale.weight01kg : null}
              stable={scale.stable}
              connected={scale.connected}
              size="lg"
            />
          </div>

          {/* 右侧：本单已取重量明细 + 捕获操作（填掉读数右边的空白） */}
          <div className="flex shrink-0 min-w-[220px] flex-col justify-center gap-1.5 border-t sm:border-l sm:border-t-0 pt-1.5 sm:pt-0 sm:pl-2.5">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground border-b pb-0.5">本单实测重量</span>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">毛重</span>
                <span className="tnum font-semibold text-foreground">
                  {order?.gross_weight_01kg != null ? weight(order.gross_weight_01kg) : "待捕获"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">皮重</span>
                <span className="tnum font-semibold text-foreground">
                  {order?.tare_weight_01kg != null ? weight(order.tare_weight_01kg) : "待捕获"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs border-t pt-0.5">
                <span className="font-semibold text-foreground">净重</span>
                <span className="tnum font-bold text-primary text-sm">
                  {order?.net_weight_01kg != null ? weight(order.net_weight_01kg) : "—"}
                </span>
              </div>
              {/*
                单价摆在"本单实测"这一块里：农户到站问的第二句就是价，磅员得在同一处能看见、能改。
                缺价标红——只有制单时该品种没有现行价目才会走到这一步（有现行价目的单制单就带上了），
                而**捕毛重之前这一格必须有价**（`lib/weigh-gate.ts` 那道闸），所以它不是提醒，是前置条件。
              */}
              <div className="flex items-center justify-between gap-2 text-xs border-t pt-0.5">
                <span className="text-muted-foreground">单价</span>
                {order?.price_fen_per_ton != null ? (
                  <span className="tnum font-semibold text-foreground">{fmtPrice(order.price_fen_per_ton)}</span>
                ) : (
                  <span className="font-semibold text-destructive">未定价</span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                size="default"
                variant={next === "gross" ? "default" : "outline"}
                onClick={() => captureLive("gross")}
                disabled={!order || capture.isPending || (!manualMode && (!scale.connected || !scale.stable))}
                className="h-8 text-xs"
              >
                {manualMode ? "录入毛重" : "捕获毛重"}
                <kbd className="ml-1 text-[10px] opacity-70">空格</kbd>
              </Button>
              <Button
                size="default"
                variant={next === "tare" ? "default" : "outline"}
                onClick={() => captureLive("tare")}
                disabled={!order || capture.isPending || (!manualMode && (!scale.connected || !scale.stable))}
                className="h-8 text-xs"
              >
                {manualMode ? "录入皮重" : "捕获皮重"}
                <kbd className="ml-1 text-[10px] opacity-70">P</kbd>
              </Button>
            </div>
            {/*
              定价 / 改价：价是成交的前提，把入口放在刚才那个"单价"行的正下方、且排在「去结算」之前
              ——先谈价后卸货，磅房这一格的顺序就该是它。权限走 `price.override`（磅员 / 站长），
              没有这权限的人照样看得见上面的单价，只是改不了。
            */}
            {can("price.override") && (
              <Button
                size="default"
                variant="outline"
                onClick={() => setPriceOpen(true)}
                disabled={!order || capture.isPending}
                className={cn(
                  "h-8 col-span-2 text-xs",
                  order && order.price_fen_per_ton == null && "border-warning bg-warning-bg text-warning",
                )}
              >
                <TagIcon className="size-3.5" />
                {order?.price_fen_per_ton == null ? "先定价（本单还没价）" : "定价 / 改价"}
              </Button>
            )}
            {/*
              往下走的那一步。刷卡推进的站点由第③刷自然唤起结算框，**没卡的站点没有第三刷**
              ——少了这个入口，磅房过完磅就再也走不到钱那一步（06 §4.4 C1）。净重齐了才高亮。
            */}
            {onRequestSettle && (
              <Button
                size="default"
                variant={order && next == null && !settleGate ? "default" : "outline"}
                onClick={goSettle}
                disabled={!order || capture.isPending}
                className="h-8 text-xs"
              >
                <HandCoinsIcon className="size-3.5" />
                去结算（本单）
              </Button>
            )}
          </div>
        </div>
        {!order && <p className="text-xs text-warning">尚未制单，取号后才能捕获重量。</p>}
        {order && !scale.connected && (
          <p className="text-xs text-destructive">
            仪表离线{scale.error ? `：${scale.error}` : ""}。下方录入框已自动打开，直接录入读数即可（两个按钮也已切成「录入…」，空格 / P 同权提交）。本单将永久标记为「手录」，事后由站长在审计日志里逐条核对。
          </p>
        )}
        {order && scale.connected && !manualMode && !scale.stable && (
          <p className="text-xs text-warning">读数未稳定（窗口内波动超容差），捕获按钮已锁定。</p>
        )}
        {/*
          价闸的说明（02 §F1.4）：毛重那一捕之前单上必须有价——票面要给客户一个价，库里的账也要
          有个凭据。只在"毛重还没捕"的时候说这句话：捕过毛重的单不该再被它拦住（价已经在这条路上了），
          而皮重那一捕本来就不设这道闸。
        */}
        {order && order.price_fen_per_ton == null && order.gross_weight_01kg == null && (
          <p className="text-xs text-destructive">
            本单还没有单价：
            {can("price.override")
              ? "捕毛重前必须先定价——点上面的「先定价（本单还没价）」把价填好，再刷卡或点捕获。"
              : "捕毛重前必须由磅员或站长先定价，本岗位改不了这一格。"}
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <Label className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5">
              <PenLineIcon className="size-3.5" />
              手工录入读数（仪表故障应急）
            </span>
            {/*
              仪表离线时这个开关不该还能拨：那时手录已经是唯一的路，拨到"关"等于让人以为自己
              关掉了唯一能用的通道。`checked` 直接反映实际模式，离线时置灰并靠上面那段话说清楚。
            */}
            <Switch checked={manualMode} disabled={scaleDown} onCheckedChange={(v) => setManual(v === true)} size="sm" />
          </Label>
          {manualMode && (
            <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-1.5 border bg-muted/20 p-2">
              <NumField
                id="ws-manual-gross"
                inputRef={manualGrossRef}
                label="毛重"
                text={manualGross == null ? "" : String(toKg(manualGross))}
                onText={(t) => setManualGross(t.trim() === "" ? null : fromKg(t))}
                // 回车即提交这一项：与刷卡"一次动作落一条读数"同感，省掉"输入→挪手去点按钮"那一步
                onKeyDown={(e) => {
                  if (e.key === "Enter") captureLive("gross");
                }}
                unit="kg"
                decimals={1}
              />
              <NumField
                id="ws-manual-tare"
                inputRef={manualTareRef}
                label="皮重"
                text={manualTare == null ? "" : String(toKg(manualTare))}
                onText={(t) => setManualTare(t.trim() === "" ? null : fromKg(t))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") captureLive("tare");
                }}
                unit="kg"
                decimals={1}
              />
              <div className="flex gap-1">
                {/* 走 `captureLive` 而不是直接 `submit`：空值时那条提示 + 把光标送进框只有一份 */}
                <Button size="sm" variant="outline" disabled={capture.isPending} onClick={() => captureLive("gross")}>
                  录毛重
                </Button>
                <Button size="sm" variant="outline" disabled={capture.isPending} onClick={() => captureLive("tare")}>
                  录皮重
                </Button>
              </div>
              <p className="col-span-3 text-[11px] text-warning">
                手录会在磅单上永久标记，事后由站长在审计日志里逐条核对；仪表恢复后请与仪表小票核对一遍。
              </p>
            </div>
          )}
        </div>

        {records.length > 0 && (
          <p className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground">
            <span>
              称重轨迹 {records.length} 次
              {records.some((r) => r.source === "manual") && <span className="text-warning">（含手录）</span>}
            </span>
            <span className="tnum">
              最近 {lastRecord.weigh_type === "gross" ? "毛重" : "皮重"} {weight(lastRecord.weight_01kg)} ·{" "}
              {dateTime(lastRecord.captured_at).slice(5)}
              {lastRecord.source === "scale" ? " 地磅" : " 手录"}
            </span>
          </p>
        )}

        {order?.tare_override_reason && (
          <div className="border border-warning bg-warning-bg p-1.5 text-xs">
            <ToneBadge tone="warning">皮重偏差超容差</ToneBadge>
            <p className="mt-0.5">
              本单已按现场读数捕获（数据有效）：{order.tare_override_reason}。请核对车辆与读数，如需更正走红冲重录；提醒已记入磅单、补打票面与审计。
            </p>
          </div>
        )}

      </CardContent>

      {/*
        定价框挂在 CardContent 末尾：它是个弹层（Portal 到 body），放哪儿渲染都一样，而贴着
        「定价 / 改价」那个按钮所在的容器收尾，能让"点按钮 → 开框"的关系一眼看得出
        （`open` 只由上面那个按钮置 true，这里只管渲染）。
      */}
      <PriceDialog
        open={priceOpen}
        onOpenChange={setPriceOpen}
        order={order}
        onSaved={() => {
          // 只报"价定了"这个结论：数字归屏幕（上面的单价行）与码单（05 §6.5 规矩①「不念单号、
          // 卡号、姓名、重量」——价同理，念出来还会盖住下一条更该听的播报）
          announce("本单单价已定", `ws-price:${order?.order_no ?? "-"}`);
        }}
      />
    </Card>
  );
}
