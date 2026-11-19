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
import { EmptyState, PagePending } from "@/components/business/layout";
import { useSession } from "@/store/session";
import { lazy, Suspense } from "react";
import type { MastersSection } from "@/pages/MastersPage";
import type { ReportKind } from "@/pages/ReportsPage";
import type { SystemSection } from "@/pages/SystemPage";

/**
 * 21 个页面按导航现取，不进首包。
 *
 * 原来这些全是静态 import，主包堆到 2.2MB（连 recharts、react-grid-layout 一起在启动时解析执行），
 * 磅房那些弱机上光跑这段就要好几秒——那几秒就是"打开程序先白屏一会儿"。
 *
 * 页面 chunk 的取法只写在这一份表里：`lazy()` 用它做代码分割，`preloadPages()` 用同一个函数预热。
 * 两处必须共用同一批闭包——预热走成另一个 `import()` 说明符的话，模块虽然进了缓存，
 * lazy 那边照样重新取一遍，等于白跑。
 *
 * 表的**键序就是预热顺序**，照侧栏排：磅房和磅单中心最先落地，带图表的报表排在后面。
 *
 * 三条口径别破：
 *  1. React.lazy 只认 default 导出，页面清一色具名导出，所以每个都要 .then 转一下。
 *  2. 类型必须走 `import type`（见上面 MastersSection 那三行）——写成值 import 会把页面又拽回首包。
 *  3. 每个懒页面都得落在某个 Suspense 边界里头，见 RootComponent 的登录分支与 AppShell 的内容区。
 */
const PAGE_LOADERS = {
  dashboard: () => import("@/pages/DashboardPage").then((m) => ({ default: m.DashboardPage })),
  workstation: () => import("@/pages/WorkstationPage").then((m) => ({ default: m.WorkstationPage })),
  orders: () => import("@/pages/OrdersPage").then((m) => ({ default: m.OrdersPage })),
  orderDetail: () => import("@/pages/OrderDetailPage").then((m) => ({ default: m.OrderDetailPage })),
  outbound: () => import("@/pages/OutboundPage").then((m) => ({ default: m.OutboundPage })),
  outboundDetail: () => import("@/pages/OutboundDetailPage").then((m) => ({ default: m.OutboundDetailPage })),
  devices: () => import("@/pages/DevicesPage").then((m) => ({ default: m.DevicesPage })),
  stock: () => import("@/pages/StockPage").then((m) => ({ default: m.StockPage })),
  parties: () => import("@/pages/PartiesPage").then((m) => ({ default: m.PartiesPage })),
  partyDetail: () => import("@/pages/PartyDetailPage").then((m) => ({ default: m.PartyDetailPage })),
  qc: () => import("@/pages/QcPage").then((m) => ({ default: m.QcPage })),
  qcDetail: () => import("@/pages/QcDetailPage").then((m) => ({ default: m.QcDetailPage })),
  settlements: () => import("@/pages/SettlementsPage").then((m) => ({ default: m.SettlementsPage })),
  settlementDetail: () => import("@/pages/SettlementDetailPage").then((m) => ({ default: m.SettlementDetailPage })),
  payments: () => import("@/pages/PaymentsPage").then((m) => ({ default: m.PaymentsPage })),
  masters: () => import("@/pages/MastersPage").then((m) => ({ default: m.MastersPage })),
  reports: () => import("@/pages/ReportsPage").then((m) => ({ default: m.ReportsPage })),
  cards: () => import("@/pages/CardsPage").then((m) => ({ default: m.CardsPage })),
  system: () => import("@/pages/SystemPage").then((m) => ({ default: m.SystemPage })),
  support: () => import("@/pages/SupportPage").then((m) => ({ default: m.SupportPage })),
  login: () => import("@/pages/LoginPage").then((m) => ({ default: m.LoginPage })),
};

