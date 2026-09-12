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

export interface BreadcrumbItemDef {
  label: string;
  href?: string;
}

const MASTERS_SECTIONS: Record<string, string> = {
  varieties: "品种与指标",
  warehouses: "仓房与货位",
  prices: "收购价目表",
  settings: "站点参数",
};

const REPORTS_KINDS: Record<string, string> = {
  ledger: "收购明细台账",
  daily: "日报",
  quality: "质量分析",
  parties: "农户排行",
  staff: "作业量与异常",
};

const SYSTEM_SECTIONS: Record<string, string> = {
  users: "登录与权限",
  staff: "员工与岗位",
  audit: "操作审计",
  backup: "备份与恢复",
  shift: "日结交班",
  appearance: "外观与主题",
  templates: "小票模板",
};

export function getBreadcrumbItems(pathname: string, search?: Record<string, unknown>): BreadcrumbItemDef[] {
  if (pathname === "/") {
    return [{ label: "首页看板" }];
  }

  const items: BreadcrumbItemDef[] = [{ label: "首页看板", href: "/" }];

  if (pathname === "/workstation") {
    const orderNo = typeof search?.orderNo === "string" && search.orderNo ? search.orderNo : undefined;
    if (orderNo) {
      items.push({ label: "磅房工作台", href: "/workstation" });
      items.push({ label: `过磅单 ${orderNo}` });
    } else {
      items.push({ label: "磅房工作台" });
    }
  } else if (pathname === "/orders") {
    items.push({ label: "磅单中心" });
  } else if (pathname.startsWith("/orders/")) {
    const orderNo = decodeURIComponent(pathname.slice("/orders/".length));
    items.push({ label: "磅单中心", href: "/orders" });
    items.push({ label: `磅单 ${orderNo}` });
  } else if (pathname === "/parties") {
    items.push({ label: "农户与单位" });
  } else if (pathname.startsWith("/parties/")) {
    const id = decodeURIComponent(pathname.slice("/parties/".length));
    items.push({ label: "农户与单位", href: "/parties" });
    items.push({ label: `档案 ${id}` });
  } else if (pathname === "/qc") {
    items.push({ label: "化验工作台" });
  } else if (pathname.startsWith("/qc/")) {
    const reportNo = decodeURIComponent(pathname.slice("/qc/".length));
    items.push({ label: "化验工作台", href: "/qc" });
    items.push({ label: `质检单 ${reportNo}` });
  } else if (pathname === "/settlements") {
    items.push({ label: "结算中心" });
  } else if (pathname.startsWith("/settlements/")) {
    const settleNo = decodeURIComponent(pathname.slice("/settlements/".length));
    items.push({ label: "结算中心", href: "/settlements" });
    items.push({ label: `结算单 ${settleNo}` });
  } else if (pathname === "/payments") {
    items.push({ label: "付款与挂账" });
  } else if (pathname.startsWith("/masters/")) {
    const section = pathname.slice("/masters/".length);
    const label = MASTERS_SECTIONS[section] || section;
    items.push({ label: "基础档案", href: "/masters/varieties" });
    items.push({ label });
  } else if (pathname.startsWith("/reports/")) {
    const kind = pathname.slice("/reports/".length);
    const label = REPORTS_KINDS[kind] || kind;
    items.push({ label: "台账报表", href: "/reports/ledger" });
    items.push({ label });
  } else if (pathname === "/devices") {
    items.push({ label: "设备中心" });
  } else if (pathname.startsWith("/system/")) {
    const section = pathname.slice("/system/".length);
    const label = SYSTEM_SECTIONS[section] || section;
    items.push({ label: "系统与审计", href: "/system/audit" });
    items.push({ label });
  } else {
    const segs = pathname.split("/").filter(Boolean);
    if (segs.length > 0) {
      items.push({ label: segs[segs.length - 1] });
    }
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
