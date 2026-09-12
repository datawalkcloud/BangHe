/**
 * 列表表格——shadcn DataTable 形态。
 *
 * 引擎是 @tanstack/react-table v9，外观与交互仍然走 components/ui/table 那几个原语，
 * 也就是 shadcn 官方 DataTable 的配方（列定义 + flexRender + 分页/勾选状态由 table 实例持有）。
 * 它和 business/DataTable.tsx 的列契约（Column<T>）是一样的，调用方只换一行 import 就能切过来。
 *
 * 抄 v8 的例子会直接编译不过，v9 有三处差别：
 *  1. useReactTable → useTable，且没有 getCoreRowModel() 这类参数了，
 *     行模型改成显式注册：tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel() })；
 *  2. 行模型 slot 必须和它的 feature 成对出现——只写 sortedRowModel 会在 tableFeatures 处报缺前置；
 *  3. 没有 flexRender 导出，渲染改用 table.FlexRender。
 *
 * 刻意保留的旧行为（磅房现场真在用，不是审美取舍）：
 *  - 表头 sticky + 不透明底色；
 *  - 排序只在 降序 ↔ 升序 之间翻，不出现「取消排序」，且首点为降序；
 *  - 空值恒排最后（sortUndefined:"last" 在 desc 下不会被取反，见 createSortedRowModel 的 compareRows）；
 *  - 「全选」是全量筛选结果而不是当前页（toggleAllRowsSelected 走 pre-grouped 行模型）。
 */
"use client"

import * as React from "react"
import {
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type PaginationState,
  type RowData,
  type RowSelectionState,
  type Row,
  type SortingState,
  type Updater,
} from "@tanstack/react-table"
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
} from "@/components/ui/pagination"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export interface Column<T> {
  key: string
  header: React.ReactNode
  cell: (row: T, index: number) => React.ReactNode
  align?: "left" | "right" | "center"
  /** 提供排序取值；不给则表头不可排序 */
  sortValue?: (row: T) => number | string | null | undefined
  className?: string
  headClassName?: string
  /** 列口径说明，挂到表头的原生 title（“历史平均皮重”这类跨口径列必须写清分母） */
  title?: string
  /** 合计行内容，跨全表分页数据计算 */
  footer?: (rows: T[]) => React.ReactNode
}

/**
 * 行模型必须在模块作用域一次性装配好：放进组件体内每次渲染都会重建 features，
 * 连带把整棵行模型的缓存作废。sortedRowModel 一定要跟 rowSortingFeature 一起给。
 */
const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
  rowSelectionFeature,
})

type ColDef<T extends RowData> = ColumnDef<typeof features, T>

const SELECT_KEY = "__select"
const PAGE_SIZES = [50, 100, 200] as const
/** data 为空时别每次都现造一个 []：TanStack 把引用变化当数据变更，会整棵行模型重算 */
const EMPTY_ROWS: never[] = []

/** 与 05 §6.1 一致：数字比大小，其余按中文排序；空值位置交给 sortUndefined 处理 */
function compareValues(
  a: number | string | null | undefined,
  b: number | string | null | undefined,
): number {
  if (typeof a === "number" && typeof b === "number") return a - b
  return String(a).localeCompare(String(b), "zh-CN")
}

/**
 * 页码窗口：页数不多就全画，多了只画首尾与当前页附近，缺口用省略号。
 * 不能用 -1 当页号，所以这里约定 -1 只表示省略号。
 */
function pageWindow(current: number, count: number): number[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i)
  const wanted = [0, count - 1, current - 1, current, current + 1].filter(
    (p) => p >= 0 && p < count,
  )
  const sorted = Array.from(new Set(wanted)).sort((a, b) => a - b)
  const out: number[] = []
  let prev = -1
  for (const p of sorted) {
    if (prev !== -1 && p - prev > 1) out.push(-1)
    out.push(p)
    prev = p
  }
  return out
}

