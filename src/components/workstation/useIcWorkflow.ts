/**
 * 刷卡推进编排器（06 篇 §2.2 / §3 / §4）。
 *
 * 整条"读卡器 → 定位磅单 → 按单据落库状态推进一步"的判断**只收在这一个 hook 里**：
 *  ① 工作台默认起 `reader.ic.watch` 后台常听；
 *  ② 每读到一张卡先 `api.cardLocate(sn)`：**不在册的卡就地自动登记入库**（06 §4.1 闸门 3，
 *     不再把磅员赶去「流转卡」页点一次登记；站点参数 `card_auto_register` 关掉才退回硬拦），
 *     登记完与空闲卡同路；空闲卡→发卡绑到最近无卡单，
 *     **一张等卡的单都没有时直接把这张卡交给常驻的「身份与制单」面板就地制单**（不弹窗，
 *     制成就绑它，不让人把同一张卡再刷一遍）；在途卡→**先把工作台定位到这张卡绑的那张单**
 *     （哪怕此刻仪表离线、读数未稳，也要让面板说的是这张单），再按这张单缺什么推进；
 *  ③ 推进只认"此刻地磅稳定读数"，读数未稳 / 皮重超容差一律不写库、交回面板手点（06 §2.2 三条硬规矩）；
 *     另有一道数据闸排在它前面：**捕毛重之前磅单上必须有价**（02 §F1.4，判定在 `lib/weigh-gate.ts`），
 *     没价这一刷什么都不写，让磅员先在称重区把价填好再刷——价是成交的前提，没价就等于还没谈成；
 *  ④ "一刷"的判据是**边沿**：`reader.ic.watch` 只在换卡、或天线空过一次之后再放上时才命中，
 *    卡压在感应区不动不会一轮轮重复推进（06 §4.2）；本 hook 再叠一层 `card_swipe_debounce_ms`
 *    时间窗当第二道保险（同一张卡同一待办步窗口内只算一刷）。
 *  ⑤ `card_flow_mode=off` 的站点根本不起监听，全程面板手点（06 §4.4 C1"无外设也要能完成闭环"）；
 *    这台机压根没有 IC 通道（浏览器预览 / 台账未登记启用 / 台账切成 Mock）同样不起循环。
 *    真设备只是**暂时**故障时才按 2→15 s 退避重起，插回来不必刷新页面（06 §4.2）。
 *
 * 设备互斥（06 §1.2）：一台读卡器一次只解一种介质。弹窗要读身份证 / 弹结算框时 `paused=true`，
 * 本 hook 立刻 `stopWatch` 让出设备锁；`paused` 回到 false 再恢复监听。绝不在别处再起第二条 IC 循环。
 *
 * 结算落点与扫码窗口不冲突：第三刷只把**这张单**交给 `onRequestSettle`，由页面弹复用 `SettleForm`
 * 的结算框完成收付款；`/scan-settle` 是同一条 `api.settle` 的另一个入口，两条都算同一份价。
 *
 * ③ 那一刷之后还有一步：**这一捕把净重凑齐了**（不管补上的是毛重还是皮重），本 hook 就把单交给
 * `onNetDetermined`，由页面决定收尾——出码单，以及"磅单上已经有价就直接挂账结掉 / 没价才弹结算框"。
 * 本 hook 不掺和那条判定，手点捕获（`WeighPanel`）走的是同一个出口，两条路必须给出同一个结论。
 */
import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { autoRegisterCard, autoRegisterOn } from "@/lib/card-auto-register";
import { announce } from "@/lib/voice-prompt";
import { priceGateOf } from "@/lib/weigh-gate";
import type { DeviceConfig, WeighOrder } from "@/mock/types";
import { grabCaptureFrames } from "@/lib/local-camera";
import { useDeviceStore } from "@/store/device";
import { actorId } from "@/store/session";
import { runningInTauri } from "@/lib/native";
import { useSetting } from "@/hooks/useLookups";

