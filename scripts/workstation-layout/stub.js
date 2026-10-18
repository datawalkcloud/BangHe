export const api = { getPref: async () => null, setPref: async () => null };
export function useSession() { return null; }
export function actorId() { return 1; }
export const verticalCompactor = { compact: (items) => [...items].sort((a, b) => a.y - b.y || a.x - b.x) };
export function useQuery() { return { data: undefined, isFetched: true, isError: false, refetch: () => {} }; }
export function useMutation(o) { return { mutate: (x) => o.mutationFn(x), isPending: false }; }
/**
 * `useWorkstationLayout` 只用到 `setQueryData`（把解析好的布局回填给查询缓存）。
 * 这个导出是补上的：`layout.ts` 引入 `useQueryClient` 时没同步这里，esbuild 直接
 * 报 "No matching export"，整份布局守卫从那时起就没再跑起来过。
 */
export function useQueryClient() { return { setQueryData: () => {}, invalidateQueries: () => {} }; }
export const toast = { error: (m) => console.log("[toast.error]", m), success: (m) => console.log("[toast.success]", m), info: () => {}, warning: () => {} };
