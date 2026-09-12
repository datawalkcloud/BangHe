/**
 * 磅房语音提示：把"下一步该干什么、这一步成没成"用本机扬声器念出来（05 §6.5）。
 *
 * 为什么必须有声音：读卡器装在窗口外、地磅在窗外十几米，操作员的眼睛盯着车和仪表，而且
 * 大多是上了年纪的——**屏幕上那行 toast 根本没人在看**。05 §1 早写了"关键反馈不能只靠视觉"，
 * 这一层就是把它补齐：弹窗弹出念一句"请把卡放上去"，闸门拦下念一句"读数没稳，等车停稳"，
 * 落库成功念一句"毛重已捕获"。
 *
 * 发声走 WebView2 的平台语音合成（`window.speechSynthesis`，即 Windows 自带的中文语音包）：
 * 不联网、不引第三方 TTS、不加音频资源包。它与 07 篇那条「功放 + 音柱 + 片段包」的喊话链路是
 * **两条独立通路**——这里只管"弹窗与工作台就在这台机器上"的近场提示，不进车间大喇叭、不参与
 * 07 §3 的通道仲裁、也不需要 07 §5.3 的片段工装。将来 PA 链路落地后要不要把这些话也喂进功放
 * （07 §2.1 接法 A 的线路输出天然会带上），届时候再定，这里不预先接线。
 *
 * 五条硬规矩，全部在本文件这一处实现，调用侧不许各自再加一层判断：
 *  ① **只播动作与结论，不播编号与数字**：卡号是一串十六进制、重量是定点小数，念出来既听不懂
 *     又拖长句子；编号与数值由屏幕和码单承担（要把数字念成人话是 07 §5.4 的中文位值读法，
 *     属于功放链路，不在这里做）。姓名同样不播——本机喇叭也是在磅房里公开响（07 H12 那条合规线）。
 *  ② 一次只念一句：投递前先掐掉上一句，连着出两件事不许叠音（半句叠半句等于没说）。
 *  ③ **同一件事 3 秒内不重念**：卡压在感应区不动、或连点两次按钮时，别把喇叭变成复读机。
 *     去重键沿用那条 toast 已经在用的 `sticky(id)`，两边说的是同一件事，不另立一套编号。
 *  ④ **绝不允许静默失败**：接口不在、或本机没有中文语音包（英文引擎念中文只会不出声）时降级成
 *     两声提示音，并把"为什么不是人声"上一条说明，一次会话只说一次。
 *  ⑤ 全链路不抛异常——喇叭坏了不许开不了单（07 §4.2 G9 同一条理由）。
 */
import { toast } from "sonner";

/** 一次播报的结局：`off` 是开关关着或正在节流，其余三种是实际投递结果 */
export type PromptResult =
  | { kind: "off" }
  | { kind: "speech" }
  | { kind: "tone"; reason: string }
  | { kind: "silent"; reason: string };

const ZH_LANG = /^zh([-_]|$)/i;

/** 同一去重键两次播报的最小间隔：短到不耽误"又刷了一次"，长到压得住卡不动时的连发 */
const ANNOUNCE_GAP_MS = 3_000;

/**
 * 站点参数 `reader_prompt_voice` 同步进来的总闸。**未同步前按关处理**：参数还没读回来时不出声，
 * 免得站长明明关掉了开关、弹窗仍抢在参数落地前念一句。写入方只有 `useVoicePromptVoice`
 * （挂在应用根上，一次），别处不许直接改。
 */
let enabled = false;
const lastSpoken = new Map<string, number>();
let zhVoice: SpeechSynthesisVoice | null = null;
/** 语音表已加载完（Chromium 首次 `getVoices()` 常常回空，要等 `voiceschanged`） */
let voicesLoaded = false;
/** 规矩④那条说明，一次会话只上一条 */
let degradedNoticed = false;

function refreshVoices() {
  const list = typeof window !== "undefined" ? window.speechSynthesis?.getVoices?.() : undefined;
  if (!list || list.length === 0) return; // 还没加载好：保持 voicesLoaded=false，等回调再来一趟
  voicesLoaded = true;
  zhVoice = list.find((v) => !!v.lang && ZH_LANG.test(v.lang)) ?? null;
}

if (typeof window !== "undefined" && "speechSynthesis" in window) {
  refreshVoices();
  // 用 addEventListener 而不是赋 onvoiceschanged：那是共享对象，别处的回调不该被我们顶掉
  window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
}

/** 由 `useVoicePromptVoice` 在站点参数读回来后写入；关掉即这台机彻底不出声 */
export function setPromptVoiceEnabled(v: boolean) {
  enabled = v;
}

/** 提示音：两声上行"叮咚"。单声太像系统通知，磅房里容易被直接忽略 */
let audioCtx: AudioContext | null = null;

function playTone(): boolean {
  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return false;
    audioCtx ??= new Ctor();
    const ctx = audioCtx;
    // 触发点基本都是点按钮/刷卡带出来的，这一下就是用户手势，被自动播放策略挂起的上下文这里能救回来
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    [880, 1174.66].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = now + i * 0.18;
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.16);
    });
    return true;
  } catch {
    return false; // 没有输出设备 / WebAudio 被禁：交给规矩④说清"这台机出不了声"
  }
}

/** 规矩④：出不了人声就上一条说明，只说一次，并给出恢复办法，不留"它为什么不说话"的猜疑 */
function noticeDegraded(res: PromptResult) {
  if (res.kind !== "tone" && res.kind !== "silent") return;
  if (degradedNoticed) return;
  degradedNoticed = true;
  if (res.kind === "tone") {
    toast.warning(`语音提示改用提示音：${res.reason}`, {
      description: "在 Windows「设置 · 时间和语言 · 语音」里添加中文语音后即可恢复人声播报。",
      id: "voice-prompt-degraded",
    });
  } else {
    toast.error(`语音提示没能出声：${res.reason}`, {
      description: "不影响读卡、称重与结算本身；检查一下这台机的扬声器是否接好。",
      id: "voice-prompt-degraded",
    });
  }
}

