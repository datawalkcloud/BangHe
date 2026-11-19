/**
 * 磅房工作台的工作模式（入库 / 出库），存在 §9.25 `user_preference` 的 `workstation.mode`。
 *
 * 为什么是个人偏好而不是站点参数：同一台磅房机上，磅员按收购流程干活、值仓按出库流程干活，
 * 两个人轮班时不希望对方把默认模式改掉。口径与工作台布局（`workstation.layout`）一致——
 * 跟人走，不跟机器走；全站一份的参数页也不该被一个界面开关淹掉。
 *
 * **默认入库**：升级后第一次进工作台看到的就是原来那张脸，出库模式要自己切过去。
 * 值的解析只认存进去的 `"in"` / `"out"`；读不出或存了别的东西一律回落默认值。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { prefsApi } from "@/lib/prefs-native";
import { useSession } from "@/store/session";

/** 偏好键。键名口径要过 `prefs.rs::check_key`：小写字母起始，可含 `.` `_` `-` */
export const WORKSTATION_MODE_KEY = "workstation.mode";

export type WorkstationMode = "in" | "out";

export const DEFAULT_WORKSTATION_MODE: WorkstationMode = "in";

export function parseWorkstationMode(raw: string | null | undefined): WorkstationMode {
  if (raw == null) return DEFAULT_WORKSTATION_MODE;
  try {
    const v: unknown = JSON.parse(raw);
    return v === "in" || v === "out" ? v : DEFAULT_WORKSTATION_MODE;
  } catch {
    return DEFAULT_WORKSTATION_MODE;
  }
}

export function useWorkstationMode(): {
  mode: WorkstationMode;
  /** 本人那份偏好还没读回来：这一刻的 `mode` 只是默认值，别拿它做写库级别的事 */
  loading: boolean;
  saving: boolean;
  set: (mode: WorkstationMode) => void;
} {
  const actorId = useSession((s) => s.session?.actor.id ?? null);
  const queryClient = useQueryClient();
  const queryKey = ["pref", WORKSTATION_MODE_KEY, actorId];

  const query = useQuery({
    queryKey,
    queryFn: () => prefsApi.getPref(WORKSTATION_MODE_KEY),
    enabled: actorId != null,
    staleTime: Infinity,
  });

  const save = useMutation({
    mutationFn: (next: WorkstationMode) => prefsApi.setPref(WORKSTATION_MODE_KEY, JSON.stringify(next)),
    // 回填同一份值：切页面回来时 `staleTime: Infinity` 不会再取，不回填就会看到旧模式
    onSuccess: (_at, next) => void queryClient.setQueryData(queryKey, JSON.stringify(next)),
    onError: (e: Error) => toast.error(`工作模式没能保存：${e.message}`),
  });

  return {
    mode: actorId == null ? parseWorkstationMode(undefined) : parseWorkstationMode(query.data),
    loading: actorId != null && query.isPending,
    saving: save.isPending,
    set: save.mutate,
  };
}