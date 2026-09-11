/**
 * 路由表（05 §3 页面清单）。
 *
 * 用手动路由树而不是 codegen 插件：单机桌面工程不想为 27 条路由再引入
 * 一个构建期依赖，手写一次即可稳定类型推导。
 *
 * 清单里的 /masters/* 与 /reports/* 各用一个动态段收敛，
 * 既保持 URL 与文档一致，又少 10 个几乎同构的 route 定义。
 *
 * 登录门禁（02 §11 M10"未登录不可进入任何业务页"）：壳与守卫都收敛到根路由——
 * 根路由 beforeLoad 除 `/login` 外全站过一遍守卫，component 只在 `/login` 裸渲染、其余套 AppShell。
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
  useRouterState,
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

/** 会话状态 → 能不能进业务页。`mustChangePwd` 视同未登录：进了也只能看，不如先把密码设了 */
async function guard() {
  await useSession.getState().boot();
  const { session } = useSession.getState();
  if (!session || session.actor.mustChangePwd) {
    throw redirect({ to: "/login" });
  }
}

/**
 * 根路由一手包办「壳 + 门禁」：
 *  - beforeLoad：除 `/login` 外全站过一遍会话守卫（原来挂在 shell 上，现在收敛到根，判定仍只此一处）
 *  - component：命中 `/login` 裸渲染（登录页不套侧栏/菜单栏/设备条），其余一律套 AppShell
 *
 * 为什么不再单设一个 pathless 的 shell 布局路由：TanStack 里匹配 `/` 的终端路由其 id 恒为 `/`，
 * 而为了让子路由 id 保持干净的 `/orders` 那种写法，布局路由的 id 又必须占住 `/`——两者在 `/` 上撞车，
 * 于是 createRouter 抛 "Duplicate routes found with id: /"。把壳挪到根路由后，所有业务页都成了根的
 * 直接子路由，id 天然等于各自的 path，页面里 `useParams({ from: "/orders/$orderNo" })` 一行都不用改。
 */
function RootComponent() {
  const isLogin = useRouterState({ select: (s) => s.location.pathname === "/login" });
  return isLogin ? <Outlet /> : <AppShell />;
}

const rootRoute = createRootRoute({
  component: RootComponent,
  beforeLoad: ({ location }) => {
    if (location.pathname === "/login") return;
    return guard();
  },
});

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

/** 已登录就别在登录页杵着；但"必须先设密码"的情况要留在原地（LoginPage 自己判断渲染哪一态） */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: async () => {
    await useSession.getState().boot();
    const { session, phase } = useSession.getState();
    if (phase === "in" && session && !session.actor.mustChangePwd) {
      throw redirect({ to: "/" });
    }
  },
  component: LoginPage,
});

const routeTree = rootRoute.addChildren([loginRoute, indexRoute, workstationRoute, ordersRoute, orderDetailRoute, partiesRoute, partyDetailRoute, qcRoute, qcDetailRoute, settlementsRoute, settlementDetailRoute, paymentsRoute, mastersRoute, reportsRoute, devicesRoute, systemRoute]);

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
