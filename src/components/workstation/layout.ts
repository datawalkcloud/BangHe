/**
 * 磅房工作台的自定义布局（05 §4.1）。
 *
 * 一句话口径：**排布跟人走，不跟机器走**。磅员把称重区拉成半屏、化验员把化验区挪到
 * 首屏左上、站长保留默认排布，三个人同一台磅房机互不影响；换个账号登录仍是各自那一套。
 * 所以值存 §9.25 `user_preference`（按 user_id + key 一行），而不是 localStorage——
 * 磅房机是轮班共用的，存在本机等于第二天就换个人把他排好的界面覆盖了。
 *
 * 网格参数只有两个是要紧的：
 *  - **12 列 × 24 行是固定预算**。行高由容器实际高度换算（见 WorkstationGrid），
 *    所以同一份布局在 1080p 和 2K 屏上是同一张脸，只是每块各自长高一点，
 *    不需要"每套分辨率存一份"那类额外状态。
 *  - **存的是 x/y/w/h，单位是格**。默认排布见 `PANELS` 的 `box`，是 2026-11-24 从开发
 *    环境里站长账号实际存下的那份布局固化下来的；老用户升级后仍读自己库里那份。
 *
 * 读回来的值一律过 `parseDoc`：键不认识就丢、数字越界就夹、互相压字（手工改脏的 JSON）
 * 整份退回默认。库里的文本可能被旧版本或人写过，宁可退回默认也不能让工作台开不起来——
 * 磅员手里正压着一车粮，界面渲染不出来比布局丢了严重得多。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { verticalCompactor } from "react-grid-layout";
import type { Layout, LayoutItem } from "react-grid-layout";
import { api } from "@/lib/api";
import { useSession } from "@/store/session";

/** 服务端 §9.25 里的偏好键，字符集要与 `prefs.rs::check_key` 兼容 */
export const LAYOUT_KEY = "workstation.layout";
/** 出库模式那一套面板的排布：与入库**各存一份**，两边各自拖各自的，谁也不挤动谁的格子 */
export const OUT_LAYOUT_KEY = "workstation.layout.out";

export const GRID_COLS = 12;
/** 行预算。行高按视口换算，24 行正好铺满工作区；拖过头时允许排到预算以外，由外层滚动条接住 */
export const GRID_ROWS = 24;
/**
 * 格缝。两件事同时压在这个数上：
 *  - 编辑态要在这条缝里放缩放手柄外扩的那半截抓取条（App.css 里往外伸的像素数与这里同宽，
 *    改一个就得改另一个），缝比外扩窄时相邻两卡的手柄会互相压着；
 *  - 日常态它**就是**面板之间的分隔——去线之后卡片没有外框，块与块靠这条缝和画布底色分开。
 *  取 4 px：白卡压在灰画布上，4 px 已经读成一条分隔线，再宽就是"岛与岛之间的海"。
 *  一起动、别只动这一个：编辑态手柄的外扩像素数（App.css 三条 -4px）、窄屏单列堆叠的间距、
 *  加载骨架的间距都跟着这条缝走；画布留白 GRID_PADDING 另算（左右已经顶到头）。
 */
export const GRID_MARGIN: readonly [number, number] = [4, 4];

/**
 * 画布留白 [左右, 上下]。左右取 0：面板直接顶到侧栏和窗口边，一条竖缝都不留——
 * 中间的缝是"谁和谁分开"，两侧的留白什么都没说，纯吃掉一屏里最贵的横向空间。
 * 上下留 4 px 不是审美：编辑态下缘手柄往外伸 4 px，压着 0 就伸进滚动区，
 * 滚动条反过来削高度 → 行高重算 → 整页抖（useBox 里断的那条回路，别再给它接上）。
 */
export const GRID_PADDING: readonly [number, number] = [0, 4];
/** 低于此宽度不铺网格，退回单列纵向堆叠（1280 以下三栏本来就挤） */
export const GRID_MIN_WIDTH = 1280;
/** 停手多久后落库。太短等于每帧一写，太长会让"拖完马上关窗口"丢掉布局 */
const SAVE_DEBOUNCE_MS = 400;

