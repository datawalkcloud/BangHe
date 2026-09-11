/**
 * 磅房工作台的自定义布局（05 §4.1）。
 *
 * 一句话口径：**排布跟人走，不跟机器走**。磅员把称重区拉成半屏、化验员把化验区挪到
 * 首屏左上、站长保留默认三栏，三个人同一台磅房机互不影响；换个账号登录仍是各自那一套。
 * 所以值存 §9.25 `user_preference`（按 user_id + key 一行），而不是 localStorage——
 * 磅房机是轮班共用的，存在本机等于第二天就换个人把他排好的界面覆盖了。
 *
 * 网格参数只有两个是要紧的：
 *  - **12 列 × 24 行是固定预算**。行高由容器实际高度换算（见 WorkstationGrid），
 *    所以同一份布局在 1080p 和 2K 屏上是同一张脸，只是每块各自长高一点，
 *    不需要"每套分辨率存一份"那类额外状态。
 *  - **存的是 x/y/w/h，单位是格**。默认排布就是原来写死的三栏（3 / 6 / 3 列），
 *    老用户升级后看到的还是熟悉的界面，只是这次能动。
 *
 * 读回来的值一律过 `parseDoc`：键不认识就丢、数字越界就夹、互相压字（手工改脏的 JSON）
 * 整份退回默认。库里的文本可能被旧版本或人写过，宁可退回默认也不能让工作台开不起来——
 * 磅员手里正压着一车粮，界面渲染不出来比布局丢了严重得多。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Layout, LayoutItem } from "react-grid-layout";
import { api } from "@/lib/api";
import { useSession } from "@/store/session";

/** 服务端 §9.25 里的偏好键，字符集要与 `prefs.rs::check_key` 兼容 */
export const LAYOUT_KEY = "workstation.layout";

export const GRID_COLS = 12;
/** 行预算。行高按视口换算，24 行恒等于铺满工作区 */
export const GRID_ROWS = 24;
export const GRID_MARGIN: readonly [number, number] = [8, 8];
/** 低于此宽度不铺网格，退回单列纵向堆叠（1280 以下三栏本来就挤） */
export const GRID_MIN_WIDTH = 1280;
/** 停手多久后落库。太短等于每帧一写，太长会让"拖完马上关窗口"丢掉布局 */
const SAVE_DEBOUNCE_MS = 400;

export type PanelId = "identity" | "tare" | "camera" | "weigh" | "qc" | "settle";

export interface PanelSpec {
  id: PanelId;
  /** 编辑态把手上显示的名字，与面板自己 CardTitle 一致（含 05 §4 的序号） */
  title: string;
  /** 面板选择菜单里的副文案：这块是干什么的 */
  hint: string;
  /** 默认格位，就是接真库以前那三栏的样子 */
  box: { x: number; y: number; w: number; h: number };
  /** 再小就没法用了：称重区要容得下读数，结算区要容得下算价表 */
  min: { w: number; h: number };
}

export const PANELS: readonly PanelSpec[] = [
  { id: "identity", title: "① 身份与制单", hint: "读卡、选农户、取号制单", box: { x: 0, y: 0, w: 3, h: 14 }, min: { w: 2, h: 8 } },
  { id: "tare", title: "② 皮重参考", hint: "历史皮重与容差告警", box: { x: 0, y: 14, w: 3, h: 10 }, min: { w: 2, h: 4 } },
  { id: "camera", title: "车上磅画面", hint: "实时预览与上磅抓拍", box: { x: 3, y: 0, w: 6, h: 7 }, min: { w: 3, h: 4 } },
  { id: "weigh", title: "③ 称重区", hint: "读数、判稳、捕获", box: { x: 3, y: 7, w: 6, h: 11 }, min: { w: 3, h: 8 } },
  { id: "qc", title: "④ 化验区", hint: "指标录入与等级判定", box: { x: 3, y: 18, w: 6, h: 6 }, min: { w: 3, h: 5 } },
  { id: "settle", title: "⑤ 结算与打印", hint: "取价、扣量、付款、打码单", box: { x: 9, y: 0, w: 3, h: 24 }, min: { w: 2, h: 10 } },
];

