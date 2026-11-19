/**
 * 统一详情抽屉容器（05 §6.3）。
 *
 * 抽屉不再自己画一套"精简版详情"，而是直接渲染四个详情页的正文组件：
 * 列表点行弹出的内容与详情整页完全一致，看一张单不必再点第二次。
 * 状态与内联链接在 `quickDetail.tsx`，那个模块不引页面，这里的 import 图才不成环。
 *
 * 宽度按正文里最宽的那几块（磅单详情的 xl:grid-cols-2 + 称重轨迹 11 列）定的：
 * 96vw（上限 1760 px）下两张卡片并排仍然立得住，再宽就把列表整块盖住了。
 * 这条上限只在这里给：`ui/sheet.tsx` 里不要再放默认 max-w，它会盖掉调用方的宽度。
 */
import { lazy, Suspense } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useQuickDetail, type QuickDetailType } from "@/components/business/quickDetail";
import { PagePending } from "@/components/business/layout";

/**
 * 四个正文按抽屉打开时再取。
 *
 * 它们与详情整页共用同一份实现，写成静态 import 会把四页的代码连同各自的依赖一起钉进首包——
 * router.tsx 那份代码分割就白做了（构建期 INEFFECTIVE_DYNAMIC_IMPORT 报的正是这四处）。
 * 抽屉本来就要人点一下才出，多等一个本地 chunk 读盘看不出来。
 */
const OrderDetailBody = lazy(() => import("@/pages/OrderDetailPage").then((m) => ({ default: m.OrderDetailBody })));
const PartyDetailBody = lazy(() => import("@/pages/PartyDetailPage").then((m) => ({ default: m.PartyDetailBody })));
const QcDetailBody = lazy(() => import("@/pages/QcDetailPage").then((m) => ({ default: m.QcDetailBody })));
const SettlementDetailBody = lazy(() => import("@/pages/SettlementDetailPage").then((m) => ({ default: m.SettlementDetailBody })));

const ARIA_LABEL: Record<QuickDetailType, string> = {
  order: "磅单详情",
  party: "售粮人档案详情",
  qc: "质检单详情",
  settlement: "结算单详情",
};

export function QuickDetailSheet() {
  const { target, close } = useQuickDetail();

  return (
    <Sheet open={!!target} onOpenChange={(open) => !open && close()}>
      <SheetContent side="right" className="w-[96vw] sm:max-w-[1760px] gap-0 overflow-hidden p-0" aria-label={target ? ARIA_LABEL[target.type] : undefined}>
        {/* 四个正文都在同一个边界里：target 为空时一个都不渲染，启动因此不会被这里的 import 触发 */}
        <Suspense fallback={<PagePending />}>
          {target?.type === "order" && <OrderDetailBody orderNo={target.id} embedded />}
          {target?.type === "party" && <PartyDetailBody partyId={Number(target.id)} embedded />}
          {target?.type === "qc" && <QcDetailBody reportNo={target.id} embedded />}
          {target?.type === "settlement" && <SettlementDetailBody settleNo={target.id} embedded />}
        </Suspense>
      </SheetContent>
    </Sheet>
  );
}