export type PanelId = "identity" | "tare" | "camera" | "weigh" | "qc" | "open";
/**
 * 出库模式那一桌的面板。id 与入库那套各自成表（各存各的偏好键），所以同名（`camera` / `weigh`）
 * 不冲突——两块称重面板本来就不是一份东西：入库围绕流转卡推进，出库只填一单过账。
 */
export type OutboundPanelId = "queue" | "form" | "camera" | "weigh";

export interface PanelSpec<I extends string = PanelId> {
  id: I;
  /** 编辑态把手上显示的名字，与面板自己 CardTitle 一致 */
  title: string;
  /** 面板选择菜单里的副文案：这块是干什么的 */
  hint: string;
  /** 默认格位：没存过偏好的人开箱即用的几何，见 `PANELS` 下的说明 */
  box: { x: number; y: number; w: number; h: number };
  /** 再小就没法用了：称重区要容得下读数，化验区要容得下指标行 */
  min: { w: number; h: number };
  /**
   * **版本后加的面板**：老用户存好的排布里按「收起」补进来，不占他已排好的格子（05 §4.1）。
   * 不加这个标记的话，`sanitize` 会把档案里没有的新面板按默认位补成可见，而老用户的格子
   * 通常已经占满 12×24 → `normalize` 的压字闸门整份退回 `defaultDoc`——升级等于把他
   * 排好的界面悄悄重排一遍，正是最招骂的那种"我的界面怎么变了"。本人没存过排布的新账号
   * 走 `defaultDoc`，不受此标记影响，一进来就能看见。
   */
  defaultHidden?: boolean;
}

// 「身份与制单」回归常驻格子（原 05 §4 左栏第一格，git f9d407b 之前那张）。
// 「制单」弹窗（F7 / 刷卡带卡）没有撤：两条入口共用同一个 `IdentityPanel`，
// 弹窗开着时这一格让位不挂载（同一张读卡器的回读只能被一个实例认领，见 WorkstationPage）。
//
// 默认几何（12 列 × 24 行）于 2026-11-24 从开发环境里站长账号实际保存的
// `user_preference.workstation.layout` 原样固化：
//   左 在途作业 x0 w2 通高 24；身份与制单 x2 w3 h16、皮重参考 x2 w3 h16~24；
//   中 称重区 x5 w4 h13、化验区 x5 w4 h13~24；右 车上磅画面 x9 w3 h10。
// 改这里的 box 就是改「恢复默认」与未存过偏好账号的开箱布局；已经存过排布的人不受影响。
export const PANELS: readonly PanelSpec[] = [
  // 后加/回归面板一律带 defaultHidden：老用户库里那份排布按「收起」补进来，不挤动他排好的格子。
  { id: "open", title: "在途作业", hint: "手上压着的单，点一张接着干", box: { x: 0, y: 0, w: 2, h: 24 }, min: { w: 2, h: 4 }, defaultHidden: true },
  { id: "identity", title: "身份与制单", hint: "读卡、选农户、取号制单", box: { x: 2, y: 0, w: 3, h: 16 }, min: { w: 2, h: 8 }, defaultHidden: true },
  { id: "tare", title: "皮重参考", hint: "历史皮重与容差告警", box: { x: 2, y: 16, w: 3, h: 8 }, min: { w: 2, h: 4 } },
  { id: "weigh", title: "称重区", hint: "读数与捕获", box: { x: 5, y: 0, w: 4, h: 13 }, min: { w: 3, h: 8 } },
  { id: "qc", title: "化验区", hint: "指标录入与等级判定", box: { x: 5, y: 13, w: 4, h: 11 }, min: { w: 3, h: 5 } },
  { id: "camera", title: "车上磅画面", hint: "实时预览与上磅抓拍", box: { x: 9, y: 0, w: 3, h: 10 }, min: { w: 3, h: 4 } },
  // 「凭票与打印」不再是格子面板：出票/补打入口收进第三刷结算弹窗（TicketPrintSection）。
  // 老用户存好的排布里若还留着 "settle" 那一格，sanitize 认不出就静默丢弃，不报错也不重排其余面板。
];

const SPEC_BY_ID = new Map<string, PanelSpec>(PANELS.map((p) => [p.id, p]));

