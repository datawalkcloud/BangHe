/**
 * 路由表（05 §3 页面清单）。
 *
 * 用手动路由树而不是 codegen 插件：单机桌面工程不想为 27 条路由再引入
 * 一个构建期依赖，手写一次即可稳定类型推导。
 *
 * 清单里的 /masters/* 与 /reports/* 各用一个动态段收敛，
 * 既保持 URL 与文档一致，又少 10 个几乎同构的 route 定义。
 *
 * 登录门禁（02 §11 M10"未登录不可进入任何业务页"）：路由分两个壳——
 * `plainRoute` 只有登录页，`shellRoute` 带侧栏/菜单栏/设备状态条并挂 beforeLoad 守卫。
 * 判定只写在守卫这一处，页面组件不再各自判断"我是不是该被挡住"。
 */
import {
  Link,
  Outlet,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
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
import { LoginPage } from "@/pages/LoginPage";
import { MastersPage, type MastersSection } from "@/pages/MastersPage";
import { ReportsPage, type ReportKind } from "@/pages/ReportsPage";
import { DevicesPage } from "@/pages/DevicesPage";
import { SystemPage, type SystemSection } from "@/pages/SystemPage";
import { useSession } from "@/store/session";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

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

/** 会话状态 → 能不能进业务页。`mustChangePwd` 视同未登录：进了也只能看，不如先把口令设了 */
async function guard() {
  await useSession.getState().boot();
  const { session } = useSession.getState();
  if (!session || session.actor.mustChangePwd) {
    throw redirect({ to: "/login" });
  }
}

/** 壳路由本身不占 URL 段；`id: "/"` 是必须的——否则子路由 id 会变成 "/shell/…"，
 *  全站 `useParams({ from: "/orders/$orderNo" })` 之类的写法会集体编译不过。 */
const shellRoute = createRoute({ getParentRoute: () => rootRoute, id: "/", beforeLoad: guard, component: AppShell });

const indexRoute = createRoute({ getParentRoute: () => shellRoute, path: "/", component: DashboardPage });

/** 工作台的 orderNo 走 URL，便于看板与在途条"点卡片接着干"，也方便把链接贴给同事。
 *  返回类型必须写成可选属性，否则 TanStack 会把 search 当成必填，`to="/workstation"` 不带 search 就报类型错 */
const workstationRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/workstation",
  validateSearch: (raw: Record<string, unknown>): { orderNo?: string } => ({
    orderNo: typeof raw.orderNo === "string" ? raw.orderNo : undefined,
  }),
  component: WorkstationPage,
});

const ordersRoute = createRoute({ getParentRoute: () => shellRoute, path: "/orders", component: OrdersPage });
const orderDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/orders/$orderNo",
  component: OrderDetailPage,
});

const partiesRoute = createRoute({ getParentRoute: () => shellRoute, path: "/parties", component: PartiesPage });
const partyDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/parties/$id",
  component: PartyDetailPage,
});

const qcRoute = createRoute({ getParentRoute: () => shellRoute, path: "/qc", component: QcPage });
const qcDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/qc/$reportNo",
  component: QcDetailPage,
});

const settlementsRoute = createRoute({ getParentRoute: () => shellRoute, path: "/settlements", component: SettlementsPage });
const settlementDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settlements/$settleNo",
  component: SettlementDetailPage,
});

const paymentsRoute = createRoute({ getParentRoute: () => shellRoute, path: "/payments", component: PaymentsPage });

/** /masters/$section —— 用壳组件把 params 传下去，页面本身保持纯 props */
const mastersRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/masters/$section",
  component: () => {
    const { section } = useParams({ from: "/masters/$section" });
    return <MastersPage section={section as MastersSection} />;
  },
});

const reportsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/reports/$kind",
  component: () => {
    const { kind } = useParams({ from: "/reports/$kind" });
    return <ReportsPage kind={kind as ReportKind} />;
  },
});

const devicesRoute = createRoute({ getParentRoute: () => shellRoute, path: "/devices", component: DevicesPage });

const systemRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/system/$section",
  component: () => {
    const { section } = useParams({ from: "/system/$section" });
    return <SystemPage section={section as SystemSection} />;
  },
});

/** 已登录就别在登录页杵着；但"必须先设口令"的情况要留在原地（LoginPage 自己判断渲染哪一态） */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: () => {
    const { session, phase } = useSession.getState();
    if (phase === "in" && session && !session.actor.mustChangePwd) {
      throw redirect({ to: "/" });
    }
  },
  component: LoginPage,
});

const routeTree = rootRoute.addChildren([loginRoute, shellRoute.addChildren([indexRoute, workstationRoute, ordersRoute, orderDetailRoute, partiesRoute, partyDetailRoute, qcRoute, qcDetailRoute, settlementsRoute, settlementDetailRoute, paymentsRoute, mastersRoute, reportsRoute, devicesRoute, systemRoute])]);

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
