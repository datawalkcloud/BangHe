/**
 * 扫码枪输入捕获（键盘模拟式扫码枪 = 每秒几十下按键、以 Enter 结尾的键盘）。
 *
 * 为什么不直接把焦点钉在扫码框上：窗口里全是输入框——单价、改价事由、本次实付。
 * "永远聚焦扫码框"意味着枪一响，那串字符落进当时正聚焦的那个框里，
 * 结果是**把单号当成改价事由存进去**，钱算错了票面还看不出异常。
 * 所以这里反过来做：谁在打字就不抢谁的键，只有在没有任何输入框聚焦时，
 * 才把这串按键当作一次扫码收走。这与 `useHotkey` 用同一条 `isTypingTarget` 规则，
 * 两处对"什么叫在输入"的判断必须一致，否则同一个动作在两个地方行为不同。
 *
 * 弹出的打印预览、对话框打开时调用方要把 `enabled` 关掉：那时焦点在弹层里，
 * 扫进来的码不该把底下的单子换掉。
 *
 * 间隔判据对**老纸上的票面码载荷**放宽到 1500ms（见 `PREFIX_GAP_CAP_MS`）：机器一卡就把枪
 * 判成人在打字，是现场"扫了没反应"的真凶之一。载荷改成"码里就是单号本体"（02 §F1.4 本版）
 * 之后，这条放宽只剩下老纸那一半管用——新票的码开头就是站码，与人在键盘上敲一串单号的形状
 * 完全一样，"看着像票"这个证据没有了。不在这里换判据是故意的：拿"整串像单号 + 回车"当枪，
 * 等于把刻意撤掉的手输单号那扇门重新打开（误输一位就结错一张单）。真因为卡顿扫不出新票，
 * 要动的是捕获层本身（枪的 HID 报文，或换串口 / USB 模式），不是放宽到人那一侧。
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { isTypingTarget } from "@/hooks/useHotkey";
import { announce } from "@/lib/voice-prompt";

/** 条码最长长度：超过它基本是有人用键盘在乱按，不是枪在扫 */
const MAX_LEN = 64;
/** 两次按键间隔超过此值说明是人在一个字一个字敲，不算一次扫码（毫秒） */
const MAX_GAP_MS = 80;
/** 输入法警告的吐司 id：合成期间每个按键都会命中，靠同一个 id 让它只留一条 */
const IME_TOAST_ID = "scan-ime-composing";
/**
 * 已经打出**老纸上那两种载荷**开头的缓冲，放宽到这个间隔（毫秒）。
 *
 * 为什么单给这一串开一条：80ms 是"人 vs 枪"的判据，可它同时也是"枪 vs 卡住的机器"的判据——
 * 磅房这台机上 IC 卡在常听、抓拍机在取帧、WebView2 主线程一卡就是几百毫秒，按键事件之间的
 * 间隔被拉长，整串载荷照进来却被判成人在打字，缓冲一次次清空，现场看到的就是"扫了没反应"
 * 或"这个码我们认不出来（只剩半截）"。而老载荷的开头两位是**版本位 + 票种位**（`1` + `1`…`5`，
 * 见 `lib/ticket-code`）：没有人会对着磅房的键盘手打这一串，看到它就可以认定这是枪。
 *
 * 本版把前缀撤了（码里就是单号本体），于是这份豁免只覆盖手上的老纸：**新票的码不再享有放宽**，
 * 一串单号的开头是站码，跟人手敲一个单号完全同形，没有形状能证明这是枪。不给新票开后门是
 * 故意的——那正是被刻意撤掉的"手输单号"入口，放宽它等于把误输的门重新打开（误输一位就结错一
 * 张单）。真在这台机上因为卡顿扫不出新票，要改的是捕获层本身（枪切 HID 报文 / 换串口或 USB
 * 模式），不是把判据放宽到人那一侧。
 *
 * 仍要有上限：半截 `1101202610` 留在缓冲里，过一会儿有人乱按键盘再回车，就会拼出一串
 * 像真单号的垃圾。超过这个间隔就当这一枪已经废了，清掉重来。
 */
const PREFIX_GAP_CAP_MS = 1500;

