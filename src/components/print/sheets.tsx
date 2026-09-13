/**
 * 打印模板（05 §9）。
 *
 * 三张票据都按"套打黑白仍可判读"来做：
 *  - 字体用宋体系，与界面雅黑区隔，保证与存量纸质码单观感一致
 *  - 证号中间 6 位掩码；迎检需完整证号由站长单独导出
 *  - 单价一律印元/公斤，金额打印人民币大写
 *  - 磅员 / 化验员 / 结算员三署名栏 + 售粮人签字栏 + 联次标注
 *  - 补打时右上角"补打"字样（05 §9 明确要求）
 */
import type { ReactNode } from "react";
import type { QcReport, Settlement, Station, WeighOrder } from "@/mock/types";
import { GRADES, INDICATORS, ORDER_STATUS, PAYMENT_METHOD } from "@/lib/constants";
import { dateTime, maskIdCard, money, percent, price, rmbUpper, ton, weight } from "@/lib/format";

const SONG = { fontFamily: '"SimSun", "宋体", "NSimSun", serif' };

function Sheet({
  title,
  station,
  docNo,
  dateText,
  reprint,
  copyNote,
  children,
}: {
  title: string;
  station: Station;
  docNo: string;
  dateText: string;
  reprint?: boolean;
  copyNote?: string;
  children: ReactNode;
}) {
  return (
    <div
      id="print-root"
      style={SONG}
      className="relative mx-auto w-[740px] max-w-full bg-white px-6 py-5 text-[12px] leading-[1.6] text-black print:w-full"
    >
      {/* 骑缝单号：竖排在左侧，套打时与存根联对齐 */}
      <div className="absolute top-8 left-1 flex flex-col items-center">
        <span className="[writing-mode:vertical-rl] text-[10px] tracking-[0.2em]">{docNo}</span>
        <span className="mt-1 h-8 w-px bg-black/40" />
      </div>

      {reprint && (
        <span className="absolute top-3 right-6 border border-black px-1.5 py-0.5 text-[11px] font-bold">
          补 打
        </span>
      )}

      <header className="text-center">
        <h1 className="text-[19px] font-bold tracking-[0.12em]">{station.name}</h1>
        <p className="mt-0.5 text-[15px] font-bold tracking-[0.3em]">{title}</p>
        <p className="mt-1 flex items-center justify-center gap-6 text-[11px]">
          <span>单据号：{docNo}</span>
          <span>业务日期：{dateText}</span>
          <span>地址：{station.address}</span>
          <span>电话：{station.phone}</span>
        </p>
      </header>

      <div className="mt-3 border-t-2 border-black" />
      {children}
      <div className="mt-2 border-t border-black" />
      <footer className="mt-1.5 flex items-center justify-between text-[10px]">
        <span>{copyNote ?? "第一联 存根（粮站留存）"}</span>
        <span>本单一式三联，涂改无效；如有疑问请当场向磅员核对</span>
        <span>{station.code}</span>
      </footer>
    </div>
  );
}

/** 两列一组的键值行，模拟票据上的方格区 */
function Cells({ items }: { items: { k: string; v: ReactNode; w?: string }[] }) {
  return (
    <div className="grid grid-cols-4 border-b border-black">
      {items.map((it, i) => (
        <div key={i} className={`flex items-baseline gap-1 border-r border-black px-2 py-1 last:border-r-0 ${it.w ?? ""}`}>
          <span className="shrink-0 text-black/70">{it.k}</span>
          <span className="min-w-0 flex-1 truncate font-medium">{it.v}</span>
        </div>
      ))}
    </div>
  );
}

function Line({ label, v }: { label: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between px-2 py-[3px]">
      <span className="text-black/70">{label}</span>
      <span className="font-mono text-[12px]">{v}</span>
    </div>
  );
}

