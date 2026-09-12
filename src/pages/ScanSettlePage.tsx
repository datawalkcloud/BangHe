/**
 * 扫码结算窗口（02 §F1.4 的"结算"那一半；05 §3 `/scan-settle`）。
 *
 * 现场节奏是这样的：车过完磅，码单打出来给客户，钱**当时不算**。客户下午或第二天
 * 拿着一沓票回到这个窗口，出纳一张一张扫票面上的二维码——扫进来就是那张磅单，
 * 现场议价、现场扣重、现场收钱，一次结一张。所以：
 *
 *  - **扫码是唯一的入口**。工作台那一屏已经不再结算（PrintPanel 只出票），
 *    现金客户也一样要扫一次：不扫就没有"哪张单、什么时候、被谁结算"的对应关系，
 *    事后对账只能靠人脑回忆，那是红冲和扯皮的源头。
 *  - **一码一单**，不做多单合并。粮站的价按品种、按等级、按水分一单一议，
 *    把三张单攒成一篮再摊一个价，等于放弃逐单议价；真要并到一张付款凭证上，结算台账里查得到人。
 *  - **一切判定都摆在脸上**。扫错了票（质检单、别人的结算凭证、作废单、已经结过的单）
 *    必须当场说清楚"这是什么、该上哪儿去"，而不是丢一句"单据不存在"把人钉在这儿。
 *    重复结算在库里本来就有闸门（03 §3.6 不变式 6），这一屏只是提前一步、用人话拦住。
 *
 * 客户把票弄丢了也能结：左边「待结算池」按售粮人列出所有没结的磅单，点一下等同扫一下。
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, BanknoteIcon, FileScanIcon, PrinterIcon, ScanLineIcon, WalletIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { ORDER_STATUS, PARTY_TYPE } from "@/lib/constants";
import type { Settlement, WeighOrder } from "@/mock/types";
import { dateTime, money, weight } from "@/lib/format";
import { useSetting, usePrices, useStaffNames, useStation, useVarieties } from "@/hooks/useLookups";
import { useScannerCapture } from "@/hooks/useScannerCapture";
import { useSession } from "@/store/session";
import { parseScannedCode } from "@/lib/ticket-code";
import { SettleForm, type SettleOutcome } from "@/components/settlement/SettleForm";
import { ReceiptPrintPreview } from "@/components/print/receipt/ReceiptPrintPreview";
import { OrderStatusBadge, PaymentStatusBadge, ToneBadge } from "@/components/business/badges";
import { CallOut, EmptyState, InfoGrid, Kbd, PageHeader } from "@/components/business/layout";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/** 本窗口刚结完的单，只用于"我刚结了谁"的回看，不是台账（台账在 /settlements） */
interface SettledItem {
  order_no: string;
  settle_no: string;
  party_name: string;
  payable_fen: number;
  paid_now: boolean;
}

