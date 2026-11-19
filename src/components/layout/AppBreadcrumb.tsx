import React from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { HomeIcon } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { NAV_FLAT } from "@/components/layout/app-nav";

export interface BreadcrumbItemDef {
  label: string;
  href?: string;
}

/**
 * 中文一律取自侧栏配置，本文件不再维护第二套名字。
 * 自己抄一份的代价已经踩过两次：这里写"系统与审计"而侧栏是"系统设置"；
 * /cards、/stock、/outbound 三条压根没登记，落到兜底分支上把英文路由段直接印进顶栏。
 * 侧栏高亮按路径首段归属模块（isNavActive 同一口径），面包屑也照这个口径取条目。
 */

/** 详情页在模块之后追加单据号；键是路径首段，值是与页面标题一致的单据名 */
const DOC_CRUMB: Record<string, string> = {
  "/orders": "磅单",
  "/outbound": "出库单",
  "/parties": "档案",
  "/qc": "质检单",
  "/settlements": "结算单",
};

export function getBreadcrumbItems(pathname: string, search?: Record<string, unknown>): BreadcrumbItemDef[] {
  if (pathname === "/") {
    return [{ label: "首页看板" }];
  }

  const items: BreadcrumbItemDef[] = [{ label: "首页看板", href: "/" }];
  const segs = pathname.split("/").filter(Boolean);
  const nav = NAV_FLAT.find((entry) => entry.match === `/${segs[0]}`);
  if (!nav) {
    items.push({ label: decodeURIComponent(segs[segs.length - 1] ?? pathname) });
    return items;
  }

  // 二层只在"真的下到了某一张单"时出现。分区/报表/设置类页面的第三段是页内标签页，
  // 抬头下方的标签条已经写着同一个词，再进面包屑只是把当前页名字换成侧栏里没有的那个。
  const doc = segs.length > 1 ? DOC_CRUMB[nav.match] : undefined;
  const orderNo = typeof search?.orderNo === "string" && search.orderNo ? search.orderNo : undefined;

  if (doc || orderNo) {
    items.push({ label: nav.label, href: nav.href });
    items.push({ label: doc ? `${doc} ${decodeURIComponent(segs[1])}` : `过磅单 ${orderNo}` });
  } else {
    items.push({ label: nav.label });
  }

  return items;
}

export function AppBreadcrumb() {
  const location = useLocation();
  const rawSearch = location.search;
  const searchObj: Record<string, unknown> =
    rawSearch && typeof rawSearch === "object"
      ? (rawSearch as Record<string, unknown>)
      : typeof rawSearch === "string"
        ? Object.fromEntries(new URLSearchParams(rawSearch).entries())
        : {};

  const items = getBreadcrumbItems(location.pathname, searchObj);

  return (
    <Breadcrumb className="text-xs">
      <BreadcrumbList className="gap-1 text-xs sm:gap-1">
        {items.map((item, idx) => {
          const isLast = idx === items.length - 1;
          return (
            <React.Fragment key={idx}>
              {idx > 0 && <BreadcrumbSeparator className="[&>svg]:size-3" />}
              <BreadcrumbItem>
                {isLast || !item.href ? (
                  <BreadcrumbPage className="max-w-[160px] truncate text-xs font-medium">
                    {idx === 0 ? (
                      <span className="flex items-center gap-1">
                        <HomeIcon className="size-3 shrink-0" />
                        <span>{item.label}</span>
                      </span>
                    ) : (
                      item.label
                    )}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink
                    render={<Link to={item.href as never} />}
                    className="max-w-[160px] truncate text-xs text-muted-foreground hover:text-foreground"
                  >
                    {idx === 0 ? (
                      <span className="flex items-center gap-1">
                        <HomeIcon className="size-3 shrink-0" />
                        <span>{item.label}</span>
                      </span>
                    ) : (
                      item.label
                    )}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
