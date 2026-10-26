/**
 * ③ 称重区（05 §4 中栏上）。
 *
 * 三条现场规则写死在这里：
 *  1. 读数不稳定不允许捕获——按钮禁用并说明原因（05 §5 要求禁用必须带文字）
 *  2. 仪表离线时毛重 / 皮重那一格本身就是录入框，手录会永久标记在磅单上，迎检必查
 *  3. 皮重与历史偏差超容差 → **不拦下这次捕获**：数据照常有效，只给一句警告，
 *     并在磅单上留醒目提醒（本面板醒目条、详情页、码单票面「皮重警示」栏、审计）
 *
 * 另有一条边界：这一捕把净重凑齐之后该干什么（出码单、自动挂账结算、还是弹结算框等人定价）
 * **不在这里决定**。本面板只把"净重刚定"这件事交给页面（`onNetDetermined`），判定与话术归
 * 页面与 `lib/settle-defaults.ts`——刷卡那条路（`useIcWorkflow`）要给出同一个结论，
 * 两处各写一份就会出现"同一次过磅、手点与刷卡走出两种结果"。
 *
 * **手录就是这一格本身，不是另开的一条应急通道**（2026-10-09 改版；05 §4 ②、§10-1「无外设也要能完成闭环」）。
 * 「毛重 / 皮重」两行按三种样子出现，用的是同一个落库动作：
 *  - **还没捕** → 行内直接就是录入框，照仪表小票敲一个数、按回车即落库（原来那块「手工录入读数」
 *    开关连同下面两个框一起撤了：现场为多一个开关多点一下，换来的只是"该填哪儿"多一处要找）；
 *  - **已经捕到地磅读数** → 退回只读，数值右边一只「修改」，点开才进编辑态；
 *  - 两种编辑态提交的都是 `source: "manual"`，服务端据此把本单 `weight_source` 标成手录，
 *    且**粘滞不回**（`orders.rs::capture`：手录过的单再捕地磅读数也仍是手录——出库单相反，
 *    那边看"当前采用的那一捕"）。所以这一格的警告只在框里有数时出现，说清改不回去。
 *
 * 手录与刷卡在三个点上**同权**：
 *  1. **入口**：主按钮与空格 / P 跟着这一格的实际走法变——框里有人敲了数就提交那个数（按钮写成
 *     「录入…」/「保存…」），框里空着且仪表离线也走手录；其余情况才捕地磅的稳定读数；
 *  2. **判据**：判"净重刚定"用的必须是**捕获前**那一份快照（`priorNet`），不能拿 `order`
 *     这个 prop 现读——它随时可能被后台重取覆盖成"已经含净重"的新值，判据会静默变 false，
 *     这一捕就既不出码单也不走结算。刷卡那条路没这个坑，因为它在捕获前自己 `api.getOrder`
 *     取一份快照来比；这里照同一口径办；
 *  3. **下一步**：净重齐了之后要能把这一单送去结算（`onRequestSettle`，等价于第③刷）。
 *     没卡的站点没有第三刷可刷，缺了这个入口，过完磅就卡在磅房走不到钱那一步。
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HandCoinsIcon, PencilIcon, TagIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { announce } from "@/lib/voice-prompt";
import { settleGateOf } from "@/lib/settle-gate";
import { priceGateOf } from "@/lib/weigh-gate";
import { tareDev01kg, tareOverTolerance } from "@/lib/tare-ref";
import type { DeviceConfig, WeighOrder } from "@/mock/types";
import { grabCaptureFrames } from "@/lib/local-camera";
import { dateTime, fromKg, nowLocalISO, price as fmtPrice, toKg, weight } from "@/lib/format";
import { useDeviceStore } from "@/store/device";
import { actorId, useSession } from "@/store/session";
import { useHotkey } from "@/hooks/useHotkey";
import { WeightDisplay } from "@/components/business/WeightDisplay";
import { InlineNumField } from "@/components/business/NumField";
import { PriceDialog } from "@/components/business/PriceDialog";
import { ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "cn";

/** 本面板里"哪一项"的取值域，毛重 / 皮重两行共用一套渲染与提交 */
type WeighType = "gross" | "tare";

