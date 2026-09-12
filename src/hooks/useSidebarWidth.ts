/**
 * 侧栏展开宽度：跟着账号走的一份界面偏好，键 `sidebar.width`（05 §7.3 只定了 240/56 两档，
 * 拖动之后停在哪儿得记下来，否则下次进来又跳回 240）。
 *
 * 归属上它和主题一样是"只作用本机"的显示偏好，不是站点参数，也不进审计——
 * 所以走 `user_preference` 通道（`lib/prefs-native.ts`），浏览器预览回落 localStorage。
 *
 * 写入时机很关键：拖动中每帧都在改宽度，只有**松手**那一次才落库，
 * 不然一次拖动就是几十次写。拖动本身由 `SidebarProvider` 的 `onWidthChange` 承担，
 * 这里只负责初值、夹紧与保存。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useSession } from "@/store/session";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "@/components/ui/sidebar";

export const SIDEBAR_WIDTH_KEY = "sidebar.width";
/** 展开态出厂宽度（05 §7.3 的 240） */
export const SIDEBAR_DEFAULT_WIDTH = 240;

/** 库里那份可能是旧值，也可能是被人改坏的值，读回来都得夹一道 */
const clampWidth = (w: number) =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(w)));

export function useSidebarWidth() {
  const actorId = useSession((s) => s.session?.actor.id ?? null);

  const query = useQuery({
    queryKey: ["pref", SIDEBAR_WIDTH_KEY, actorId],
    queryFn: () => api.getPref(SIDEBAR_WIDTH_KEY),
    enabled: actorId != null,
    staleTime: Infinity,
  });

  const [width, setWidth] = useState(SIDEBAR_DEFAULT_WIDTH);

  // 只在"这个账号的第一份数据到了"时采纳历史宽度：之后无论怎么重取，
  // 都不能把用户刚拖出来的宽度盖回去
  const hydratedFor = useRef<typeof actorId>(null);
  useEffect(() => {
    if (actorId == null || !query.isFetched) return;
    if (hydratedFor.current === actorId) return;
    hydratedFor.current = actorId;
    const stored = Number.parseFloat(query.data ?? "");
    setWidth(Number.isFinite(stored) ? clampWidth(stored) : SIDEBAR_DEFAULT_WIDTH);
  }, [actorId, query.isFetched, query.data]);

  const save = useMutation({
    mutationFn: (next: number) => api.setPref(SIDEBAR_WIDTH_KEY, String(next)),
    onError: (e: Error) =>
      toast.error(`侧栏宽度没能保存：${e.message}（本机仍生效，重启后可能回到原样）`),
  });
  const persist = save.mutate;

  /** 手势结束那次调用：先上屏再落库，界面不等网络 */
  const commit = useCallback(
    (next: number) => {
      const w = clampWidth(next);
      setWidth(w);
      persist(w);
    },
    [persist],
  );

  return { width, setWidth, commit };
}
