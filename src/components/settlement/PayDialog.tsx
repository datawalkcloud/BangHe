/**
 * 挂账核销弹窗（补付框的"框体"）。
 *
 * 同一件事如今有两个入口，进的是同一个框：
 *  - 磅房工作台：第③刷 / 扫票面码 / 称重区「去结算」命中"钱算过、没付完"的单，
 *    由 `WorkstationPage::requestSettle` 分派到这里（那条路上另有扫**结算凭证**直接进来的）；
 *  - 磅单详情的「结算与付款」卡片：所属结算单还有未付余额时，底部那枚「付款」。
 *
 * 为什么把框体也抽出来（表单本体 `PayForm` 早就是单源）：这里显示的是**应付 / 已付 / 尚欠**，
 * 而 `PayForm` 的超额校验读的就是同一个 `unpaidFen`。两处各写一份排版，迟早一边显示尚欠
 * 200、另一边按 300 拦人——差的那一笔只能靠红冲收拾。所以：
 *  1. 结算单**每次开框都重取**（`refetchOnMount: "always"`）：已付与付款状态是刚登记完的数，
 *     吃缓存会把已经付清的单继续当挂账单显示，余额也会带进下一笔；
 *  2. 校验、`api.recordPayment`、每笔登记自动出结算凭证，全在 `PayForm`，这里不碰；
 *  3. 进框前那一步判定（查无此单 / 已撤销 / 已付清 / 岗位无权收钱）是 `settle-gate.ts::creditPayGate`，
 *     由调用方把关——判定层只出结论不出控件，拦下来时用什么提示（吐司 / 红字 / 语音）归调用方那块界面。
 *
 * 「登记成功之后干什么」不在这里：语音播报、在途条与当前单的缓存重取是磅房现场的事，
 * 磅单详情要重取的是本页那一行账，各自通过 `onPaid` 接走。关框由本组件负责：登记成功即收框
 * （工作台从前就是这个行为——`onPaid` 里 `setPayNo(null)`），人不在框上站着了还留个空框，
 * 只会诱导他把同一笔钱再点一次。
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { date, rmbUpper } from "@/lib/format";
import { unpaidFen } from "@/lib/settle-gate";
import type { Settlement } from "@/mock/types";
import { MoneyLine } from "@/components/business/NumField";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PayForm } from "@/components/settlement/PayForm";

/** 结算单详情那一行账（结算单本体 + 它名下的磅单与付款流水），即 `api.settlementOf` 的返回 */
export type SettlementDetail = NonNullable<Awaited<ReturnType<typeof api.settlementOf>>>;

/**
 * @param settleNo 要收钱的那张结算单号；null = 框关着
 * @param onClose  收起这一框（调用方清掉自己那份 settleNo 状态）
 * @param onPaid   登记成功后的收尾，先于关框执行：`paid` 是库里写回后的那一行（已付与付款状态都是新的），
 *                 `detail` 是开框时读到的那一份，调用方要用它拿到同批磅单号去刷新各自的行
 */
export function PayDialog({
  settleNo,
  onClose,
  onPaid,
}: {
  settleNo: string | null;
  onClose: () => void;
  onPaid?: (paid: Settlement, detail: SettlementDetail) => void;
}) {
  const { data: detail } = useQuery({
    queryKey: ["settlement", settleNo],
    queryFn: () => (settleNo ? api.settlementOf(settleNo) : Promise.resolve(null)),
    enabled: settleNo != null,
    refetchOnMount: "always",
  });

  return (
    <Dialog open={settleNo != null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">挂账核销 {settleNo ?? ""}</DialogTitle>
        </DialogHeader>
        {detail ? (
          <>
            <div className="flex flex-col gap-1 border-b pb-1.5 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">收款人</span>
                <span className="truncate">{detail.settlement.payee_name}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">结算于</span>
                <span className="tnum">
                  {date(detail.settlement.settled_at)} · {detail.settlement.order_count} 张磅单
                </span>
              </div>
              <MoneyLine label="应付" valueFen={detail.settlement.payable_fen} />
              <MoneyLine label="已付" valueFen={detail.settlement.paid_fen} />
              <MoneyLine label="尚欠" emphasis valueFen={unpaidFen(detail.settlement)} hint={rmbUpper(unpaidFen(detail.settlement))} />
            </div>
            <PayForm
              settlement={detail.settlement}
              onPaid={(paid) => {
                onPaid?.(paid, detail);
                onClose();
              }}
            />
          </>
        ) : (
          <p className="py-4 text-center text-xs text-muted-foreground">读取结算单中…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