/**
 * 出库模式的默认格子（2026-11-25 首版，照入库那张桌子的列宽分法 2/3/4/3 摆）：
 * 草稿队列、出库单（就地编辑）、地磅称重、过磅画面四格通高，一进来没有空区。
 * 画面给到通高是因为现场的第一句反馈就是"过磅的时候看不见画面"——宁可让磅员自己收小，
 * 也别默认给他一条几十像素的黑带。
 */
export const OUT_PANELS: readonly PanelSpec<OutboundPanelId>[] = [
  { id: "queue", title: "出库草稿", hint: "现场手里那张纸，点一张接着称", box: { x: 0, y: 0, w: 2, h: 24 }, min: { w: 2, h: 4 } },
  { id: "form", title: "出库单", hint: "制单与改单都在这里，改完自动存", box: { x: 2, y: 0, w: 3, h: 24 }, min: { w: 2, h: 9 } },
  { id: "weigh", title: "地磅称重", hint: "毛重皮重与过磅抓拍", box: { x: 5, y: 0, w: 4, h: 24 }, min: { w: 3, h: 8 } },
  { id: "camera", title: "过磅画面", hint: "实时预览，压没压边靠眼睛", box: { x: 9, y: 0, w: 3, h: 24 }, min: { w: 3, h: 4 } },
];

const OUT_SPEC_BY_ID = new Map<string, PanelSpec<OutboundPanelId>>(OUT_PANELS.map((p) => [p.id, p]));

/**
 * 一套面板 = 一个偏好键 + 一份注册表 + 它的 id 查表。
 * 入库与出库共用下面整套规整逻辑（夹边界、退回默认、压字挤开、防抖落库），只差这三样。
 */
export interface LayoutKit<I extends string> {
  key: string;
  panels: readonly PanelSpec<I>[];
  byId: Map<string, PanelSpec<I>>;
  defaultDoc(): LayoutDoc<I>;
  parseDoc(raw: string | null): LayoutDoc<I>;
}

function makeKit<I extends string>(key: string, panels: readonly PanelSpec<I>[], byId: Map<string, PanelSpec<I>>): LayoutKit<I> {
  const kit: LayoutKit<I> = {
    key,
    panels,
    byId,
    defaultDoc: () => defaultDocIn(kit),
    parseDoc: (raw) => parseDocIn(raw, kit),
  };
  return kit;
}

const IN_KIT: LayoutKit<PanelId> = makeKit(LAYOUT_KEY, PANELS, SPEC_BY_ID);
const OUT_KIT: LayoutKit<OutboundPanelId> = makeKit(OUT_LAYOUT_KEY, OUT_PANELS, OUT_SPEC_BY_ID);

/** 存库的排布。`items` 恒含全部面板（收起来的那格也留着，再放回来还在老地方），`hidden` 只是显隐标记 */
export interface LayoutDoc<I extends string = PanelId> {
  items: Layout;
  hidden: I[];
}

function intIn(value: unknown, lo: number, hi: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(hi, Math.max(lo, Math.round(value)));
}

