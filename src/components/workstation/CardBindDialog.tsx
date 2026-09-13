/**
 * 「制单请放流转卡」监听弹窗（06 §4.0）。
 *
 * 点「取号并制单」弹出：磅员把那张 IC 小白卡贴到感应区，读到卡号就地过闸——**不在册的先当场
 * 自动登记入库**（06 §4.1 闸门 3），再判未注销、没挂着没做完的单，全过才把卡号交回制单——绑卡与
 * 取号在同一次事务里完成，所以**读不到卡这张单就制不成**。
 *
 * 闸门不过时不关窗、也不叠 toast：原因直接写在弹窗里继续监听，磅员换一张卡就是下一轮，
 * 不必重新点按钮（与 `IcScanDialog`/`CardScanDialog` 同一套节奏）。未登记已经不算闸门不过，
 * 回写到弹窗里的只剩"已注销 / 还挂着没做完的单 / 自动登记这一步本身失败"三种。
 *
 * 弹窗开着＝工作台的 IC 常听让出设备锁（06 §1.2），这里起的这一条循环是那段时间里唯一在读 IC 的人。
 * 让位由进入本框的那一侧负责：从制单弹窗（`RegistrationDialog`）进来靠它置 `regHolding`；从常驻的
 * 「身份与制单」面板（`IdentityPanel`）进来靠面板在 `bindOpen` 期间挂 `panelHolding`。
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { autoRegisterCard, autoRegisterOn } from "@/lib/card-auto-register";
import { useDeviceStore } from "@/store/device";
import { useSetting } from "@/hooks/useLookups";
import { announce } from "@/lib/voice-prompt";
import { useReaderPromptVoice } from "@/hooks/useVoicePrompt";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface CardBindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 本站参数「制单必须绑卡」：关掉时才给一条"不绑卡照样制单"的退路 */
  required: boolean;
  /** 三道闸全过的卡号：交回制单，跟着 order_create 同事务绑上 */
  onPicked: (cardNo: string) => void;
  /** 不绑卡继续制单（仅 required=false 时可达） */
  onSkip: () => void;
  /** 到点没人放卡就收工，不让弹窗无限挂着占住磅房节奏（与读卡建档同一口径） */
  timeoutSeconds?: number;
}

const RING_R = 62;
const RING_C = 2 * Math.PI * RING_R;

/**
 * 提示语音的原文。刻意不等于标题：标题里的"（IC 小白卡）"是给操作员看的辨识说明，
 * 念出来只会把句子拖长、把重点（贴卡）淹掉。改标题时记得回来看这行。
 */
const VOICE_ALOUD = "请将流转卡贴在读卡器感应区";

/** 感应弧 + 一张探出面板右缘的 IC 卡：读作"贴上来别动"，不是扫码 */
function PlaceIcArt() {
  return (
    <div aria-hidden className="relative size-[84px]">
      <span className="absolute left-[18px] top-[7px] h-[72px] w-[50px] rounded-[10px] bg-border/60" />
      <span className="absolute left-[14px] top-[4px] h-[72px] w-[50px] rounded-[10px] border border-border bg-muted/50">
        <span className="absolute right-[7px] top-[9px] flex flex-col items-end gap-[3px]">
          <span className="h-[3px] w-[11px] rounded-full bg-primary/70 motion-safe:animate-pulse" />
          <span className="h-[3px] w-[11px] rounded-full bg-border" />
        </span>
      </span>
      <svg viewBox="0 0 18 24" className="absolute left-[15px] top-[24px] h-[26px] w-[20px]">
        {[
          { d: "M6.2 8.2 A5 5 0 0 1 6.2 15.8", delay: 0 },
          { d: "M8.8 5.1 A9 9 0 0 1 8.8 18.9", delay: 220 },
          { d: "M11.4 2 A13 13 0 0 1 11.4 22", delay: 440 },
        ].map((arc) => (
          <path
            key={arc.delay}
            d={arc.d}
            fill="none"
            strokeWidth="1.8"
            strokeLinecap="round"
            className="motion-safe:animate-pulse stroke-primary/60"
            style={{ animationDelay: `${arc.delay}ms` }}
          />
        ))}
      </svg>
      <span className="absolute left-[26px] top-[42px] motion-safe:animate-bounce">
        <span className="relative block h-[27px] w-[46px] rounded-[5px] border border-primary/45 bg-primary/12">
          <span className="absolute left-[5px] top-[6px] size-[10px] rounded-[2px] bg-warning/70 ring-1 ring-warning/40" />
          <span className="absolute left-[19px] top-[8px] h-[3px] w-[20px] rounded-full bg-foreground/25" />
          <span className="absolute left-[19px] top-[15px] h-[3px] w-[13px] rounded-full bg-foreground/20" />
        </span>
      </span>
    </div>
  );
}

