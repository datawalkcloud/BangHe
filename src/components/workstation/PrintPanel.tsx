/**
 * ⑤ 凭票与打印（05 §4 右栏）。
 *
 * 这块原来叫「结算与打印」，两件事挤在一个按钮上：按 F10 先 `order_settle` 生成结算单、
 * 再弹打印。现场的真实节奏不是这样——绝大多数粮站是**先过磅、先打码单把票给客户**，
 * 钱等客户拿着一沓票回来再统一算。于是这一栏只管一件事：把带凭票二维码的码单打出来。
 * 结算整段挪到「扫码结算」窗口（02 §F1.4），这里连一个能改价、能收钱的输入框都不留——
 * 留一个就能被误按，磅房里定下的价和窗口定下的价，事后对不上时谁都不认。
 *
 * 留下的金额是**预估**，而且必须写明是预估：磅员要能回答客户"大概多少钱"，
 * 但那几个扣量项此刻还没人录。预估一律取化验扣重 + 价目表现价，真算钱的仍是结算窗口。
 *
 * 「已打印几张」不靠组件内的一次性 state：print_log 里本来就有这张单的打印流水，
 * 用它当唯一依据，补打角标、第几次补打、以及换人重开软件后仍然记得打过，共用同一个事实。
 */
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { PrinterIcon, ScanLineIcon } from "lucide-react";
import type { GrainVariety, PriceList, QcReport, WeighOrder } from "@/mock/types";
import { dateTimeShort, money, rmbUpper, ton, weight } from "@/lib/format";
import { previewSettlement } from "@/lib/calc";
import { lookupPrice } from "@/components/settlement/SettleForm";
import { MoneyLine } from "@/components/business/NumField";
import { PaymentStatusBadge, ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function PrintPanel({
  order,
  variety,
  qc,
  prices,
  onPrint,
}: {
  order: WeighOrder | null;
  variety: GrainVariety | null;
  qc: QcReport | null;
  prices: PriceList[];
  /** 打印走页面注册的直打路径（F9 同源）：无预览直接打到默认打印机，失败才弹预览框 */
  onPrint: () => void;
}) {
  const listed = useMemo(
    () => (order ? lookupPrice(prices, order.variety_id, order.grade ?? qc?.grade ?? null, order.business_date) : null),
    [prices, order, qc?.grade],
  );

  /**
   * 票打过几次——只认 print_log，不认本地 state。
   *
   * 判据是"这张票曾经成功出过纸"，所以失败的打印（result=failed）不算：机器卡纸一次就把
   * 下一张标成「补打」、在票面上多印一行谎话，那是把设备故障写进客户的凭据里。
   */
  const prints = useMemo(
    () => (order?.prints ?? []).filter((p) => p.doc_type === "weigh_order" && p.result === "success"),
    [order?.prints],
  );

  const preview = useMemo(
    () =>
      previewSettlement({
        net_weight_01kg: order?.net_weight_01kg ?? null,
        package_deduct_01kg: order?.package_deduct_01kg ?? variety?.default_package_deduct_01kg ?? 0,
        moisture_deduct_01kg: order?.moisture_deduct_01kg ?? qc?.moisture_deduct_01kg ?? 0,
        impurity_deduct_01kg: order?.impurity_deduct_01kg ?? qc?.impurity_deduct_01kg ?? 0,
        other_deduct_01kg: order?.other_deduct_01kg ?? 0,
        price_fen_per_ton: order?.price_fen_per_ton ?? listed?.price_fen_per_ton ?? null,
        deduction_fee_fen: order?.deduction_fee_fen ?? 0,
      }),
    [order, variety, qc, listed],
  );

  /** 没有净重就别打——票上连重量都没有，客户拿回去也结不了钱 */
  const canPrint = !!order && order.net_weight_01kg != null;
  /** 结没结过只看 settled_at / 终态：to_settle 的单本来就带着结算重量与预估价，拿它们当代理会说谎 */
  const settled = !!order && (order.settled_at != null || order.status === "settled" || order.status === "paid" || order.status === "archived");
  const lastPrintAt = prints.at(-1)?.printed_at;

  // F9 由 WorkstationPage 注册在全局：把这一栏收起来的人也得能出票，这里不再注册第二次

  return (
    <Card size="sm" className="min-w-0 py-0 gap-0">
      <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center border-b px-2.5">
        <CardTitle className="text-xs font-semibold">凭票与打印</CardTitle>
        <CardAction className="self-center">
          {prints.length > 0 ? (
            <ToneBadge tone="success">已打 {prints.length} 张</ToneBadge>
          ) : (
            <ToneBadge tone="warning">未打印</ToneBadge>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 p-2">
        {!order ? (
          <p className="py-6 text-center text-xs text-muted-foreground">制单并完成称重后，这里出现打印入口。</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-1 text-xs">
              <span className="text-muted-foreground">价目表现价</span>
              <span className="tnum">{listed ? `${money(listed.price_fen_per_ton)}/吨 · ${listed.grade}` : "无生效价"}</span>
            </div>

            <div className="flex flex-col gap-0.5 bg-muted/25 p-1.5 text-xs">
              <div className="flex items-baseline justify-between">
                <span className="text-muted-foreground">净重</span>
                <span className="tnum">{weight(order.net_weight_01kg)}</span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">结算重量</span>
                <span className="tnum text-sm font-bold">
                  {weight(preview.settlementWeight01kg)}
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">（{ton(preview.settlementWeight01kg)}）</span>
                </span>
              </div>
              <MoneyLine label="预估应付" emphasis valueFen={preview.payableAmountFen} hint={rmbUpper(preview.payableAmountFen)} />
              <p className="text-[10px] text-muted-foreground">
                {settled ? "本单已结算，以上即结算结果" : "预估按化验扣重与价目表现价，实付以结算窗口录入为准"}
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <Button size="default" onClick={onPrint} disabled={!canPrint} className="h-8 text-xs">
                <PrinterIcon />
                {prints.length > 0 ? `补打码单（F9，已打 ${prints.length} 次）` : "打印码单交客户（F9）"}
              </Button>
              {!canPrint && <p className="text-xs text-warning">净重还没确定，打出来是一张没有重量的票。</p>}
              {lastPrintAt && <p className="text-[10px] text-muted-foreground">最近一次出纸 {dateTimeShort(lastPrintAt)}，再打即为补打。</p>}
            </div>

            <div className="flex flex-col gap-1 border-t pt-1.5 text-xs">
              <p className="flex items-start gap-1 text-muted-foreground">
                <ScanLineIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>本单不在这里结算。把码单交给客户，他凭票面右下角的二维码到结算窗口扫码算价付款。</span>
              </p>
              <Button size="xs" variant="outline" render={<Link to="/scan-settle" />} className="justify-start">
                <ScanLineIcon />
                去扫码结算窗口
              </Button>
            </div>

            {settled && (
              <div className="flex flex-wrap items-center gap-1 border-t pt-1 text-xs">
                <PaymentStatusBadge status={order.payment_status} />
                <span className="tnum text-muted-foreground">已付 {money(order.paid_amount_fen)}</span>
                {order.payable_amount_fen != null && order.payable_amount_fen - order.paid_amount_fen > 0 && (
                  <ToneBadge tone="warning">未付 {money(order.payable_amount_fen - order.paid_amount_fen)}</ToneBadge>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