export function ScanSettlePage() {
  const { orderNo } = useSearch({ from: "/scan-settle" });
  const navigate = useNavigate();
  const qcClient = useQueryClient();
  const maySettle = useSession((s) => s.can("settle.create"));
  const names = useStaffNames();
  const { data: station } = useStation();
  const { data: varieties = [] } = useVarieties();
  const { data: prices = [] } = usePrices();
  const allowCredit = useSetting("settlement_allow_part_pay").bool;

  const scanRef = useRef<HTMLInputElement>(null);
  const [manual, setManual] = useState("");
  /** 最近一次扫码的判定说明（不拦事的用提示条，要拦人的走下面的闸门分支） */
  const [note, setNote] = useState<{ tone: "info" | "warning" | "danger"; text: string } | null>(null);
  const [done, setDone] = useState<SettledItem[]>([]);
  /**
   * 要打的票：结算凭证（财务入账那一联）或付款小票（客户要的那张）。
   * 两者都从同一个结算单详情取数，所以只存"哪张结算单 + 哪一种"。
   */
  const [print, setPrint] = useState<{ settleNo: string; kind: "voucher" | "payment" } | null>(null);

  const { data: order, isFetching } = useQuery({
    queryKey: ["order", orderNo],
    queryFn: () => (orderNo ? api.getOrder(orderNo) : Promise.resolve(null)),
    enabled: !!orderNo,
  });
  const { data: qcRows = [] } = useQuery({
    queryKey: ["qc-of-order", orderNo],
    queryFn: () => (orderNo ? api.listQc({ keyword: orderNo }) : Promise.resolve([])),
    enabled: !!orderNo,
  });
  const { data: bill } = useQuery({
    queryKey: ["settlement-of-order", orderNo],
    queryFn: () => (orderNo ? api.settlementOfOrderNo(orderNo) : Promise.resolve(null)),
    enabled: !!orderNo,
  });
  const { data: pool = [] } = useQuery({
    queryKey: ["pending-settlements"],
    queryFn: () => api.pendingSettlements(),
    refetchInterval: 30_000,
  });
  // 凭证上那张「结算磅单明细」表和小票上的付款记录都不在 settle 的返回值里，按单号取一次全的
  const { data: printDetail } = useQuery({
    queryKey: ["settlement-print", print?.settleNo],
    queryFn: () => (print ? api.settlementOf(print.settleNo) : Promise.resolve(null)),
    enabled: !!print,
  });

  const qc = useMemo(
    () => (order?.qc_report_id != null ? (qcRows.find((r) => r.id === order.qc_report_id) ?? null) : null),
    [qcRows, order?.qc_report_id],
  );
  const variety = useMemo(() => varieties.find((v) => v.id === order?.variety_id) ?? null, [varieties, order?.variety_id]);

  /** 载入一张单 = 换掉 URL 上的 orderNo。与扫码同一条路径，池子里点一下也是它 */
  const openOrder = useCallback(
    (no: string) => {
      setNote(null);
      void navigate({ to: "/scan-settle", search: { orderNo: no } });
    },
    [navigate],
  );

  /** 一次扫码的判定：认得出种类 → 不是本窗口正在处理的这张 → 载入 */
  const handleCode = useCallback(
    (raw: string) => {
      const code = parseScannedCode(raw);
      if (!code) {
        setNote({
          tone: "danger",
          text: `这个码我们认不出来（${raw.trim().slice(0, 40) || "空"}）。可能是别家粮站的票，或码被压坏了——可以在上面框里手输码单上的单号。`,
        });
        return;
      }
      if (code.kind === "order") {
        if (code.docNo === orderNo) {
          setNote({ tone: "info", text: `码单 ${code.docNo} 已经在当前窗口，不用重复扫。` });
          return;
        }
        openOrder(code.docNo);
        if (!code.prefixed) setNote({ tone: "info", text: `按单号 ${code.docNo} 取单（没扫到票面码，可能是手输或旧版票）。` });
        return;
      }
      if (code.kind === "settlement") {
        setNote({ tone: "warning", text: `递过来的是结算凭证（${code.docNo}），不是码单。结算凭证是已经算过钱的单子，挂账未付清请到「付款与挂账」核销。` });
        return;
      }
      if (code.kind === "payment") {
        setNote({ tone: "info", text: `递过来的是付款凭证（${code.docNo}）：这一笔已经付过钱了。要复核付款记录去「付款与挂账」。` });
        return;
      }
      if (code.kind === "qc") {
        setNote({ tone: "warning", text: `递过来的是质检单（${code.docNo}），质检单不能结算。请让客户翻出那张收购码单。` });
        return;
      }
      setNote({ tone: "danger", text: `扫到的是本系统没有的单据种类（${code.docNo}），只有码单（BD）能在这里结算。` });
    },
    [orderNo, openOrder],
  );

  // 打印弹层开着时不捕获扫码：那会儿焦点在弹层里，扫进来的码不该换掉底下的单
  useScannerCapture(handleCode, { enabled: !print });

  const onSettled = useCallback(
    (r: SettleOutcome) => {
      const paidNow = r.settlement.payment_status === "paid";
      setDone((s) => [
        { order_no: r.order.order_no, settle_no: r.settlement.settle_no, party_name: r.order.party_name, payable_fen: r.settlement.payable_fen, paid_now: paidNow },
        ...s,
      ]);
      toast.success(`已结算 ${r.order.order_no} · 应付 ${money(r.settlement.payable_fen)}${paidNow ? "，已付清" : "，已挂账"}`, {
        description: paidNow ? "结算凭证已弹出打印；先关掉也行，客户要走时再补一张。" : "这张凭证日后凭票面上的码到「付款与挂账」核销。",
      });
      const keys: string[][] = [
        ["order", r.order.order_no],
        ["orders"],
        ["settlements"],
        ["pending-settlements"],
        ["settlement-of-order", r.order.order_no],
        ["dashboard"],
      ];
      for (const key of keys) qcClient.invalidateQueries({ queryKey: key });
      // 结算完自动弹凭证：老流程里"结完顺手打一张"是习惯，那一联是财务入账的依据，不能指望人记得打
      setPrint({ settleNo: r.settlement.settle_no, kind: "voucher" });
      setManual("");
    },
    [qcClient],
  );

  const gate = useMemo(() => gateOf(order ?? null, bill ?? null, maySettle, allowCredit), [order, bill, maySettle, allowCredit]);

  const printSettlement = printDetail?.settlement ?? null;
  /** 付款小票打最后一笔：当场结清时只有一条；挂账后分次核销，打的正是刚发生的这一笔 */
  const printPayment = print?.kind === "payment" ? (printDetail?.payments?.at(-1) ?? null) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="扫码结算"
        description={
          <>
            客户凭码单右下角的二维码到窗口算钱：扫一张、结一张、结完即清。<Kbd>F10</Kbd> 提交结算；票没带来可在左侧「待结算池」按姓名点出那张单。
          </>
        }
        actions={
          <>
            <Button size="sm" variant="outline" render={<Link to="/settlements" />}>
              <WalletIcon />
              结算台账
            </Button>
            <Button size="sm" variant="outline" render={<Link to="/payments" />}>
              <BanknoteIcon />
              付款与挂账
            </Button>
          </>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto px-6 py-4 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)] xl:overflow-hidden">
        <div className="flex min-h-0 flex-col gap-3">
          <Card size="sm" className="shrink-0 py-0 gap-0">
            <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center border-b px-2.5">
              <CardTitle className="text-xs font-semibold">
                <ScanLineIcon className="mr-1 inline size-3.5" />
                扫码口
              </CardTitle>
              <CardAction className="self-center">
                <ToneBadge tone={order ? "success" : "neutral"}>{order ? `已取单 ${order.order_no}` : "等待扫码"}</ToneBadge>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-1.5 p-2">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!manual.trim()) return;
                  handleCode(manual);
                  setManual("");
                }}
                className="flex gap-1.5"
              >
                <Input
                  ref={scanRef}
                  autoFocus
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  placeholder="扫码枪扫码单，或手输码单号后回车"
                  aria-label="扫码 / 输入码单号"
                  className="h-9 font-mono text-sm"
                />
                <Button size="sm" type="submit" className="shrink-0">
                  <FileScanIcon />
                  取单
                </Button>
              </form>
              <p className="text-[11px] text-muted-foreground">
                光标不在别的输入框里时，扫码枪的按键会被直接当成一次扫码收走，不必先点进这个框。
              </p>
              {note && (
                <CallOut tone={note.tone} title={note.tone === "info" ? "提示" : "这张票在这儿结不了"}>
                  {note.text}
                </CallOut>
              )}
            </CardContent>
          </Card>

          <PoolCard pool={pool} activeNo={orderNo} onPick={openOrder} />

          {done.length > 0 && (
            <Card size="sm" className="shrink-0 py-0 gap-0">
              <CardHeader className="card-header-compact border-b px-2.5">
                <CardTitle className="text-xs font-semibold">本窗口已结 {done.length} 张</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 p-2 text-xs">
                {done.slice(0, 6).map((s) => (
                  <div key={s.order_no} className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate">
                      <span className="tnum">{s.order_no}</span> · {s.party_name}
                    </span>
                    <span className={`tnum shrink-0 ${s.paid_now ? "" : "text-warning"}`}>
                      {money(s.payable_fen)}
                      {!s.paid_now && " 挂账"}
                    </span>
                  </div>
                ))}
                {done.length > 6 && <p className="text-[10px] text-muted-foreground">其余 {done.length - 6} 张以结算台账为准。</p>}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="min-h-0 overflow-y-auto">
          {!orderNo ? (
            <EmptyState
              title="等一张码单"
              description="把客户递来的收购码单右下角那个二维码对准扫码枪即可。票丢了就从左边「待结算池」按售粮人点出那张单。"
            />
          ) : isFetching && !order ? (
            <Card size="sm" className="py-0 gap-0">
              <CardContent className="p-6 text-xs text-muted-foreground">正在读取 {orderNo}…</CardContent>
            </Card>
          ) : !order ? (
            <CallOut
              tone="danger"
              title={`查不到磅单 ${orderNo}`}
              action={
                <Button size="xs" variant="outline" render={<Link to="/orders" />}>
                  到磅单中心查
                  <ArrowRightIcon />
                </Button>
              }
            >
              常见原因：票不是本站打的（换站码、换了另一套系统）、单号被折角或晒白扫错、这张单已被归档清理。
              先核一眼票面上的单号与站码；对不上就让客户报姓名，在「磅单中心」按人查。
            </CallOut>
          ) : (
            <div className="flex flex-col gap-3">
              <OrderCard order={order} bill={bill ?? null} onPrint={(kind) => bill && setPrint({ settleNo: bill.settle_no, kind })} />
              {gate ? (
                <CallOut tone={gate.tone} title={gate.title} action={gate.action}>
                  {gate.body}
                </CallOut>
              ) : (
                <Card size="sm" className="py-0 gap-0">
                  <CardHeader className="card-header-compact border-b px-2.5">
                    <CardTitle className="text-xs font-semibold">计价与收款 · {order.order_no}</CardTitle>
                  </CardHeader>
                  <CardContent className="p-2">
                    <SettleForm
                      order={order}
                      variety={variety}
                      qc={qc}
                      prices={prices}
                      allowCredit={allowCredit}
                      onSettled={onSettled}
                    />
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>
      </div>

      {station && printSettlement && (
        <ReceiptPrintPreview
          open={!!print && (print.kind === "voucher" || !!printPayment)}
          onOpenChange={(v) => {
            if (v) return;
            setPrint(null);
            // 关掉凭证就把注意力交回扫码口：这一屏是"一张接一张"的节奏，不该停在原地找键盘。
            // rAF 是等 Dialog 自己把焦点还给触发元素之后再抢回来，否则会被它盖回去。
            window.requestAnimationFrame(() => scanRef.current?.focus());
            void navigate({ to: "/scan-settle", search: {} });
          }}
          scenario={print?.kind === "payment" ? "payment_receipt" : "settlement_voucher"}
          context={{ station, names, settlement: printSettlement, payment: printPayment ?? undefined }}
          docNo={print?.kind === "payment" ? printPayment?.pay_no ?? printSettlement.settle_no : printSettlement.settle_no}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 当前单摘要 */

function OrderCard({
  order,
  bill,
  onPrint,
}: {
  order: WeighOrder;
  bill: Settlement | null;
  onPrint: (kind: "voucher" | "payment") => void;
}) {
  const settled = order.settled_at != null || order.status === "settled" || order.status === "paid" || order.status === "archived";
  return (
    <Card size="sm" className="shrink-0 py-0 gap-0">
      <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center border-b px-2.5">
        <CardTitle className="flex items-center gap-2 text-xs font-semibold">
          <span className="tnum">{order.order_no}</span>
          <OrderStatusBadge status={order.status} />
          {settled && <PaymentStatusBadge status={order.payment_status} />}
        </CardTitle>
        <CardAction className="flex items-center gap-1.5 self-center text-[11px] text-muted-foreground">
          {bill && (
            <Button size="xs" variant="outline" onClick={() => onPrint("voucher")}>
              <PrinterIcon />
              结算凭证
            </Button>
          )}
          {bill?.payment_status === "paid" && (
            <Button size="xs" variant="outline" onClick={() => onPrint("payment")}>
              <PrinterIcon />
              付款小票
            </Button>
          )}
          {dateTime(order.registered_at)} 制单
        </CardAction>
      </CardHeader>
      <CardContent className="p-2">
        <InfoGrid
          cols={4}
          items={[
            { label: "售粮人", value: `${order.party_name} · ${PARTY_TYPE[order.party_type]}` },
            { label: "车牌", value: order.vehicle_no ?? "—" },
            { label: "品种 / 等级", value: `${order.variety_name}${order.grade ? ` · ${order.grade}` : " · 未定级"}` },
            { label: "净重", value: weight(order.net_weight_01kg) },
            { label: "仓房 / 货位", value: `${order.warehouse_name ?? "未登记"}${order.slot_label ? ` / ${order.slot_label}` : ""}` },
            { label: "称重方式", value: order.weight_source === "scale" ? "地磅读数" : "人工手录" },
            { label: settled ? "应付" : "预估应付", value: money(order.payable_amount_fen) },
            { label: "结算单", value: bill ? bill.settle_no : "尚未结算" },
            { label: "业务日期", value: order.business_date },
          ]}
        />
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ 待结算池 */

function PoolCard({ pool, activeNo, onPick }: { pool: Awaited<ReturnType<typeof api.pendingSettlements>>; activeNo?: string; onPick: (no: string) => void }) {
  const [kw, setKw] = useState("");
  const groups = useMemo(() => {
    const k = kw.trim();
    return pool
      .map((g) => ({ ...g, rows: k ? g.rows.filter((o) => o.order_no.includes(k) || o.party_name.includes(k) || (o.vehicle_no ?? "").includes(k)) : g.rows }))
      .filter((g) => g.rows.length > 0);
  }, [pool, kw]);
  const total = pool.reduce((n, g) => n + g.rows.length, 0);

  return (
    <Card size="sm" className="flex min-h-0 flex-1 py-0 gap-0">
      <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center border-b px-2.5">
        <CardTitle className="text-xs font-semibold">待结算池 {total} 张</CardTitle>
        <CardAction className="self-center">
          <Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="姓名 / 单号 / 车牌" aria-label="筛选待结算池" className="h-7 w-36 text-xs" />
        </CardAction>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-y-auto p-0">
        {groups.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            {total === 0 ? "没有待结算的磅单——该结的都结清了。" : "没有匹配这个筛选条件的单。"}
          </p>
        ) : (
          <ul className="divide-y">
            {groups.map((g) => (
              <li key={g.party.id} className="px-2.5 py-1.5">
                <p className="flex items-baseline justify-between text-[11px] text-muted-foreground">
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {g.party.name}
                    <span className="ml-1">· {PARTY_TYPE[g.party.party_type]}</span>
                  </span>
                  <span className="tnum shrink-0">{g.rows.length} 张</span>
                </p>
                <div className="mt-1 flex flex-col gap-0.5">
                  {g.rows.slice(0, 8).map((o) => (
                    <button
                      key={o.order_no}
                      type="button"
                      onClick={() => onPick(o.order_no)}
                      className={`flex items-baseline justify-between gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-accent ${activeNo === o.order_no ? "bg-accent" : ""}`}
                    >
                      <span className="tnum min-w-0 truncate">{o.order_no}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {o.variety_name} {weight(o.net_weight_01kg)}
                      </span>
                    </button>
                  ))}
                  {g.rows.length > 8 && <p className="px-1.5 text-[10px] text-muted-foreground">还有 {g.rows.length - 8} 张，收紧筛选条件或让客户把票递过来。</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ 闸门 */

interface Gate {
  tone: "info" | "warning" | "danger";
  title: string;
  body: string;
  action?: ReactNode;
}

/**
 * 能不能在这张单上算钱，返回 null 表示能。
 *
 * 判定顺序就是现场"为什么扫不下去"的顺序；每一条都得带出路，只写"不允许结算"的界面
 * 等于把出纳一个人扔在窗口——他既不能改数，也不能告诉客户为什么不行。
 */
function gateOf(order: WeighOrder | null, bill: Settlement | null, maySettle: boolean, allowCredit: boolean): Gate | null {
  if (!order) return null;

  if (!maySettle) {
    return {
      tone: "danger",
      title: "当前岗位不能在这个窗口结算",
      body: "结算需要出纳或站长权限（05 §5）。请换当班出纳的账号登录；磅员只负责出票，不负认定价。",
    };
  }
  if (order.status === "voided" || order.status === "rejected" || order.status === "reversed" || order.status === "archived") {
    return {
      tone: "danger",
      title: `这张单是「${ORDER_STATUS[order.status].label}」，不能结算`,
      body: `${ORDER_STATUS[order.status].desc}${order.void_reason ? `。原因：${order.void_reason}` : ""}。要更正只能走红冲流程，不能在窗口直接改数收钱。`,
      action: (
        <Button size="xs" variant="outline" render={<Link to="/orders/$orderNo" params={{ orderNo: order.order_no }} />}>
          看这张单
          <ArrowRightIcon />
        </Button>
      ),
    };
  }
  /**
   * "已经结过了"的唯一可靠判据。
   *
   * 不能用 settlement_weight_01kg / price_fen_per_ton 不空来代理：`to_settle` 这个状态的定义
   * 本身就是"净重与结算重量已确定、待结算"，建单时还会带出预估价与预估应付——按那个写法，
   * 每一张等着被结算的单都会被判定成"已经结算过"，窗口直接把自己锁死。
   */
  const alreadySettled = !!bill || order.settled_at != null || order.status === "settled" || order.status === "paid";
  if (alreadySettled) {
    const paid = order.payment_status === "paid";
    return {
      tone: paid ? "info" : "warning",
      title: paid ? "这张单已经结算并付清了" : "这张单已经结算过，还没付清",
      body: `结算单 ${bill?.settle_no ?? "已生成"} 于 ${dateTime(bill?.settled_at ?? order.settled_at)}，重复结算在库里就被拦（不变式 6）。${
        paid ? "客户要再拿一张纸，点上方「结算凭证」或「付款小票」即可。" : allowCredit ? "挂账的到「付款与挂账」按结算单核销。" : "本站已关闭挂账，请把尾款当场收清。"
      }`,
      action: bill ? (
        <Button size="xs" variant="outline" render={<Link to="/settlements/$settleNo" params={{ settleNo: bill.settle_no }} />}>
          看结算单
          <ArrowRightIcon />
        </Button>
      ) : undefined,
    };
  }
  if (order.net_weight_01kg == null) {
    return {
      tone: "warning",
      title: "净重还没确定，算不了钱",
      body: `当前状态「${ORDER_STATUS[order.status].label}」：${ORDER_STATUS[order.status].desc}。请让客户回磅房把剩下的那一次过磅做完。`,
      action: (
        <Button size="xs" variant="outline" render={<Link to="/workstation" search={{ orderNo: order.order_no }} />}>
          带到工作台
          <ArrowRightIcon />
        </Button>
      ),
    };
  }
  return null;
}