export function CardBindDialog({ open, onOpenChange, required, onPicked, onSkip, timeoutSeconds = 60 }: CardBindDialogProps) {
  const qc = useQueryClient();
  /**
   * 站点参数「允许使用未登记的流转卡」`card_auto_register`（06 §4.1 闸门 3，缺省＝开）：
   * 开＝读到陌生卡号当场入库留痕再绑本单；关＝退回硬拦，要磅员先去「流转卡」页登记。
   *
   * 走 ref 不进监听 effect 依赖：参数是异步查回来的，进依赖会让本框在刚开的那一刻
   * stopWatch + 重起一轮，正压在感应区上那一次 `read` 被任期号判废——这刷就凭空丢了
   * （与 `IdentityPanel` 那对 `panelHolding` 拆成两个 effect 挡抖动是同一个坑）。
   */
  const autoRegisterRef = useRef(true);
  autoRegisterRef.current = autoRegisterOn(useSetting("card_auto_register").raw);
  const watchNote = useDeviceStore((s) => s.reader.ic.watchNote);
  const icError = useDeviceStore((s) => s.reader.ic.error);
  // 弹出即念一句"请将流转卡贴在读卡器感应区"：这一框挡在取号制单前面，农户不贴卡整张单都开不了
  useReaderPromptVoice(open, VOICE_ALOUD);
  const [left, setLeft] = useState(timeoutSeconds);
  /** 监听被设备故障/没有 IC 通道打断：弹窗留着说清原因，不静默关掉让磅员以为是自己手快 */
  const [halted, setHalted] = useState(false);
  /** 闸门拦下的原因（已注销 / 还挂着没做完的单 / 未登记但自动入库失败），写在弹窗里继续等下一张卡 */
  const [rejected, setRejected] = useState<string | null>(null);

  // 关窗动作来自定时器与监听回调，不该因为这些回调重跑监听 effect
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;
  const pickedRef = useRef(onPicked);
  pickedRef.current = onPicked;

  /** 开一次 = 起一轮监听；任何原因关闭都要把监听摘掉，绝不留后台轮询 */
  useEffect(() => {
    if (!open) return;
    setHalted(false);
    setRejected(null);
    let alive = true;
    const ic = useDeviceStore.getState().reader.ic;
    ic.clear();
    (async () => {
      while (alive) {
        const hit = await useDeviceStore.getState().reader.ic.watch();
        if (!alive) break;
        if (!hit) {
          setHalted(true); // 设备故障 / 这台机压根没有 IC 通道 / 被 stopWatch 打断
          announce("这台机器读不到卡，请检查一下读卡器", "bind-halted");
          return;
        }
        const sn = hit.sn.trim().toUpperCase();
        if (!sn) continue; // 寻到卡却没拿到卡号：按 06 §4.1 闸门 2 降级，别拿"未登记"冤枉操作员
        try {
          const loc = await api.cardLocate(sn);
          if (!loc.found) {
            // 站点关掉「允许使用未登记的流转卡」＝闸门 3 退回硬拦：不替它登记，只说清去哪儿登记
            if (!autoRegisterRef.current) {
              setRejected(`卡 ${sn} 未在卡池登记：请到「流转卡」页登记后再制单，或换一张已登记的卡`);
              // 拒绝原因写在屏上，农户看不见——这一句得从喇叭里出去才知道下一步干什么
              announce("这张卡没有登记过，换一张卡");
              continue;
            }
            /**
             * 不在册不再是"这一张用不了、你去另一屏登记"（06 §4.1 闸门 3）：卡已经贴在感应区上、
             * 农户站在窗口前，就地补一次登记入库再按正常空闲卡走完这一框。
             * 只有登记这一步本身失败（岗位无权 / 没解锁 / 库锁）才回写弹窗，换一张卡就是下一轮。
             */
            const reg = await autoRegisterCard(qc, sn, "制单绑卡");
            if (!reg.ok) {
              setRejected(`卡 ${sn} 自动登记失败：${reg.reason}；请换一张卡，或到「流转卡」页登记后再制单`);
              // 拒绝原因写在屏上，农户看不见——这一句得从喇叭里出去才知道下一步干什么
              announce("这张卡登记不上，换一张卡");
              continue;
            }
            announce("这张新卡已经登记好了，正在取号制单");
            useDeviceStore.getState().reader.ic.stopWatch();
            pickedRef.current(sn);
            return;
          }
          if (loc.status === "retired") {
            setRejected(`卡 ${sn} 已注销，不能再用：请换一张空闲卡`);
            announce("这张卡已经注销了，换一张卡");
            continue;
          }
          if (loc.status === "in_use") {
            setRejected(
              `卡 ${sn} 还挂着没做完的单 ${loc.order_no ?? ""}${loc.party_name ? `（${loc.party_name}）` : ""}：一张卡不能同时开两张单，请先给那张单退卡或换一张空闲卡`,
            );
            announce("这张卡还挂着没做完的单，先换一张");
            continue;
          }
          announce("卡读到了，正在取号制单");
          useDeviceStore.getState().reader.ic.stopWatch();
          pickedRef.current(sn);
          return;
        } catch (e) {
          setRejected(`定位卡 ${sn} 失败：${e instanceof Error ? e.message : "请重试，或换一张卡"}`);
          announce("这张卡读不出来，再贴一次试试");
        }
      }
    })();
    return () => {
      alive = false;
      useDeviceStore.getState().reader.ic.stopWatch();
    };
  }, [open]);

  /** 倒计时只管关窗，不参与监听；被故障打断后就不再走表 */
  useEffect(() => {
    if (!open || halted) return;
    setLeft(timeoutSeconds);
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      const rest = Math.max(0, timeoutSeconds - Math.floor((Date.now() - startedAt) / 1000));
      setLeft(rest);
      if (rest > 0) return;
      clearInterval(ticker);
      toast.info(`监听了 ${timeoutSeconds} 秒，还没有读到流转卡`, {
        description: required
          ? "本站要求「制单必须绑卡」，没读到卡这张单制不成。重新点一次「取号并制单」可再来一轮。"
          : "这一轮没人放卡；重新点一次「取号并制单」可再来一轮，也可以不绑卡先制单。",
      });
      // 弹窗是自己关的，谁都没盯着屏幕——这一声不说，农户会一直站在窗口前等着
      announce(
        required ? "等了一会儿没人放卡，这张单先不制了" : "没人放卡，监听已经停了",
        "bind-timeout",
      );
      closeRef.current(false);
    }, 200);
    return () => clearInterval(ticker);
  }, [open, halted, timeoutSeconds, required]);

  const statusLine = halted
    ? "这台机此刻读不到 IC 卡，监听已停止"
    : rejected
      ? "这张卡用不了，换一张贴上来就行"
      : "正在监听感应区，请放卡…";
  const hint = halted ? (icError ?? "请检查读卡器连接") : (rejected ?? (watchNote ? `${watchNote}（继续等待中）` : null));

  return (
    <Dialog open={open} onOpenChange={(next) => closeRef.current(next)}>
      <DialogContent className="max-w-[470px]">
        <DialogHeader>
          <DialogTitle className="text-sm">请将流转卡（IC 小白卡）贴在读卡器感应区</DialogTitle>
          <DialogDescription className="text-xs">
            {halted
              ? "这台机现在解不出 IC 卡，下面写的是具体原因。"
              : "本站制单要绑卡：贴稳后不用点任何东西，系统正在连续寻卡，读到可用的卡就自动取号制单。"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-5">
          <div className="relative size-[136px] shrink-0">
            <svg viewBox="0 0 136 136" className="absolute inset-0 -rotate-90" aria-hidden>
              <circle cx="68" cy="68" r={RING_R} fill="none" strokeWidth="5" className="stroke-border" />
              <circle
                cx="68"
                cy="68"
                r={RING_R}
                fill="none"
                strokeWidth="5"
                strokeLinecap="round"
                strokeDasharray={RING_C}
                strokeDashoffset={RING_C * (1 - left / timeoutSeconds)}
                className="stroke-primary transition-[stroke-dashoffset] duration-200 ease-linear"
              />
            </svg>
            <div className="absolute inset-0 grid place-items-center">
              <PlaceIcArt />
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-1.5" aria-live="polite">
            <p className="text-xs text-muted-foreground">{statusLine}</p>
            {!halted && (
              <p className="flex items-baseline gap-1">
                <span className="tnum text-2xl font-semibold leading-none">{left}</span>
                <span className="text-xs text-muted-foreground">秒后自动停止</span>
              </p>
            )}
            <p className={halted || rejected ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{hint}</p>
            {required && halted && (
              <p className="text-xs text-muted-foreground">
                读不到卡就制不了单：接上读卡器再点一次，或到「设置 · 过磅计量」关掉「制单必须绑卡」。
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          {!required && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                useDeviceStore.getState().reader.ic.stopWatch();
                onSkip();
              }}
            >
              不绑卡，直接制单
            </Button>
          )}
          <DialogClose render={<Button size="sm" variant="outline" />}>
            取消制单
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
