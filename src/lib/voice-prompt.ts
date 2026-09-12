/**
 * 弹窗提示语音：把"该放卡了"这句话用本机扬声器播出去（05 §6.5）。
 *
 * 为什么必须有声音：读卡器在窗口外，农户不知道什么时候该把证件放上去，磅房隔着玻璃
 * 与一台发动着的车，光靠屏幕上一行小字谁也看不见；弹窗一开先念一句，操作员就不必每单
 * 扯着嗓子喊一次"放卡"。
 *
 * 发声走 WebView2 的平台语音合成（`window.speechSynthesis`，即 Windows 自带的中文语音包）：
 * 不联网、不引第三方 TTS、不加音频资源包。它与 07 篇那条「功放 + 音柱 + 片段包」的喊话链路
 * 是**两条独立通路**——这里只管"弹窗就在本机屏幕上"的近场提示，不进车间大喇叭、不参与 §3 的
 * 通道仲裁，也不需要 07 §5.3 的片段工装。将来 PA 链路落地后要不要把它也喂进功放（§2.1 接法 A
 * 的线路输出天然会带上），届时候再定，这里不预先接线。
 *
 * 三条硬规矩：
 *  ① 先 `cancel()` 再播，一次只念一句——连着开两个窗不许叠音（半句人话叠半句人话等于没说）；
 *  ② **绝不允许静默失败**：接口不在、或本机压根没有中文语音包（英文引擎念中文只会不出声）时
 *     改播一声提示音，并把"为什么不是人声"交回调用方上屏（`useReaderPromptVoice`），不静默；
 *  ③ 全链路不抛异常——喇叭坏了不许开不了单（07 §4.2 G9 同一条理由）。
 */

/** 一次播报的结局：`speech` 人声已投递，`tone` 降级为提示音，`silent` 连提示音也没出声 */
export type PromptResult =
  | { kind: "speech" }
  | { kind: "tone"; reason: string }
  | { kind: "silent"; reason: string };

const ZH_LANG = /^zh([-_]|$)/i;

let zhVoice: SpeechSynthesisVoice | null = null;
/** 语音表已加载完（Chromium 首次 `getVoices()` 常常回空，要等 `voiceschanged`） */
let voicesLoaded = false;

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

/** 提示音：两声上行"叮咚"。单声太像系统通知，磅房里容易被直接忽略 */
let audioCtx: AudioContext | null = null;

function playTone(): boolean {
  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return false;
    audioCtx ??= new Ctor();
    const ctx = audioCtx;
    // 弹窗由点按钮带出来，这一下就是用户手势，被自动播放策略挂起的上下文在这里能.resume 成功
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
    return false; // 没有输出设备 / WebAudio 被禁：交回调用方说清"这台机出不了声"
  }
}

/**
 * 播一句提示语音（同步返回结局，不 await——语音投递本身是异步的，念到一半被下一次 cancel 掉是常态）。
 * 只有 `useReaderPromptVoice` 该调它；别处要提示语音请走同一个 hook，口径只留一处。
 */
export function speakPrompt(text: string): PromptResult {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (synth) {
    try {
      if (!voicesLoaded) refreshVoices();
      if (voicesLoaded && zhVoice) {
        const u = new SpeechSynthesisUtterance(text);
        u.voice = zhVoice;
        u.lang = zhVoice.lang;
        u.rate = 0.95; // 略慢半拍：磅房背景噪声大，农户以中老年为主
        u.pitch = 1;
        u.volume = 1;
        deliver(synth, u);
        return { kind: "speech" };
      }
      synth.cancel(); // 规矩①：把上一句没念完的掐掉，别叠音
    } catch {
      // 落到下面的提示音，不静默
    }
  }
  const reason = !synth
    ? "这台机的界面没有语音合成接口"
    : !voicesLoaded
      ? "本机没有可用的中文语音包（或语音包尚未就绪）"
      : "本机没有安装中文语音包（英文引擎念不出中文）";
  return playTone() ? { kind: "tone", reason } : { kind: "silent", reason: `${reason}，提示音也无法播放` };
}

/**
 * 投递批次号。推迟那 60 ms 里可能弹窗已经关掉、或又开出了下一个窗：
 * 每次投递与每次 `stopPrompt` 都推进它，真正 `speak()` 前对一下号，过期的那一句直接作废，
 * 免得人都关窗了才响半句"请将身份证……"。
 */
let speakSeq = 0;

/**
 * 投递一句话。两处都不是多余的：
 *  - **有在播/待播内容时先 `cancel()`，但那一下不能同 tick 接 `speak()`**——Chromium（含 WebView2）
 *    有个老毛病：`cancel()` 紧跟 `speak()` 会把新这一句直接吞掉，表现成"偶发不出声"。所以推迟 60 ms，
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
      /* 出声失败不阻断弹窗，降级说明由调用侧的 toast 负责 */
    }
  };
  if (synth.speaking || synth.pending) {
    synth.cancel();
    window.setTimeout(speak, 60);
  } else {
    speak();
  }
}

/** 掐掉在播的那一句：弹窗关闭时必调，免得用户都关窗了半句"请将身份证……"还在念 */
export function stopPrompt() {
  speakSeq++; // 顺带作废还在推迟里没投出去的那一句
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* 不出声不该是故障 */
  }
}