/** 投递批次号。推迟那 60 ms 里可能弹窗已关、或又冒出下一件事：每次投递与每次 stopPrompt 都推进它 */
let speakSeq = 0;
/**
 * 当前这句是不是"弹窗提示"。关窗只该掐掉弹窗那句"请将卡放到感应区"（人已经把卡放上去了，
 * 再念就是抢话），**不该把刚播出去的业务回话一起吞掉**——绑卡框读到卡是先 `announce` 再关框，
 * 无差别 cancel 会把"卡读到了，正在取号制单"念成半句"卡读到……"。
 * 弹窗提示与业务回话的分界就是有没有去重键：`speakPrompt` 不带，`announce` 必带。
 */
let promptOwned = false;

/**
 * 投递一句话。两处都不是多余的：
 *  - **有在播/待播内容时先 `cancel()`，但那一下不能同 tick 接 `speak()`**——Chromium（含 WebView2）
 *    有个老毛病：`cancel()` 紧跟 `speak()` 会把新这一句吞掉，表现成"偶发不出声"。所以推迟 60 ms，
 *    现场听不出来，却把这条坑绕开；空闲时照旧立即投，不多等这 60 ms。
 *  - `resume()`：引擎起播时偶发处于 paused（页面切走过一轮），不 resume 就永远等不到声音。
 */
function deliver(synth: SpeechSynthesis, u: SpeechSynthesisUtterance) {
  const seq = ++speakSeq;
  const speak = () => {
    if (seq !== speakSeq) return;
    try {
      synth.resume();
      synth.speak(u);
    } catch {
      /* 出声失败不阻断业务，说明由 noticeDegraded 负责 */
    }
  };
  if (synth.speaking || synth.pending) {
    synth.cancel();
    window.setTimeout(speak, 60);
  } else {
    speak();
  }
}

/**
 * 念一句话（同步返回结局，不 await——语音投递是异步的，念到一半被下一句掐掉是常态）。
 * 给了 `key` 就走规矩③的节流；不给则每次调用都念（弹窗提示那种"开一次框念一次话"）。
 */
function say(text: string, key?: string): PromptResult {
  if (!enabled) return { kind: "off" };
  if (key) {
    const now = Date.now();
    const prev = lastSpoken.get(key);
    if (prev != null && now - prev < ANNOUNCE_GAP_MS) return { kind: "off" };
    // 一台磅房机一天也轮不到几百件事，键位攒着不清也有限；不为这点内存引入淘汰策略
    lastSpoken.set(key, now);
  }
  promptOwned = !key; // 弹窗提示不带键、业务回话必带键：关窗只掐前者（见 stopPrompt）
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  let res: PromptResult;
  if (!synth) {
    const reason = "这台机的界面没有语音合成接口";
    res = playTone() ? { kind: "tone", reason } : { kind: "silent", reason: `${reason}，提示音也无法播放` };
  } else {
    try {
      if (!voicesLoaded) refreshVoices();
      if (voicesLoaded && zhVoice) {
        const u = new SpeechSynthesisUtterance(text);
        u.voice = zhVoice;
        u.lang = zhVoice.lang;
        u.rate = 0.95; // 略慢半拍：磅房背景噪声大，操作员与农户都以中老年为主
        u.pitch = 1;
        u.volume = 1;
        deliver(synth, u);
        res = { kind: "speech" };
      } else {
        synth.cancel(); // 规矩②：没有可用的中文声音时也把上一句掐掉，别留半句在放
        const reason = voicesLoaded
          ? "本机没有安装中文语音包（英文引擎念不出中文）"
          : "本机没有可用的中文语音包（或语音包尚未就绪）";
        res = playTone() ? { kind: "tone", reason } : { kind: "silent", reason: `${reason}，提示音也无法播放` };
      }
    } catch {
      res = { kind: "silent", reason: "语音合成调用失败" };
    }
  }
  noticeDegraded(res);
  return res;
}

/**
 * 弹窗提示语音：读卡类监听弹窗弹出那一刻念"请将卡放到感应区"那一句。
 * 只经 `useReaderPromptVoice` 调；业务事件的回话走 `announce`，两者共用同一个总闸与同一条降级路。
 */
export function speakPrompt(text: string): PromptResult {
  return say(text);
}

/**
 * 业务事件播报：闸门拦下、重量落库、发卡成功这类"干完一件事的回话"。
 * `key` 传调用侧那条 toast 已经在用的 `sticky(id)`——同一件事在屏幕上只占一个位置，
 * 在喇叭里也只占一个位置（规矩③）。没有现成 id 就省略，按整句话去重。
 *
 * ```ts
 * toast.warning("读数未稳，请等车停稳再刷", sticky(`ic-scale:${o.order_no}`));
 * announce("读数还没稳定，等车停稳再刷一次", `ic-scale:${o.order_no}`);
 * ```
 */
export function announce(text: string, key?: string): PromptResult {
  return say(text, key ?? text);
}

/** 掐掉在播的那一句：读卡弹窗关闭时必调，免得人都关窗了半句"请将身份证……"还在念 */
export function stopPrompt() {
  if (!promptOwned) return; // 在播的是业务回话（"卡读到了，正在取号制单"）就让它念完，别念半句
  promptOwned = false;
  speakSeq++; // 顺带作废还在推迟里没投出去的那一句
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* 不出声不该是故障 */
  }
}
