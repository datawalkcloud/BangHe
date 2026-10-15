/**
 * 主窗口关闭行为的读写入口（同 `useWorkstationLayout` 的口径：按账号读一次，改了写一次）。
 *
 * 写入即生效——Rust 每次收到关闭请求都现读这一行，所以这里不需要"通知后端"，
 * 也不需要在前端缓存一份判定结果。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSession } from "@/store/session";
import { CLOSE_BEHAVIOR_KEY, parseCloseBehavior, windowApi, type CloseBehavior } from "@/lib/window-native";

export interface CloseBehaviorState {
  /**
   * 当前生效的行为。**没存过**是默认值（`hide`，藏进托盘）；
   * 没登录、或库里那行认不出来，都是 `exit`——与 Rust `window::close_behavior` 的回落口径一致。
   */
  behavior: CloseBehavior;
  /** 首次读偏好的过程中为 true；此时界面上的选项还不能反映库里的值 */
  loading: boolean;
  saving: boolean;
  set: (next: CloseBehavior) => void;
}

export function useCloseBehavior(): CloseBehaviorState {
  const actorId = useSession((s) => s.session?.actor.id ?? null);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["pref", CLOSE_BEHAVIOR_KEY, actorId],
    queryFn: () => windowApi.readCloseBehavior(),
    enabled: actorId != null,
    staleTime: Infinity,
  });

  const save = useMutation({
    mutationFn: (next: CloseBehavior) => windowApi.writeCloseBehavior(next),
    onSuccess: (_at, next) => {
      // 直接把新值塞回查询：等 invalidate 再读一次的话，选项会在旧值上多停一拍
      void queryClient.setQueryData(["pref", CLOSE_BEHAVIOR_KEY, actorId], JSON.stringify(next));
      toast.success(next === "hide" ? "已保存：点关闭窗口会藏进右下角托盘" : "已保存：点关闭窗口会退出程序");
    },
    onError: (e: Error) => toast.error(`关闭行为没能保存：${e.message}`),
  });

  return {
    // 没登录时查询是关掉的（`enabled`），但 Rust 侧这时一律按退出处理——
    // 界面要跟着显示"退出程序"，否则卡片高亮在隐藏、实际却是退出，是骗人的
    behavior: actorId == null ? "exit" : parseCloseBehavior(query.data),
    loading: query.isPending,
    saving: save.isPending,
    set: save.mutate,
  };
}