export function DataTable<T extends RowData>({
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
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T, index: number) => string | number
  loading?: boolean
  onRowClick?: (row: T, index: number) => void
  /** 给出后 Ctrl+点击 可在新窗口打开同一张单（对账时并排看两张单是真实需求） */
  rowHref?: (row: T) => string
  toolbar?: React.ReactNode
  defaultPageSize?: number
  empty?: React.ReactNode
  dense?: boolean
  rowClassName?: (row: T) => string | undefined
  /** 勾选列：两者一起给才启用（05 §3 磅单列表「批量打印」需要）；rowKey 必须是稳定单号 */
  selected?: Set<string>
  onSelectedChange?: (next: Set<string>) => void
}) {
  const selectable = selected != null && onSelectedChange != null

  const [sorting, setSorting] = React.useState<SortingState>([])
  const [pagination, setPagination] = React.useState<PaginationState>({
    pageIndex: 0,
    pageSize: defaultPageSize,
  })

  /**
   * 勾选状态的真值留在调用方（批量打印要跨页攒着），这里只做 Set ⇄ 表格 state 的翻译。
   * 反过来如果不给 state.rowSelection，表格就变成自持状态，外部清空勾选会失效。
   */
  const rowSelection = React.useMemo<RowSelectionState>(() => {
    const next: RowSelectionState = {}
    selected?.forEach((k) => {
      next[k] = true
    })
    return next
  }, [selected])

  const handleSortingChange = React.useCallback((updater: Updater<SortingState>) => {
    setSorting((prev) => (typeof updater === "function" ? updater(prev) : updater))
    // 换了排序口径就回第一页：停在旧页码上，降序第一名不在视野里
    setPagination((p) => (p.pageIndex === 0 ? p : { ...p, pageIndex: 0 }))
  }, [])

  const handlePaginationChange = React.useCallback((updater: Updater<PaginationState>) => {
    setPagination((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater
      // 改每页条数必须回第一页，否则会停在一个新页数下并不存在的页码上
      return next.pageSize === prev.pageSize ? next : { ...next, pageIndex: 0 }
    })
  }, [])

  const handleRowSelectionChange = React.useCallback(
    (updater: Updater<RowSelectionState>) => {
      if (!onSelectedChange) return
      const next = typeof updater === "function" ? updater(rowSelection) : updater
      onSelectedChange(new Set(Object.keys(next).filter((k) => next[k])))
    },
    [onSelectedChange, rowSelection],
  )

  const columnDefs = React.useMemo<ColDef<T>[]>(() => {
    const defs: ColDef<T>[] = []

    if (selectable) {
      defs.push({
        id: SELECT_KEY,
        enableSorting: false,
        header: ({ table }) => (
          <Checkbox
            aria-label="全选筛选结果"
            checked={table.getIsAllRowsSelected()}
            onCheckedChange={(v) => table.toggleAllRowsSelected(v === true)}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            aria-label={`选择 ${row.id}`}
            checked={row.getIsSelected()}
            onCheckedChange={(v) => row.toggleSelected(v === true)}
          />
        ),
      })
    }

    for (const c of columns) {
      const get = c.sortValue
      if (get) {
        defs.push({
          id: c.key,
          header: () => c.header,
          cell: (ctx) => c.cell(ctx.row.original, ctx.row.index),
          // accessorFn 只是为了给 sortUndefined 取值用（它读的是 row.getValue）；
          // 真正的比较口径由 sortFn 决定：字符串按中文排，数字按数值排。
          accessorFn: (row: T) => get(row),
          sortUndefined: "last",
          sortFn: (a: Row<typeof features, T>, b: Row<typeof features, T>) =>
            compareValues(get(a.original), get(b.original)),
        })
      } else {
        defs.push({
          id: c.key,
          header: () => c.header,
          cell: (ctx) => c.cell(ctx.row.original, ctx.row.index),
          enableSorting: false,
        })
      }
    }
    return defs
  }, [columns, selectable])

  /**
   * 列号 → 原始列配置：表头/单元格的类名、title、合计都从这里取，避免再给 meta 定一套类型。
   * 勾选列没有对应的调用方列，这里补一条同名登记，宽度和「合计」占位才不用另开分支。
   */
  const byKey = React.useMemo(() => {
    const m = new Map<string, Column<T>>()
    if (selectable) {
      m.set(SELECT_KEY, {
        key: SELECT_KEY,
        header: null,
        cell: () => null,
        className: "w-9",
        headClassName: "w-9",
      })
    }
    for (const c of columns) m.set(c.key, c)
    return m
  }, [columns, selectable])

  /** 列清单只用来画骨架行与合计行，顺序必须和 columnDefs 一致 */
  const allKeys = React.useMemo(
    () => (selectable ? [SELECT_KEY, ...columns.map((c) => c.key)] : columns.map((c) => c.key)),
    [columns, selectable],
  )

  const data: T[] = rows.length > 0 ? rows : EMPTY_ROWS

  const table = useTable({
    features,
    columns: columnDefs,
    data,
    getRowId: (row, index) => String(rowKey(row, index)),
    state: { sorting, pagination, rowSelection },
    onSortingChange: handleSortingChange,
    onPaginationChange: handlePaginationChange,
    onRowSelectionChange: handleRowSelectionChange,
    // 首点即降序，且不会翻回「未排序」——保持旧表的排序节奏
    sortDescFirst: true,
    enableSortingRemoval: false,
  })

  const total = table.getRowCount()
  const pageCount = Math.max(1, table.getPageCount())
  const pageIndex = Math.min(pagination.pageIndex, pageCount - 1)
  /** 合计行取全量（排序后、分页前）的行；只按当前页算合计是最常见的那种错 */
  const allRows = table.getPrePaginatedRowModel().rows.map((r) => r.original)
  const showFooter =
    !loading && total > 0 && (selectable || columns.some((c) => c.footer))

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
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const col = byKey.get(header.column.id)
                  const sorted = header.column.getIsSorted()
                  const content = header.isPlaceholder ? null : (
                    <table.FlexRender header={header} />
                  )
                  return (
                    <TableHead
                      key={header.id}
                      title={col?.title}
                      className={cn(
                        "h-9 whitespace-nowrap font-medium",
                        col?.align === "right" && "text-right",
                        col?.align === "center" && "text-center",
                        col?.title &&
                          "underline decoration-dotted decoration-muted-foreground/60 underline-offset-4",
                        col?.headClassName,
                      )}
                    >
                      {header.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "inline-flex items-center gap-1 hover:text-foreground",
                            col?.align === "right" && "flex-row-reverse",
                            sorted && "text-foreground",
                          )}
                        >
                          {content}
                          {sorted === "asc" ? (
                            <ArrowUpIcon className="size-3.5" />
                          ) : sorted === "desc" ? (
                            <ArrowDownIcon className="size-3.5" />
                          ) : (
                            <ArrowUpDownIcon className="size-3.5 opacity-40" />
                          )}
                        </button>
                      ) : (
                        content
                      )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>

          <TableBody>
            {loading
              ? Array.from({ length: 6 }, (_, i) => (
                  <TableRow key={`sk-${i}`}>
                    {allKeys.map((k) => (
                      <TableCell key={k}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    onClick={(e) => {
                      if ((e.ctrlKey || e.metaKey) && rowHref) {
                        window.open(
                          `${window.location.pathname}${window.location.search}#${rowHref(row.original)}`,
                          "_blank",
                        )
                        return
                      }
                      onRowClick?.(row.original, row.index)
                    }}
                    className={cn(
                      onRowClick && "cursor-pointer",
                      rowClassName?.(row.original),
                    )}
                  >
                    {row.getAllCells().map((cell) => {
                      const col = byKey.get(cell.column.id)
                      return (
                        <TableCell
                          key={cell.id}
                          className={cn(
                            dense ? "py-1.5" : "py-2",
                            "whitespace-nowrap",
                            col?.align === "right" && "text-right tnum",
                            col?.align === "center" && "text-center",
                            col?.className,
                          )}
                        >
                          <table.FlexRender cell={cell} />
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
          </TableBody>

          {showFooter && (
            <TableFooter className="sticky bottom-0 border-t-2 border-foreground/15 bg-muted/50">
              <TableRow className="hover:bg-transparent">
                {allKeys.map((key, ci) => {
                  const col = byKey.get(key)
                  const label = col?.footer
                    ? col.footer(allRows)
                    : ci === (selectable ? 1 : 0)
                      ? "合计"
                      : ""
                  return (
                    <TableCell
                      key={key}
                      className={cn(
                        "h-9 whitespace-nowrap font-semibold",
                        col?.align === "right" && "text-right tnum",
                        col?.align === "center" && "text-center",
                      )}
                    >
                      {label}
                    </TableCell>
                  )
                })}
              </TableRow>
            </TableFooter>
          )}

          {!loading && total === 0 && (
            <TableBody>
              <TableRow>
                <TableCell colSpan={allKeys.length} className="h-32 text-center">
                  {empty ?? (
                    <span className="text-sm text-muted-foreground">没有符合条件的记录</span>
                  )}
                </TableCell>
              </TableRow>
            </TableBody>
          )}
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="tnum">共 {total} 条</span>
          <NativeSelect
            aria-label="每页条数"
            size="sm"
            className="w-28"
            value={String(pagination.pageSize)}
            onChange={(e) => table.setPageSize(Number(e.target.value))}
          >
            {PAGE_SIZES.map((s) => (
              <NativeSelectOption key={s} value={String(s)}>
                {s} 条/页
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>

        <Pagination className="mx-0 w-auto justify-end">
          <PaginationContent>
            <PaginationItem>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="上一页"
                disabled={!table.getCanPreviousPage()}
                onClick={() => table.previousPage()}
              >
                <ChevronLeftIcon />
              </Button>
            </PaginationItem>
            {pageWindow(pageIndex, pageCount).map((p, i) =>
              p === -1 ? (
                <PaginationItem key={`gap-${i}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={p}>
                  <Button
                    variant={p === pageIndex ? "outline" : "ghost"}
                    size="icon-sm"
                    className="tnum"
                    aria-label={`第 ${p + 1} 页`}
                    aria-current={p === pageIndex ? "page" : undefined}
                    onClick={() => table.setPageIndex(p)}
                  >
                    {p + 1}
                  </Button>
                </PaginationItem>
              ),
            )}
            <PaginationItem>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="下一页"
                disabled={!table.getCanNextPage()}
                onClick={() => table.nextPage()}
              >
                <ChevronRightIcon />
              </Button>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  )
}

/** 数值单元格统一样式：右对齐 + 等宽（05 §6.1） */
export function NumCell({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <span className={cn("tnum block text-right", className)}>{children}</span>
}