const SPEC_BY_ID = new Map<string, PanelSpec>(PANELS.map((p) => [p.id, p]));

export interface LayoutDoc {
  items: Layout;
  hidden: PanelId[];
}

function intIn(value: unknown, lo: number, hi: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(hi, Math.max(lo, Math.round(value)));
}

/** 面板当前该占的格子：尺寸/位置都夹在合法区间内，minW/minH 一律取注册表而不是存值 */
function toLayoutItem(spec: PanelSpec, raw?: Partial<LayoutItem>): LayoutItem {
  const w = intIn(raw?.w, spec.min.w, GRID_COLS - spec.box.x) ?? spec.box.w;
  const h = intIn(raw?.h, spec.min.h, GRID_ROWS) ?? spec.box.h;
  const x = intIn(raw?.x, 0, GRID_COLS - w) ?? spec.box.x;
  const y = intIn(raw?.y, 0, GRID_ROWS - h) ?? spec.box.y;
  return { i: spec.id, x, y, w, h, minW: spec.min.w, minH: spec.min.h };
}

function overlaps(a: LayoutItem, b: LayoutItem): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function isStackable(items: Layout): boolean {
  return items.every((a, i) => items.slice(i + 1).every((b) => !overlaps(a, b)));
}

/**
 * 收进来的一串格子规整成能用的布局：认不出的丢、越界的夹、重复的只留第一个，
 * 本次版本新增而档案里没有的面板补回默认位（升级后不会"少一块"）。
 * 夹完还互相压字的（手改过 JSON、或旧版本格式对不上）整份退回默认——
 * 与其猜他要哪一块，不如给他一张确定的桌子。
 */
function normalize(rawItems: unknown, rawHidden: unknown): LayoutDoc {
  const seen = new Set<string>();
  const items: LayoutItem[] = [];
  const list = Array.isArray(rawItems) ? rawItems : [];
  for (const entry of list) {
    const spec = typeof entry?.i === "string" ? SPEC_BY_ID.get(entry.i) : undefined;
    if (!spec || seen.has(spec.id)) continue;
    seen.add(spec.id);
    items.push(toLayoutItem(spec, entry));
  }
  for (const spec of PANELS) {
    if (!seen.has(spec.id)) items.push(toLayoutItem(spec));
  }
  if (!isStackable(items)) return defaultDoc();

  const hidden = Array.isArray(rawHidden)
    ? (rawHidden.filter((id): id is PanelId => typeof id === "string" && SPEC_BY_ID.has(id)) as PanelId[])
    : [];
  const kept = items.filter((it) => !hidden.includes(it.i as PanelId));
  // 全收起来就没有可操作的界面了：至少留一块，多了不管（编辑态能自己调回来）
  return { items: kept.length > 0 ? kept : items, hidden: hidden.filter((id) => !kept.some((it) => it.i === id)) };
}

export function defaultDoc(): LayoutDoc {
  return { items: PANELS.map((spec) => toLayoutItem(spec)), hidden: [] };
}

export function parseDoc(raw: string | null): LayoutDoc {
  if (!raw) return defaultDoc();
  try {
    const parsed = JSON.parse(raw) as { items?: unknown; hidden?: unknown };
    return normalize(parsed.items, parsed.hidden);
  } catch {
    return defaultDoc();
  }
}

export function stringifyDoc(doc: LayoutDoc): string {
  return JSON.stringify({
    version: 1,
    items: doc.items.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })),
    hidden: doc.hidden,
  });
}

