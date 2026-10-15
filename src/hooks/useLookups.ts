/**
 * 常驻小表的读取 hook。
 *
 * 品种 / 仓房 / 货位 / 员工 / 站点参数这几张表几乎不变，却又被每个页面用到。
 * 统一在这里出，页面就不必各自 queryKey 拼写，也不会有人绕过 lib/api 去 import mock。
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { QuickOptionKind } from "@/lib/constants";

export function useStaff() {
  return useQuery({ queryKey: ["staff"], queryFn: () => api.staff(), staleTime: 300_000 });
}

/** id → 姓名，署名栏与"经手人"列都用它 */
export function useStaffNames(): (id: number | null | undefined) => string {
  const { data = [] } = useStaff();
  const map = new Map(data.map((u) => [u.id, u.display_name]));
  return (id) => (id == null ? "—" : (map.get(id) ?? `#${id}`));
}

export function useVarieties() {
  return useQuery({ queryKey: ["varieties"], queryFn: () => api.varieties(), staleTime: 300_000 });
}

export function useWarehouses() {
  return useQuery({ queryKey: ["warehouses"], queryFn: () => api.warehouses(), staleTime: 300_000 });
}

export function useSlots() {
  return useQuery({ queryKey: ["slots"], queryFn: () => api.slots(), staleTime: 300_000 });
}

export function usePrices() {
  return useQuery({ queryKey: ["prices"], queryFn: () => api.prices(), staleTime: 60_000 });
}

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: () => api.settings(), staleTime: 300_000 });
}

/** 站点参数取值：布尔与数值在这里收敛一次，页面不写 Number(...) */
export function useSetting(key: string): { raw: string | undefined; num: number; bool: boolean } {
  const { data = [] } = useSettings();
  const raw = data.find((s) => s.key === key)?.value;
  return {
    raw,
    num: raw == null ? 0 : Number(raw) || 0,
    bool: raw === "true" || raw === "1",
  };
}

export function useStation() {
  return useQuery({ queryKey: ["station"], queryFn: () => api.station(), staleTime: Infinity });
}

/* ------------------------------------------------------ 常用语快捷选项 */

/** 整表缓存（含停用行）；后台维护页与六个下拉共用同一份缓存，改完失效一次全体刷新 */
export function useAllQuickOptions() {
  return useQuery({ queryKey: ["quick-options"], queryFn: () => api.quickOptions(), staleTime: 300_000 });
}

/**
 * 某个分类当前可用的下拉候选（已启用、按 sort_order）。
 *
 * 落库是自由文本，这里只是给 ComboBox 备选；取不到（首帧未加载完）就回空数组，
 * 文本框照旧能打字，不做前端常量兜底——站长把某类删空就该真的没有候选。
 */
export function useQuickOptions(kind: QuickOptionKind) {
  const { data = [], ...rest } = useAllQuickOptions();
  const options = useMemo(
    () =>
      data
        .filter((r) => r.kind === kind && r.is_active === 1)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((r) => ({ label: r.label, value: r.value })),
    [data, kind],
  );
  return { options, ...rest };
}