/** 面板当前该占的格子：尺寸/位置都夹在合法区间内，minW/minH 一律取注册表而不是存值 */
function toLayoutItem<I extends string>(spec: PanelSpec<I>, raw?: Partial<LayoutItem>): LayoutItem {
  const minX = intIn(raw?.x, 0, GRID_COLS - spec.min.w) ?? spec.box.x;
  const w = intIn(raw?.w, spec.min.w, GRID_COLS - minX) ?? spec.box.w;
  const x = Math.min(minX, GRID_COLS - w);
  const h = intIn(raw?.h, spec.min.h, GRID_ROWS) ?? spec.box.h;
  // y 不设上限：24 行是"铺满工作区"的预算，不是硬顶。把某一块撑宽之后，
  // 网格自己会把后面的块顶到 24 行以外（外层那根滚动条接住它，见 WorkstationGrid）。
  // 这里再夹回 24 行以内，等于凭空造出压字——存出去的排布跟屏幕上看到的不是一张图，
  // 下次读回来还会被 normalize 的脏数据闸门整体退回默认（用户的调整白做）。
  const y = intIn(raw?.y, 0, Number.MAX_SAFE_INTEGER) ?? spec.box.y;
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
 * 本次版本新增而档案里没有的面板补回默认位（升级后不会"少一块"）；`hidePanelsAbsentFromStore`
 * 带上时（只有读库那条路）再给标了 `defaultHidden` 的新面板补一个收起标记，
 * 于是老用户升级后看到的仍是他自己排的那张桌子，新面板在「面板」菜单里等着被勾出来。
 * 这一步**不判互相压字**，因为它的两个调用方对压字的容忍度不一样：
 * 网格在一次缩放的中间帧就是会报回压字的格子（把别人挤开是手势结束时它自己做的事），
 * 而库里读回来的脏值需要 `normalize` 那道退回默认的闸门。
 */
function sanitize<I extends string>(
  rawItems: unknown,
  rawHidden: unknown,
  kit: LayoutKit<I>,
  opts?: { hidePanelsAbsentFromStore?: boolean },
): LayoutDoc<I> {
  const seen = new Set<string>();
  const items: LayoutItem[] = [];
  const list = Array.isArray(rawItems) ? rawItems : [];
  for (const entry of list) {
    const spec = typeof entry?.i === "string" ? kit.byId.get(entry.i) : undefined;
    if (!spec || seen.has(spec.id)) continue;
    seen.add(spec.id);
    items.push(toLayoutItem(spec, entry));
  }
  const hidden: I[] = Array.isArray(rawHidden)
    ? rawHidden.filter((id): id is I => typeof id === "string" && kit.byId.has(id))
    : [];
  const alreadyHidden = new Set(hidden);
  for (const spec of kit.panels) {
    if (seen.has(spec.id)) continue;
    items.push(toLayoutItem(spec));
    // 这一格在档案里压根没有 ⇒ 那份排布是本面板上线以前写的：后加的面板按「收起」补进来，
    // 只登记显隐标记、不去动他任何一块格子。放出来的权利留给顶栏「面板」里那一下勾选。
    if (opts?.hidePanelsAbsentFromStore && spec.defaultHidden && !alreadyHidden.has(spec.id)) hidden.push(spec.id);
  }
  return { items, hidden };
}

/**
 * 只用于读库那条路：夹完还互相压字的（手改过 JSON、或旧版本格式对不上）整份退回默认——
 * 与其猜他要哪一块，不如给他一张确定的桌子。收起的面板不参与判重叠，
 * 它那一格让给谁都可以，放回来时由网格自己挤开。全收起来也退回默认，
 * 否则界面上就没有可操作的东西了。
 */
function normalize<I extends string>(rawItems: unknown, rawHidden: unknown, kit: LayoutKit<I>): LayoutDoc<I> {
  const doc = sanitize(rawItems, rawHidden, kit, { hidePanelsAbsentFromStore: true });
  const visible = doc.items.filter((it) => !doc.hidden.includes(it.i as I));
  if (!isStackable(visible) || visible.length === 0) return defaultDocIn(kit);
  return doc;
}

/**
 * 落库前的最后一道：把互相压字的可见格子按**跟界面同一套规则**（竖向 compactor）挤开。
 *
 * 为什么要有这一步：网格只在手势结束时才报回挤干净的格子，而我们的 `flush` 挂在
 * `onResizeStop`/`onDragStop` 上、防抖也可能抢在它前面一帧，写出去的就会是压字的脏值。
 * 脏值一进库，下次读回来就被 `normalize` 那道闸门整体退回默认——用户这次拖的、缩的白做，
 * 表现就是"一松手弹回原样"。本地显示什么我们不动它，只保证**进库的那份一定站得住**。
 */
function settle<I extends string>(doc: LayoutDoc<I>, kit: LayoutKit<I>): LayoutDoc<I> {
  const hiddenItems = doc.items.filter((it) => doc.hidden.includes(it.i as I));
  const visible = doc.items.filter((it) => !doc.hidden.includes(it.i as I));
  if (isStackable(visible)) return doc;
  return sanitize([...verticalCompactor.compact(visible, GRID_COLS), ...hiddenItems], doc.hidden, kit);
}

/**
 * 默认排布：注册表里的 box + 本次版本的所有面板都在位。这里**不**读 `defaultHidden`——
 * 那个标记只管"库里那份老排布别被新面板挤动"（走 `normalize`），
 * 而压根没存过排布的账号第一眼就该看见新面板，不该还要自己去菜单里勾一下。
 */
function defaultDocIn<I extends string>(kit: LayoutKit<I>): LayoutDoc<I> {
  return { items: kit.panels.map((spec) => toLayoutItem(spec)), hidden: [] };
}

function parseDocIn<I extends string>(raw: string | null, kit: LayoutKit<I>): LayoutDoc<I> {
  if (!raw) return defaultDocIn(kit);
  try {
    const parsed = JSON.parse(raw) as { items?: unknown; hidden?: unknown };
    return normalize(parsed.items, parsed.hidden, kit);
  } catch {
    return defaultDocIn(kit);
  }
}

/** 入库那一套的自由函数出口：老调用方（含 `scripts/workstation-layout/check.ts`）不必带 kit */
export function defaultDoc(): LayoutDoc<PanelId> {
  return IN_KIT.defaultDoc();
}

export function parseDoc(raw: string | null): LayoutDoc<PanelId> {
  return IN_KIT.parseDoc(raw);
}

/** 出库那一套的同样两个出口（自检脚本与任何不想挂 hook 的调用方用） */
export function outDefaultDoc(): LayoutDoc<OutboundPanelId> {
  return OUT_KIT.defaultDoc();
}

export function outParseDoc(raw: string | null): LayoutDoc<OutboundPanelId> {
  return OUT_KIT.parseDoc(raw);
}

export function stringifyDoc<I extends string>(doc: LayoutDoc<I>): string {
  return JSON.stringify({
    version: 1,
    items: doc.items.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })),
    hidden: doc.hidden,
  });
}

