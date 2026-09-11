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
import { useEffect, useRef, useState, type ReactNode } from "react";
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
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
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
  const gridHeight = GRID_ROWS * (rowHeight + MARGIN_Y) - MARGIN_Y;

  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
      {stacked ? (
        // 窄屏 / 尚未测量：单列堆叠，按默认格子的阅读顺序排，不采信拖出来的几何
        <div className="flex flex-col gap-2">{children}</div>
      ) : (
        <GridLayout
          className={cn("ws-grid", editing && "ws-grid-edit")}
          style={{ height: gridHeight }}
          width={box.width}
          layout={items}
          gridConfig={{ cols: GRID_COLS, maxRows: GRID_ROWS, rowHeight, margin: GRID_MARGIN, containerPadding: [0, 0] }}
          dragConfig={{ enabled: editing, handle: ".ws-grip", cancel: ".ws-grip-hide" }}
          resizeConfig={{ enabled: editing, handles: ["se"] }}
          compactor={verticalCompactor}
          autoSize={false}
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
 * 一格面板。编辑态在卡片标题条上覆一条把手：拖它换位、拖右下角改大小、点 × 收起。
 * 把手只在编辑态存在——日常界面里不能有"手一抖布局就变了"的入口。
 */
export function PanelTile({
  spec,
  editing,
  onHide,
  children,
}: {
  spec: PanelSpec;
  editing: boolean;
  onHide: () => void;
  children: ReactNode;
}) {
  return (
    <div className={cn("ws-tile", editing && "ws-tile-edit")}>
      {editing && (
        <div className="ws-grip" title={`拖动「${spec.title}」换位置，拖右下角改大小`}>
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