/**
 * 缓冲"还可能是**老纸上那两种载荷**的开头"吗？（放宽间隔的判据，见 `PREFIX_GAP_CAP_MS`）
 *
 * 两轨都要认：① 上一版数字载荷的开头是版本位 `1` + 票种位 `1`…`5`，所以 `1`、`11`、
 * `11012026…` 都算还在路上，而 `10`、`19` 这种第二位对不上票种的一开始就不是载荷；
 * ② 存量票的 `BH1:` 头——`B`、`BH`、`BH1` 都算还在路上，`BH1` 之后接半角还是全角冒号都算已确认。
 * 必须连"半个开头"一起认，否则缓冲根本攒不到能判据的长度就被 80ms 规则清了
 * （第一版就栽在这里：`B`→`H` 那一步 next 是 "BH"，不匹配 `^BH1` 就被当人打字丢掉）。
 *
 * 本版的码（= 单号本体）**不在这里**，也不该在这里：它开头就是站码，与手敲一串单号同形。
 */
function couldBeLegacyTicketBurst(s: string): boolean {
  return /^1([1-5]\d*)?$/.test(s) || /^B(H1?)?$/i.test(s) || /^BH1[:：]?/i.test(s);
}

export function useScannerCapture(
  onScan: (raw: string) => void,
  opts: { enabled?: boolean } = {},
): { capturing: boolean } {
  const enabled = opts.enabled !== false;
  const buf = useRef("");
  const last = useRef(0);
  const cb = useRef(onScan);
  cb.current = onScan;

  useEffect(() => {
    if (!enabled) {
      buf.current = "";
      return;
    }
    /** 输入法警告：同一个 id 让吐司自我替换（合成期间每个键都会命中，不能刷屏），语音靠键去重 */
    const warnImeActive = () => {
      toast.warning("这台机正开着中文输入法，扫码枪的按键被它改写了（开头的字母被吞、数字与冒号被折成中文标点）。按 Shift 切到英文输入法再扫一次。", { id: IME_TOAST_ID });
      announce("输入法是中文模式，请切成英文再扫", IME_TOAST_ID);
    };
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) {
        buf.current = "";
        return;
      }
      /**
       * 中文输入法正在合成 = 这一串按键不是给我们的，是给 IME 拼字的。
       *
       * 现场实测到的形态是：票面码 `BH1:BD01202610000069` 扫进来只剩 `D01202610000069`——
       * 开头的字母与冒号被合成区吞掉（字母进拼音串、数字被当成候选项序号），后半串数字则
       * 原样漏出来。这种码永远解析不成单号，而"未知的码格式：D01202610000069"这句对磅房
       * 没有任何指导意义：他不知道是自己输入法没切。所以在这里当场说破，别让人去翻票。
       *
       * 判据要挑"没有输入框聚焦"这一刻：光标在文本框里时人本来就在打中文，那不该报警。
       */
      if (e.isComposing || e.keyCode === 229 || e.key === "Process") {
        buf.current = "";
        warnImeActive();
        return;
      }
      const now = Date.now();
      /**
       * 按键间隔拉太开就是人在敲键盘，不是枪：清空缓冲，免得半截条码被当成一单。
       *
       * 例外只给老纸：加上这一个键之后仍可能是上一版数字载荷（`1` + 票种位）或 `BH1:` 头
       * （含只打了 B / BH 的开头，也含 Enter 收尾那一步——枪的回车后缀同样可能慢半拍），
       * 按 `PREFIX_GAP_CAP_MS` 放宽。判据必须看"加上这个键之后"的缓冲，看"加之前"会永远
       * 攒不到前缀就被清掉。本版的码没有前缀，不走这条（理由见 `couldBeLegacyTicketBurst`）。
       */
      const next = e.key.length === 1 ? buf.current + e.key : buf.current;
      if (now - last.current > (couldBeLegacyTicketBurst(next) ? PREFIX_GAP_CAP_MS : MAX_GAP_MS)) buf.current = "";
      last.current = now;

      if (e.key === "Enter") {
        const raw = buf.current;
        buf.current = "";
        if (raw.trim()) {
          /**
           * 票面码是纯可见 ASCII（02 §F1.4 契约第 1 条：不许有中文、空格与会被输入法折腾的字符）。
           * 所以串里只要出现非 ASCII，就一定是输入法把按键改写过——实测形态
           * `BH：BD！＠）＠……！）））））%＃`：每个数字都是 Shift+数字 的符号，再被
           * 「中文标点」折成全角。这一类**没有合成事件可抓**（不拼拼音，只换标点），
           * 只能在收尾这一刻认出来，否则磅房看到的只是一句"未知的码格式"加一串乱码。
           */
          if (/[^\x20-\x7e]/.test(raw)) warnImeActive();
          e.preventDefault();
          cb.current(raw);
        }
        return;
      }
      // 方向键、功能键、Tab 之类：这一串已经不是条码了
      if (e.key.length !== 1) {
        buf.current = "";
        return;
      }
      buf.current += e.key;
      if (buf.current.length > MAX_LEN) buf.current = "";
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  return { capturing: enabled };
}