/** 一张单当前缺的下一步；settled/终态返回 done */
function nextStep(o: WeighOrder): "gross" | "tare" | "settle" | "done" {
  if (o.settled_at != null || o.status === "settled" || o.status === "paid" || o.status === "archived") return "done";
  // 作废 / 拒收退粮 / 红冲：这张单已经不会再回炉过磅了，卡在农户手里只是"待收回"。
  // 不并进终态，就会被下一步当成"缺毛重"去要一次地磅读数，弹出一句误导人的"仪表离线"——
  // 明明单子早结束了，操作员却以为是自己没连上磅。（发卡/建卡侧 check_usable_for_create 早已对
  // 挂着终态单的卡就地收回，推进侧此前漏了这同一条，这里补齐同一口径。）
  if (o.status === "voided" || o.status === "rejected" || o.status === "reversed") return "done";
  if (o.gross_weight_01kg == null) return "gross";
  if (o.tare_weight_01kg == null) return "tare";
  return "settle";
}

/**
 * 同一件事在屏幕上只占一个位置：同一张卡/同一张单连着闸门不过时更新原来那个框，不叠出一摞红框。
 *
 * 下面每条 `toast.error/warning` 旁边都跟一句 `announce(...)`，且**去重键照抄同一个 `sticky(id)`**，
 * 不另立一套编号（05 §6.5 规矩③）：操作员与农户都在窗外，屏上那行红字没人回头看，闸门拦下的事
 * 必须同时从喇叭里出去。话术只说动作与结论，不念单号、卡号、姓名与重量（那些归屏幕和码单）。
 */
const sticky = (id: string) => ({ id });

/**
 * 服务端"没有可发的在途单"这句原文（Rust `cards.rs::issue` 与 mock 同名实现是同一句）。
 * 发卡前已经预检过一轮，这里是兜底：预检看的是那一瞬间，真发卡这一刻可能已被别台机抢走。
 */
const NO_PENDING_ORDER = "没有等待发卡的在途单";
const isNoPendingOrder = (e: unknown) => e instanceof Error && e.message.includes(NO_PENDING_ORDER);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 读卡器故障后重起监听的退避：2 s 起、翻倍、封顶 15 s（06 §4.4 C1：故障期间工作台退回手点，不必死盯循环） */
const WATCH_RETRY_MIN_MS = 2_000;
const WATCH_RETRY_MAX_MS = 15_000;

