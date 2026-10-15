/**
 * 磅单详情（05 §3 `/orders/$orderNo`）。
 *
 * 这张页面的存在理由只有一个：迎检与纠纷。所以它不做任何"美化"，
 * 而是把 谁在什么时间以什么来源留下了什么数字 完整摊开：
 *   基本信息 → 重量轨迹（含被弃用的读数）→ 化验指标 → 结算明细
 *   → 附件墙 → 打印记录 → 全链路时间轴
 *
 * 页面上只有四处写操作：「作废」**任何状态都能点**、不需要授权、只需填明事由留痕
 *  （已结算的单作废时会连带撤销它那张结算单，弹窗里提前说破，见 02 §F2.3）；「定价 / 改价」
 *  改的是本单结算价（票面按它出票，偏离价目表须写清事由，02 §F1.4）；「入仓去向」由值仓事后
 *  补录（制单时选填，见 03 §9.9），改派写 order.destination 审计、署名进 keeper_id；
 *  「补绑流转卡」把当时走「无卡制单」（06 §4.0 的现场退路）缺的那张卡补上，走的是发卡那条命令
 *  （06 §4.1，闸门与磅房里现场发卡一字不差）。
 * 红冲（reversals）在库里只有表和词表、没有命令，因此这里只给出跳转与说明，
 * 绝不伪装成已完成的操作（02 §F6.3 要求红冲另立新单，接口未实现）。
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, ArrowLeftIcon, BadgeCheckIcon, BanknoteIcon, CreditCardIcon, FlaskConicalIcon, MapPinIcon, PrinterIcon, ShieldAlertIcon, TagIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { WeighRecord } from "@/mock/types";
import { INDICATORS, GRADES, OPEN_STATUSES, ORDER_STATUS, PARTY_TYPE, PAYMENT_METHOD, PAYMENT_STATUS, TEST_METHOD, VOID_REASON_MIN } from "@/lib/constants";
import { dateTime, money, orDash, percent, price as fmtPrice, density, weight, varietyLabel } from "@/lib/format";
import { awaitingPayment, creditPayGate, unpaidFen } from "@/lib/settle-gate";
import { useQuickOptions, useStaffNames, useStation, useWarehouses, useSlots } from "@/hooks/useLookups";
import { actorId, useSession } from "@/store/session";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Choose } from "@/components/business/Choose";
import { VoidReasonField } from "@/components/business/VoidReasonField";
import { ComboBox } from "@/components/business/ComboBox";
import { IdCardText } from "@/components/business/IdCardText";
import { PriceDialog } from "@/components/business/PriceDialog";
import { CardBindDialog } from "@/components/workstation/CardBindDialog";
import { PayDialog } from "@/components/settlement/PayDialog";
import { MoneyLine } from "@/components/business/NumField";
import { PaidStamp } from "@/components/business/PaidStamp";
import { DocTimeline } from "@/components/business/DocTimeline";
import { CapturePhotoThumb } from "@/components/business/CapturePhotoThumb";
import { OrderStatusBadge, PaymentStatusBadge, QcDecisionBadge, ToneBadge, WeightSourceBadge } from "@/components/business/badges";
import { CallOut, EmptyState, InfoGrid, PageHeader } from "@/components/business/layout";
import { QuickDetailLink, useQuickDetail } from "@/components/business/quickDetail";
import { useSilentReceiptPrint } from "@/components/print/receipt/useSilentPrint";
import { cn } from "cn";

/**
 * 详情页只读明细表的紧凑排版。
 *
 * shadcn Table 的默认节奏（表头 h-12、单元格 p-3、表头 font-medium 且继承 text-foreground）
 * 是给"列表页"用的；详情页里的这些表是嵌在卡片内的小明细，必须保持原先的
 * py-1.5 / 无左右内边距 / 表头随行取色，否则卡片会被撑开一大截。
 * 用后代选择器（[&_th] / [&_td]）而不是单元格上的 className，是因为前者的
 * 特异性高于组件内置的 p-3、h-12、text-foreground，能稳定压住。
 */
const DETAIL_TABLE =
  "border-collapse text-sm [&_th]:h-auto [&_th]:px-0 [&_th]:py-1.5 [&_th]:font-normal [&_th]:text-inherit [&_td]:px-0 [&_td]:py-1.5";

/**
 * 磅单正文（整页与详情抽屉共用）。
 *
 * `embedded` 给抽屉用：标题条要让开 Sheet 右上角的关闭按钮，
 * 「返回列表」这类整页导航由整页壳通过 `headerExtra` 传进来；
 * 抽屉里点去工作台这种功能页的链接要先收起抽屉，否则抽屉会盖在新页面上。
 */
