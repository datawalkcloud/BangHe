/**
 * 「请放置证件」连续监听弹窗（05 §3 /parties 读卡建档）。
 *
 * 现场动作是农户**走过来把证件放上去**，不是操作员点一下按钮。老流程点一次读一次
 * （Rust 侧一轮约 2 秒），人还没走到读卡器那一下就用完了，只能再点一次。这里改成：
 * 弹窗开着就一直在监听（`store/device` 的 `idcard.watch`），读到卡自动收工去带档案。
 *
 * 两条停止口径，都算正常结束、不留后台轮询：
 *  - 倒计时走完（默认 60 秒）：说明这一轮没人放卡，弹提示后关掉；
 *  - 用户提前关闭（右上角叉 / 取消监听 / Esc）：立刻 `stopWatch`。
 *
 * 监听期间的"没检测到卡"只走 `watchNote` 显示在弹窗里；页面级 `error` 只留设备故障，
 * 否则弹窗背后那条告警会随每一轮寻卡反复闪。
 */
import { useEffect, useRef, useState } from "react";
import { KeyboardIcon } from "lucide-react";
import { toast } from "sonner";
import { useDeviceStore } from "@/store/device";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface CardScanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 监听到第几秒自动收工；到点即停，不让弹窗无限挂着占住制单节奏 */
  timeoutSeconds?: number;
  /** 读不到卡的退路：关掉监听直接开手工录入表单 */
  onManualEntry?: () => void;
  /**
   * 场景文案：建档（/parties）与制单（工作台弹窗）共用同一套监听逻辑，只换说法——
   * 建档说「去建档」，制单说「去搜档案选人」。缺省即建档场景。
   */
  scene?: "enroll" | "order";
}

/** 各场景的文案差异收在一张表里，监听行为两处完全一致 */
const SCENE_COPY: Record<
  NonNullable<CardScanDialogProps["scene"]>,
  { description: string; timeoutDescription: string; footerHint: string; manualLabel: string }
> = {
  enroll: {
    description: "放稳后不用点任何东西，系统正在连续寻卡，读到即自动带出档案。",
    timeoutDescription: "人还没走过来？重新点一次「读卡建档」可再来一轮；也可改用手工录入证号。",
    footerHint: "读卡只影响录入速度。读不出来可以点「手工录入」，照样能建档。",
    manualLabel: "手工录入",
  },
  order: {
    description: "放稳后不用点任何东西，系统正在连续寻卡，读到即自动填入售粮人。",
    timeoutDescription: "人还没走过来？重新点一次「读卡」可再来一轮；也可点「搜档案」选人。",
    footerHint: "读卡只影响录入速度。读不出来可以点「搜档案」，照样能制单。",
    manualLabel: "搜档案",
  },
};

const RING_R = 62;
const RING_C = 2 * Math.PI * RING_R;

/**
 * 按真机外形画的示意：竖版圆角面板 + 右上角指示灯槽 + 中左侧非接触感应弧 + 平放的身份证。
 * 感应弧由内向外依次亮，配合证件轻落，读作"把卡放到这块面板上别动"，而不是扫码。
 */
function PlaceCardArt() {
  return (
    <div aria-hidden className="relative size-[84px]">
      {/* 面板厚度：错开一格压在主体右下，露出真机那圈侧边 */}
      <span className="absolute left-[18px] top-[7px] h-[72px] w-[50px] rounded-[10px] bg-border/60" />
      <span className="absolute left-[14px] top-[4px] h-[72px] w-[50px] rounded-[10px] border border-border bg-muted/50">
        {/* 指示灯槽 */}
        <span className="absolute right-[7px] top-[9px] flex flex-col items-end gap-[3px]">
          <span className="h-[3px] w-[11px] rounded-full bg-primary/70 motion-safe:animate-pulse" />
          <span className="h-[3px] w-[11px] rounded-full bg-border" />
        </span>
      </span>

      {/* 非接触感应符号：三层弧从内往外依次亮 */}
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

      {/* 身份证：横版，压在感应区上、略微探出面板右缘 */}
      <span className="absolute left-[26px] top-[42px] motion-safe:animate-bounce">
        <span className="relative block h-[27px] w-[46px] rounded-[5px] border border-primary/45 bg-primary/12">
          <span className="absolute left-[5px] top-[6px] size-[8px] rounded-[2px] bg-primary/55" />
          <span className="absolute left-[17px] top-[7px] h-[3px] w-[22px] rounded-full bg-foreground/25" />
          <span className="absolute left-[17px] top-[14px] h-[3px] w-[15px] rounded-full bg-foreground/20" />
        </span>
      </span>
    </div>
  );
}

export function CardScanDialog({ open, onOpenChange, timeoutSeconds = 60, onManualEntry, scene = "enroll" }: CardScanDialogProps) {
  const copy = SCENE_COPY[scene];
  const watchNote = useDeviceStore((s) => s.reader.idcard.watchNote);
  const cardError = useDeviceStore((s) => s.reader.idcard.error);
  const [left, setLeft] = useState(timeoutSeconds);
  /** 监听被设备故障打断（不是读到卡、也不是倒计时走完）：弹窗留着说清原因 */
  const [halted, setHalted] = useState(false);

  // 关弹窗的动作来自定时器与 watch 回调，不该因为这些回调重跑监听 effect
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;

  /** 开一次 = 起一轮监听；关闭（任何原因）都要把监听摘掉 */
  useEffect(() => {
    if (!open) return;
    setHalted(false);
    let mounted = true;
    void useDeviceStore
      .getState()
      .reader.idcard.watch()
      .then((card) => {
        if (!mounted) return;
        // 读到卡就收工：档案页原有的 lastCard 副作用负责带出或预填表单
        if (card) closeRef.current(false);
        else setHalted(true); // 设备故障，循环自己停了：弹窗留着说清原因
      });
    return () => {
      mounted = false;
      useDeviceStore.getState().reader.idcard.stopWatch();
    };
  }, [open]);

  /** 倒计时只管关窗，不参与监听；监听被故障打断后就不再走表 */
  useEffect(() => {
    if (!open || halted) return;
    setLeft(timeoutSeconds);
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      const rest = Math.max(0, timeoutSeconds - Math.floor((Date.now() - startedAt) / 1000));
      setLeft(rest);
      if (rest > 0) return;
      clearInterval(ticker);
      toast.info(`监听了 ${timeoutSeconds} 秒，还没有读到证件`, {
        description: copy.timeoutDescription,
      });
      closeRef.current(false);
    }, 200);
    return () => clearInterval(ticker);
    // copy 来自模块级常量表，引用恒定，不会造成重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, halted, timeoutSeconds]);

  const statusLine = halted ? "读卡器不可用，监听已停止" : "正在监听感应区，请放卡…";
  const hint = cardError ?? (watchNote ? `${watchNote}（继续等待中）` : null);

  return (
    <Dialog open={open} onOpenChange={(next) => closeRef.current(next)}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="text-sm">请将身份证平放在读卡器感应区</DialogTitle>
          <DialogDescription className="text-xs">
            {copy.description}
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
              <PlaceCardArt />
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
            <p className={cardError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{hint}</p>
            <p className="text-xs text-muted-foreground">{copy.footerHint}</p>
          </div>
        </div>

        <DialogFooter>
          {onManualEntry && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                closeRef.current(false);
                onManualEntry();
              }}
            >
              <KeyboardIcon />
              {copy.manualLabel}
            </Button>
          )}
          <DialogClose render={<Button size="sm" variant="outline" />}>
            取消监听
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
