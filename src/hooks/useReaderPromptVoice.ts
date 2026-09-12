/**
 * 读卡弹窗提示语音（05 §6.5）——所有"请把卡放到感应区"的监听弹窗共用这一条入口：
 * `CardScanDialog`（身份证）、`CardBindDialog` 与 `IcScanDialog`（流转卡）。
 *
 * 判断只留这一处，弹窗里不许各自再拼一层：
 *  - 站点参数 `reader_prompt_voice` 关掉即彻底静音；参数**还没读回来时先不出声**（免得站长
 *    明明关了开关仍抢跑念一句），读回来确认库里没有这个键才按默认的「开」走（与
 *    `card_required_on_create` 同一口径：这类默认要出声的功能，静默才是故障）；
 *  - 弹窗一开播一次，关窗即把没念完的半句掐掉；
 *  - 播不出人声时（无语音接口 / 无中文语音包）`voice-prompt` 内部降级成提示音，
 *    这里把"为什么不是人声"用 toast 说清楚，**只说一次**——每次弹卡框都念一遍检讨
 *    等于把提示语音变成新的噪声源。
 */
import { useEffect } from "react";
import { toast } from "sonner";
import { speakPrompt, stopPrompt } from "@/lib/voice-prompt";
import { useSettings } from "@/hooks/useLookups";

/** 降级说明一次会话只上一条：操作员知道就行了，不必每单被提醒"我这台机没人声" */
let degradedNoticed = false;

export function useReaderPromptVoice(open: boolean, text: string) {
  /**
   * 不用 `useSetting().bool`，因为它在参数读回来之前恒为 false——那是"缺省关"，
   * 而这里要的是"缺省开"（关了就彻底静音、开了库里没这个键也照播）。
   * 更要紧的是躲开一个竞态：参数还没到就先出声，站长明明关掉了开关，
   * 弹窗还是会抢在参数落地前念一句"请将身份证放到……"。所以先等 `isFetched`。
   */
  const { data = [], isFetched } = useSettings();
  const raw = data.find((s) => s.key === "reader_prompt_voice")?.value;
  const enabled = raw === undefined ? isFetched : raw !== "false";

  useEffect(() => {
    if (!open || !enabled) return;
    const res = speakPrompt(text);
    if (res.kind !== "speech" && !degradedNoticed) {
      degradedNoticed = true;
      if (res.kind === "tone") {
        toast.warning(`读卡提示改用提示音：${res.reason}`, {
          description: "在 Windows「设置 · 时间和语言 · 语音」里添加中文语音后即可恢复人声播报。",
          id: "reader-prompt-degraded",
        });
      } else {
        toast.error(`读卡提示没能出声：${res.reason}`, {
          description: "不影响读卡与制单本身；检查一下这台机的扬声器是否接好。",
          id: "reader-prompt-degraded",
        });
      }
    }
    return () => stopPrompt();
  }, [open, enabled, text]);
}
