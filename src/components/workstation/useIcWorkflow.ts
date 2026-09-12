/**
 * 刷卡推进编排器（06 篇 §2.2 / §3 / §4）。
 *
 * 整条"读卡器 → 定位磅单 → 按单据落库状态推进一步"的判断**只收在这一个 hook 里**：
 *  ① 工作台默认起 `reader.ic.watch` 后台常听；
 *  ② 每读到一张卡先 `api.cardLocate(sn)`：空闲卡→发卡绑到最近无卡单；在途卡→按这张单缺什么推进；
 *  ③ 推进只认"此刻地磅稳定读数"，读数未稳 / 皮重超容差一律不写库、交回面板手点（06 §2.2 三条硬规矩）；
 *  ④ "一刷"的判据是**边沿**：`reader.ic.watch` 只在换卡、或天线空过一次之后再放上时才命中，
 *    卡压在感应区不动不会一轮轮重复推进（06 §4.2）；本 hook 再叠一层 `card_swipe_debounce_ms`
 *    时间窗当第二道保险（同一张卡同一待办步窗口内只算一刷）。
 *  ⑤ `card_flow_mode=off` 的站点根本不起监听，全程面板手点（06 §4.4 C1"无外设也要能完成闭环"）；
 *    这台机压根没有 IC 通道（浏览器预览 / 台账未登记启用 / 台账切成 Mock / 底栏「Mock 关」）同样不起循环。
 *    真设备只是**暂时**故障时才按 2→15 s 退避重起，插回来不必刷新页面（06 §4.2）。
 *
 * 设备互斥（06 §1.2）：一台读卡器一次只解一种介质。弹窗要读身份证 / 弹结算框时 `paused=true`，
 * 本 hook 立刻 `stopWatch` 让出设备锁；`paused` 回到 false 再恢复监听。绝不在别处再起第二条 IC 循环。
 *
 * 结算落点与扫码窗口不冲突：第三刷只把**这张单**交给 `onRequestSettle`，由页面弹复用 `SettleForm`
 * 的结算框完成收付款；`/scan-settle` 是同一条 `api.settle` 的另一个入口，两条都算同一份价。
 */
import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { WeighOrder } from "@/mock/types";
import { useDeviceStore } from "@/store/device";
import { actorId } from "@/store/session";
import { runningInTauri } from "@/lib/native";
import { useSetting } from "@/hooks/useLookups";

/** 一张单当前缺的下一步；settled/终态返回 done */
function nextStep(o: WeighOrder): "gross" | "tare" | "settle" | "done" {
  if (o.settled_at != null || o.status === "settled" || o.status === "paid" || o.status === "archived") return "done";
  if (o.gross_weight_01kg == null) return "gross";
  if (o.tare_weight_01kg == null) return "tare";
  return "settle";
}

/** 同一件事在屏幕上只占一个位置：同一张卡/同一张单连着闸门不过时更新原来那个框，不叠出一摞红框 */
const sticky = (id: string) => ({ id });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 读卡器故障后重起监听的退避：2 s 起、翻倍、封顶 15 s（06 §4.4 C1：故障期间工作台退回手点，不必死盯循环） */
const WATCH_RETRY_MIN_MS = 2_000;
const WATCH_RETRY_MAX_MS = 15_000;