const LoginPage = lazy(PAGE_LOADERS.login);
const DashboardPage = lazy(PAGE_LOADERS.dashboard);
const WorkstationPage = lazy(PAGE_LOADERS.workstation);
const OrdersPage = lazy(PAGE_LOADERS.orders);
const OrderDetailPage = lazy(PAGE_LOADERS.orderDetail);
const OutboundPage = lazy(PAGE_LOADERS.outbound);
const OutboundDetailPage = lazy(PAGE_LOADERS.outboundDetail);
const StockPage = lazy(PAGE_LOADERS.stock);
const PartiesPage = lazy(PAGE_LOADERS.parties);
const PartyDetailPage = lazy(PAGE_LOADERS.partyDetail);
const QcPage = lazy(PAGE_LOADERS.qc);
const QcDetailPage = lazy(PAGE_LOADERS.qcDetail);
const SettlementsPage = lazy(PAGE_LOADERS.settlements);
const SettlementDetailPage = lazy(PAGE_LOADERS.settlementDetail);
const PaymentsPage = lazy(PAGE_LOADERS.payments);
const MastersPage = lazy(PAGE_LOADERS.masters);
const ReportsPage = lazy(PAGE_LOADERS.reports);
const DevicesPage = lazy(PAGE_LOADERS.devices);
const CardsPage = lazy(PAGE_LOADERS.cards);
const SystemPage = lazy(PAGE_LOADERS.system);
const SupportPage = lazy(PAGE_LOADERS.support);

/**
 * 首屏画完之后，把还没取过的页面 chunk 一个个读进来。
 *
 * 为什么必须预热而不是等点到再取：侧栏用的是 `navigate()` 不是 `<Link>`，
 * `defaultPreload: "intent"` 那套悬停预读一次都不会触发，于是每个页面**头一次**打开都要
 * 现读盘、现解析，Suspense 骨架先顶上去——就是"页面闪一下才出来"。
 * 本地磁盘上一个 chunk 也就几毫秒，但弱机上解析执行是真耗时，且骨架一定会先画出一帧。
 *
 * 串行 await 而不是一次 all：二十来份模块同时执行会在空闲那几秒把 CPU 占满，
 * 正在看首页的人会觉得卡；一份一份来，浏览器自己会把每份之间让出来。
 */
export async function preloadPages(): Promise<void> {
  for (const load of Object.values(PAGE_LOADERS)) {
    try {
      await load();
    } catch {
      // 预热失败不当回事：真导航到那一页时 lazy 会自己再取一次，取不到照样有中文空态兜着
    }
  }
}

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
  // 业务页那一支的 Suspense 在 AppShell 的内容区（壳要保持不动）；登录页不套壳，边界只能挂在这里。
  if (isLogin) return <Suspense fallback={<PagePending />}><Outlet /></Suspense>;
  return <AppShell />;
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

const outboundRoute = createRoute({ getParentRoute: () => rootRoute, path: "/outbound", component: OutboundPage });
const outboundDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/outbound/$no",
  component: OutboundDetailPage,
});
// 库存账：结存矩阵与出入库流水同页两屏（结存的一格下钻就是流水，拆两页只会各留一套筛选）
const stockRoute = createRoute({ getParentRoute: () => rootRoute, path: "/stock", component: StockPage });

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

const cardsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/cards", component: CardsPage });

// 付费服务与售后入口；二次开发可移除，但分发须遵守 AGPL-3.0（见 SupportPage 文件头说明）
const supportRoute = createRoute({ getParentRoute: () => rootRoute, path: "/support", component: SupportPage });

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

const routeTree = rootRoute.addChildren([loginRoute, indexRoute, workstationRoute, ordersRoute, orderDetailRoute, outboundRoute, outboundDetailRoute, stockRoute, partiesRoute, partyDetailRoute, qcRoute, qcDetailRoute, settlementsRoute, settlementDetailRoute, paymentsRoute, mastersRoute, reportsRoute, devicesRoute, cardsRoute, supportRoute, systemRoute]);

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