/** 收起面板时它那一格的位置留不留？留——再放回来还在老地方，这是"收起"不是"删除" */
function withHidden(doc: LayoutDoc, id: PanelId, hide: boolean): LayoutDoc {
  const spec = SPEC_BY_ID.get(id)!;
  if (hide) {
    const hidden = doc.hidden.includes(id) ? doc.hidden : [...doc.hidden, id];
    return { items: doc.items.filter((it) => it.i !== id), hidden };
  }
  const bottom = doc.items.reduce((m, it) => Math.max(m, it.y + it.h), 0);
  const shown = doc.items.some((it) => it.i === id)
    ? doc.items
    : [...doc.items, toLayoutItem(spec, { ...spec.box, y: Math.min(bottom, GRID_ROWS - spec.box.h) })];
  return { items: shown, hidden: doc.hidden.filter((h) => h !== id) };
}

/**
 * 当前操作员的工作台布局：读一次（跟着账号走）、拖完写一次。
 *
 * 写入只在拖拽/缩放**结束**、以及收起/放出/重置时发生。网格在拖动过程中每帧都在报
 * 新格子（react-grid-layout 的行为），那时只更本地状态，不然一次拖动往库里写几十行。
 */
export function useWorkstationLayout() {
  const actorId = useSession((s) => s.session?.actor.id ?? null);
  const query = useQuery({
    queryKey: ["pref", LAYOUT_KEY, actorId],
    queryFn: () => api.getPref(LAYOUT_KEY),
    enabled: actorId != null,
    staleTime: Infinity,
  });

  const [doc, setDoc] = useState<LayoutDoc>(defaultDoc);
  const docRef = useRef(doc);
  docRef.current = doc;

  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (actorId == null || !query.isFetched) return;
    const stamp = `${actorId}:${query.data ?? ""}`;
    if (loadedFor.current === stamp) return;
    loadedFor.current = stamp;
    setDoc(parseDoc(query.data ?? null));
  }, [actorId, query.isFetched, query.data]);

  const save = useMutation({
    mutationFn: (next: LayoutDoc) => api.setPref(LAYOUT_KEY, stringifyDoc(next)),
    onError: (e: Error) => toast.error(`布局没能保存：${e.message}（本机仍生效，重启后可能回到原样）`),
  });
  const persist = save.mutate;

  /** 落库计时器。网格在拖动中每帧都报新格子，只有停手后那一次才值得写库 */
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPending = useCallback(() => {
    if (pending.current == null) return;
    clearTimeout(pending.current);
    pending.current = null;
  }, []);

  const commit = useCallback(
    (next: LayoutDoc, debounce = false) => {
      loadedFor.current = null; // 服务端那份旧值不该再把刚改的盖回去
      setDoc(next);
      docRef.current = next;
      cancelPending();
      if (debounce) pending.current = setTimeout(() => persist(docRef.current), SAVE_DEBOUNCE_MS);
      else persist(next);
    },
    [cancelPending, persist],
  );

  /** 手势结束后补写一次：防抖还没到点就直接落库，避免"拖完立刻关窗口"丢布局 */
  const flush = useCallback(() => {
    if (pending.current == null) return;
    cancelPending();
    persist(docRef.current);
  }, [cancelPending, persist]);

  useEffect(() => flush, [flush]);

  const applyLayout = useCallback((items: Layout) => commit(normalize(items, docRef.current.hidden), true), [commit]);
  const togglePanel = useCallback(
    (id: PanelId, show: boolean) => commit(withHidden(docRef.current, id, show)),
    [commit],
  );
  const reset = useCallback(() => {
    commit(defaultDoc());
    toast.success("已恢复默认三栏");
  }, [commit]);

  const hidden = doc.hidden;
  const specs = useMemo(() => PANELS.map((p) => ({ ...p, shown: !hidden.includes(p.id) })), [hidden]);

  return {
    /** 没拿到本人那份之前不要铺网格：否则会把别人的/默认排布当成他的闪一下 */
    ready: actorId != null && query.isFetched,
    items: doc.items,
    hidden,
    specs,
    saving: save.isPending,
    applyLayout,
    flush,
    togglePanel,
    reset,
  };
}