export function useIcWorkflow({
  paused,
  onRequestSettle,
  onWeighed,
}: {
  /** 弹窗开着 / 结算框开着时为真，本 hook 让出设备锁不监听（`card_flow_mode=off` 在内部同样按不监听处理） */
  paused: boolean;
  /** 第三刷：把这张单交给页面的结算框（复用 SettleForm） */
  onRequestSettle: (orderNo: string) => void;
  /** 皮重捕获成功（算完净重）后回调，页面据此自动出码单 */
  onWeighed: (order: WeighOrder) => void;
}) {
  const qc = useQueryClient();
  const watch = useDeviceStore((s) => s.reader.ic.watch);
  const stopWatch = useDeviceStore((s) => s.reader.ic.stopWatch);
  const debounceMs = useSetting("card_swipe_debounce_ms").num || 1500;
  /** 该站用不用流转卡：off＝不起监听、全程面板手点（06 §4.4 C1 的退路，读卡器故障时同样靠它） */
  const flowMode = useSetting("card_flow_mode").raw ?? "auto";
  /**
   * 这台机此刻有没有 IC 通道：浏览器预览 / 台账没登记启用 / 台账切成 Mock / 底栏「Mock 关」都算**没有**。
   * 没有就别起循环，更别跟着退避重起——那是配置态不是故障，反复轮只会白刷 store。
   * 四个量都进依赖：站长登记/启用这台机、切回真机、或把外设开关打开，本 effect 自己会重挂起来听。
   */
  const icAvailable = useDeviceStore(
    (s) => runningInTauri() && !s.mockOff && s.reader.registered && !s.reader.mocked,
  );

  const running = useRef(false);
  /** 第二道保险：key = `单号:待办步` → 上次处理时刻，同键窗口内不重复推进（一刷的判据见 watch 边沿） */
  const lastFire = useRef<Map<string, number>>(new Map());
  /**
   * 页面传进来的两个回调每次渲染都是新的箭头函数。直接进 `useCallback` 依赖，
   * `handle` 就跟着每帧换身份，底下那条监听 effect 每帧 stopWatch + 重起——
   * 真机上正压着卡的那一轮 read 会被 epoch 判废、这一刷凭空丢掉。收成 ref，effect 只依赖稳定量。
   */
  const cbs = useRef({ onRequestSettle, onWeighed });
  useEffect(() => {
    cbs.current = { onRequestSettle, onWeighed };
  });

  const refresh = useCallback((orderNo: string, partyId: number) => {
    qc.invalidateQueries({ queryKey: ["order", orderNo] });
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["open-orders"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["party", partyId] });
  }, [qc]);

  /** 处理一张在途卡：按单据缺项推进一步。命中即写，闸门不过则只提示、交回手点 */
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
        return;
      }
      const step = nextStep(o);
      if (step === "done") {
        toast.info(`${o.party_name} 的单已结算，卡可收回；要继续请到卡池页退卡`, sticky(`ic-order-done:${o.order_no}`));
        return;
      }
      const key = `${o.order_no}:${step}`;
      const now = Date.now();
      const prev = lastFire.current.get(key);
      if (prev != null && now - prev < debounceMs) return; // 连击去抖：这张单这一步刚处理过
      lastFire.current.set(key, now);

      if (step === "settle") {
        cbs.current.onRequestSettle(o.order_no);
        return;
      }
      // 毛重 / 皮重都要"此刻稳定读数"，未稳这一刷作废、不缓存不凑数
      if (!scale.connected || !scale.stable) {
        toast.warning(scale.error ? `仪表离线：${scale.error}` : "读数未稳，请等车停稳再刷", sticky(`ic-scale:${o.order_no}`));
        return;
      }
      const weight01kg = scale.weight01kg;
      if (weight01kg <= 0) {
        toast.error("读数不大于 0，这一刷不记账", sticky(`ic-zero:${o.order_no}`));
        return;
      }
      // 皮重超容差不在这里拦：一刷照样捕获，服务端复算后把警示记在磅单上（成功提示后补一条警告）
      try {
        const updated = await api.capture({
          order_no: o.order_no,
          weigh_type: step,
          weight_01kg: weight01kg,
          source: "scale",
          operator_id: actorId(),
          raw_frame: scale.rawFrame ?? undefined,
          has_photo: false,
        });
        if (!updated) {
          toast.error("捕获失败：磅单不存在或已被他人修改", sticky(`ic-capture:${o.order_no}`));
          return;
        }
        toast.success(`${step === "gross" ? "毛重" : "皮重"} ${updated.order_no} 已捕获`);
        if (step === "tare" && updated.tare_override_reason) {
          toast.warning("皮重偏差超容差，本刷仍有效", {
            description: `${updated.tare_override_reason}；已在磅单醒目提醒，请核对车辆与读数`,
            id: `ic-tare-tol:${o.order_no}`,
          });
        }
        refresh(o.order_no, o.party_id);
        if (step === "tare") cbs.current.onWeighed(updated); // 皮重即净重已定 → 自动出码单
        else if (updated.settled_at == null && updated.net_weight_01kg != null) cbs.current.onRequestSettle(updated.order_no);
      } catch (e) {
        toast.error(`捕获失败：${e instanceof Error ? e.message : "请重试；读数未丢，仪表仍在推送"}`, sticky(`ic-capture:${o.order_no}`));
      }
    },
    [debounceMs, refresh],
  );

  /** 读到一张空闲卡：按 06 §4.1 把它发给最近一张无卡在途单 */
  const issueFree = useCallback(
    async (cardNo: string) => {
      try {
        const res = await api.cardIssue({ card_no: cardNo });
        toast.success(`已把卡 ${cardNo} 发给 ${res.order_no}，请交给农户`);
        qc.invalidateQueries({ queryKey: ["order", res.order_no] });
        qc.invalidateQueries({ queryKey: ["open-orders"] });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "发卡失败", sticky(`ic-issue:${cardNo}`));
      }
    },
    [qc],
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
        toast.error(`卡 ${sn} 未在卡池登记，请先到「流转卡」页登记`, sticky(`ic-unregistered:${sn}`));
        return;
      }
      if (loc.status === "retired") {
        toast.error(`卡 ${sn} 已注销，不能再用`, sticky(`ic-retired:${sn}`));
        return;
      }
      if (loc.status === "in_pool") {
        // 空闲卡 = 发卡动作；给最近无卡单
        await issueFree(sn);
        return;
      }
      // in_use：命中它挂的那张单，按缺项推进
      if (loc.order_no) await advance(loc.order_no);
      else toast.info("这张卡挂着的单已经不在途了", sticky(`ic-loose:${sn}`));
    },
    [advance, issueFree],
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
