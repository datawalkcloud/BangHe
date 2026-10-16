/**
 * 「请放置证件」连续监听弹窗（05 §3 /parties 读卡建档）。
 *
 * 现场动作是农户**走过来把证件放上去**，不是操作员点一下按钮。老流程点一次读一次
 * （Rust 侧一轮约 2 秒），人还没走到读卡器那一下就用完了，只能再点一次。这里改成：
 * 弹窗开着就一直在监听（`store/device` 的 `idcard.watch`），读到卡自动收工。
 *
 * 三个读卡入口共用这一份，只差文案与"读到之后归谁处理"：
 *  - 建档（`scene="enroll"`）与制单（`scene="order"`）：读到后由所在页面原有的 `lastCard`
 *    副作用去带出或预填表单，弹窗不插手；
 *  - 档案详情核对（`scene="verify"`）：比对对象是页面上这一张档案，不归那套副作用管，
 *    由调用方传 `onCardRead` 就地接手。
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
import { useDeviceStore, type IdCardResult } from "@/store/device";
import { useReaderPromptVoice } from "@/hooks/useVoicePrompt";
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
   * 场景文案：建档（/parties）、制单（工作台弹窗）与档案详情核对共用同一套监听逻辑，只换说法——
   * 建档说「去建档」，制单说「去搜档案选人」，核对说「与这张档案比对」。
   */
  scene?: "enroll" | "order" | "verify";
  /**
   * 读到卡就地交给调用方（核对场景用）：比对的是页面上这一张档案，不该走 `lastCard` 那套
   * 页面副作用。传了这个回调，弹窗会在交出卡片后清掉 `reader.idcard.last`——否则用户之后
   * 打开档案页，这一刷会被当成刚读到的卡，凭空再弹一次建档/编辑表单。
   */
  onCardRead?: (card: IdCardResult) => void;
}

/** 各场景的文案差异收在一张表里，监听行为三处完全一致 */
const SCENE_COPY: Record<
  NonNullable<CardScanDialogProps["scene"]>,
  {
    description: string;
    timeoutDescription: string;
    footerHint: string;
    /** 退路按钮的字样；不给这句就不画按钮（核对场景没有"改走手工录入"这条退路） */
    manualLabel?: string;
  }
> = {
  enroll: {
    description: "放稳后不用点任何东西，读到证件会自动带出档案。",
    timeoutDescription: "重新点一次「读卡建档」再来一轮；也可改用手工录入证号。",
    footerHint: "读不出来可以点「手工录入」，照样能建档。",
    manualLabel: "手工录入",
  },
  order: {
    description: "放稳后不用点任何东西，读到证件会自动填入售粮人。",
    timeoutDescription: "重新点一次「读卡」再来一轮；也可点「搜档案」选人。",
    footerHint: "读不出来可以点「搜档案」，照样能制单。",
    manualLabel: "搜档案",
  },
  verify: {
    description: "放稳后不用点任何东西，读到证件即与这张档案的证号比对。",
    timeoutDescription: "重新点一次「读卡核对」再来一轮；这一轮什么都没改。",
    footerHint: "只比对，不会改动这张档案里的内容。",
  },
};

const RING_R = 62;
const RING_C = 2 * Math.PI * RING_R;

/**
 * 弹窗标题与提示语音共用这一句原文：改文案只改一处，不会出现"屏上写平放、喇叭里念贴一下"
 * 这种两边各说各话的错位——农户听一句看一句，最后谁都不动手。
 */
const VOICE_ALOUD = "请将身份证平放在读卡器感应区";

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

export function CardScanDialog({
  open,
  onOpenChange,
  timeoutSeconds = 60,
  onManualEntry,
  scene = "enroll",
  onCardRead,
}: CardScanDialogProps) {
  const copy = SCENE_COPY[scene];
  const watchNote = useDeviceStore((s) => s.reader.idcard.watchNote);
  const cardError = useDeviceStore((s) => s.reader.idcard.error);
  // 弹窗一开先念一句"请将身份证平放在读卡器感应区"：人站在窗外时，这一声比屏幕上的字先到
  useReaderPromptVoice(open, VOICE_ALOUD);
  const [left, setLeft] = useState(timeoutSeconds);
  /** 监听被设备故障打断（不是读到卡、也不是倒计时走完）：弹窗留着说清原因 */
  const [halted, setHalted] = useState(false);

  // 关弹窗的动作来自定时器与 watch 回调，不该因为这些回调重跑监听 effect
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;
  // 交卡片的回调同理：调用方每次渲染都是新函数，不能让监听因此重起一轮（读卡器只有一台）
  const readRef = useRef(onCardRead);
  readRef.current = onCardRead;

  /** 开一次 = 起一轮监听；关闭（任何原因）都要把监听摘掉 */
  useEffect(() => {
    if (!open) return;
    setHalted(false);
    let mounted = true;
    void useDeviceStore
      .getState()
      // 顺手把卡面照片一起取回来：档案人像只有"读卡这一次"能拿到（02 §F3.1）。
      // 取不到照片时 Rust 会退回不带照片的读法，读卡本身照常成功，所以这里不必按场景省掉它。
      .reader.idcard.watch({ photo: true })
      .then((card) => {
        if (!mounted) return;
        if (!card) {
          setHalted(true); // 设备故障，循环自己停了：弹窗留着说清原因
          return;
        }
        const onRead = readRef.current;
        if (onRead) {
          // 交给调用方就地处理，同时清掉这份跨页面共享的卡片缓存——留着它，用户之后打开档案页
          // 会被那条 lastCard 副作用当成"刚读到的卡"，凭空再弹一次建档/编辑表单
          useDeviceStore.getState().reader.idcard.clear();
          onRead(card);
        }
        closeRef.current(false); // 读到卡就收工：建档/制单场景由页面的 lastCard 副作用带出或预填
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
          <DialogTitle className="text-sm">{VOICE_ALOUD}</DialogTitle>
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
          {/* 退路按钮：只有这个场景既有回调方、文案表里又给了字样才画（核对没有"改走手工录入"） */}
          {onManualEntry && copy.manualLabel && (
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