export function WeighOrderSheet({
  order,
  station,
  reprint,
  qc,
  names,
}: {
  order: WeighOrder;
  station: Station;
  reprint?: boolean;
  qc?: QcReport | null;
  names: (id: number | null | undefined) => string;
}) {
  const p = price(order.price_fen_per_ton);
  const moisture = qc?.indicators.find((x) => x.code === "moisture")?.value_num;
  const impurity = qc?.indicators.find((x) => x.code === "impurity")?.value_num;
  return (
    <Sheet
      title="收购码单（过磅单）"
      station={station}
      docNo={order.order_no}
      dateText={order.business_date}
      reprint={reprint}
    >
      <Cells
        items={[
          { k: "售粮人", v: order.party_name },
          { k: "证号", v: maskIdCard(order.id_card_no) },
          { k: "身份", v: order.party_type === "farmer" ? "农户" : "单位/大户" },
          { k: "车牌", v: order.vehicle_no ?? "—" },
        ]}
      />
      <Cells
        items={[
          { k: "品种", v: order.variety_name },
          { k: "等级", v: order.grade ?? (qc?.grade ?? "未定级") },
          { k: "水分", v: moisture != null ? percent(moisture) : "—" },
          { k: "杂质", v: impurity != null ? percent(impurity) : "—" },
        ]}
      />
      <Cells
        items={[
          { k: "入库", v: `${order.warehouse_name ?? "—"}${order.slot_label ? ` / ${order.slot_label}` : ""}` },
          { k: "状态", v: ORDER_STATUS[order.status].label },
          { k: "称重方式", v: order.weight_source === "scale" ? "地磅读数" : "人工手录" },
          { k: "结算单", v: order.remark ? "见备注" : "—" },
        ]}
      />

      <div className="mt-2 border border-black">
        <Line label="毛重" v={weight(order.gross_weight_01kg)} />
        <Line label="皮重" v={weight(order.tare_weight_01kg)} />
        <Line label="净重" v={weight(order.net_weight_01kg)} />
        <div className="grid grid-cols-4 border-t border-black/60">
          <Line label="袋重" v={weight(order.package_deduct_01kg)} />
          <Line label="扣水" v={weight(order.moisture_deduct_01kg)} />
          <Line label="扣杂" v={weight(order.impurity_deduct_01kg)} />
          <Line label="其他扣" v={weight(order.other_deduct_01kg)} />
        </div>
        <div className="grid grid-cols-2 border-t border-black/60">
          <Line label="扣重合计" v={weight(order.deduct_total_01kg)} />
          <Line label="结算重量" v={`${weight(order.settlement_weight_01kg)}（${ton(order.settlement_weight_01kg)}）`} />
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <div className="border border-black">
          <Line label="单价" v={p} />
          <Line label="货款" v={money(order.goods_amount_fen)} />
          <Line label="扣款" v={money(order.deduction_fee_fen)} />
          <Line label="应付" v={money(order.payable_amount_fen)} />
        </div>
        <div className="flex flex-col justify-between border border-black px-2 py-1">
          <p>
            金额大写：
            <span className="font-bold">{rmbUpper(order.payable_amount_fen)}</span>
          </p>
          <p className="mt-1">
            付款：{order.payment_status === "paid" ? "已付清" : order.payment_status === "partial" ? "部分付款" : "挂账未付"}
            {order.payment_method ? ` · ${PAYMENT_METHOD[order.payment_method]}` : ""}
            {order.paid_amount_fen > 0 ? ` · 已付 ${money(order.paid_amount_fen)}` : ""}
          </p>
          {order.price_override_reason && <p className="mt-1">改价原因：{order.price_override_reason}</p>}
          {order.remark && <p className="mt-1">备注：{order.remark}</p>}
        </div>
      </div>

      <table className="mt-3 w-full border-collapse text-[11px]">
        <tbody>
          <tr>
            <td className="w-1/4 border border-black px-2 py-3">磅员：{names(order.weigher_id)}</td>
            <td className="w-1/4 border border-black px-2 py-3">化验员：{names(order.inspector_id)}</td>
            <td className="w-1/4 border border-black px-2 py-3">结算员：{names(order.registered_by)}</td>
            <td className="w-1/4 border border-black px-2 py-3">售粮人签字：＿＿＿＿＿＿</td>
          </tr>
          <tr>
            <td colSpan={4} className="border border-black px-2 py-1">
              制单 {dateTime(order.registered_at)}　毛重 {dateTime(order.gross_at)}　皮重 {dateTime(order.tare_at)}
              　化验 {dateTime(order.qc_at)}　结算 {dateTime(order.settled_at)}　付款 {dateTime(order.paid_at)}
            </td>
          </tr>
        </tbody>
      </table>
    </Sheet>
  );
}

