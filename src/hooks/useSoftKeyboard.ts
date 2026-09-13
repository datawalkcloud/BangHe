/**
 * 软键盘显隐偏好的读写入口（与 `useCloseBehavior` 同一条 `user_preference` 通道）。
 *
 * 字段组件用 `useSoftKeyboardVisible()`：一次查询被多处复用（react-query 按键去重，
 * 一个屏幕几十个数字框也只发一次请求），改值靠 `setQueryData` 立刻回灌，
 * 不等 refetch——否则操作员关掉键盘后会看见按钮还在。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSession } from "@/store/session";
import { parseSoftKeyboard, softKeyboardApi, SOFT_KEYBOARD_KEY } from "@/lib/soft-keyboard";

export function useSoftKeyboardSetting(): {
  enabled: boolean;
  loading: boolean;
  saving: boolean;
  set: (on: boolean) => void;
} {
  const actorId = useSession((s) => s.session?.actor.id ?? null);
  const queryClient = useQueryClient();
  const queryKey = ["pref", SOFT_KEYBOARD_KEY, actorId];

  const query = useQuery({ queryKey, queryFn: () => softKeyboardApi.read(), enabled: actorId != null, staleTime: Infinity });

  const save = useMutation({
    mutationFn: (on: boolean) => softKeyboardApi.write(on),
    onSuccess: (_at, on) => {
      void queryClient.setQueryData(queryKey, JSON.stringify(on));
      toast.success(on ? "已开启：输入框旁恢复显示点选键盘" : "已关闭：界面只留输入框，仍可逐字键入");
    },
    onError: (e: Error) => toast.error(`没能保存：${e.message}`),
  });

  return {
    // 没登录时查询是关掉的，这时按默认值显示：登录页与锁屏本来就没有软键盘
    enabled: actorId == null ? parseSoftKeyboard(undefined) : parseSoftKeyboard(query.data),
    loading: query.isPending,
    saving: save.isPending,
    set: save.mutate,
  };
}

/** 这个界面该不该摆点选键盘。设置页之外只用这一个返回值 */
export function useSoftKeyboardVisible(): boolean {
  return useSoftKeyboardSetting().enabled;
}
