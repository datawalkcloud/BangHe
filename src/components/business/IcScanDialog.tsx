/**
 * 「请放置 IC 卡 → 登记入库」单弹窗（流转卡卡池；卡号登记得在弹窗内一次性闭环）。
 *
 * 业务节奏：操作员点一次按钮开弹窗，把卡贴上感应区，弹窗自动走完「监听→读卡→录入贴签→提交」
 * 四步，中间不让操作员来回切两屏——所以传统"页面放卡号栏 + 读卡按钮 + 登记按钮"那一段
 * 整个儿被这个弹窗接走，留在 CardsPage 顶部 actions 的只是一个"读卡登记"触发按钮。
 *
 * 三态机器：
 *  - `scanning`：起一轮 `ic.watch()`，听着感应区。读到新卡号或用户按"手工录入"进 ready；
 *  - `ready`：卡号就位（读到的或手输的），可加贴签、可"再刷一张"换卡；
 *  - `submitting`：调 `onRegister` 中，成功 toast + 关弹窗 + `onRegistered`；失败 toast.error 留 ready 让用户改。
 *
 * 倒计时只在 scanning 阶段走；ready 与 submitting 阶段不算监听时长，弹窗可以一直挂着。
 *
 * 两条停止口径（都算正常结束、不留后台轮询）：
 *  - 倒计时走完：没人放卡，弹提示后关掉；
 *  - 用户提前关闭（右上角叉 / 取消监听 / Esc）：立刻 `stopWatch`。
 *
 * 监听期间的"没检测到卡/密钥不对"只走 `watchNote` 显示在弹窗里；
 * 设备故障走 `ic.error`，区别于"找不到卡"软失败。
 */
import { useEffect, useRef, useState } from "react";
import { CreditCardIcon, KeyboardIcon, ScanLineIcon } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface IcScanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** scanning 阶段到点自动收工；ready 与 submitting 阶段不算时长 */
  timeoutSeconds?: number;
  /** 提交前的字段校验；返回人类可读错误信息，空数组 = 通过 */
  validate?: (input: { card_no: string; label: string }) => string[];
  /** 真正登记的实现：弹窗只 await 一次；抛错时弹窗里 toast.error 并留在 ready 阶段 */
  onRegister: (input: { card_no: string; label: string }) => Promise<void>;
  /** 登记成功后才回调（弹窗已关上），通常用来 invalidate 列表 */
  onRegistered?: (card_no: string) => void;
}

const RING_R = 62;
const RING_C = 2 * Math.PI * RING_R;

/**
 * 扫描态的画面：感应区圆环 + 倒计时 progress；中央 IC 卡示意，三层感应弧由内向外依次亮，
 * 表达"把卡贴上"而不是"扫一下"。
 */
function ScanningArt() {
  return (
    <div aria-hidden className="relative size-[84px]">
      <span className="absolute left-[8px] top-[10px] h-[60px] w-[68px] rounded-[6px] bg-border/60" />
      <span className="absolute left-[4px] top-[6px] flex h-[60px] w-[68px] flex-col rounded-[6px] border border-border bg-card">
        <span className="flex h-[26px] items-center justify-center border-b border-border/60 px-1">
          <span className="tnum text-[8px] text-muted-foreground">卡号待读入…</span>
        </span>
        <span className="relative flex-1">
          <span className="absolute left-[6px] top-[7px] h-[10px] w-[12px] rounded-[1.5px] bg-warning/85 ring-1 ring-warning/30" />
          <span className="absolute left-[8px] top-[9px] h-[6px] w-[8px] rounded-[1px] border border-warning/55" />
        </span>
      </span>
      <svg viewBox="0 0 18 14" className="absolute left-[53px] top-[16px] h-[14px] w-[20px]">
        {[
          { d: "M3 11 A5 5 0 0 1 13 11", delay: 0 },
          { d: "M1.5 12.5 A8 8 0 0 1 14.5 12.5", delay: 220 },
          { d: "M0 14 A11 11 0 0 1 16 14", delay: 440 },
        ].map((arc) => (
          <path
            key={arc.delay}
            d={arc.d}
            fill="none"
            strokeWidth="1.6"
            strokeLinecap="round"
            className="motion-safe:animate-pulse stroke-primary/60"
            style={{ animationDelay: `${arc.delay}ms` }}
          />
        ))}
      </svg>
    </div>
  );
}