export function useIcWorkflow({
  paused,
  captureCams,
  anyCamOnline,
  onRequestSettle,
  onNetDetermined,
  onRequestRegister,
  onFocusOrder,
}: {
  /** 弹窗开着 / 结算框开着时为真，本 hook 让出设备锁不监听（`card_flow_mode=off` 在内部同样按不监听处理） */
  paused: boolean;
  /** 勾了「过磅抓拍」的相机（04 §4：一次最多 3 台）：本机 USB 摄像头时，刷卡通行的捕获也逐台就地取帧回传 */
  captureCams: DeviceConfig[];
  /** 这些相机里有没有至少一台此刻可用（决定要不要让服务端去等 IP 抓图那 3 秒） */
  anyCamOnline: boolean;
  /** 第三刷：把这张单交给页面的结算框（复用 SettleForm） */
  onRequestSettle: (orderNo: string) => void;
  /**
   * 这一捕把净重凑齐了（算完净重）之后回调，页面据此收尾：出码单，以及
   * "自动挂账结算 / 弹结算框"那一步（判定见 `lib/settle-defaults.ts::postWeighAction`）。
   *
   * 判据是"净重刚定"而不是"这一捕是皮重"：一次/二次称重顺序自由（02 §F1.2），先捕皮重后捕
   * 毛重的车，凑齐净重的是毛重那一捕——原先按类型判，那种车的第三刷要靠人记着去刷。
   */
  onNetDetermined: (order: WeighOrder) => void;
  /** 刷到一张空闲卡、但库里没有等发卡的在途单：把这张卡交给页面弹制单框，制成就绑这张卡 */
  onRequestRegister: (cardNo: string) => void;
  /**
   * 刷到一张在途卡：先把工作台**定位**到这张卡绑的那张单，再去推进它缺的那一步。
   * 定位与推进是两件事——仪表离线、读数未稳、这一刷落在去抖窗口里，拦下的都只是"写库"那一下，
   * 没有理由让面板继续报上一张单。操作员刷谁的卡，屏幕上就该是谁的单（06 §4.2）。
   */
  onFocusOrder: (orderNo: string) => void;
}) {
  const qc = useQueryClient();
  const watch = useDeviceStore((s) => s.reader.ic.watch);
  const stopWatch = useDeviceStore((s) => s.reader.ic.stopWatch);
  const debounceMs = useSetting("card_swipe_debounce_ms").num || 1500;
  /** 该站用不用流转卡：off＝不起监听、全程面板手点（06 §4.4 C1 的退路，读卡器故障时同样靠它） */
  const flowMode = useSetting("card_flow_mode").raw ?? "auto";
  /**
   * 该站准不准用**未登记**的卡（06 §4.1 闸门 3）：开＝刷到陌生卡当场自动登记入库再用；
   * 关＝闸门退回硬拦，提示先到「流转卡」页登记。缺省按开，与 `card_required_on_create` 同一式。
   */
  const autoRegister = autoRegisterOn(useSetting("card_auto_register").raw);
  /**
   * 这台机此刻有没有 IC 通道：浏览器预览 / 台账没登记启用 / 台账切成 Mock 都算**没有**。
   * 没有就别起循环，更别跟着退避重起——那是配置态不是故障，反复轮只会白刷 store。
   * 三个量都进依赖：站长登记/启用这台机、切回真机，本 effect 自己会重挂起来听。
   */
  const icAvailable = useDeviceStore(
    (s) => runningInTauri() && s.reader.registered && !s.reader.mocked,
  );

  const running = useRef(false);
  /** 第二道保险：key = `单号:待办步` → 上次处理时刻，同键窗口内不重复推进（一刷的判据见 watch 边沿） */
  const lastFire = useRef<Map<string, number>>(new Map());
  /**
   * 页面传进来的两个回调每次渲染都是新的箭头函数。直接进 `useCallback` 依赖，
   * `handle` 就跟着每帧换身份，底下那条监听 effect 每帧 stopWatch + 重起——
   * 真机上正压着卡的那一轮 read 会被 epoch 判废、这一刷凭空丢掉。收成 ref，effect 只依赖稳定量。
   * `captureCams`/`anyCamOnline` 同理：它们来自 devices 查询，每次刷新都是新值，只能进 ref，绝不能进依赖。
   */
  const cbs = useRef({ onRequestSettle, onNetDetermined, onRequestRegister, onFocusOrder, captureCams, anyCamOnline });
  useEffect(() => {
    cbs.current = { onRequestSettle, onNetDetermined, onRequestRegister, onFocusOrder, captureCams, anyCamOnline };
  });

  const refresh = useCallback((orderNo: string, partyId: number) => {
    qc.invalidateQueries({ queryKey: ["order", orderNo] });
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["open-orders"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["party", partyId] });
  }, [qc]);

  /** 处理一张在途卡：先把工作台定位到这张单，再按单据缺项推进一步。命中即写，闸门不过则只提示、交回手点 */
  const advance = useCallback(
    async (orderNo: string) => {
      const scale = useDeviceStore.getState().scale;
      let o: WeighOrder | null;
      try {
        o = await api.getOrder(orderNo);
      } catch {
        return;
      }
      if (!o) {
        toast.error(`卡挂的单 ${orderNo} 已不存在`, sticky(`ic-order-gone:${orderNo}`));
        announce(`这张卡的单已经没有了，请重新制单`, `ic-order-gone:${orderNo}`);
        return;
      }
      const step = nextStep(o);
      if (step === "done") {
        const doneLabel =
          o.status === "voided" ? "已作废" : o.status === "rejected" ? "已拒收退粮" : o.status === "reversed" ? "已被红冲" : "已结算";
        toast.info(`${o.party_name} 的单${doneLabel}，卡可收回；要继续请到「流转卡」页退卡`, sticky(`ic-order-done:${o.order_no}`));
        announce("这张单已经不能继续了，把卡收回来", `ic-order-done:${o.order_no}`);
        return;
      }
      /**
       * 定位在推进之前、且在仪表与去抖两道闸门之前：这张卡挂的是哪张单，屏幕上就说哪张单。
       * 仪表离线/读数未稳/连击去抖拦下的都只是"这一刷写不写库"，不是"工作台该显示谁"——先前那一步
       * 先撞闸门就 return，面板还停在上一张单上，操作员看着别人的单核对这次的读数，比多刷一次危险得多。
       * 页面侧只在单号真的变了时才导航，所以这一句重复刷同一张卡不会产生多余的history。
       */
      cbs.current.onFocusOrder(o.order_no);

      const key = `${o.order_no}:${step}`;
      const now = Date.now();
      const prev = lastFire.current.get(key);
      if (prev != null && now - prev < debounceMs) return; // 连击去抖：这张单这一步刚处理过
      lastFire.current.set(key, now);

      if (step === "settle") {
        // 不在这儿插话：第三刷就是把这张单交给结算框，接下来由结算框自己念它自己的话
        cbs.current.onRequestSettle(o.order_no);
        return;
      }
      /**
       * 价闸（02 §F1.4）：毛重那一捕之前磅单上必须有价。判定与文案在 `lib/weigh-gate.ts`——
       * 手点 / 手录那条路（`WeighPanel.submit`）调的是同一份，否则同一张单会因"是刷的还是点的"
       * 走出两种结果。这一刷什么都不写：让磅员先在称重区把价填好，再把卡刷一次
       * （服务端 `capture` 与 mock 另有同一句话的硬闸兜底，这里只是把话说在现场）。
       *
       * 排在仪表两道闸之前：缺价是"这一单还不该收粮"，仪表离线只是"这一下读不到数"，
       * 前者的处置（填价）比后者的处置（等仪表）更要紧，先说要紧的。
       */
      const priceMsg = priceGateOf(o, step);
      if (priceMsg) {
        toast.warning(priceMsg, sticky(`ic-price-required:${o.order_no}`));
        announce("这一单还没有单价，请先填好单价再刷一次卡", `ic-price-required:${o.order_no}`);
        return;
      }
      // 毛重 / 皮重都要"此刻稳定读数"，未稳这一刷作废、不缓存不凑数
      if (!scale.connected || !scale.stable) {
        toast.warning(scale.error ? `仪表离线：${scale.error}` : "读数未稳，请等车停稳再刷", sticky(`ic-scale:${o.order_no}`));
        announce(
          scale.error ? "仪表离线，这一刷没有记上" : "读数还没稳定，等车停稳再刷一次",
          `ic-scale:${o.order_no}`,
        );
        return;
      }
      const weight01kg = scale.weight01kg;
      if (weight01kg <= 0) {
        toast.error("读数不大于 0，这一刷不记账", sticky(`ic-zero:${o.order_no}`));
        announce("读数是零，这一刷不记账", `ic-zero:${o.order_no}`);
        return;
      }
      // 皮重超容差不在这里拦：一刷照样捕获，服务端复算后把警示记在磅单上（成功提示后补一条警告）
      try {
        // 与手点那条路同一口径：逐台就地取本机帧（IP 机的抓图仍在服务端，按 anyCamOnline 放行）
        const frames = await grabCaptureFrames(cbs.current.captureCams);
        const updated = await api.capture({
          order_no: o.order_no,
          weigh_type: step,
          weight_01kg: weight01kg,
          source: "scale",
          operator_id: actorId(),
          raw_frame: scale.rawFrame ?? undefined,
          has_photo: cbs.current.anyCamOnline,
          frames,
        });
        if (!updated) {
          toast.error("捕获失败：磅单不存在或已被他人修改", sticky(`ic-capture:${o.order_no}`));
          announce("捕获失败，这张单可能已经被改过", `ic-capture:${o.order_no}`);
          return;
        }
        toast.success(`${step === "gross" ? "毛重" : "皮重"} ${updated.order_no} 已捕获`);
        // 落库这一下是最该听到的一声：车马上要下磅，操作员不需要回头确认屏幕上那行绿字
        announce(step === "gross" ? "毛重已捕获，请卸货后再来一次" : "皮重已捕获，可以下磅了", `ic-weight:${key}`);
        if (step === "tare" && updated.tare_override_reason) {
          toast.warning("皮重偏差超容差，本刷仍有效", {
            description: `${updated.tare_override_reason}；已在磅单醒目提醒，请核对车辆与读数`,
            id: `ic-tare-tol:${o.order_no}`,
          });
          announce("皮重偏差超出容差，请核对车上有没有留人", `ic-tare-tol:${o.order_no}`);
        }
        refresh(o.order_no, o.party_id);
        /**
         * 这一捕把净重凑齐了就交给页面收尾（出码单 + 自动挂账结算 / 弹结算框）。
         * 毛重补齐最后一笔与皮重补齐最后一笔同权——`step` 是"缺哪项"，**不是**"这一捕的意义"。
         * `o` 是捕获前取的那份，拿它比才知道净重是"刚定"还是"本来就有"：复称、补捕、
         * 已经结算过的单都不该再被推进一遍。
         */
        if (o.net_weight_01kg == null && updated.net_weight_01kg != null && updated.settled_at == null) {
          cbs.current.onNetDetermined(updated);
        }
      } catch (e) {
        toast.error(`捕获失败：${e instanceof Error ? e.message : "请重试；读数未丢，仪表仍在推送"}`, sticky(`ic-capture:${o.order_no}`));
        announce("捕获失败，读数没有丢，再刷一次", `ic-catch:${o.order_no}`);
      }
    },
    [debounceMs, refresh],
  );

  /**
   * 没有可发的单：把这张卡交给常驻的「身份与制单」面板就地制单（不再弹制单框，减少弹窗次数）。
   * 卡已经贴在感应区上、人已经站在窗口前，此时回一句"请先点制单"等于让人把同一张卡再刷一遍；
   * 面板经 `presetCardNo` 收到这张卡后，选好售粮人点「取号并制单」即随单绑上，不必再刷第二次。
   */
  const openRegister = useCallback((cardNo: string) => {
    cbs.current.onRequestRegister(cardNo);
    toast.warning("当前没有等待发卡的在途单：已把这张卡贴到「身份与制单」，选好售粮人点取号即随单绑上", sticky(`ic-need-order:${cardNo}`));
    announce("当前卡未使用，请在制单面板选人取号", `ic-need-order:${cardNo}`);
  }, []);

  /** 读到一张空闲卡：按 06 §4.1 把它发给最近一张无卡在途单；一张都没有就直接请人制单 */
  const issueFree = useCallback(
    async (cardNo: string) => {
      /**
       * 先问清"有没有等卡的单"，有才发。
       * 不问就发会撞上服务端那句"请先点制单"的报错——那句话该由机器变成动作（弹窗），不该由人去读。
       */
      let open: WeighOrder[] | null = null;
      try {
        open = await api.openOrders();
      } catch {
        open = null; // 读不出来不猜，交给下面 cardIssue，由服务端给准话
      }
      if (open && !open.some((o) => !o.card_no)) {
        openRegister(cardNo);
        return;
      }
      try {
        const res = await api.cardIssue({ card_no: cardNo });
        toast.success(`已把卡 ${cardNo} 发给 ${res.order_no}，请交给农户`);
        announce("卡已经发出，请把卡交给农户", `ic-issued:${cardNo}`);
        qc.invalidateQueries({ queryKey: ["order", res.order_no] });
        qc.invalidateQueries({ queryKey: ["open-orders"] });
      } catch (e) {
        // 预检过了仍撞上"没有在途单"：多半是这一瞬间被别台机抢走，同样直接把制单框给人
        if (isNoPendingOrder(e)) {
          openRegister(cardNo);
          return;
        }
        toast.error(e instanceof Error ? e.message : "发卡失败", sticky(`ic-issue:${cardNo}`));
        // 服务端回的原因带单号、带条款，念出来没人听得懂，只念结论：这一步没成
        announce("这张卡发不出去，请到工作台上手点制单", `ic-issue:${cardNo}`);
      }
    },
    [qc, openRegister],
  );

  const handle = useCallback(
    async (sn: string) => {
      // 闸门 2（06 §4.1）：寻卡成功但没拿到卡号＝读卡降级，不是"外来卡"，别拿"未登记"冤枉操作员
      if (!sn.trim()) return;
      let loc;
      try {
        loc = await api.cardLocate(sn);
      } catch {
        return;
      }
      if (!loc.found) {
        /**
         * 站点关掉「允许使用未登记的流转卡」＝闸门 3 退回硬拦：这一刷到此为止，请人去卡池页登记。
         * 默认（开着）才走下面那条就地补登记的路，不让磅员为一张新卡切两屏、再刷第二遍。
         */
        if (!autoRegister) {
          toast.error(`卡 ${sn} 未在卡池登记，请先到「流转卡」页登记`, sticky(`ic-unregistered:${sn}`));
          announce("这张卡没有登记过，换一张卡", `ic-unregistered:${sn}`);
          return;
        }
        /**
         * 未登记不再是"这一刷到此为止、你去「流转卡」页点一次登记再回来重刷"（06 §4.1 闸门 3）：
         * 卡已经贴在感应区上，就地走 `card_pool_register` 入池留痕，然后与一张普通空闲卡走同一条分支。
         * 登记不上（岗位无权 / 没解锁 / 库锁）才拦下这一刷——原因写在屏上，也必须出声。
         */
        const reg = await autoRegisterCard(qc, sn, "发卡");
        if (!reg.ok) {
          toast.error(`卡 ${sn} 自动登记失败：${reg.reason}；请换一张卡或到「流转卡」页登记`, sticky(`ic-unregistered:${sn}`));
          announce("这张卡登记不上，换一张卡", `ic-unregistered:${sn}`);
          return;
        }
        // 成功不再另念一句：紧接着发卡/交给制单面板那一路自己会说话，抢着念反而听不清结论
        await issueFree(sn);
        return;
      }
      if (loc.status === "retired") {
        toast.error(`卡 ${sn} 已注销，不能再用`, sticky(`ic-retired:${sn}`));
        announce("这张卡已经注销了，换一张卡", `ic-retired:${sn}`);
        return;
      }
      if (loc.status === "in_pool") {
        // 空闲卡 = 发卡动作；给最近无卡单
        await issueFree(sn);
        return;
      }
      // in_use：命中它挂的那张单，按缺项推进
      if (loc.order_no) await advance(loc.order_no);
      else {
        toast.info("这张卡挂着的单已经不在途了", sticky(`ic-loose:${sn}`));
        announce("这张卡挂的单已经做完了，把卡收回来", `ic-loose:${sn}`);
      }
    },
    [advance, issueFree, qc, autoRegister],
  );

  // 单一循环监听：该听时拉起 watch，命中一张卡就 handle，然后接着听下一张。
  useEffect(() => {
    // 弹窗让位 / off 站点 / 这台机压根没有 IC 通道：一条循环都不起，已经起来的也要立刻交还设备锁
    if (paused || flowMode === "off" || !icAvailable) {
      stopWatch();
      return;
    }
    if (running.current) return;
    running.current = true;
    let alive = true;
    let retryMs = WATCH_RETRY_MIN_MS;
    (async () => {
      while (alive) {
        const hit = await watch();
        if (!alive) break;
        if (!hit) {
          // 空手回来只有两种可能：被 stopWatch 打断（paused / off 变了，本 effect 会重挂），
          // 或设备级故障。故障不能让循环就此死掉——读卡器重启、USB 重新枚举之后必须自己缓过来，
          // 不该要操作员刷新页面；但也不能一轮轮去抢这把单实例设备锁，退避到最长 15 s。
          await sleep(retryMs);
          retryMs = Math.min(retryMs * 2, WATCH_RETRY_MAX_MS);
          continue;
        }
        retryMs = WATCH_RETRY_MIN_MS;
        await handle(hit.sn);
      }
      running.current = false;
    })();
    return () => {
      alive = false;
      running.current = false;
      stopWatch();
    };
  }, [paused, flowMode, icAvailable, watch, stopWatch, handle]);
}
