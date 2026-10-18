/**
 * 挂账补付表单（02 §F5.2「凭结算凭证核销」那一步的落点）。
 *
 * 为什么单独成文件：同一件事如今有两个现场入口——「结算台账」里点开结算单详情的右栏卡片，
 * 与磅房工作台扫票面码 / 第③刷命中"钱算过、没付完"时弹出的补付框。两处收的都是
 * `api.recordPayment`，但**校验与出票必须只有一份**：金额不得超出未付余额、非现金必带
 * 交易流水号、每登记一笔都追加一条流水（绝不覆盖已付数）、且每次成功都出一张结算凭证
 * 给客户当收款依据。分两处写迟早一边收得进去、一边收不进去，而差的那一笔只能靠红冲收拾。
 *
 * 前端的校验只是让人少跑一步；库里 `settlements.rs::record_payment` 同样拦超额、
 * 拦已撤销，命令层回的是中文短句，吐司原样上屏。
 *
 * **付款方式刻意不预选**（与 `SettleForm` 同一条道理）：默认停在「现金」上等于替出纳认了
 * 一笔付款渠道，十单有九单照默认走，月底「付款方式分布」就全是现金、那个统计再没人敢信。
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BanknoteIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { PaymentMethod } from "@/lib/constants";
import { PAYMENT_METHOD } from "@/lib/constants";
import { money, rmbUpper } from "@/lib/format";
import { unpaidFen } from "@/lib/settle-gate";
import { useStaffNames, useStation } from "@/hooks/useLookups";
import { actorId, useSession } from "@/store/session";
import { Choose } from "@/components/business/Choose";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { KeypadInput, alnumKeys, digitKeys } from "@/components/ui/keypad";
import { useSilentReceiptPrint } from "@/components/print/receipt/useSilentPrint";
import type { Settlement } from "@/mock/types";

export function PayForm({ settlement, onPaid }: { settlement: Settlement; onPaid?: (paid: Settlement) => void }) {
  const names = useStaffNames();
  const can = useSession((s) => s.can);
  const { data: station } = useStation();
  const queryClient = useQueryClient();
  const settleNo = settlement.settle_no;
  const left = unpaidFen(settlement);

  const [amountYuan, setAmountYuan] = useState("");
  /** 空串＝还没选，与 `SettleForm` 同一条口径（见文件头） */
  const [method, setMethod] = useState<PaymentMethod | "">("");
  const [tradeNo, setTradeNo] = useState("");
  /** 直连打印失败时 hook 给出的兜底预览框，没发起过出票就是 null，不占 DOM */
  const { print: printReceipt, preview: printFallback } = useSilentReceiptPrint();

  const amountFen = Math.round((Number(amountYuan) || 0) * 100);
  // 校验错误按字段归位：红框 + 紧贴控件的红字，不在表单下方聚合清单
  const amountErr =
    amountYuan.trim() === ""
      ? "请填写本次付款金额"
      : !Number.isFinite(amountFen) || amountFen <= 0
        ? "金额必须是大于 0 的数字"
        : amountFen > left
          ? `超出未付余额 ${money(left)}`
          : "";
  const tradeErr = method !== "" && method !== "cash" && tradeNo.trim() === "" ? "非现金付款请填写交易流水号" : "";
  const blocked = !!(amountErr || tradeErr) || method === "";

  /**
   * 登记成功后自动出结算凭证（票面用返回值，不用手上这份缓存）：`payment_add` 回的是
   * 写库后重新读出来的那一行，已付与付款状态都是刚登记完的——照旧数据印，票面上「已付」
   * 还是登记前那个数。票种是**结算凭证**（整单，不是付款小票），且每次登记都出：
   * 分次付款时每笔都有一张纸，农户每拿一笔钱都握得住凭据。
   */
  const printVoucher = (paid: Settlement) => {
    // 没有出票权就压根不该出纸（页头那枚「打印凭证」同样是禁用的）
    if (!can("print")) return;
    if (!station) {
      toast.warning("结算凭证没能出纸：站点信息还没载入，请到「结算台账」按单号补打一张");
      return;
    }
    void printReceipt({
      scenario: "settlement_voucher",
      docNo: paid.settle_no,
      // 这一单在「登记付款」这条路上的首次出票，不是补打
      isReprint: false,
      context: { station, names, settlement: paid },
    });
  };

  const pay = useMutation({
    mutationFn: () =>
      api.recordPayment({
        settle_no: settleNo,
        amount_fen: amountFen,
        method: method as PaymentMethod,
        operator_id: actorId(),
        trade_no: tradeNo.trim() || null,
      }),
    onSuccess: (s) => {
      if (!s) {
        toast.error("登记失败：未找到该结算单");
        return;
      }
      toast.success(`已登记付款 ${money(amountFen)}（${PAYMENT_METHOD[method as PaymentMethod]}）`);
      setAmountYuan("");
      setTradeNo("");
      setMethod("");
      for (const key of [["settlement", settleNo], ["settlements"], ["payments"], ["credits"], ["dashboard"], ["orders"]]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      printVoucher(s);
      onPaid?.(s);
    },
    // 真库闸门回的是人话（"本次付款 X 元超出未付余额 Y 元"、"本结算单已撤销"），原样送到眼前
    onError: (e) => toast.error(e instanceof Error && e.message ? e.message : "登记失败，请重试"),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span>本次金额（元）</span>
        <KeypadInput
          aria-label="本次付款金额"
          aria-invalid={amountErr ? true : undefined}
          value={amountYuan}
          onChangeValue={setAmountYuan}
          keys={digitKeys({ decimalPoint: true })}
          columns={6}
          maxLength={12}
          toggleLabel="数字"
          inputMode="decimal"
          autoComplete="off"
          placeholder={String(left / 100)}
          inputClassName="tnum text-base"
        />
        {!!amountErr && <span className="text-destructive">{amountErr}</span>}
        <Button type="button" variant="outline" className="h-8 self-stretch text-sm" onClick={() => setAmountYuan(String(left / 100))}>
          全额付清 {money(left)}
        </Button>
        <span className="text-[11px]">尚欠 <span className="tnum">{money(left)}</span>（{rmbUpper(left)}），改小即为分次付款。</span>
      </div>
      <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
        付款方式
        <Choose
          aria-label="付款方式"
          value={method}
          onChange={(v) => setMethod(v as PaymentMethod)}
          invalid={method === ""}
          options={[
            // 未选就是一枚真选项（空串），不是"没渲染出来的值"：原生 select 找不到匹配项时
            // 会自顾自显示第一项，那就又变成了"默认现金"
            { value: "", label: "请选择" },
            ...(Object.keys(PAYMENT_METHOD) as PaymentMethod[])
              .filter((k) => k !== "credit_writeoff")
              .map((k) => ({ value: k, label: PAYMENT_METHOD[k] })),
          ]}
        />
      </Label>
      {method === "" && <p className="-mt-2 text-xs text-destructive">请选择付款方式</p>}
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span>交易流水号 / 凭证号</span>
        <KeypadInput
          aria-label="交易流水号"
          aria-invalid={tradeErr ? true : undefined}
          value={tradeNo}
          onChangeValue={setTradeNo}
          keys={alnumKeys()}
          columns={9}
          maxLength={32}
          toggleLabel="键盘"
          autoComplete="off"
          placeholder="现金可不填"
          inputClassName="tnum text-sm"
        />
        {!!tradeErr && <span className="text-destructive">{tradeErr}</span>}
      </div>
      <Button size="sm" disabled={blocked || pay.isPending} onClick={() => pay.mutate()}>
        <BanknoteIcon />
        {pay.isPending ? "登记中…" : "确认付款"}
      </Button>
      <p className="text-xs text-muted-foreground">
        每次登记付款都会自动打一张结算凭证：凭证联交售粮人，存根联财务留存。没出纸会弹预览框，手动补打即可。
      </p>
      {printFallback}
    </div>
  );
}
