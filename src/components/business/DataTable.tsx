/**
 * 统一列表表格（05 §6.3）。
 *
 * 特性：表头点击排序、分页（默认 50，可选 50/100/200）、固定表尾合计行、
 * 行点击进详情、Ctrl+点击新窗口、加载骨架、带下一步动作的空状态。
 *
 * 没有引入第三方表格库：@tanstack/react-table v9 换成了全新的 useTable API，
 * 在只展示 mock 数据的阶段自研更稳，也避免为一个表格组件背未知 API 的风险。
 */
import { useMemo, useState, type ReactNode } from "react";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Choose } from "@/components/business/Choose";
import { ArrowDownIcon, ArrowUpIcon, ArrowUpDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "cn";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  align?: "left" | "right" | "center";
  /** 提供排序取值；不给则表头不可排序 */
  sortValue?: (row: T) => number | string | null | undefined;
  className?: string;
  headClassName?: string;
  /** 列口径说明，挂到表头的原生 title（“历史平均皮重”这类跨口径列必须写清分母） */
  title?: string;
  /** 合计行内容，跨全表分页数据计算 */
  footer?: (rows: T[]) => ReactNode;
}

const PAGE_SIZES = ["50", "100", "200"];

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  onRowClick,
  rowHref,
  toolbar,
  defaultPageSize = 50,
  empty,
  dense = false,
  rowClassName,
  selected,
  onSelectedChange,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  loading?: boolean;
  onRowClick?: (row: T, index: number) => void;
  /** 给出后 Ctrl+点击 可在新窗口打开同一张单（对账时并排看两张单是真实需求） */
  rowHref?: (row: T) => string;
  toolbar?: ReactNode;
  defaultPageSize?: number;
  empty?: ReactNode;
  dense?: boolean;
  rowClassName?: (row: T) => string | undefined;
  /** 勾选列：两者一起给才启用（05 §3 磅单列表「批量打印」需要）；rowKey 必须是稳定单号 */
  selected?: Set<string>;
  onSelectedChange?: (next: Set<string>) => void;
}) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    return rows.slice().sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return dir === "asc" ? av - bv : bv - av;
      return dir === "asc" ? String(av).localeCompare(String(bv), "zh-CN") : String(bv).localeCompare(String(av), "zh-CN");
    });
  }, [rows, sortKey, dir, columns]);

  const total = sorted.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pageCount);
  const view = sorted.slice((current - 1) * pageSize, current * pageSize);

  const toggleSort = (key: string) => {
    if (sortKey === key) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setDir("desc");
    }
    setPage(1);
  };

  const toggleAll = (on: boolean) => {
    if (!onSelectedChange) return;
    const next = new Set(selected ?? []);
    for (const r of sorted) {
      const k = String(rowKey(r, 0));
      if (on) next.add(k);
      else next.delete(k);
    }
    onSelectedChange(next);
  };

  /** 勾选列作为一普通列前置，后面所有渲染循环就不用再分叉 */
  const allCols: Column<T>[] = onSelectedChange
    ? [
        {
          key: "__select",
          header: (
            <Checkbox
              aria-label="全选筛选结果"
              checked={sorted.length > 0 && sorted.every((r) => selected?.has(String(rowKey(r, 0))))}
              onCheckedChange={(v) => toggleAll(v === true)}
            />
          ),
          cell: (row) => {
            const k = String(rowKey(row, 0));
            return (
              <Checkbox
                aria-label={`选择 ${k}`}
                checked={selected?.has(k) ?? false}
                onCheckedChange={(v) => {
                  const next = new Set(selected ?? []);
                  if (v === true) next.add(k);
                  else next.delete(k);
                  onSelectedChange(next);
                }}
              />
            );
          },
          className: "w-9",
        },
        ...columns,
      ]
    : columns;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">{toolbar}</div>

      {/* 滚动口必须是 Table 自带的那一层 container（见 ui/table.tsx 的 containerClassName）：
          在它外层限高会让表头跟着整块滚走，几十列的台账滚下去就找不到列名了 */}
      <div className="min-w-0 rounded-none border border-border">
        <Table
          containerClassName="max-h-[70vh] overflow-auto"
          className={cn(dense && "text-[13px]")}
        >
          {/* 表头必须用不透明底色：sticky 时半透明的 bg-muted/60 会让下面两行正文透上来，
              列名与字形压在一起，完全没法读（backdrop-blur 也拦不住） */}
          <TableHeader className="sticky top-0 z-10 bg-muted [&_th]:bg-muted">
            <TableRow className="hover:bg-transparent">
              {allCols.map((c) => {
                const active = sortKey === c.key;
                return (
                  <TableHead
                    key={c.key}
                    title={c.title}
                    className={cn(
                      "h-9 whitespace-nowrap font-medium",
                      c.align === "right" && "text-right",
                      c.align === "center" && "text-center",
                      c.title && "underline decoration-dotted decoration-muted-foreground/60 underline-offset-4",
                      c.headClassName,
                    )}
                  >
                    {c.sortValue ? (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => toggleSort(c.key)}
                        className={cn(
                          "h-auto gap-1 px-0 hover:bg-transparent hover:text-foreground",
                          c.align === "right" && "flex-row-reverse",
                          active && "text-foreground",
                        )}
                      >
                        {c.header}
                        {active ? (
                          dir === "asc" ? <ArrowUpIcon className="size-3.5" /> : <ArrowDownIcon className="size-3.5" />
                        ) : (
                          <ArrowUpDownIcon className="size-3.5 opacity-40" />
                        )}
                      </Button>
                    ) : (
                      c.header
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? Array.from({ length: 6 }, (_, i) => (
                  <TableRow key={`sk-${i}`}>
                    {allCols.map((c) => (
                      <TableCell key={c.key}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : view.map((row, i) => (
                  <TableRow
                    key={rowKey(row, i)}
                    onClick={(e) => {
                      if ((e.ctrlKey || e.metaKey) && rowHref) {
                        window.open(`${window.location.pathname}${window.location.search}#${rowHref(row)}`, "_blank");
                        return;
                      }
                      onRowClick?.(row, i);
                    }}
                    className={cn(onRowClick && "cursor-pointer", rowClassName?.(row))}
                  >
                    {allCols.map((c) => (
                      <TableCell
                        key={c.key}
                        className={cn(
                          dense ? "py-1.5" : "py-2",
                          "whitespace-nowrap",
                          c.align === "right" && "text-right tnum",
                          c.align === "center" && "text-center",
                          c.className,
                        )}
                      >
                        {c.cell(row, (current - 1) * pageSize + i)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
          </TableBody>
          {!loading &&
            total > 0 &&
            (columns.some((c) => c.footer) || !!onSelectedChange) && (
              <TableFooter className="border-t-2 border-foreground/15 bg-muted/50 sticky bottom-0">
                <TableRow className="hover:bg-transparent">
                  {allCols.map((c, ci) => (
                    <TableCell
                      key={c.key}
                      className={cn(
                        "h-9 whitespace-nowrap font-semibold",
                        c.align === "right" && "text-right tnum",
                        c.align === "center" && "text-center",
                      )}
                    >
                      {c.footer ? c.footer(sorted) : ci === (onSelectedChange ? 1 : 0) ? "合计" : ""}
                    </TableCell>
                  ))}
                </TableRow>
              </TableFooter>
            )}
          {!loading && total === 0 && (
            <TableBody>
              <TableRow>
                <TableCell colSpan={allCols.length} className="h-32 text-center">
                  {empty ?? <span className="text-sm text-muted-foreground">没有符合条件的记录</span>}
                </TableCell>
              </TableRow>
            </TableBody>
          )}
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <span>共 {total} 条</span>
          <Choose
            aria-label="每页条数"
            size="sm"
            className="w-28"
            value={String(pageSize)}
            onChange={(v) => {
              setPageSize(Number(v));
              setPage(1);
            }}
            options={PAGE_SIZES.map((s) => ({ value: s, label: `${s} 条/页` }))}
          />
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" onClick={() => setPage(Math.max(1, current - 1))} disabled={current <= 1} aria-label="上一页">
            <ChevronLeftIcon />
          </Button>
          <span className="px-2 tnum">
            {current} / {pageCount}
          </span>
          <Button variant="outline" size="icon-sm" onClick={() => setPage(Math.min(pageCount, current + 1))} disabled={current >= pageCount} aria-label="下一页">
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 数值单元格统一样式：右对齐 + 等宽（05 §6.1） */
export function NumCell({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("tnum block text-right", className)}>{children}</span>;
}
