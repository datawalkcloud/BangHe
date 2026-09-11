/**
 * 路由表（05 §3 页面清单）。
 *
 * 用手动路由树而不是 codegen 插件：单机桌面工程不想为 27 条路由再引入
 * 一个构建期依赖，手写一次即可稳定类型推导。
 *
 * 清单里的 /masters/* 与 /reports/* 各用一个动态段收敛，
 * 既保持 URL 与文档一致，又少 10 个几乎同构的 route 定义。
 */
import {
  Link,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
} from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { EmptyState } from "@/components/business/layout";
import { DashboardPage } from "@/pages/DashboardPage";
import { WorkstationPage } from "@/pages/WorkstationPage";
import { OrdersPage } from "@/pages/OrdersPage";
import { OrderDetailPage } from "@/pages/OrderDetailPage";
import { PartiesPage } from "@/pages/PartiesPage";
import { PartyDetailPage } from "@/pages/PartyDetailPage";
import { QcPage } from "@/pages/QcPage";
import { QcDetailPage } from "@/pages/QcDetailPage";
import { SettlementsPage } from "@/pages/SettlementsPage";
import { SettlementDetailPage } from "@/pages/SettlementDetailPage";
import { PaymentsPage } from "@/pages/PaymentsPage";
import { MastersPage, type MastersSection } from "@/pages/MastersPage";
import { ReportsPage, type ReportKind } from "@/pages/ReportsPage";
import { DevicesPage } from "@/pages/DevicesPage";
import { SystemPage, type SystemSection } from "@/pages/SystemPage";

const rootRoute = createRootRoute({ component: AppShell });

/** 兜底：URL 打错时给一个能回到工作台的空态，而不是白屏（05 §6.3） */
function NotFound() {
  return (
    <EmptyState
      title="页面不存在"
      description="地址可能输错了，或该功能尚未开放。"
      action={
        <Link to="/" className="text-sm underline">
          回到首页看板
        </Link>
      }
    />
  );
}

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardPage });

/** 工作台的 orderNo 走 URL，便于看板与在途条"点卡片接着干"，也方便把链接贴给同事。
 *  返回类型必须写成可选属性，否则 TanStack 会把 search 当成必填，`to="/workstation"` 不带 search 就报类型错 */
const workstationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workstation",
  validateSearch: (raw: Record<string, unknown>): { orderNo?: string } => ({
    orderNo: typeof raw.orderNo === "string" ? raw.orderNo : undefined,
  }),
  component: WorkstationPage,
});

const ordersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/orders", component: OrdersPage });
const orderDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/orders/$orderNo",
  component: OrderDetailPage,
});

const partiesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/parties", component: PartiesPage });
const partyDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/parties/$id",
  component: PartyDetailPage,
});

const qcRoute = createRoute({ getParentRoute: () => rootRoute, path: "/qc", component: QcPage });
const qcDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/qc/$reportNo",
  component: QcDetailPage,
});

const settlementsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settlements", component: SettlementsPage });
const settlementDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settlements/$settleNo",
  component: SettlementDetailPage,
});

const paymentsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/payments", component: PaymentsPage });

/** /masters/$section —— 用壳组件把 params 传下去，页面本身保持纯 props */
const mastersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/masters/$section",
  component: () => {
    const { section } = useParams({ from: "/masters/$section" });
    return <MastersPage section={section as MastersSection} />;
  },
});

const reportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reports/$kind",
  component: () => {
    const { kind } = useParams({ from: "/reports/$kind" });
    return <ReportsPage kind={kind as ReportKind} />;
  },
});

const devicesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/devices", component: DevicesPage });

const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/system/$section",
  component: () => {
    const { section } = useParams({ from: "/system/$section" });
    return <SystemPage section={section as SystemSection} />;
  },
});

/** 未实现页面的占位，避免菜单点到就白屏 */
function Placeholder({ name }: { name: string }) {
  return (
    <EmptyState
      title={`${name}尚未开放`}
      description="P0 阶段先交付核心收粮闭环，该模块在 P1 排期内。"
      action={
        <Link to="/" className="text-sm underline">
          回到看板
        </Link>
      }
    />
  );
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: () => <Placeholder name="口令登录" />,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  workstationRoute,
  ordersRoute,
  orderDetailRoute,
  partiesRoute,
  partyDetailRoute,
  qcRoute,
  qcDetailRoute,
  settlementsRoute,
  settlementDetailRoute,
  paymentsRoute,
  mastersRoute,
  reportsRoute,
  devicesRoute,
  systemRoute,
  loginRoute,
]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: "intent",
  // 找不到的路由给中文空态，不给白屏
  defaultNotFoundComponent: NotFound,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