/**
 * 收起 / 放出面板。格子不动只翻标记：再放回来还在老地方，这是"收起"不是"删除"。
 * 放出后若与别人压字，交给网格的 compactor 当场挤开，下一次 onLayoutChange 就是干净的。
 */
function withHidden<I extends string>(doc: LayoutDoc<I>, id: I, hide: boolean, kit: LayoutKit<I>): LayoutDoc<I> {
  if (!kit.byId.has(id)) return doc;
  const hidden = doc.hidden.includes(id) ? doc.hidden : [...doc.hidden, id];
  return { items: doc.items, hidden: hide ? hidden : doc.hidden.filter((h) => h !== id) };
}

/**
 * 当前操作员的一套排布：读一次（跟着账号走）、拖完写一次。入库与出库各是一份（`kit.key` 不同）。
 *
 * 写入只在拖拽/缩放**结束**、以及收起/放出/重置时发生。网格在拖动过程中每帧都在报
 * 新格子（react-grid-layout 的行为），那时只更本地状态，不然一次拖动往库里写几十行。
 *
 * **写到库里之后必须把同一份文本回填查询缓存**（见 `remember`）。不回填的话，工作台这个
 * 路由组件一被卸载，它内部的 `loadedFor` ref 就清零了；再切回来时缓存在 `staleTime: Infinity`
 * 下不重取，回来的还是保存前那份旧文本，于是被当成本人的排布灌回本地状态——用户看到的就是
 * "点完完成、切去别的页面再回来，布局还是保存前的"。同一份值两处口径必须一致，别再拆开写。
 */
