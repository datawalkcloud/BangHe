/**
 * 侧栏导航配置（05 §2 应用骨架）。
 *
 * Alt+1..9 按 items 的**展开顺序**跳转，所以这里的顺序就是快捷键顺序，
 * 调整顺序等于改快捷键，必须同步改 §5 的表格与帮助菜单。
 *
 * 说明：/masters 与 /reports 在路由表里是动态段，侧栏要"点基础档案永远落在品种页"，
 * 因此这里存的是**已展开的真实 URL**而非路由 pattern。跳转统一走 useGo()，
 * 路径写错由路由的 defaultNotFoundComponent 兜底成中文空态，不会白屏。
 */
import {
  BarChart3Icon,
  BookOpenIcon,
  ClipboardListIcon,
  CreditCardIcon,
  FlaskConicalIcon,
  LayoutDashboardIcon,
  PlugZapIcon,
  ScaleIcon,
  Settings2Icon,
  UsersIcon,
  WalletIcon,
} from "lucide-react";
import type { ComponentType } from "react";

export interface NavEntry {
  label: string;
  /** 已展开的真实 URL */
  href: string;
  /** 高亮前缀，/masters/prices 也要点亮"基础档案" */
  match: string;
  icon: ComponentType<{ className?: string }>;
  hint?: string;
}

function item(
  label: string,
  href: string,
  icon: ComponentType<{ className?: string }>,
  hint: string,
): NavEntry {
  const seg = href.split("/").filter(Boolean);
  // /masters/prices 这类多段路径，高亮只看第一段
  return { label, href, icon, hint, match: seg.length ? `/${seg[0]}` : "/" };
}

export const NAV_GROUPS: { label: string; items: NavEntry[] }[] = [
  {
    label: "作业",
    items: [
      item("首页看板", "/", LayoutDashboardIcon, "今日收购概览与告警"),
      item("磅房工作台", "/workstation", ScaleIcon, "读卡 · 过磅 · 化验 · 结算"),
      item("磅单中心", "/orders", ClipboardListIcon, "全部过磅单查询与打印"),
    ],
  },
  {
    label: "往来",
    items: [
      item("农户与单位", "/parties", UsersIcon, "售粮人档案与履历"),
      item("化验工作台", "/qc", FlaskConicalIcon, "待检队列与质检单"),
      item("结算中心", "/settlements", WalletIcon, "合并结算与结算单"),
      item("付款与挂账", "/payments", CreditCardIcon, "付款登记、挂账超期"),
    ],
  },
  {
    label: "管理",
    items: [
      item("基础档案", "/masters/varieties", BookOpenIcon, "品种、仓房、价目、参数"),
      item("台账报表", "/reports/ledger", BarChart3Icon, "监管台账与统计分析"),
      item("设备中心", "/devices", PlugZapIcon, "地磅、读卡、抓拍、打印"),
      item("系统与审计", "/system/audit", Settings2Icon, "操作留痕、备份、日结"),
    ],
  },
];

/** 展开后的平铺列表，Alt+N 用 */
export const NAV_FLAT: NavEntry[] = NAV_GROUPS.flatMap((g) => g.items);

export function isNavActive(entry: NavEntry, pathname: string): boolean {
  if (entry.match === "/") return pathname === "/";
  // 首页看板只在根路径高亮；其余按一级前缀高亮，
  // 但 /orders/$no 这类详情仍归属其前缀，符合"我在哪个模块"的直觉
  return pathname === entry.href || pathname.startsWith(`${entry.match}/`) || pathname === entry.match;
}