/** 卡号太长（14 hex）全压上去会糊掉，存根取头 6 + 尾 4，对一张实卡来说足够对上号 */
const maskSn = (sn: string) => `${sn.slice(0, 6)} · ${sn.slice(-4)}`;

export function IcScanDialog({
  open,
  onOpenChange,
  timeoutSeconds = 60,
  validate,
  onRegister,
  onRegistered,
}: IcScanDialogProps) {
  const watchNote = useDeviceStore((s) => s.reader.ic.watchNote);
  const icError = useDeviceStore((s) => s.reader.ic.error);
  /** store 的 ic.last 给扫描态做"上一次"占位（页面级监听留下的卡号）：命中后立刻被自己覆盖 */
  const lastFromStore = useDeviceStore((s) => s.reader.ic.last);

  type Phase = "scanning" | "ready" | "submitting";
  const [phase, setPhase] = useState<Phase>("scanning");
  const [cardNo, setCardNo] = useState("");
  const [label, setLabel] = useState("");
  const [left, setLeft] = useState(timeoutSeconds);
  /** 监听被设备故障打断（不是读到卡、也不是倒计时走完）：弹窗留着说清原因 */
  const [halted, setHalted] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // 关弹窗的动作来自定时器、watch 回调、提交成功，不该因为这些回调重跑监听 effect
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;
  /** 成功 toast + onRegistered 回调都走 ref，避开父组件重渲染闭包漂移 */
  const onRegisteredRef = useRef(onRegistered);
  onRegisteredRef.current = onRegistered;
  const onRegisterRef = useRef(onRegister);
  onRegisterRef.current = onRegister;
  const validateRef = useRef(validate);
  validateRef.current = validate;

  /**
   * 每次弹窗打开都重置到 scanning：新拿一张卡入库、还是给同一张补个贴签，应该都从干净的
   * 「请贴卡」开始。上次如果有未提交的 label，也清空，避免误用。
   */
  useEffect(() => {
    if (!open) return;
    setPhase("scanning");
    setCardNo("");
    setLabel("");
    setHalted(false);
    setErrors([]);
    setLeft(timeoutSeconds);
    let mounted = true;
    void useDeviceStore
      .getState()
      .reader.ic.watch()
      .then((card) => {
        if (!mounted) return;
        if (card) {
          // 边沿触发：读到的就是新一刷卡号（一刷=换卡或天线空过一次再放上）。
          // 不在这里关弹窗——统一让 ready 阶段让用户确认 + 入库。
          setCardNo(card.sn.trim().toUpperCase());
          setPhase("ready");
        } else {
          setHalted(true); // 设备故障，循环自己停了：弹窗留着说清原因
        }
      });
    return () => {
      mounted = false;
      useDeviceStore.getState().reader.ic.stopWatch();
    };
    // timeoutSeconds 改值不重起一轮新监听；保持开启节奏只取第一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** 倒计时只管关窗，不参与监听；监听被故障打断或已经读到卡后就不再走表 */
  useEffect(() => {
    if (!open || halted || phase !== "scanning") return;
    setLeft(timeoutSeconds);
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      const rest = Math.max(0, timeoutSeconds - Math.floor((Date.now() - startedAt) / 1000));
      setLeft(rest);
      if (rest > 0) return;
      clearInterval(ticker);
      toast.info(`监听了 ${timeoutSeconds} 秒，还没读到 IC 卡`, {
        description: "卡未贴紧感应区？点「再读一轮」可继续；也可改「手工录入」直接输卡号。",
      });
      closeRef.current(false);
    }, 200);
    return () => clearInterval(ticker);
  }, [open, halted, phase, timeoutSeconds]);

  /** ready 阶段「再刷一张」回 scanning：清空卡号重新起 watch */
  function scanAgain() {
    setErrors([]);
    setCardNo("");
    setLabel("");
    setHalted(false);
    setLeft(timeoutSeconds);
    setPhase("scanning");
    let mounted = true;
    void useDeviceStore
      .getState()
      .reader.ic.watch()
      .then((card) => {
        if (!mounted) return;
        if (card) {
          setCardNo(card.sn.trim().toUpperCase());
          setPhase("ready");
        } else {
          setHalted(true);
        }
      });
    /** 这一轮自己起的 watch 要自己摘；闭包里的 mounted 由下面 cleanup 负责 */
    return () => {
      mounted = false;
      useDeviceStore.getState().reader.ic.stopWatch();
    };
  }

  /** scanning 阶段手动放弃监听、进 ready 自己手输卡号 */
  function enterManual() {
    useDeviceStore.getState().reader.ic.stopWatch();
    setPhase("ready");
    setCardNo("");
    setLabel("");
    setHalted(false);
    setErrors([]);
  }

  async function submit() {
    const card_no = cardNo.trim().toUpperCase();
    if (validateRef.current) {
      const errs = validateRef.current({ card_no, label });
      if (errs.length > 0) {
        setErrors(errs);
        return;
      }
    }
    setErrors([]);
    setPhase("submitting");
    try {
      await onRegisterRef.current({ card_no, label: label.trim() });
      toast.success(`卡 ${card_no} 已入池`);
      onRegisteredRef.current?.(card_no);
      closeRef.current(false);
    } catch (e) {
      toast.error(`登记失败：${e instanceof Error ? e.message : String(e)}`);
      setPhase("ready");
    }
  }

  const scanning = phase === "scanning";
  const ready = phase === "ready";
  const submitting = phase === "submitting";

  /** 扫描态把"还有一个 N 秒"放在右栏；就绪后让位给卡号 + 贴签表单 */
  return (
    <Dialog open={open} onOpenChange={(next) => closeRef.current(next)}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {scanning ? "请将流转卡平放在读卡器感应区" : "登记入库"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {scanning
              ? "贴稳后不用点任何东西，系统正在连续寻卡，读到即自动带回卡号登记。"
              : "卡号已就位。补一条贴签便于现场辨认，然后点「登记入库」即可。也可「再刷一张」换卡。"}
          </DialogDescription>
        </DialogHeader>

        {scanning ? (
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
                <ScanningArt />
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-1.5" aria-live="polite">
              <p className="text-xs text-muted-foreground">
                {halted ? "IC 卡读卡器不可用，监听已停止" : "正在监听感应区，请贴卡…"}
              </p>
              {!halted && (
                <p className="flex items-baseline gap-1">
                  <span className="tnum text-2xl font-semibold leading-none">{left}</span>
                  <span className="text-xs text-muted-foreground">秒后自动停止</span>
                </p>
              )}
              <p className={halted || icError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                {halted
                  ? (icError ?? "请检查读卡器连接；如已损坏，可在右侧点「手工录入」直接输卡号。")
                  : watchNote
                    ? `${watchNote}（继续等待中）`
                    : "读卡只影响录入速度；读不出可点「手工录入」照样登记。"}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              卡号（{ready ? "读到" : submitting ? "读到 · 提交中" : "—"}）
              <div className="flex items-center gap-2">
                <ScanLineIcon className="size-3.5 text-primary" />
                <span className="tnum text-sm font-semibold tracking-wide text-foreground">{cardNo || "—"}</span>
                {cardNo && (
                  <span className="text-[11px] text-muted-foreground">（存根 {maskSn(cardNo)}）</span>
                )}
              </div>
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              贴签编号（选填，便于现场辨认）
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="如 CARD-013"
                disabled={submitting}
                className="h-8 text-xs"
                autoFocus
              />
            </Label>
            {errors.length > 0 && (
              <ul className="list-disc pl-4 text-xs text-destructive">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            {/* hint 上一次 store.last 只是兜底：弹窗自己命中后 cardNo 就盖过它了 */}
            {lastFromStore && !cardNo && (
              <p className="text-xs text-muted-foreground">
                上一次读到：<span className="tnum">{maskSn(lastFromStore.sn.trim().toUpperCase())}</span>
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {scanning && (
            <>
              <Button size="sm" variant="ghost" onClick={enterManual}>
                <KeyboardIcon />
                手工录入
              </Button>
              <DialogClose render={<Button size="sm" variant="outline" />}>
                取消监听
              </DialogClose>
            </>
          )}
          {ready && (
            <>
              <Button size="sm" variant="ghost" onClick={scanAgain}>
                <ScanLineIcon />
                再刷一张
              </Button>
              <Button size="sm" onClick={submit} disabled={!cardNo}>
                <CreditCardIcon />
                登记入库
              </Button>
            </>
          )}
          {submitting && (
            <Button size="sm" disabled>
              <CreditCardIcon />
              登记中…
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
