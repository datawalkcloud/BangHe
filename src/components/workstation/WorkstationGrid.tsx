/**
 * 磅房工作台的可拖拽网格（05 §4.1）。
 *
 * react-grid-layout v2 只负责"格子怎么动"，这里管三件事：
 *  1. **行高随视口换算**。24 行是死预算（layout.ts），rowHeight 由容器实际高度反算，
 *     所以同一份布局在 1080p 与 2K 屏上是同一张脸，只是每块各自长高一点；
 *     屏太矮时行高退到 16px 上限，工作区整体出滚动条，不偷偷改变谁占几格。
 *  2. **只在编辑态给把手**。磅员一手油一手票据，日常界面上任何地方都不该能被"不小心拖走"；
 *     所以拖拽/缩放的开关由页面顶部的「自定义布局」控制，没进编辑态时网格是死的。
 *  3. **窄屏退回单列**。1280 以下三栏本来就挤，格子几何直接不采信，按 y→x 的阅读顺序堆叠。
 *
 * 面板本体一行都不用改：它们各自是一张 Card，`.ws-tile` 负责把 Card 撑满整格、
 * 让 CardContent 自己滚（见 App.css）。
 */
import { useEffect, useRef, useState, type ComponentPropsWithRef, type ReactNode } from "react";
import { GridLayout, verticalCompactor } from "react-grid-layout";
import type { Layout } from "react-grid-layout";
import { MoveHorizontalIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { GRID_COLS, GRID_MARGIN, GRID_MIN_WIDTH, GRID_ROWS, type PanelSpec } from "./layout";

const MARGIN_Y = GRID_MARGIN[1];
const MIN_ROW_HEIGHT = 16;

/** 24 行正好铺满可用高度时的行高；容器还没测出来时回 0，调用方据此跳过绘制 */
function rowHeightFor(height: number): number {
  if (height <= 0) return 0;
  return Math.max(MIN_ROW_HEIGHT, Math.floor((height + MARGIN_Y) / GRID_ROWS) - MARGIN_Y);
}

function useBox<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // 网格要铺的是滚动容器去掉内边距后的「内容盒」，不是 clientWidth/clientHeight 本身。
      // 直接把 clientWidth/clientHeight 喂给 react-grid-layout，网格会比内容区每个方向多出一个
      // padding 的宽高，于是必然溢出、冒出滚动条；滚动条又反过来把 clientWidth/clientHeight 各削
      // 掉一截 → ResizeObserver 再量 → rowHeight / 宽度重算 → 再溢出……窗口态高度正卡在溢出临界
      // 点上就变成整页每帧抖（全屏专注留白多，撑不到临界点，所以不闪）。这里把 padding 减掉，
      // 让网格恰好铺进内容盒，反馈回路从源头断掉。
      const cs = getComputedStyle(el);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const width = Math.max(0, el.clientWidth - padX);
      const height = Math.max(0, el.clientHeight - padY);
      // 只在尺寸真变了才 setState：网格报回的是小数高度，RO 会被亚像素抖动连发，
      // 不拦等于给刚断掉的那条回路再补一个触发源。
      setBox((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box] as const;
}

export function WorkstationGrid({
  items,
  editing,
  onLayout,
  onCommit,
  children,
}: {
  items: Layout;
  editing: boolean;
  /** 拖动过程中的每一帧都会回调，只用来同步界面，别在这里写库 */
  onLayout: (next: Layout) => void;
  /** 一次手势结束：把防抖里欠的那次保存补上 */
  onCommit: () => void;
  children: ReactNode;
}) {
  const [ref, box] = useBox<HTMLDivElement>();
  const rowHeight = rowHeightFor(box.height);
  const stacked = box.width < GRID_MIN_WIDTH || rowHeight === 0;

  return (
    // 内边距比格缝（GRID_MARGIN 12）小一点但容得下手柄外扩的那 6 px：
    // 最右列、最后一行的抓取条伸进边距里，不至于被这个 overflow 容器剪掉半截。
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] px-2.5 py-2">
      {editing && (
        <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <MoveHorizontalIcon className="size-3.5 shrink-0" />
          {stacked
            ? "窗口不足 1280 px，面板先按顺序堆着；拉宽窗口就能拖。收起在顶栏「面板」里。"
            : "拖顶部把手换位置，拖右缘 / 下缘 / 右下角改大小，点 × 收起。"}
        </p>
      )}
      {stacked ? (
        // 窄屏 / 尚未测量：单列堆叠，按默认格子的阅读顺序排，不采信拖出来的几何
        <div className="ws-stacked flex flex-col gap-3">{children}</div>
      ) : (
        // 只给 se 一个角标时，12 px 的格缝里根本容不下"看准了再拽"这个动作：磅员要的是拽哪都行。
        // 所以右缘、下缘、右下角三向都给（三条都只在编辑态出现，见 App.css 的 .ws-grid-edit 节）。
        // handles 的顺序即手柄 DOM 的顺序，角上那几像素由排最后的 se 压住右缘/下缘。
        <GridLayout
          className={cn("ws-grid", editing && "ws-grid-edit")}
          width={box.width}
          layout={items}
          gridConfig={{ cols: GRID_COLS, maxRows: GRID_ROWS, rowHeight, margin: GRID_MARGIN, containerPadding: [0, 0] }}
          dragConfig={{ enabled: editing, handle: ".ws-grip", cancel: ".ws-grip-hide" }}
          resizeConfig={{ enabled: editing, handles: ["e", "s", "se"] }}
          compactor={verticalCompactor}
          autoSize
          onLayoutChange={onLayout}
          onDragStop={onCommit}
          onResizeStop={onCommit}
        >
          {children}
        </GridLayout>
      )}
    </div>
  );
}

/**
 * 一格面板。编辑态在卡片标题条上覆一条把手：拖它换位、拖右缘/下缘/右下角改大小、点 × 收起。
 * 把手只在编辑态存在——日常界面里不能有"手一抖布局就变了"的入口。
 *
 * **`...rest` 必须原样落到根 div 上，这一条不能省。** react-grid-layout 不给自己的外壳，
 * 而是用 `cloneElement` 把三样东西注入到直接子元素上：格子的 inline `style`
 * （position/left/top/width/height）、`react-grid-item` 等类名、以及拖拽要用的 `ref`。
 * 挑着只取自己认识的 prop 会把三者一起丢掉，后果是面板退化成普通流里的整宽块
 * （彼此 0 间距贴在一起），而库自带的 `.react-grid-item > .react-resizable-handle` 永不命中，
 * 缩放手柄就成了夹在卡片末尾的一个 0×0 inline span——看着像"没有右下角可拽"。
 * React 19 里 `ref` 也走 props，所以连同 `ref` 一起摊开即可，不必再包一层 forwardRef。
 */
export function PanelTile({
  spec,
  editing,
  onHide,
  className,
  children,
  ...rest
}: ComponentPropsWithRef<"div"> & {
  spec: PanelSpec;
  editing: boolean;
  onHide: () => void;
}) {
  return (
    <div {...rest} className={cn("ws-tile", editing && "ws-tile-edit", className)}>
      {editing && (
        <div className="ws-grip" title={`拖动「${spec.title}」换位置，拖右缘 / 下缘 / 右下角改大小`}>
          <MoveHorizontalIcon className="size-3.5 shrink-0 opacity-70" />
          <span className="truncate text-[11px] font-medium">{spec.title}</span>
          <button
            type="button"
            className="ws-grip-hide"
            onClick={onHide}
            title={`收起「${spec.title}」，可从顶部「面板」再放回来`}
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}
      {children}
    </div>
  );
}
