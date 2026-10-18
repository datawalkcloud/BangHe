/**
 * 磅房语音提示的两个挂载点（发声本体在 `lib/voice-prompt.ts`，规矩都写在那儿，这里只负责"什么时候响"）。
 *
 *  - `useVoicePromptSwitch`：应用根上挂一次，把站点参数 `reader_prompt_voice` 同步进语音模块。
 *    判断只留这一处，弹窗与事件播报共用同一个闸——**参数没读回来之前先不出声**，免得站长明明
 *    关了开关，弹窗还抢在参数落地前念一句；读回来确认库里没有这个键才按默认的「开」走
 *    （与 `card_required_on_create` 同一口径：这类默认要出声的功能，静默才是故障）。
 *  - `useReaderPromptVoice`：所有"请把卡放到感应区"的读卡监听弹窗共用（`CardScanDialog` 身份证、
 *    `CardBindDialog` 与 `IcScanDialog` 流转卡），弹出念一次、关窗把没念完的半句掐掉。
 *
 * 业务闸门与结果的回话不走这里，直接在决策点调 `announce()`（05 §6.5）。
 */
import { useEffect } from "react";
import { setPromptVoiceEnabled, speakPrompt, stopPrompt } from "@/lib/voice-prompt";
import { useSettings } from "@/hooks/useLookups";

export const PROMPT_VOICE_KEY = "reader_prompt_voice";

/** 挂在应用根上：参数读回来（或读回来发现库里没这个键）之前，全应用不出声 */
export function useVoicePromptSwitch() {
  // 不用 useSetting().bool：它在参数读回来之前恒为 false，那是"缺省关"，而这里要的是"缺省开"
  const { data = [], isFetched } = useSettings();
  const raw = data.find((s) => s.key === PROMPT_VOICE_KEY)?.value;
  const on = raw === undefined ? isFetched : raw !== "false";

  useEffect(() => {
    setPromptVoiceEnabled(on);
    // 从"开"被关掉的这一刻把在播的那句掐了：开关应当立刻见效，不等下一句念完
    if (!on) stopPrompt();
  }, [on]);
}

/** 读卡弹窗弹出时念那一句（`text` 与该弹窗标题同源，见各弹窗里的 VOICE_ALOUD） */
export function useReaderPromptVoice(open: boolean, text: string) {
  useEffect(() => {
    if (!open) return;
    speakPrompt(text);
    return () => stopPrompt();
  }, [open, text]);
}
