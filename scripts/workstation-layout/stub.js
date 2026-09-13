export const api = { getPref: async () => null, setPref: async () => null };
export function useSession() { return null; }
export function actorId() { return 1; }
export const verticalCompactor = { compact: (items) => [...items].sort((a, b) => a.y - b.y || a.x - b.x) };
export function useQuery() { return { data: undefined, isFetched: true, isError: false, refetch: () => {} }; }
export function useMutation(o) { return { mutate: (x) => o.mutationFn(x), isPending: false }; }
export const toast = { error: (m) => console.log("[toast.error]", m), success: (m) => console.log("[toast.success]", m), info: () => {}, warning: () => {} };