export function OrderDetailBody({
  orderNo,
  embedded = false,
  headerExtra,
}: {
  orderNo: string;
  embedded?: boolean;
  headerExtra?: ReactNode;
}) {
  const headerCls = embedded ? "pr-11" : undefined;
  const closeDetail = useQuickDetail((s) => s.close);
  const queryClient = useQueryClient();
  const names = useStaffNames();
  const can = useSession((s) => s.can);
  const { data: station } = useStation();

  /**
   * 出票走与磅房工作台同一条路（无预览直打 → 失败才回退预览框），出纸口由设备中心台账决定。
   * 这里不再自己开预览框：那会让配好的打印机被 `window.print()` 的系统默认队列顶掉。
   */
  const { print: printReceipt, preview: printFallback } = useSilentReceiptPrint();
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  /** 去向弹窗：Choose 的 value 一律是字符串，"" 表示"未定"（清空也是合法写入） */
  const [destOpen, setDestOpen] = useState(false);
  const [destWh, setDestWh] = useState("");
  const [destSlot, setDestSlot] = useState("");
  /** 调整等级：改的是磅单上的业务定级，化验报告上的判定永不改写 */
  const [gradeOpen, setGradeOpen] = useState(false);
  const [gradeValue, setGradeValue] = useState("");
  const [gradeReason, setGradeReason] = useState("");
  const { options: gradeReasonOptions } = useQuickOptions("price");
  /**
   * 定价 / 改价（02 §F1.4）。框是共用的 `PriceDialog`，与磅房称重区那个入口同一份判定
   * ——都在改 `weigh_order.price_fen_per_ton` 这一列，各写一份必然分叉出"同一张单两个价"。
   */
  const [priceOpen, setPriceOpen] = useState(false);
  /**
   * 补付框（挂账核销）要收钱的那张**结算单号**，null = 框关着。
   * 与磅房工作台那一份 `payNo` 同义：进的是同一个 `PayDialog`，只是这里的入口是本卡片
   * 底部那枚「付款」。记单号而不是布尔量，是为了让框上的标题永远指着真正在收钱的那张账
   * （一张结算单可以名下挂着好几张磅单）。
   */
  const [paySettleNo, setPaySettleNo] = useState<string | null>(null);
  /**
   * 「补绑流转卡」：这张单当时走的是「无卡制单」（06 §4.0 的现场退路——读卡器坏了、卡池见底），
   * 卡事后在这里补回去。读到卡走 `card_issue`，与磅房里现场发卡同一条闸门（06 §4.1）。
   */
  const [bindOpen, setBindOpen] = useState(false);

  const { data: order, isLoading } = useQuery({
    queryKey: ["order", orderNo],
    queryFn: () => api.getOrder(orderNo),
  });
  const { data: qcRows = [] } = useQuery({
    queryKey: ["qc-of-order", orderNo],
    queryFn: () => api.listQc({ keyword: orderNo }),
    enabled: !!orderNo,
  });
  const { data: settlement } = useQuery({
    queryKey: ["settlement-of-order", orderNo],
    queryFn: () => api.settlementOfOrderNo(orderNo),
    enabled: !!orderNo,
  });
  /** 档案里的联系方式与账户，详情页不重复维护一份，只从档案读 */
  const { data: partyDetail } = useQuery({
    queryKey: ["party", order?.party_id],
    queryFn: () => (order ? api.getParty(order.party_id) : Promise.resolve(null)),
    enabled: !!order,
  });
  /** 去向候选（停用的仓房/货位不出列，与工作台同一口径） */
  const { data: warehouses = [] } = useWarehouses();
  const { data: slots = [] } = useSlots();

  const qc = useMemo(
    () => (order?.qc_report_id != null ? (qcRows.find((r) => r.id === order.qc_report_id) ?? null) : null),
    [qcRows, order?.qc_report_id],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["order", orderNo] });
    void queryClient.invalidateQueries({ queryKey: ["orders"] });
    void queryClient.invalidateQueries({ queryKey: ["openOrders"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    void queryClient.invalidateQueries({ queryKey: ["audits"] });
    // 作废会连带撤销本单那张结算单（02 §F2.3），这一页「结算与付款」卡片读的就是它
    void queryClient.invalidateQueries({ queryKey: ["settlement-of-order", orderNo] });
  };

  const voidMut = useMutation({
    mutationFn: () => api.voidOrder({ order_no: orderNo, reason: voidReason.trim(), operator_id: actorId() }),
    onSuccess: (o) => {
      if (!o) {
        toast.error("作废失败：未找到该磅单");
        return;
      }
      toast.success(`磅单 ${o.order_no} 已作废，原因与经办人已记入审计日志`);
      setVoidOpen(false);
      setVoidReason("");
      invalidate();
    },
    // 闸门回的是人话（事由不足 6 字、单据查不到），固定文案会把"为什么没废成"吞掉
    onError: (e: Error) => toast.error(e.message || "作废失败，请重试"),
  });

  /**
   * 作废会连带撤掉的那张结算单（没有或早已撤销则为 null）。
   *
   * 判据只认库里的 `settlement_order` 归属（`api.settlementOfOrderNo`），不用
   * `order.settled_at` 代理：结算单被撤过一次之后，磅单上的 settled_at 仍然留着（留痕），
   * 再废一次就不该吓唬人"钱要追回"——那笔钱早就没人催了。
   */
  const voidRevokesBill = settlement && settlement.status !== "revoked" ? settlement : null;

  /** 打开时以本单现状为准：不预先清空，改派与补录走同一个入口 */
  const openDest = () => {
    setDestWh(String(order?.warehouse_id ?? ""));
    setDestSlot(String(order?.slot_id ?? ""));
    setDestOpen(true);
  };

  const destMut = useMutation({
    mutationFn: () =>
      api.assignOrderDestination({
        order_no: orderNo,
        warehouse_id: destWh ? Number(destWh) : null,
        slot_id: destSlot ? Number(destSlot) : null,
        operator_id: actorId(),
      }),
    onSuccess: (o) => {
      if (!o) {
        toast.error("登记失败：未找到该磅单");
        return;
      }
      const now = [o.warehouse_name, o.slot_label].filter(Boolean).join(" / ");
      toast.success(now ? `去向已登记：${now}` : "本单去向已清空");
      setDestOpen(false);
      invalidate();
    },
    // 真库说的是人话（"货位「C01-03」不在该仓房下"），固定文案会把原因吞掉
    onError: (e: Error) => toast.error(e.message || "去向登记失败，请重试"),
  });

  /**
   * 补绑＝发卡（06 §4.1）。刻意不另开一条"绑定"命令：显式给了 `order_no` 的 `card_issue` 与
   * 磅房里现场发卡走的是同一道闸（卡在册 / 未注销 / 没挂着未完成单 / 本单还没绑卡），
   * 分成两条就会在"一张卡能不能同时挂两张单"这种问题上各自维持一套，早晚分叉。
   */
  const bindCardMut = useMutation({
    mutationFn: (cardNo: string) => api.cardIssue({ order_no: orderNo, card_no: cardNo }),
    onSuccess: (res) => {
      toast.success(`已补绑流转卡 ${res.card.card_no}：本单回到「刷卡推进」那条流（毛重 / 皮重 / 结算）`);
      setBindOpen(false);
      invalidate();
      // `invalidate()` 里那个 ["openOrders"] 是全局检索与档案下拉的键；工作台在途条读的是 ["open-orders"]，
      // 卡号在在途条上不刷新就等于没补上，两张键都得点
      void queryClient.invalidateQueries({ queryKey: ["open-orders"] });
      void queryClient.invalidateQueries({ queryKey: ["cards"] });
    },
    // 闸门回的是人话（"卡 X 还挂在单 Y 上"），固定文案会把"换一张卡"这条现场动作吞掉
    onError: (e: Error) => toast.error(e.message || "补绑失败，请重试"),
  });

  /** 打开时以本单现状为准，与改派同一条规矩：不预先清空 */
  const openGrade = () => {
    setGradeValue(order?.grade ?? "");
    setGradeReason("");
    setGradeOpen(true);
  };

  const gradeMut = useMutation({
    mutationFn: () =>
      api.setOrderGrade({
        order_no: orderNo,
        grade: gradeValue || null,
        reason: gradeReason.trim(),
        operator_id: actorId(),
      }),
    onSuccess: (o) => {
      if (!o) {
        toast.error("调整失败：未找到该磅单");
        return;
      }
      toast.success(`本单等级已改为 ${o.grade ?? "未定级"}，事由已记入审计日志`);
      setGradeOpen(false);
      invalidate();
    },
    // 真库把"为什么不能改"说得很具体（值域 / 已结算 / 已作废 / 已拒收），固定文案会把原因吞掉
    onError: (e: Error) => toast.error(e.message || "调整等级失败，请重试"),
  });

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="磅单详情" description="加载中…" className={headerCls} />
        <div className="grid gap-4 px-6 py-4 xl:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-52" />
          ))}
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="磅单详情" className={headerCls} />
        <EmptyState
          title={`找不到磅单 ${orderNo}`}
          description="单号可能被手动改过，或这张单属于另一台电脑的数据。回列表按日期找一下。"
          action={
            embedded ? undefined : (
              <Button size="sm" variant="outline" render={<Link to="/orders" />}>
                返回磅单中心
              </Button>
            )
          }
        />
      </div>
    );
  }

  const records = order.records ?? [];
  const photos = order.photos ?? [];
  const prints = order.prints ?? [];
  const timeline = order.timeline ?? [];
  /**
   * 这张单已经"翻案定论"了：改价 / 改等级 / 补去向都不再接受（真库 `PRE_SETTLE` 那三处闸门
   * 的前端镜像）。**作废不在它的管辖范围内**——作废任何状态都能点（02 §F2.3），包括对一张
   * 已作废的单再废一次改事由：审计与时间轴按次追加，第一次写下的那句不会被抹掉。
   */
  const locked = order.status === "voided" || order.status === "rejected";
  const manual = order.weight_source === "manual";
  const statusDesc = ORDER_STATUS[order.status].desc;
  /**
   * 付清的磅单也盖印子（与结算单详情的「全额付清」同一枚 PaidStamp、同一条规矩）：
   * 页头徽章与「已付金额 / 未付余额」两行太小，客户问"钱付清没有"时得凑近读。
   * 章上的字直接取词表 PAYMENT_STATUS.paid.label，与页头徽章永远同词，不各写一份。
   */
  const showPaidStamp = order.payment_status === "paid";

  /**
   * 所属结算单的未付余额（分）：本卡片那枚「付款」按钮上要说的那个钱数。
   *
   * 口径单源在 `settle-gate.ts::unpaidFen`（结算单的 `payable_fen - paid_fen`），与
   * `PayForm` 里"超出未付余额"那道校验、结算单详情的「登记付款」卡片读的是同一个数。
   * 刻意**不用**本页上面那行"未付余额 = payable_amount_fen - paid_amount_fen"：钱是按**结算单**
   * 收的，一张结算单可以名下挂好几张磅单，磅单上那份是结算时摊下来的展示数（末单还担四舍五入
   * 差），拿它当余额就会和框里真正收得进去的钱差出几毛来。
   */
  const payLeftFen = settlement ? unpaidFen(settlement) : 0;
  /**
   * 本卡片底部那颗「付款」按钮露不露。两个条件各挡一种错：
   *  - `awaitingPayment(order)`：**这张磅单自己**还欠着钱（已结算 + 未付清）。少了这一条，
   *    一张已付清的磅单会因为同批结算单上别的单没付完而亮出「付款」，客户站在屏幕前
   *    只会问"我这单不是付清了吗"；工作台第③刷/扫票也是按这一条决定进不进补付框的
   *    （`WorkstationPage::requestSettle`），两个入口对同一张票得给同一个答案。
   *  - `payLeftFen > 0`：账上确实还有余额才收得进去。已付清时 `creditPayGate` 会拦
   *    （"这张结算单已经付清了"），按钮不该留在屏幕上等人去撞那句话。
   *  - 结算单没被撤销：作废本单会把它的结算单一起撤掉（02 §F2.3），那时 `awaitingPayment`
   *    照着磅单上的 `settled_at` + `payment_status` 仍然判"还欠钱"，不按结算单本体拦一下，
   *    就会留一颗点开只弹"已撤销，不能再收钱"的死按钮在屏幕上。
   */
  const showPayButton = !!settlement && settlement.status !== "revoked" && awaitingPayment(order) && payLeftFen > 0;
  /**
   * 点「付款」：先过 `creditPayGate`（与磅房工作台第③刷命中挂账单、结算台账点开那张单
   * 登记付款同一份判定与话术），
   * 放行了才进同一个 `PayDialog`。已撤销 / 已付清 / 岗位不能收钱这三类当场说清楚"为什么不行、
   * 该上哪儿去"，而不是把一颗点了没反应的按钮留在屏幕上。
   *
   * 与工作台唯一的差别是不上语音：播报是磅房窗口那台机器的现场提示（07 篇 §1.2 的例外通道），
   * 这一页是迎检与纠纷时翻出来看的，突然出声反而吓人。
   */
  const requestPay = () => {
    if (!settlement) return;
    const gate = creditPayGate(settlement, can("pay.record"));
    if (gate) {
      const msg = `${gate.title}：${gate.body}`;
      if (gate.tone === "danger") toast.error(msg, { id: `od-pay-gate:${settlement.settle_no}` });
      else if (gate.tone === "warning") toast.warning(msg, { id: `od-pay-gate:${settlement.settle_no}` });
      else toast.info(msg, { id: `od-pay-gate:${settlement.settle_no}` });
      return;
    }
    setPaySettleNo(settlement.settle_no);
  };

  /**
   * 等级的闸门比去向严：结算完成（settled/paid）后等级就是"钱"的一部分，
   * 想改只能走红冲——否则会出现"结算单上是二等、台账里是三等"的对不上账。
   */
  const gradeBlocked =
    locked
      ? "作废/拒收的单不能再调整等级"
      : ["settled", "paid", "archived", "reversed"].includes(order.status)
        ? "本单已结算，改等级请先由站长红冲（02 §F6.3）"
        : !can("order.grade")
          ? "当前岗位无权调整等级（需化验员、出纳或站长）"
          : null;
  /**
   * 价的闸门与等级同一条线：结算完成（settled/paid/archived/reversed）后价就是"钱"的一部分，
   * 票面也已经把它印给客户了，想改只能由站长红冲——否则会出现"票上是这个价、账上是另一个价"。
   */
  const priceBlocked =
    locked
      ? "作废/拒收的单不能再定价"
      : ["settled", "paid", "archived", "reversed"].includes(order.status)
        ? "本单已结算，改价请先由站长红冲（02 §F6.3）"
        : !can("price.override")
          ? "当前岗位无权定价（需磅员或站长）"
          : null;
  /** 补打角标只看 print_log 里真正出过纸的那几条，与工作台同一口径 */
  const weighPrinted = prints.filter((p) => p.doc_type === "weigh_order" && p.result === "success").length;
  /**
   * 补打：无预览直打，出纸口/纸型全交给设备中心台账（与磅房工作台 F9 同一条路）；
   * 直打失败时 hook 自己弹预览框兜底。
   */
  const reprintWeighOrder = () => {
    if (!station) return;
    void printReceipt({
      scenario: "weigh_order",
      docNo: order.order_no,
      isReprint: weighPrinted > 0,
      context: { station, names, order, qc },
    });
  };
  const reprintQcReport = () => {
    if (!station || !qc) return;
    void printReceipt({
      scenario: "quality_report",
      docNo: qc.report_no,
      isReprint: true,
      context: { station, names, qc },
    });
  };
  /** 停用只挡住新指定，历史单据上的去向照旧显示（与工作台同一口径） */
  const activeWarehouses = warehouses.filter((w) => w.is_active !== 0);
  const slotPool = slots
    .filter((s) => s.is_active !== 0)
    .filter((s) => !destWh || s.warehouse_id === Number(destWh));

  const recordCols: Column<WeighRecord>[] = [
    { key: "seq", header: "序号", cell: (r) => <span className="tnum">{r.seq}</span> },
    {
      key: "weigh_type",
      header: "称重项",
      cell: (r) => (r.weigh_type === "gross" ? "毛重" : "皮重"),
    },
    {
      key: "weight",
      header: "读数",
      align: "right",
      cell: (r) => <span className="tnum">{weight(r.weight_01kg)}</span>,
    },
    {
      key: "aligned",
      header: "整量化",
      align: "right",
      cell: (r) => <span className="tnum text-muted-foreground">{weight(r.aligned_weight_01kg)}</span>,
    },
    {
      key: "stable",
      header: "稳定",
      cell: (r) => (r.stable === 1 ? <ToneBadge tone="success">稳定</ToneBadge> : <ToneBadge tone="warning">不稳定</ToneBadge>),
    },
    { key: "source", header: "来源", cell: (r) => <WeightSourceBadge source={r.source} /> },
    {
      key: "adopted",
      header: "是否采用",
      cell: (r) =>
        r.is_adopted === 1 ? (
          <span className="text-xs">采用</span>
        ) : (
          <span className="text-xs text-muted-foreground">弃用{r.adopt_reason ? `（${r.adopt_reason}）` : ""}</span>
        ),
    },
    { key: "device", header: "设备", cell: (r) => <span className="tnum text-xs text-muted-foreground">{r.device_code}</span> },
    { key: "at", header: "时间", cell: (r) => <span className="tnum text-xs">{dateTime(r.captured_at)}</span> },
    {
      key: "raw",
      header: "原始帧",
      cell: (r) => <span className="font-mono text-[11px] text-muted-foreground">{orDash(r.raw_frame)}</span>,
    },
    { key: "op", header: "经手", cell: (r) => <span className="text-xs">{names(r.operator_id)}</span> },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        className={headerCls}
        title={
          <span className="flex items-center gap-2">
            <span className="tnum">{order.order_no}</span>
            <OrderStatusBadge status={order.status} />
            <PaymentStatusBadge status={order.payment_status} />
          </span>
        }
        description={`${order.business_date} · ${order.party_name}（${PARTY_TYPE[order.party_type]}）· ${varietyLabel(order.variety_name)}${order.grade ? ` ${order.grade}` : ""} · ${statusDesc}`}
        actions={
          <>
            {headerExtra}
            <Button size="sm" variant="outline" onClick={reprintQcReport} disabled={!qc || !can("print")}>
              <FlaskConicalIcon />
              质检单
            </Button>
            <Button size="sm" variant="outline" onClick={reprintWeighOrder} disabled={!can("print")}>
              <PrinterIcon />
              补打码单
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!can("order.void")}
              title={can("order.void") ? undefined : "当前岗位无作废权限"}
              onClick={() => setVoidOpen(true)}
            >
              <ShieldAlertIcon />
              作废
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-col gap-4">
          {/* 异常留痕前置：一进来就得看见这张单有没有"人工干预" */}
          {locked && (
            <CallOut tone="danger" title={`本单已${ORDER_STATUS[order.status].label}`} icon={<AlertTriangleIcon />}>
              {order.status === "voided"
                ? `作废原因：${orDash(order.void_reason)}；作废时间 ${orDash(order.voided_at && dateTime(order.voided_at))}。作废单不参与任何汇总统计。`
                : "化验判定为拒收，车辆已放行，本单不进入结算与付款。"}
            </CallOut>
          )}
          {manual && (
            <CallOut tone="warning" title="称重读数为手工录入" icon={<AlertTriangleIcon />}>
              仪表通讯异常时允许手录，但必须事后补上传仪表打印小票照片。迎检时此标记会作为重点核查项。
            </CallOut>
          )}
          {order.tare_override_reason && (
            <CallOut tone="warning" title="皮重偏差超容差（数据有效，醒目标记）" icon={<AlertTriangleIcon />}>
              {order.tare_override_reason}；本单已按现场读数捕获，请核对车辆与读数，如需更正走红冲后重录。
            </CallOut>
          )}
          {order.price_override_reason && (
            <CallOut tone="info" title={order.price_list_id != null ? "单价偏离价目表" : "手工定价（当时无生效价目）"}>
              {orDash(order.price_override_reason)}（执行单价 {fmtPrice(order.price_fen_per_ton)}）
            </CallOut>
          )}
          {order.reversed_order_id != null && (
            <CallOut tone="danger" title="本单为红冲单">
              负值冲销原单 #{order.reversed_order_id}，与原单同时参与汇总，净额相互抵消。
            </CallOut>
          )}

          <div className="grid items-start gap-4 xl:grid-cols-2">
            <Card size="sm">
              <CardHeader>
                <CardTitle className="text-sm">基本信息</CardTitle>
                {/* CardHeader 是 grid，右侧动作必须走 CardAction 槽位才不会被挤成整宽 */}
                <CardAction>
                  <div className="flex items-center gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setPriceOpen(true)}
                      disabled={!!priceBlocked}
                      title={priceBlocked ?? "定价 / 改价（票面按本单价出票，偏离价目表可写事由留痕，选填）"}
                    >
                      <TagIcon />
                      {order.price_fen_per_ton == null ? "定价" : "改价"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={openGrade}
                      disabled={!!gradeBlocked}
                      title={gradeBlocked ?? "调整磅单上的业务定级（化验单判定不受影响）"}
                    >
                      <BadgeCheckIcon />
                      {order.grade ? "调整等级" : "定级"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={openDest}
                      disabled={locked || !can("order.destination")}
                      title={
                        locked
                          ? "作废/拒收的单不再登记入仓去向"
                          : !can("order.destination")
                            ? "登记入仓去向需保管员或站长岗位（02 §11 权限矩阵）"
                            : undefined
                      }
                    >
                      <MapPinIcon />
                      {order.warehouse_id || order.slot_id ? "改派去向" : "登记去向"}
                    </Button>
                    {/* 只在"在途 + 手上没卡"时出现：这是「无卡制单」那张单的下半场（06 §4.0），
                        补上之后这颗按钮自己消失，不给已绑卡的单摆一个必然报错的控件 */}
                    {OPEN_STATUSES.includes(order.status) && !order.card_no && (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setBindOpen(true)}
                        disabled={bindCardMut.isPending}
                        title="这张单还没有流转卡：把一张空闲卡贴到感应区，或从卡池里挑一张"
                      >
                        <CreditCardIcon />
                        补绑流转卡
                      </Button>
                    )}
                  </div>
                </CardAction>
              </CardHeader>
              <CardContent>
                <InfoGrid
                  cols={2}
                  items={[
                    { label: "磅单号", value: <span className="tnum font-medium">{order.order_no}</span> },
                    { label: "业务日期", value: <span className="tnum">{order.business_date}</span> },
                    {
                      label: "流转卡",
                      // 在途又没卡＝当时走了「无卡制单」：这一格说清下一步，别留一个「—」让人以为本站不用卡
                      value: order.card_no ? (
                        <span className="tnum">{order.card_no}</span>
                      ) : OPEN_STATUSES.includes(order.status) ? (
                        <span className="text-warning">未绑定 · 请点右上角「补绑流转卡」</span>
                      ) : (
                        "—"
                      ),
                    },
                    { label: "售粮人", value: <QuickDetailLink type="party" id={order.party_id}>{order.party_name}</QuickDetailLink> },
                    { label: "身份类型", value: PARTY_TYPE[order.party_type] },
                    { label: "证件号", value: <IdCardText value={order.id_card_no} partyId={order.party_id} className="tnum" /> },
                    { label: "联系电话", value: <span className="tnum">{orDash(partyDetail?.phone)}</span> },
                    { label: "住址", value: orDash(partyDetail?.address), span: 2 },
                    {
                      label: "结算账户",
                      value: partyDetail?.bank_account
                        ? `${partyDetail.bank_name ?? "银行"} ${partyDetail.bank_account}（挂账额度 ${money(partyDetail.credit_limit_fen, false)} 元）`
                        : "未登记（只能现金或当场扫码）",
                      span: 2,
                    },
                    { label: "品种", value: order.variety_id == null ? varietyLabel(null) : `${varietyLabel(order.variety_name)}（${order.variety_code}）` },
                    { label: "等级", value: orDash(order.grade) },
                    { label: "车牌", value: <span className="tnum">{orDash(order.vehicle_no)}</span> },
                    { label: "驾驶员", value: orDash(order.driver_name) },
                    { label: "入仓房", value: orDash(order.warehouse_name) },
                    { label: "货位", value: orDash(order.slot_label) },
                    { label: "登记", value: `${names(order.registered_by)} · ${dateTime(order.registered_at)}` },
                    { label: "磅员", value: names(order.weigher_id) },
                    { label: "化验员", value: names(order.inspector_id) },
                    { label: "保管员", value: names(order.keeper_id) },
                    { label: "备注", value: orDash(order.remark), span: 2 },
                  ]}
                />
              </CardContent>
            </Card>

            <Card size="sm">
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  重量与扣重
                  <WeightSourceBadge source={order.weight_source} />
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <InfoGrid
                  cols={2}
                  items={[
                    { label: "毛重", value: <span className="tnum">{weight(order.gross_weight_01kg)}</span> },
                    { label: "皮重", value: <span className="tnum">{weight(order.tare_weight_01kg)}</span> },
                    { label: "净重", value: <span className="tnum font-semibold">{weight(order.net_weight_01kg)}</span> },
                    { label: "包装物", value: <span className="tnum">{weight(order.package_deduct_01kg)} × {order.package_count} 件</span> },
                    { label: "扣水（磅单值）", value: <span className="tnum">{weight(order.moisture_deduct_01kg)}</span> },
                    { label: "扣杂（磅单值）", value: <span className="tnum">{weight(order.impurity_deduct_01kg)}</span> },
                    { label: "其他扣重", value: <span className="tnum">{weight(order.other_deduct_01kg)}</span> },
                    { label: "扣重合计", value: <span className="tnum">{weight(order.deduct_total_01kg)}</span> },
                    {
                      label: "结算重量",
                      value: <span className="tnum text-sm font-semibold">{weight(order.settlement_weight_01kg)}</span>,
                      span: 2,
                    },
                  ]}
                />
                {/* 化验单上还有一组同名的扣水/扣杂（化验给出的建议）。两个数不等不是错，
                    是"现场按实际情况改过"，但页面必须替人说清哪一份算了钱——否则迎检时
                    两张卡上的同名数字会被当成录入重复。 */}
                {qc && (qc.moisture_deduct_01kg !== order.moisture_deduct_01kg || qc.impurity_deduct_01kg !== order.impurity_deduct_01kg) && (
                  <p className="text-xs text-warning">
                    化验给出的建议扣量是 扣水 <span className="tnum">{weight(qc.moisture_deduct_01kg)}</span>／扣杂{" "}
                    <span className="tnum">{weight(qc.impurity_deduct_01kg)}</span>，
                    本单按上表（扣水 <span className="tnum">{weight(order.moisture_deduct_01kg)}</span>／扣杂{" "}
                    <span className="tnum">{weight(order.impurity_deduct_01kg)}</span>）结算——结算重量、票面与台账一律认磅单这份。
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  净重 = 毛重 − 皮重；结算重量 = 净重 − 扣重合计。首版不实现水分/杂质自动增扣量（02 §F4.4），
                  上表扣重均为人工录入值，其中扣水/扣杂以<span className="text-foreground">结算时在计算单确认的磅单值</span>为准。
                </p>
              </CardContent>
            </Card>
          </div>

          <Card size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                称重轨迹
                <span className="font-normal text-xs text-muted-foreground">
                  共 {records.length} 次读数，含被弃用记录；整量化按分度值取整
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <DataTable
                columns={recordCols}
                rows={records}
                rowKey={(r) => r.id}
                dense
                defaultPageSize={50}
                empty={<EmptyState title="本单尚无称重读数" description="若车辆已上过磅，说明读数未捕获成功，需在工作台重新捕获。" />}
              />
            </CardContent>
          </Card>

          <div className="grid items-start gap-4 xl:grid-cols-2">
            <Card size="sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  化验结果
                  {qc && <QcDecisionBadge decision={qc.decision} />}
                  {qc?.is_recheck === 1 && <ToneBadge tone="info">复检</ToneBadge>}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {!qc ? (
                  <p className="text-sm text-muted-foreground">
                    {order.qc_at ? "化验记录未随单返回，可在化验台账按单号查询。" : "本单未做化验登记。"}
                  </p>
                ) : (
                  <>
                    <InfoGrid
                      cols={2}
                      items={[
                        { label: "质检单号", value: <QuickDetailLink type="qc" id={qc.report_no} className="tnum">{qc.report_no}</QuickDetailLink> },
                        { label: "样品号", value: <span className="tnum">{qc.sample_no}</span> },
                        { label: "检测方法", value: TEST_METHOD[qc.test_method] },
                        { label: "定级", value: orDash(qc.grade) },
                        { label: "化验员", value: `${names(qc.inspector_id)} · ${dateTime(qc.inspected_at)}` },
                        { label: "留样", value: qc.retention_no ? `${qc.retention_no}（至 ${qc.retention_until}）` : "未留样" },
                        { label: "扣水（建议）", value: <span className="tnum">{weight(qc.moisture_deduct_01kg)}</span> },
                        { label: "扣杂（建议）", value: <span className="tnum">{weight(qc.impurity_deduct_01kg)}</span> },
                        {
                          label: "拒收原因",
                          value: <span className="text-destructive">{orDash(qc.reject_reason)}</span>,
                          span: 2,
                        },
                        { label: "备注", value: orDash(qc.remark), span: 2 },
                      ]}
                    />
                    <Table className={DETAIL_TABLE}>
                      <TableHeader>
                        <TableRow className="border-b text-xs text-muted-foreground hover:bg-transparent">
                          <TableHead>指标</TableHead>
                          <TableHead className="text-right">实测</TableHead>
                          <TableHead className="text-right">国标基准</TableHead>
                          <TableHead className="text-right">偏差</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {qc.indicators.map((it) => {
                          const meta = INDICATORS[it.code];
                          const shown =
                            it.unit === "text"
                              ? orDash(it.value_text)
                              : it.unit === "gL"
                                ? density(it.value_num)
                                : percent(it.value_num);
                          const std =
                            meta?.unit === "gL"
                              ? density(meta.std ?? null)
                              : meta?.unit === "text"
                                ? "—"
                                : percent(meta?.std ?? null);
                          const over = it.over_std === 1;
                          const delta =
                            meta && it.value_num != null && meta.std != null
                              ? `${meta.lowerBetter ? "↑ 超" : "↓ 低"} ${
                                  it.unit === "gL"
                                    ? `${Math.abs(it.value_num - meta.std)} g/L`
                                    : percent(Math.abs(it.value_num - meta.std), "")
                                }`
                              : null;
                          return (
                            <TableRow key={it.code} className={cn("border-b hover:bg-transparent", over && "bg-warning-bg")}>
                              <TableCell>{meta?.name ?? it.name}</TableCell>
                              <TableCell className={cn("tnum text-right", over && "font-medium text-warning")}>{shown}</TableCell>
                              <TableCell className="tnum text-right text-muted-foreground">{std}</TableCell>
                              <TableCell className="text-right text-xs">
                                {over ? delta ?? "超基准" : <span className="text-muted-foreground">合格</span>}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    <p className="text-xs text-muted-foreground">
                      基准值仅用于超标提示与定级参考，不参与扣量计算；「定级」是化验员按国标的判定（复检另立新单，本单永不改写），
                      与磅单上"这一车按几等结钱"的业务等级是两条线。「扣水（建议）／扣杂（建议）」也一样——
                      结算时以计算单确认进磅单的那份为准，化验这份不会被回写。
                    </p>
                  </>
                )}
              </CardContent>
            </Card>

            <Card size="sm" className="relative">
              <CardHeader>
                <CardTitle className="text-sm">结算与付款</CardTitle>
              </CardHeader>
              <CardContent className={cn("flex flex-col gap-3", showPaidStamp && "pb-20")}>
                {order.settled_at == null ? (
                  <p className="text-sm text-muted-foreground">
                    本单尚未结算。{ORDER_STATUS[order.status].label}状态下应到工作台完成计价结算。
                  </p>
                ) : (
                  <>
                    <InfoGrid
                      cols={2}
                      items={[
                        { label: "结算时间", value: dateTime(order.settled_at) },
                        { label: "结算人", value: names(order.weigher_id) },
                        {
                          label: "执行单价",
                          value: <span className="tnum">{fmtPrice(order.price_fen_per_ton)}</span>,
                        },
                        {
                          label: "计价依据",
                          value: order.price_list_id != null ? `价目表 #${order.price_list_id}` : "手工定价",
                        },
                        { label: "结算重量", value: <span className="tnum">{weight(order.settlement_weight_01kg)}</span> },
                        { label: "付款方式", value: order.payment_method ? PAYMENT_METHOD[order.payment_method] : "—" },
                      ]}
                    />
                    <div className="flex flex-col gap-1.5 border-t pt-3">
                      <MoneyLine label="粮款金额" valueFen={order.goods_amount_fen} />
                      <MoneyLine label="各项扣款" valueFen={-order.deduction_fee_fen} hint="装卸费、代储费等" />
                      <MoneyLine label="预付款冲抵" valueFen={-order.advance_fee_fen} />
                      <MoneyLine label="应付金额" valueFen={order.payable_amount_fen} emphasis />
                      <MoneyLine label="已付金额" valueFen={order.paid_amount_fen} />
                      <MoneyLine
                        label="未付余额"
                        valueFen={Math.max(0, (order.payable_amount_fen ?? 0) - order.paid_amount_fen)}
                      />
                    </div>
                    {settlement && (
                      <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
                        <span className="text-muted-foreground">所属结算单</span>
                        <QuickDetailLink
                          type="settlement"
                          id={settlement.settle_no}
                          className="tnum font-medium underline underline-offset-2"
                        >
                          {settlement.settle_no}
                        </QuickDetailLink>
                        <PaymentStatusBadge status={settlement.payment_status} />
                        {/* 本单作废时结算单被同事务撤销（02 §F2.3）：这一行必须跟着改口，
                            否则磅员看见的还是"所属结算单 JS…／未付清"，钱到底还催不催没人说得清 */}
                        {settlement.status === "revoked" && <ToneBadge tone="danger">已撤销</ToneBadge>}
                      </div>
                    )}
                    {/*
                      卡片底部那颗「付款」：本单已结算、钱还没付完时才出现，点开的是磅房工作台
                      同一个 `PayDialog`（挂账核销）。出纳在磅单上核完数顺手就把这笔钱收了，
                      不必再回工作台扫一遍票、也不必去「付款与挂账」里翻单号。
                    */}
                    {showPayButton && (
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                        <span className="text-xs text-muted-foreground">
                          这张结算单还欠 <span className="tnum font-medium text-foreground">{money(payLeftFen)}</span>
                          {settlement && settlement.order_count > 1 ? `（按整张结算单收，名下一共 ${settlement.order_count} 张磅单）` : ""}
                        </span>
                        <Button size="sm" onClick={requestPay}>
                          <BanknoteIcon />
                          付款
                        </Button>
                      </div>
                    )}
                  </>
                )}
                {order.status !== "voided" && order.status !== "rejected" && order.settled_at == null && (
                  <CallOut tone="info" title="下一步">
                    结算在磅房工作台做：扫这张码单右下角的二维码即弹结算框，现场计价付款，结完本页自动出现金额明细。
                    <Link
                      to="/workstation"
                      search={{ orderNo: order.order_no }}
                      onClick={() => embedded && closeDetail()}
                      className="ml-1 underline underline-offset-2"
                    >
                      带到工作台
                    </Link>
                    {(order.prints ?? []).length === 0 && order.net_weight_01kg != null && (
                      <span className="ml-1 text-muted-foreground">
                        （这单还没打过码单，客户手里没有可扫的票——到工作台打印码单，或在顶部在途条点中这张单直接结算）
                      </span>
                    )}
                  </CallOut>
                )}
              </CardContent>
              {showPaidStamp && (
                <PaidStamp label={PAYMENT_STATUS.paid.label} paidFen={order.paid_amount_fen} paidAt={order.paid_at} />
              )}
            </Card>
          </div>

          <div className="grid items-start gap-4 xl:grid-cols-2">
            <Card size="sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  现场附件
                  <span className="font-normal text-xs text-muted-foreground">
                    {photos.length} 项 · 抓拍缺失只标文字，不用颜色单独表达
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {photos.length === 0 ? (
                  <p className="text-sm text-muted-foreground">本单没有现场照片，说明抓拍设备当时离线或被人工跳过。</p>
                ) : (
                  <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {photos.map((p) => (
                      <li key={p.id} className="min-w-0">
                        <CapturePhotoThumb photo={p} />
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card size="sm">
              <CardHeader>
                <CardTitle className="text-sm">打印记录</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {prints.length === 0 ? (
                  <p className="text-sm text-muted-foreground">本单从未打印，码单联次未生成。</p>
                ) : (
                  <Table className={DETAIL_TABLE}>
                    <TableHeader>
                      <TableRow className="border-b text-xs text-muted-foreground hover:bg-transparent">
                        <TableHead>时间</TableHead>
                        <TableHead>纸型/通道</TableHead>
                        <TableHead>打印机</TableHead>
                        <TableHead>性质</TableHead>
                        <TableHead>操作人</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {prints.map((p) => (
                        <TableRow key={p.id} className="border-b hover:bg-transparent">
                          <TableCell className="tnum text-xs">{dateTime(p.printed_at)}</TableCell>
                          <TableCell className="text-xs">{p.paper}</TableCell>
                          <TableCell className="truncate text-xs">{p.printer_name}</TableCell>
                          <TableCell className="text-xs">
                            {p.is_reprint === 1 ? (
                              <ToneBadge tone="warning">补打</ToneBadge>
                            ) : (
                              <span className="text-muted-foreground">首次</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">{names(p.operator_id)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <p className="text-xs text-muted-foreground">
                  补打必须在纸上带「补打」字样并记录授权人，与首打联次区分（01 §F6.2）。
                </p>
              </CardContent>
            </Card>
          </div>

          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">
                全链路时间轴
                <span className="ml-2 font-normal text-xs text-muted-foreground">每一步都带署名与时刻，用于回答"这张单谁在哪一步干了什么"</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DocTimeline events={timeline} />
            </CardContent>
          </Card>
        </div>
      </div>

      {/* 直打失败时的兜底预览框：没发起过出票就是 null，不占 DOM */}
      {printFallback}

      {/* 给「无卡制单」那张单补卡（06 §4.0 的下半场）：与磅房制单绑卡同一个框、同一套闸——
          贴一张空闲卡即绑上，读卡器不给力时框里那条「手动绑卡」从卡池挑一张同样算 */}
      <CardBindDialog open={bindOpen} onOpenChange={setBindOpen} required purpose="rebind" onPicked={(sn) => bindCardMut.mutate(sn)} />

      <Dialog open={destOpen} onOpenChange={setDestOpen}>
        <DialogContent className="max-w-[460px]">
          <DialogHeader>
            <DialogTitle className="text-sm">入仓去向 · {order.order_no}</DialogTitle>
            <DialogDescription className="text-xs">
              去向在制单时是选填项，粮真进了仓由值仓在这里补登记；改派会记审计，并把保管员署名换成当前操作人。
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              仓房
              <Choose
                aria-label="仓房"
                value={destWh}
                onChange={(v) => {
                  setDestWh(v);
                  setDestSlot("");
                }}
                options={[
                  { value: "", label: "未定" },
                  ...activeWarehouses.map((w) => ({ value: String(w.id), label: w.name })),
                ]}
              />
            </Label>
            <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              货位
              <Choose
                aria-label="货位"
                value={destSlot}
                onChange={setDestSlot}
                options={[
                  { value: "", label: "未定" },
                  ...slotPool.map((s) => ({ value: String(s.id), label: s.label })),
                ]}
              />
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            两处都选「未定」即清空本单去向；只选货位时按货位反查仓房。停用的仓房与货位不进候选，历史单据上的去向照旧可查。
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDestOpen(false)}>
              取消
            </Button>
            <Button disabled={destMut.isPending} onClick={() => destMut.mutate()}>
              {destMut.isPending ? "保存中…" : "保存去向"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 调整等级：只改磅单业务定级，化验报告（qc_report.grade）永不改写 */}
      <Dialog open={gradeOpen} onOpenChange={setGradeOpen}>
        <DialogContent className="max-w-[460px]">
          <DialogHeader>
            <DialogTitle className="text-sm">调整业务定级 · {order.order_no}</DialogTitle>
            <DialogDescription className="text-xs">
              本单按此等级参与结算与台账汇总。化验报告上的判定不受影响——复检另立新单。
              已结算/已作废的单不能再改，要更正经站长走红冲（02 §F6.3）。
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              目标等级
              <Choose
                aria-label="目标等级"
                value={gradeValue}
                onChange={setGradeValue}
                options={[{ value: "", label: "未定级" }, ...GRADES.map((g) => ({ value: g, label: g }))]}
              />
            </Label>
            <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              现状
              <span className="tnum rounded border bg-muted/30 px-2 py-1 text-xs">
                {order.grade ?? "未定级"}
                {qc?.grade && qc.grade !== order.grade ? `（化验 ${qc.grade}）` : ""}
              </span>
            </Label>
          </div>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>改判事由（可选，填了会一起写进审计）</span>
            <ComboBox
              aria-label="改判事由"
              presets={gradeReasonOptions}
              value={gradeReason}
              onChange={setGradeReason}
              placeholder="选一条常用的，或自己写…"
              className="h-8 text-sm"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setGradeOpen(false)}>
              取消
            </Button>
            <Button
              disabled={
                gradeMut.isPending ||
                (gradeValue || null) === (order.grade ?? null)
              }
              onClick={() => gradeMut.mutate()}
              title={
                (gradeValue || null) === (order.grade ?? null)
                  ? "等级未变化，无需保存"
                  : undefined
              }
            >
              {gradeMut.isPending ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        定价 / 改价：与磅房称重区共用同一个 `PriceDialog`（同一列、同一套判定）。
        挂在等级框前面——票面出票按价走，价比等级更贴"钱"。
      */}
      <PriceDialog open={priceOpen} onOpenChange={setPriceOpen} order={order} qc={qc} />

      {/*
        挂账核销框：与磅房工作台那一份是同一个 `PayDialog`（连"每登记一笔自动出一张结算凭证"
        的出票口径都同源）。登记成功后 `PayForm` 自己会重取结算单那一行并吐司结论，这里只补
        本页读的那两处：卡片上的「已付 / 未付余额」取自磅单行，「所属结算单」那枚付款状态徽章
        取自 `settlement-of-order` —— 不重取就会停在付款前的旧数，看着像没收到钱。
      */}
      <PayDialog
        settleNo={paySettleNo}
        onClose={() => setPaySettleNo(null)}
        onPaid={() => {
          invalidate();
          void queryClient.invalidateQueries({ queryKey: ["settlement-of-order", orderNo] });
        }}
      />

      <AlertDialog open={voidOpen} onOpenChange={setVoidOpen}>
        <AlertDialogContent className="max-w-[520px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">作废磅单 {order.order_no}</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              作废后本单不再参与任何汇总统计，但记录永久保留、可查询。作废不需要站长授权，
              磅员填明事由即可废单，事由与经办人会写进审计日志。<strong>任何状态都能作废</strong>
              （02 §F2.3）：本版没有磅单红冲，配错了价、结错了钱的单就是靠这一笔勾掉。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {voidRevokesBill && (
            <CallOut tone="warning" title={`本单已结算，作废会同时撤销结算单 ${voidRevokesBill.settle_no}`} icon={<AlertTriangleIcon />}>
              这张结算单应付 {money(voidRevokesBill.payable_fen)}、已付 {money(voidRevokesBill.paid_fen)}。作废之后它标记为「已撤销」：
              挂账池里当场消失，钱也收不进来了。
              {voidRevokesBill.paid_fen > 0
                ? "已经付出去的钱流水一行都不删（账本不涂改），要线下向农户追回。"
                : ""}
              要重做这一笔，请另开一张磅单——原单号与结算单号都留在库里，审计上串得起来。
            </CallOut>
          )}
          {order.status === "voided" && (
            <CallOut tone="info" title="本单已经是作废态" icon={<ShieldAlertIcon />}>
              再填一次会把票面与详情上那句作废原因、作废时间换成新写的这句；第一次填的那句不会消失，
              它留在审计日志和本单时间轴里（按次追加，两笔都在）。
            </CallOut>
          )}
          <div className="flex flex-col gap-3">
            <VoidReasonField
              value={voidReason}
              onChange={setVoidReason}
              invalid={voidReason.trim().length > 0 && voidReason.trim().length < VOID_REASON_MIN}
              error={
                voidReason.trim().length > 0 && voidReason.trim().length < VOID_REASON_MIN
                  ? `事由写全一点（不少于 ${VOID_REASON_MIN} 字），迎检要看得懂这句为什么废单`
                  : undefined
              }
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-sm">取消</AlertDialogCancel>
            <AlertDialogAction
            className="text-sm"
            disabled={voidReason.trim().length < VOID_REASON_MIN || voidMut.isPending}
              onClick={(e) => {
                e.preventDefault();
                voidMut.mutate();
              }}
            >
              确认作废
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** 整页路由入口：深链与 Ctrl+点击新窗口仍走这里，正文与详情抽屉共用 */
export function OrderDetailPage() {
  const { orderNo } = useParams({ from: "/orders/$orderNo" });
  return (
    <OrderDetailBody
      orderNo={orderNo}
      headerExtra={
        <Button size="sm" variant="outline" render={<Link to="/orders" />}>
          <ArrowLeftIcon />
          返回列表
        </Button>
      }
    />
  );
}