export function QcReportSheet({
  report,
  station,
  names,
}: {
  report: QcReport;
  station: Station;
  names: (id: number | null | undefined) => string;
}) {
  return (
    <Sheet
      title="质检单"
      station={station}
      docNo={report.report_no}
      dateText={report.inspected_at.slice(0, 10)}
      copyNote="第一联 存根（化验室留存）"
    >
      <Cells
        items={[
          { k: "对应磅单", v: report.order_no },
          { k: "售粮人", v: report.party_name },
          { k: "样品号", v: report.sample_no },
          { k: "检测方法", v: report.test_method === "nir" ? "近红外" : report.test_method === "lab" ? "化验室" : "目测" },
        ]}
      />
      <table className="mt-2 w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-black/5">
            <th className="border border-black px-2 py-1 text-left">指标</th>
            <th className="border border-black px-2 py-1 text-right">实测</th>
            <th className="border border-black px-2 py-1 text-right">国标基准</th>
            <th className="border border-black px-2 py-1">比较</th>
            <th className="border border-black px-2 py-1 text-left">说明</th>
          </tr>
        </thead>
        <tbody>
          {report.indicators.map((it) => {
            const meta = INDICATORS[it.code];
            const over = it.over_std === 1;
            return (
              <tr key={it.code}>
                <td className="border border-black px-2 py-1">{it.name}</td>
                <td className="border border-black px-2 py-1 text-right font-mono">
                  {it.unit === "text" ? (it.value_text ?? "—") : it.unit === "gL" ? `${it.value_num} g/L` : percent(it.value_num)}
                </td>
                <td className="border border-black px-2 py-1 text-right font-mono">
                  {meta?.std == null ? "—" : meta.unit === "gL" ? `${meta.std} g/L` : percent(meta.std)}
                </td>
                <td className="border border-black px-2 py-1 text-center">{over ? (meta?.lowerBetter ? "↑ 超" : "↓ 低") : "合格"}</td>
                <td className="border border-black px-2 py-1">{it.code === "odor" ? (it.value_text ?? "—") : "按 GB 2715 限量"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Cells
        items={[
          { k: "等级", v: report.grade ? GRADES.includes(report.grade) ? report.grade : "—" : "未定级" },
          { k: "判定", v: report.decision === "accept" ? "接收" : report.decision === "conditional" ? "条件接收" : "拒收" },
          { k: "扣水", v: weight(report.moisture_deduct_01kg) },
          { k: "扣杂", v: weight(report.impurity_deduct_01kg) },
        ]}
      />
      <Cells
        items={[
          { k: "留样号", v: report.retention_no ?? "—" },
          { k: "留样至", v: report.retention_until ?? "—" },
          { k: "复检", v: report.is_recheck ? `复检单（首检 ${report.first_report_id ?? "—"}）` : "首检" },
          { k: "化验员", v: names(report.inspector_id) },
        ]}
      />
      {report.reject_reason && <p className="mt-2 border border-black px-2 py-1">拒收原因：{report.reject_reason}</p>}
      <table className="mt-3 w-full border-collapse text-[11px]">
        <tbody>
          <tr>
            <td className="w-1/2 border border-black px-2 py-4">化验员签字：＿＿＿＿＿＿</td>
            <td className="w-1/2 border border-black px-2 py-4">司磅员确认：＿＿＿＿＿＿</td>
          </tr>
        </tbody>
      </table>
    </Sheet>
  );
}

export function SettlementVoucherSheet({
  settlement,
  station,
  orders,
  names,
}: {
  settlement: Settlement;
  station: Station;
  orders: { order_no: string; settlement_weight_01kg: number; price_fen_per_ton: number; goods_amount_fen: number }[];
  names: (id: number | null | undefined) => string;
}) {
  const p = price(settlement.orders[0]?.price_fen_per_ton);
  return (
    <Sheet
      title="结算凭证"
      station={station}
      docNo={settlement.settle_no}
      dateText={settlement.business_date}
      copyNote="第一联 存根（财务入账）"
    >
      <Cells
        items={[
          { k: "收款人", v: settlement.payee_name },
          { k: "覆盖期间", v: `${settlement.period_from} 至 ${settlement.period_to}` },
          { k: "磅单数", v: `${settlement.order_count} 张` },
          { k: "状态", v: settlement.payment_status === "paid" ? "已付清" : settlement.payment_status === "partial" ? "部分付款" : "未付款" },
        ]}
      />
      <table className="mt-2 w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-black/5">
            <th className="border border-black px-2 py-1 text-left">磅单号</th>
            <th className="border border-black px-2 py-1 text-right">结算重量</th>
            <th className="border border-black px-2 py-1 text-right">单价</th>
            <th className="border border-black px-2 py-1 text-right">金额</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.order_no}>
              <td className="border border-black px-2 py-1 font-mono">{o.order_no}</td>
              <td className="border border-black px-2 py-1 text-right font-mono">{weight(o.settlement_weight_01kg)}</td>
              <td className="border border-black px-2 py-1 text-right font-mono">{price(o.price_fen_per_ton)}</td>
              <td className="border border-black px-2 py-1 text-right font-mono">{money(o.goods_amount_fen)}</td>
            </tr>
          ))}
          <tr className="bg-black/5 font-bold">
            <td className="border border-black px-2 py-1">合计</td>
            <td className="border border-black px-2 py-1 text-right font-mono">{weight(settlement.total_settle_01kg)}</td>
            <td className="border border-black px-2 py-1 text-right">{p}</td>
            <td className="border border-black px-2 py-1 text-right font-mono">{money(settlement.total_goods_fen)}</td>
          </tr>
        </tbody>
      </table>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div className="border border-black">
          <Line label="货款" v={money(settlement.total_goods_fen)} />
          <Line label="扣款" v={money(settlement.total_deduction_fen)} />
          <Line label="应付" v={money(settlement.payable_fen)} />
          <Line label="已付" v={money(settlement.paid_fen)} />
          <Line label="未付" v={money(settlement.payable_fen - settlement.paid_fen)} />
        </div>
        <div className="flex flex-col justify-between border border-black px-2 py-1">
          <p>
            应付大写：
            <span className="font-bold">{rmbUpper(settlement.payable_fen)}</span>
          </p>
          <p className="mt-1">
            付款方式：{settlement.main_method ? PAYMENT_METHOD[settlement.main_method] : "挂账"}
          </p>
          <p className="mt-1">结算员：{names(settlement.settler_id)}　结算时间：{dateTime(settlement.settled_at)}</p>
        </div>
      </div>
      <table className="mt-3 w-full border-collapse text-[11px]">
        <tbody>
          <tr>
            <td className="w-1/3 border border-black px-2 py-4">收款人签字：＿＿＿＿</td>
            <td className="w-1/3 border border-black px-2 py-4">出纳：＿＿＿＿</td>
            <td className="w-1/3 border border-black px-2 py-4">站长：＿＿＿＿</td>
          </tr>
        </tbody>
      </table>
    </Sheet>
  );
}
