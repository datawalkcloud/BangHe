/**
 * 常驻小表的读取 hook。
 *
 * 品种 / 仓房 / 货位 / 员工 / 站点参数这几张表几乎不变，却又被每个页面用到。
 * 统一在这里出，页面就不必各自 queryKey 拼写，也不会有人绕过 lib/api 去 import mock。
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

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