function useLayoutDoc<I extends string>(kit: LayoutKit<I>) {
  const actorId = useSession((s) => s.session?.actor.id ?? null);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["pref", kit.key, actorId],
    queryFn: () => api.getPref(kit.key),
    enabled: actorId != null,
    staleTime: Infinity,
  });

  const [doc, setDoc] = useState<LayoutDoc<I>>(kit.defaultDoc);
  const docRef = useRef(doc);
  docRef.current = doc;

  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (actorId == null || !query.isFetched) return;
    const stamp = `${actorId}:${query.data ?? ""}`;
    if (loadedFor.current === stamp) return;
    loadedFor.current = stamp;
    setDoc(kit.parseDoc(query.data ?? null));
  }, [actorId, kit, query.isFetched, query.data]);

  /**
   * 已发出的写入序号。落库走的是并发的 IPC，两次快速改动（连点两下面板菜单）的回执可能倒着
   * 回来。缓存里该留的是**最后一次意图**，不是最后一个回执，所以回填时只认最新那一次序号，
   * 免得先写的那份把后写的那份盖回去。
   */
  const writeSeq = useRef(0);

  /**
   * 把"本会话自己写出去的那一份"记下来，两件事必须一起做：
   *  1. 回填查询缓存 —— 否则切走再切回来读到的还是保存前那份（见 hook 头注）；
   *  2. 把 `loadedFor` 标成这份 —— 本地状态已经是它了，不需要再被回灌一次
   *     （拖动中防抖落库时回灌会把用户正拽着的那块弹回挤干净后的位置）。
   */
  const remember = useCallback(
    (json: string, seq: number) => {
      if (seq !== writeSeq.current) return;
      void queryClient.setQueryData(["pref", kit.key, actorId], json);
      loadedFor.current = actorId == null ? null : `${actorId}:${json}`;
    },
    [actorId, kit.key, queryClient],
  );

  const save = useMutation({
    mutationFn: async (next: LayoutDoc<I>) => {
      const json = stringifyDoc(settle(next, kit));
      const seq = ++writeSeq.current;
      await api.setPref(kit.key, json);
      return { json, seq };
    },
    onSuccess: ({ json, seq }) => remember(json, seq),
    onError: (e: Error, next: LayoutDoc<I>) => {
      // 库没写进去，但这一份在本次会话里仍然算数：提示语说了"本机仍生效"，就得真的生效，
      // 否则用户切个页面回来发现调整没了，比"重启后可能回到原样"更难受。序号取当前值——
      // 失败的若是最新那次，它才是该留下的意图。
      remember(stringifyDoc(settle(next, kit)), writeSeq.current);
      toast.error(`布局没能保存：${e.message}（本机仍生效，重启后可能回到原样）`);
    },
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
    (next: LayoutDoc<I>, debounce = false) => {
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

  /**
   * 网格报回来的只有可见的那几块（收起的本就不渲染），把隐藏项那一格并回去再规整，
   * 不然拖一次就把它们悄悄打回默认位。
   * 这里用 `sanitize` 而不是 `normalize`：缩放中间帧压字是常态，把别人挤开是网格
   * 在手势结束时自己做的事，拿读库那道"压字就退回默认"的闸门去卡它，
   * 等于用户每把一块拖大一点就被打回默认排布（实测就是这样，看起来像"缩放根本不生效"）。
   */
  const applyLayout = useCallback(
    (visible: Layout) => {
      const hiddenItems = docRef.current.items.filter((it) => docRef.current.hidden.includes(it.i as I));
      commit(sanitize([...visible, ...hiddenItems], docRef.current.hidden, kit), true);
    },
    [commit, kit],
  );
  const togglePanel = useCallback(
    (id: I, hide: boolean) => commit(withHidden(docRef.current, id, hide, kit)),
    [commit, kit],
  );
  const reset = useCallback(() => {
    commit(kit.defaultDoc());
    toast.success("已恢复默认布局");
  }, [commit, kit]);

  const hidden = doc.hidden;
  const specs = useMemo(() => kit.panels.map((p) => ({ ...p, shown: !hidden.includes(p.id) })), [hidden, kit]);
  /** 只含可见面板的格子，直接喂给网格 */
  const visibleItems = useMemo(
    () => doc.items.filter((it) => !hidden.includes(it.i as I)),
    [doc.items, hidden],
  );
  /** 渲染顺序按格子走（y→x），窄屏退回单列堆叠时读起来才跟宽屏一个次序 */
  const tiles = useMemo(
    () =>
      [...visibleItems]
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((it) => ({ spec: kit.byId.get(it.i)!, item: it })),
    [visibleItems, kit],
  );

  return {
    /** 没拿到本人那份之前不要铺网格：否则会把别人的/默认排布当成他的闪一下 */
    ready: actorId != null && query.isFetched,
    items: visibleItems,
    tiles,
    hidden,
    specs,
    saving: save.isPending,
    applyLayout,
    flush,
    /** 第二参数是"要不要收起"，与面板菜单里的勾选状态相反 */
    togglePanel,
    reset,
  };
}

/** 入库那张桌子的排布（键 `workstation.layout`） */
export function useWorkstationLayout() {
  return useLayoutDoc(IN_KIT);
}

/** 出库那张桌子的排布（键 `workstation.layout.out`）：与入库各存一份，互不挤动 */
export function useOutboundLayout() {
  return useLayoutDoc(OUT_KIT);
}