const CELL_LABEL: Record<WeighType, string> = { gross: "毛重", tare: "皮重" };

interface Pending {
  weight_01kg: number;
  source: "scale" | "manual";
}

export function WeighPanel({
  order,
  mean01kg,
  tolerancePct,
  scalePort,
  anyCamOnline,
  captureCams,
  onNetDetermined,
  onRequestSettle,
}: {
  order: WeighOrder | null;
  mean01kg: number | null;
  tolerancePct: number;
  scalePort: string;
  /**
   * 这一捕把净重凑齐了（无论补上的是毛重还是皮重）——交给页面决定接下来怎么收尾。
   *
   * 为什么判"净重刚定"而不是"捕的是皮重"：一次/二次称重顺序自由（02 §F1.2），先捕皮重后捕
   * 毛重的车，凑齐净重的是**毛重**那一捕。按类型判会让这种车走不到结算那一步。
   */
  onNetDetermined?: (o: WeighOrder) => void;
  /**
   * 把当前这一单送去窗口（复用页面上第③刷那条路：定位 + 开框）。
   *
   * 为什么称重区要有这个按钮：刷卡推进的站点里"两项都齐、未结算"那一刷自然会唤起结算框
   * （`useIcWorkflow` 的 `step === "settle"`），可**没卡的站点没有第三刷可刷**——关掉流转卡
   * 或读卡器坏了的磅房，过完磅就再没有入口往下走，卡在磅房走不到钱那一步（06 §4.4 C1）。
   *
   * 开的是哪一个框由页面按单据状态定：还没算钱的开结算框，已经算过钱、钱没付完的
   * （过磅即自动挂账，回来的单多是这种）开补付框——判据在 `settle-gate.ts`，与扫票同一份。
   */
  onRequestSettle?: (orderNo: string) => void;
  /** 参与过磅抓拍的相机里有没有至少一台此刻可用（本机流能开 / IP 台账在线）——决定是否值得让服务端去等那 3 秒抓图 */
  anyCamOnline: boolean;
  /** 台账里勾了「过磅抓拍」的相机（04 §4：一次最多 3 台，本机与 IP 可混）：捕获瞬间逐台就地取帧回传 */
  captureCams: DeviceConfig[];
}) {
  const scale = useDeviceStore((s) => s.scale);
  const setCamera = useDeviceStore((s) => s.setCamera);
  const can = useSession((s) => s.can);
  const qc = useQueryClient();

  /**
   * 毛重 / 皮重那一格里正在敲的文本（公斤，**不预先换算**）。
   *
   * 存字符串而不是 0.1kg 整数：`"42."` 折成 420 再回填进框，小数点就敲不上去了——
   * 换算是提交那一步的事（`draftOf`）。
   */
  const [draft, setDraft] = useState<Record<WeighType, string>>({ gross: "", tare: "" });
  /** 已经捕到读数的那一格被人点「修改」开了口（没捕过的格子本来就是框，不需要这个标记） */
  const [editing, setEditing] = useState<Record<WeighType, boolean>>({ gross: false, tare: false });
  const [flash, setFlash] = useState<"gross" | "tare" | null>(null);
  /** 定价 / 改价框（`PriceDialog`）：价是成交前提，磅房这一格是它最该出现的地方 */
  const [priceOpen, setPriceOpen] = useState(false);
  /** 这一捕有没有真把本机摄像头的帧带出去（onSuccess 里决定时标与「无抓拍」口径），记成功取到的台数 */
  const frameOut = useRef(0);
  /** 行内录入框：热键 / 回车提交空值时把光标送过去，免得人对着"没录入"四个字找框 */
  const grossInputRef = useRef<HTMLInputElement>(null);
  const tareInputRef = useRef<HTMLInputElement>(null);

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
  /** 这个岗位录得了手录吗（`weigh.manual`＝磅员 / 站长）。录不了就没有「修改」这只按钮，那一格是死的 */
  const canManual = can("weigh.manual");

  /** 这一项此刻库里采用的读数（`null`＝还没捕过） */
  function adopted01(type: WeighType): number | null {
    return (type === "gross" ? order?.gross_weight_01kg : order?.tare_weight_01kg) ?? null;
  }

  /**
   * 这一格该不该是**录入框**：制了单、这个岗位录得了手录，且（还没捕过 → 天然是框 / 捕过了 → 要本人点「修改」）。
   *
   * 判据里没有 `scale.connected`：仪表离线时"没捕过的那一格是框"这条本来成立，"捕过的要改"仍然
   * 走「修改」——离线改一个已捕的读数同样是手录，不该因为它就悄悄把只读格变成能敲的样子。
   */
  function cellIsOpen(type: WeighType): boolean {
    if (!order || !canManual) return false;
    return adopted01(type) == null || editing[type];
  }

  /**
   * 主按钮与空格 / P 这一捕**按什么提交**：`true`＝提交这一格里敲的数（手录），`false`＝捕地磅读数。
   *
   * 两条判据，对应文件头「同权」第 1 条：
   *  - 框里有人敲了数——人的意图已经写在屏上了，按钮不该背着他去捕仪表那一头跳动的读数；
   *  - 仪表离线且这一格还空着——离线没有读数可捕，这一格就是唯一的路（从前那个"离线自动切手录态"）。
   *
   * 已捕过、没点「修改」、仪表好好连着的地磅那一格 `draft` 恒为空串，两条都不成立 → 照旧捕读数。
   */
  function submitsManual(type: WeighType): boolean {
    return draft[type].trim() !== "" || (scaleDown && adopted01(type) == null);
  }

  /** 主按钮上的动词：捕读数 / 录一个新数 / 改一个已捕获的数，三件事不该共用一个名字 */
  function cellActionLabel(type: WeighType): string {
    if (!submitsManual(type)) return `捕获${CELL_LABEL[type]}`;
    return adopted01(type) == null ? `录入${CELL_LABEL[type]}` : `保存${CELL_LABEL[type]}`;
  }
  /**
   * 去结算这个按钮的那道闸：判定与话术复用 `settle-gate.ts`（与扫票、第三刷同一份），
   * 本面板只负责把它渲染成一次点击。`bill` 传 null，与工作台扫票那条路同口径。
   *
   * 闸不放行才拦下按钮；**已结算但未付清的单在这里是放行的**——点下去由页面开补付框
   * （`PayForm`），而不是再来一遍结算。那种单是过磅即自动挂账之后的常态。
   */
  const settleGate = order ? settleGateOf(order, null, can("settle.create") || can("settle.credit")) : null;

  /** 待捕项：缺哪项就优先提示哪项，两项都有则为复称 */
  const next: "gross" | "tare" | null = !order
    ? null
    : order.gross_weight_01kg == null
      ? "gross"
      : order.tare_weight_01kg == null
        ? "tare"
        : null;

  /**
   * 换单即清空整组录入框与「修改」态。残值留在框里，下一单点一下就把上一单的读数记进了这一单
   * ——手录最贵的事故就是这个，而且事后只在轨迹里看得出（那一行标着"手录"）。
   */
  useEffect(() => {
    setDraft({ gross: "", tare: "" });
    setEditing({ gross: false, tare: false });
  }, [order?.order_no]);

  const capture = useMutation({
    mutationFn: async (args: Pending & { weigh_type: WeighType; warning?: string | null }) => {
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
        toast.warning(`皮重 ${weight(args.weight_01kg)} 已捕获${manualTag}：偏差超出容差`, {
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
      // 手录那条：落库成功即收掉这一格的录入框（残值留在框里，下一车按一下空格就把这一车的数
      // 当皮重记进去了；改过的那一格也该退回只读，让人对着"保存皮重"变回"捕获皮重"确认这一笔已落）
      if (args.source === "manual") {
        setDraft((s) => ({ ...s, [args.weigh_type]: "" }));
        setEditing((s) => ({ ...s, [args.weigh_type]: false }));
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

  function submit(type: WeighType, value01kg: number, source: "scale" | "manual") {
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
    // 皮重容差（05 §4 ②）：超差只附上警示文案照常捕获，不再拦下要授权；判定以服务端复算为准。
    // "超没超"取 `lib/tare-ref` 那一份判据——与皮重参考卡片上那个红色警示态必须是同一个数，
    // 否则卡片亮着红、磅单上却一条警示都没留（反过来也一样）。
    const tareDev = type === "tare" ? tareDev01kg(value01kg, mean01kg) : null;
    if (tareDev != null && tareOverTolerance(value01kg, mean01kg, tolerancePct)) {
      capture.mutate({
        weigh_type: type,
        weight_01kg: value01kg,
        source,
        warning: `偏差 ${tareDev > 0 ? "+" : "-"}${weight(Math.abs(tareDev), false)} kg（容差 ±${tolerancePct}%）`,
      });
      return;
    }
    capture.mutate({ weigh_type: type, weight_01kg: value01kg, source });
  }

  /** 框里那个文本 → 0.1kg 整数。空串 / 只剩一个负号＝**还没录**（`null`），不当 0 处理 */
  function draftOf(type: WeighType): number | null {
    const t = draft[type].trim();
    if (t === "" || t === "-") return null;
    return fromKg(t);
  }

  /** 框里没数却要提交：屏上说一句、喇叭出一声、把光标送进那一格（操作员正拿着键盘，不该再让他摸鼠标） */
  function nudgeEmptyCell(type: WeighType) {
    toast.warning(`请先录入${CELL_LABEL[type]}读数`);
    announce("还没录入读数，先录一个数", `w-manual-empty:${order?.order_no ?? "-"}`);
    (type === "gross" ? grossInputRef : tareInputRef).current?.focus();
  }

  /**
   * 提交这一格里敲的数（手录）。格子里按回车、点主按钮「录入… / 保存…」、按空格 / P 走的都是这里。
   *
   * 与 `captureLive` 的分工要说清：这一函数**只**认框里的数，框里空着就提示 + 送光标，
   * 绝不退回去捕地磅读数——人已经在框里按了回车，框就是他的意图，替他捕一个没见过的数是越权。
   */
  function commitCell(type: WeighType) {
    const v = draftOf(type);
    if (v == null) {
      nudgeEmptyCell(type);
      return;
    }
    submit(type, v, "manual");
  }

  /**
   * 点「修改」：把这一格已捕获的读数原样填进框里、整段选中（要改就接着敲，不必先删）。
   *
   * 光标用 `requestAnimationFrame` 等框真渲染出来再送——`setEditing` 这一帧框还不存在，
   * 当场 `focus()` 是个空操作，触摸屏上就等于"点了没反应"。
   */
  function startEditCell(type: WeighType) {
    const v = adopted01(type);
    setEditing((s) => ({ ...s, [type]: true }));
    setDraft((s) => ({ ...s, [type]: v == null ? "" : String(toKg(v)) }));
    const input = type === "gross" ? grossInputRef : tareInputRef;
    requestAnimationFrame(() => input.current?.select());
  }

  /** 取消修改 / 按 Esc：退回只读，框里那个数一个字都不落库 */
  function cancelEditCell(type: WeighType) {
    setEditing((s) => ({ ...s, [type]: false }));
    setDraft((s) => ({ ...s, [type]: "" }));
  }

  function captureLive(type: WeighType) {
    // 手录那一捕（判据见 `submitsManual`）：按钮与热键一律提交**这一格里敲的数**——这是
    // "离线时不必先开开关、再点另一个按钮"的兑现，也是与刷卡"一次动作落一条读数"对齐。
    if (submitsManual(type)) {
      commitCell(type);
      return;
    }
    if (!scale.connected) {
      toast.error(scale.error ? `仪表离线：${scale.error}` : "仪表离线，请在毛重 / 皮重那一格手工录入");
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
      <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center px-2.5">
        <CardTitle className="text-xs font-semibold">称重区</CardTitle>
        <CardAction className="flex items-center gap-1.5 self-center text-xs text-muted-foreground">
          {/*
            分度值只报后端随帧下发的那一个数（`align.division_01kg`，04 §2.3）——它与读线程
            定格面板数字、与 `weigh_record.aligned_weight_01kg` 的取整是同一份模板。从前这里读
            站点参数 `scale_division_01kg`（0032 已退役），那一枚键不驱动任何计算：站长把它改成
            5 kg，屏幕上写 5 kg、磅上判的还是 10 kg、库里存的还是 10 kg 的整数倍。
            没有真机帧（还没开流、浏览器演示、只剩手录）就**不显示这一格**：那一刻软件并不
            真的知道这台磅的分度，凭空补一个数就是又造一处假真相（设备中心同一条规矩）。
          */}
          {scale.division01kg > 0
            ? `分度 ${weight(scale.division01kg, false)} · ${scalePort}`
            : scalePort}
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
              {/*
                毛重 / 皮重这两行**本身就是手录的入口**（2026-10-09 改版，原来那块「手工录入读数」
                开关连同它下面两个框一起撤了）：没捕过的格子直接是录入框，照仪表小票敲数、按回车即落库；
                捕过地磅读数的格子退回只读，数值右边一只「修改」，点开才进编辑态。
                两种编辑态提交的都是 `source: "manual"`，服务端据此把本单永久标成手录。
              */}
              {(["gross", "tare"] as WeighType[]).map((type) => {
                const v01 = adopted01(type);
                const captured = v01 != null;
                return (
                  <div key={type} className="flex items-center justify-between gap-2 text-sm">
                    <span className="shrink-0 text-muted-foreground">{CELL_LABEL[type]}</span>
                    {cellIsOpen(type) ? (
                      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
                        <InlineNumField
                          id={`ws-cell-${type}`}
                          inputRef={type === "gross" ? grossInputRef : tareInputRef}
                          text={draft[type]}
                          onText={(t) => setDraft((s) => ({ ...s, [type]: t }))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitCell(type);
                            else if (e.key === "Escape" && captured) cancelEditCell(type);
                          }}
                          placeholder={captured ? "" : "待捕获"}
                          unit="kg"
                          size="sm"
                          className="w-[96px] shrink-0"
                        />
                        {captured && (
                          <Button
                            size="xs"
                            variant="ghost"
                            className="h-6 shrink-0 px-1 text-muted-foreground"
                            disabled={capture.isPending}
                            onClick={() => cancelEditCell(type)}
                          >
                            取消
                          </Button>
                        )}
                      </div>
                    ) : (
                      <span className="flex min-w-0 items-center justify-end gap-1">
                        <span className="tnum font-semibold text-foreground">
                          {captured ? weight(v01) : "待捕获"}
                        </span>
                        {/*
                          「修改」只给录得了手录的岗位（`weigh.manual`），与提交那一道闸同一个判据——
                          摆一只点开之后按保存会被拦下的按钮，等于骗人改一遍再告诉他改不了。
                        */}
                        {captured && canManual && (
                          <Button
                            size="xs"
                            variant="ghost"
                            className="h-5 shrink-0 gap-0.5 px-1 text-[11px] text-muted-foreground hover:text-foreground"
                            title={`修改${CELL_LABEL[type]}：改完按回车，或点下面的「保存${CELL_LABEL[type]}」`}
                            disabled={capture.isPending}
                            onClick={() => startEditCell(type)}
                          >
                            <PencilIcon className="size-3" />
                            修改
                          </Button>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
              <div className="flex items-center justify-between gap-2 text-sm border-t pt-0.5">
                <span className="font-semibold text-foreground">净重</span>
                <span className="tnum font-bold text-primary text-base">
                  {order?.net_weight_01kg != null ? weight(order.net_weight_01kg) : "—"}
                </span>
              </div>
              {/*
                单价摆在"本单实测"这一块里：农户到站问的第二句就是价，磅员得在同一处能看见、能改。
                缺价标红——只有制单时该品种没有现行价目才会走到这一步（有现行价目的单制单就带上了），
                而**捕毛重之前这一格必须有价**（`lib/weigh-gate.ts` 那道闸），所以它不是提醒，是前置条件。
              */}
              <div className="flex items-center justify-between gap-2 text-sm border-t pt-0.5">
                <span className="text-muted-foreground">单价</span>
                {order?.price_fen_per_ton != null ? (
                  <span className="tnum font-semibold text-foreground">{fmtPrice(order.price_fen_per_ton)}</span>
                ) : (
                  <span className="font-semibold text-destructive">未定价</span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {(["gross", "tare"] as WeighType[]).map((type) => (
                <Button
                  key={type}
                  size="default"
                  variant={next === type ? "default" : "outline"}
                  onClick={() => captureLive(type)}
                  // 手录那一捕不看仪表脸色——框里有人敲的数，或仪表离线只剩这一条路；
                  // 只有"捕地磅读数"才要求连着且稳定（05 §5：禁用必须带文字，原因写在格子下方那行）
                  disabled={
                    !order || capture.isPending || (!submitsManual(type) && (!scale.connected || !scale.stable))
                  }
                  className="h-8 text-xs"
                >
                  {cellActionLabel(type)}
                  <Kbd className="ml-1 opacity-70">{type === "gross" ? "空格" : "P"}</Kbd>
                </Button>
              ))}
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
            仪表离线{scale.error ? `：${scale.error}` : ""}。在「毛重 / 皮重」格里照仪表小票敲数、按回车即可。本单将永久标记为「手录」。
          </p>
        )}
        {order &&
          scale.connected &&
          !scale.stable &&
          !submitsManual("gross") &&
          !submitsManual("tare") && (
            <p className="text-xs text-warning">
              读数未稳定，捕获按钮已锁定。等车停稳再捕，或在「毛重 / 皮重」格里手工录入。
            </p>
          )}
        {/*
          手录的后果**只在框里真有数的时候说**：没捕过的那一格本来就是框，空着的时候说这句是噪音。
          措辞上的硬规矩：磅单的手录标记是**粘滞**的（`orders.rs::capture`——手录过之后再捕地磅读数，
          本单仍算手录），所以这里绝不写"仪表恢复后重捕一次即可改回地磅"。出库单可以那样改
          （那边看"当前采用的那一捕"），磅单不行，说错了等于给人留一个假出口。
        */}
        {order && canManual && (draft.gross.trim() !== "" || draft.tare.trim() !== "") && (
          <p className="text-[11px] text-warning">
            这个数按「手录」记录：本单将永久标为手录，之后重新捕获也改不回去。请与仪表小票核对一遍。
          </p>
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
              ? "捕毛重前必须先定价：点上面「先定价（本单还没价）」，再刷卡或点捕获。"
              : "捕毛重前必须由磅员或站长定价，本岗位改不了这一格。"}
          </p>
        )}

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
              本单已按现场读数捕获，数据有效：{order.tare_override_reason}。请核对车辆与读数，如需更正走红冲重录。
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
