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
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useQuickDetail, type QuickDetailType } from "@/components/business/quickDetail";
import { OrderDetailBody } from "@/pages/OrderDetailPage";
import { PartyDetailBody } from "@/pages/PartyDetailPage";
import { QcDetailBody } from "@/pages/QcDetailPage";
import { SettlementDetailBody } from "@/pages/SettlementDetailPage";

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
        {target?.type === "order" && <OrderDetailBody orderNo={target.id} embedded />}
        {target?.type === "party" && <PartyDetailBody partyId={Number(target.id)} embedded />}
        {target?.type === "qc" && <QcDetailBody reportNo={target.id} embedded />}
        {target?.type === "settlement" && <SettlementDetailBody settleNo={target.id} embedded />}
      </SheetContent>
    </Sheet>
  );
}
