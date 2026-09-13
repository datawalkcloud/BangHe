/**
 * 详情抽屉的"开关 + 内联链接 + 列表操作列"。
 *
 * 单独成模块是因为抽屉现在要直接渲染四个详情页的正文（`XxxDetailBody`），
 * 而详情页正文里又要用 QuickDetailLink 跳到另一张单——两边都放在
 * `QuickDetailSheet.tsx` 里会形成循环 import。列表页同样要挂这枚入口，
 * 所以 `detailColumn` 也待在这个不引任何页面的模块里。
 */
import React from "react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { cn } from "cn";

export type QuickDetailType = "order" | "party" | "qc" | "settlement";

interface QuickDetailTarget {
  type: QuickDetailType;
  id: string;
}

interface QuickDetailStore {
  target: QuickDetailTarget | null;
  open: (type: QuickDetailType, id: string | number) => void;
  close: () => void;
}

export const useQuickDetail = create<QuickDetailStore>((set) => ({
  target: null,
  open: (type, id) => set({ target: { type, id: String(id) } }),
  close: () => set({ target: null }),
}));

/**
 * 抽屉内联跳转链接。
 *
 * 用 shadcn Button 的 link 变体而不是裸 <button>：底色/下划线/悬停/焦点环都跟
 * 全站其它可点元素走同一套 token。Button 自带 h-9 + px-3 + text-sm，
 * 在正文里要按"行内文本"用，所以 h-auto/p-0 压掉盒子，字号仍由调用方的 className 决定
 * （InfoGrid 的 dd 本身就是 text-sm，明细行里则显式传 text-xs）。
 */
export function QuickDetailLink({
  type,
  id,
  children,
  className,
}: {
  type: QuickDetailType;
  id: string | number;
  children: React.ReactNode;
  className?: string;
}) {
  const open = useQuickDetail((s) => s.open);
  return (
    <Button
      type="button"
      variant="link"
      onClick={(e) => {
        e.stopPropagation();
        open(type, id);
      }}
      className={cn("h-auto cursor-pointer p-0 underline underline-offset-2 hover:opacity-80", className)}
    >
      {children}
    </Button>
  );
}

/**
 * 列表末列「操作」：一枚「详情」按钮点开右侧抽屉。
 *
 * 行本身已经不再响应单击（05 §6.3），所以每张"一行对应一张单据"的表都要挂这列，
 * 否则详情就没有入口了。两套 DataTable 的 Column 契约字段一致，这里只声明用到的
 * 那几个字段，business 与 ui 两边都能直接塞进 columns 数组。
 */
export function detailColumn<T>(
  type: QuickDetailType,
  idOf: (row: T) => string | number,
  label = "详情",
): { key: string; header: React.ReactNode; align: "right"; cell: (row: T) => React.ReactNode } {
  return {
    key: "__detail",
    header: "操作",
    align: "right",
    cell: (row) => (
      <QuickDetailLink type={type} id={idOf(row)} className="text-xs no-underline opacity-80 hover:opacity-100">
        {label}
      </QuickDetailLink>
    ),
  };
}
