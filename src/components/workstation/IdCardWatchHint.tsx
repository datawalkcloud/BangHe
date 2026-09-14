/**
 * 「正在听身份证」的行内监听块（06 §4.0 两刷一条流：IC 卡就位后不用人再点一次读卡）。
 *
 * 为什么不做成弹窗：这一块的宿主是工作台左栏「身份与制单」，格子高度只有 `h:8`
 * （`lib/layout.ts`），弹框会把整屏的过磅节奏盖住——人正要把身份证往感应区放，
 * 却先要找一个"取消"按钮去关掉一个模态框。所以这里只占**一行**：
 * 一个脉动的感应符号 + 一句在听什么 + 剩余秒数 + 一个「取消」，读完即换人、超时即收工。
 *
 * 职责边界刻意切得很窄，避免和面板抢同一台读卡器：
 *  - 本组件**只管这一轮监听的生命周期**：挂载即 `idcard.watch({photo:true})`，
 *    卸载/取消/超时/设备故障即 `stopWatch()`；
 *  - **读到的那张证怎么变成售粮人**，仍然由 `IdentityPanel` 里那一个 `lastCard` 副作用
 *    唯一认领（`store/device` 的 `last` 是跨页面共享缓存，只有它知道该配档案、该建档、该制单）。
 *    这里绝不去 `read()` 第二遍，也不自己解析 `last`——两处读同一条缓存必然出现"谁清得晚谁丢单"。
 *
 * 到点与故障都只报一次 `toast`（文案沿用 `CardScanDialog` 那一套，两处说法要一致），
 * 然后把"接下来干什么"交回 `onEnd`：面板据此退回 IC 常听（`panelHolding` 落下，
 * `useIcWorkflow` 的后台循环自己回来），这里不越权去替它决定。
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useDeviceStore } from "@/store/device";
import { useReaderPromptVoice } from "@/hooks/useVoicePrompt";

/** 与 `CardScanDialog` 同一句：屏上写的和喇叭里念的必须是一个说法 */
const VOICE_ALOUD = "请将身份证平放在读卡器感应区";

/** 一轮监听的收工原因：读到 / 到点没人放卡 / 人按了取消 / 设备故障。面板对四者的处置相同（退场），分开只为将来好加话术 */
export type WatchEndReason = "read" | "timeout" | "cancel" | "halted";

export function IdCardWatchHint({ timeoutSeconds = 15, onEnd }: { timeoutSeconds?: number; onEnd: (why: WatchEndReason) => void }) {
  const reading = useDeviceStore((s) => s.reader.idcard.reading);
  const watchNote = useDeviceStore((s) => s.reader.idcard.watchNote);
  const cardError = useDeviceStore((s) => s.reader.idcard.error);
  const [left, setLeft] = useState(timeoutSeconds);

  // 开听即念一句"请将身份证平放在读卡器感应区"：农户站在窗口外时，这一声比这行字先到
  useReaderPromptVoice(true, VOICE_ALOUD);

  /** 收工只报一次：定时器、watch 回包、取消按钮三条路都可能同时到 */
  const endedRef = useRef(false);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const finish = (why: WatchEndReason) => {
    if (endedRef.current) return;
    endedRef.current = true;
    onEndRef.current(why);
  };

  /** 挂载 = 起一轮监听；卸载一定把循环摘掉，绝不让它在格子外继续抢那台读卡器 */
  useEffect(() => {
    let mounted = true;
    void useDeviceStore
      .getState()
      .reader.idcard.watch({ photo: true })
      .then((card) => {
        if (!mounted) return;
        if (card) finish("read");
        // 回到这里却是 null 且没人叫停＝设备此刻读不了（未登记/离线/命令失败），别再干等
        else if (!endedRef.current) finish(useDeviceStore.getState().reader.idcard.error ? "halted" : "timeout");
      });
    return () => {
      mounted = false;
      useDeviceStore.getState().reader.idcard.stopWatch();
    };
    // 只跑挂载那一次：轮内任何状态变化都不该重开一轮（那会把正压在感应区上的 read 判废）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 倒计时只管收工，不参与监听；200ms 一跳是为了那串秒数看着像在走，不是死数字 */
  useEffect(() => {
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      const rest = Math.max(0, timeoutSeconds - Math.floor((Date.now() - startedAt) / 1000));
      setLeft(rest);
      if (rest > 0) return;
      clearInterval(ticker);
      toast.info(`监听了 ${timeoutSeconds} 秒，还没有读到证件`, {
        description: "重新点「读卡」可再来一轮；也可点「搜档案」选人。",
      });
      finish("timeout");
    }, 200);
    return () => clearInterval(ticker);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeoutSeconds]);

  return (
    <p aria-live="polite" className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden className="relative flex size-3.5 shrink-0 items-center justify-center">
        <span className="absolute inset-0 rounded-full border border-primary/50 motion-safe:animate-ping" />
        <span className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse" />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {/* 一行里说清"在等什么"就够了；每轮"没检测到卡"只在后面缀一句，别把进度刷成滚动日志 */
        cardError ? cardError : reading ? "正在读证…" : watchNote ? `${watchNote}（继续等待）` : "请放身份证"}
      </span>
      <span className="tnum shrink-0">{left}s</span>
      <button
        type="button"
        onClick={() => finish("cancel")}
        className="shrink-0 text-primary hover:underline"
        title="停止监听，回到等流转卡"
      >
        取消
      </button>
    </p>
  );
}
