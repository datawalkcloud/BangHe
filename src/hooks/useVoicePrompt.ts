/**
 * 磅房语音提示的三个挂载点（发声本体在 `lib/voice-prompt.ts`，规矩都写在那儿，这里只负责"什么时候响"）。
 *
 *  - `useVoicePromptSwitch`：应用根上挂一次，把**最终是否出声**写进语音模块。判据只有一条：
 *    本机偏好 `banghe.voice.enabled` 显式设过就认本机（每台机器自己静音、互不影响，换账号也跟着这台机），
 *    没设过才回落站点参数 `reader_prompt_voice` 作为全站默认。两边都没就绪之前先不出声，免得
 *    站长明明关了、或这台机本来就静音，弹窗仍抢在真值落地前念一句。
 *  - `useVoiceMasterSwitch`：工作台页头的开关，只写这台机的 localStorage，不需要站长权限、不写审计。
 *    它只负责落盘与回填缓存，真正静音仍由根上那一个 effect 做——全应用只有一个 `setPromptVoiceEnabled`。
 *  - `useReaderPromptVoice`：所有"请把卡放到感应区"的读卡监听弹窗共用（`CardScanDialog` 身份证、
 *    `CardBindDialog` 与 `IcScanDialog` 流转卡），弹出念一次、关窗把没念完的半句掐掉。
 *
 * 业务闸门与结果的回话不走这里，直接在决策点调 `announce()`（05 §6.5）。
 */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  readVoiceLocal,
  setPromptVoiceEnabled,
  speakPrompt,
  stopPrompt,
  VOICE_LOCAL_KEY,
  writeVoiceLocal,
} from "@/lib/voice-prompt";
import { useSettings } from "@/hooks/useLookups";

export const PROMPT_VOICE_KEY = "reader_prompt_voice";
/** 本机偏好也走一份查询缓存：根上的 effect 与页头开关共用同一份值，写完回填即全局生效 */
export const VOICE_LOCAL_QUERY_KEY = ["voice-local", VOICE_LOCAL_KEY] as const;

export function useVoiceLocal() {
  return useQuery({
    queryKey: VOICE_LOCAL_QUERY_KEY,
    queryFn: () => readVoiceLocal(),
    staleTime: Infinity,
  });
}

/** "开没开"只有这一条判据：根上的同步 effect 与页头开关共用，别在组件里各算一遍 */
function promptVoiceOn(
  local: boolean | null | undefined,
  data: { key: string; value: string }[],
  isFetched: boolean,
): boolean {
  // 这台机显式选过：自己说了算，站点参数与 setting.write 权限都不再参与
  if (local === true || local === false) return local;
  // 没选过：跟随全站默认；参数还没读回来时按关，免得把"缺省开"当成真值抢跑
  const raw = data.find((s) => s.key === PROMPT_VOICE_KEY)?.value;
  return raw === undefined ? isFetched : raw !== "false";
}

/** 挂在应用根上：本机偏好或全站默认定下来之前，全应用不出声 */
export function useVoicePromptSwitch() {
  const local = useVoiceLocal();
  const { data = [], isFetched } = useSettings();
  const on = promptVoiceOn(local.data, data, isFetched);

  useEffect(() => {
    setPromptVoiceEnabled(on);
    // 从"开"被关掉的这一刻把在播的那句掐了：开关应当立刻见效，不等下一句念完
    if (!on) stopPrompt();
  }, [on]);
}

/**
 * 工作台页头的本机语音开关。写的是这台机的 localStorage（每台机器互不影响），
 * 回填 `voice-local` 缓存让根上那一个 effect 看到新值。不在这里直接调 `setPromptVoiceEnabled`
 * ——那会多出第二个写入方，两处迟早打架。
 */
export function useVoiceMasterSwitch() {
  const local = useVoiceLocal();
  const { data = [], isFetched } = useSettings();
  const queryClient = useQueryClient();
  const on = promptVoiceOn(local.data, data, isFetched);
  /** 这台机是否显式设过（用于在 UI 上写清"本机已定，不随全站变"） */
  const overridden = local.data === true || local.data === false;

  const set = (next: boolean) => {
    try {
      writeVoiceLocal(next);
      // 回填而不只是 invalidate：立刻让根上的 effect 把在播的那句掐掉，别等下一轮渲染
      queryClient.setQueryData(VOICE_LOCAL_QUERY_KEY, next);
    } catch (e) {
      toast.error(`本机语音开关没能保存：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return { on, overridden, set };
}

/** 读卡弹窗弹出时念那一句（`text` 与该弹窗标题同源，见各弹窗里的 VOICE_ALOUD） */
export function useReaderPromptVoice(open: boolean, text: string) {
  useEffect(() => {
    if (!open) return;
    speakPrompt(text);
    return () => stopPrompt();
  }, [open, text]);
}
