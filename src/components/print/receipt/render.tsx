/**
 * 通用小票渲染器：拿到「模板 + 上下文」就能画出任意场景的票据。
 *
 * 与旧 sheets.tsx 的区别——这里没有任何业务字段的硬编码，全部走模板里的区块定义，
 * 区块的取值靠 scenarios.tsx 的 resolveField / tableRows。新增字段、改版式都不动这里。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PaperKind } from "@/lib/constants";
import { getSpec } from "./scenarios";
import { PAPER_SPEC, mmToPx } from "./paper";
import type { FieldKind, ReceiptContext, ReceiptSection, ReceiptTemplate } from "./types";

const SONG = { fontFamily: '"SimSun", "宋体", "NSimSun", serif' } as const;

function valueClass(kind: FieldKind): string {
  if (kind === "money" || kind === "weight" || kind === "ton" || kind === "percent") return "font-mono";
  return "";
}

/** 从上下文推出单据号与时间（用于票头） */
export function docMeta(ctx: ReceiptContext): { docNo: string; dateText: string } {
  switch (ctx.order ? "weigh" : ctx.qc ? "qc" : ctx.settlement ? "settle" : ctx.payment ? "pay" : ctx.daily ? "daily" : "ledger") {
    case "weigh":
      return { docNo: ctx.order!.order_no, dateText: ctx.order!.business_date };
    case "qc":
      return { docNo: ctx.qc!.report_no, dateText: ctx.qc!.inspected_at.slice(0, 10) };
    case "settle":
      return { docNo: ctx.settlement!.settle_no, dateText: ctx.settlement!.business_date };
    case "pay":
      return { docNo: ctx.payment!.pay_no, dateText: ctx.payment!.paid_at.slice(0, 10) };
    case "daily":
      return { docNo: `日报 ${ctx.daily!.date}`, dateText: ctx.daily!.date };
    default:
      return { docNo: ctx.ledgerRows?.length ? `台账 ${ctx.ledgerRows[0].business_date}` : "台账", dateText: ctx.ledgerRows?.[0]?.business_date ?? "" };
  }
}

/** 把 text 区块里的 {{key}} 占位替换成对应字段值 */
function renderText(tpl: string, ctx: ReceiptContext): ReactNode {
  const spec = getSpec((ctx.order ? "weigh_order" : ctx.qc ? "quality_report" : ctx.settlement ? "settlement_voucher" : ctx.payment ? "payment_receipt" : ctx.daily ? "daily_report" : "ledger"));
  const parts = tpl.split(/(\{\{[^}]+\}\})/g);
  return parts.map((p, i) => {
    const m = p.match(/\{\{(.+?)\}\}/);
    if (!m) return <span key={i}>{p}</span>;
    return (
      <span key={i} className={valueClass("text")}>
        {spec.resolveField(m[1], ctx)}
      </span>
    );
  });
}

function KVBlock({ section, ctx }: { section: ReceiptSection; ctx: ReceiptContext }) {
  const spec = getSpec(sectionScenario(ctx));
  const fields = section.fields ?? [];
  if (fields.length === 0) return null;
  return (
    <div className="mt-2">
      {section.title && <p className="mb-0.5 text-[11px] font-bold">{section.title}</p>}
      <div className="grid grid-cols-2 border-t border-black/60">
        {fields.map((key) => {
          const def = spec.fields.find((f) => f.key === key);
          const label = def?.label ?? key;
          const v = spec.resolveField(key, ctx);
          return (
            <div key={key} className="flex items-baseline justify-between gap-2 border-b border-black/40 px-2 py-1">
              <span className="shrink-0 text-black/70">{label}</span>
              <span className={`min-w-0 truncate text-right font-medium ${valueClass(def?.kind ?? "text")}`}>{v}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TableBlock({ section, ctx }: { section: ReceiptSection; ctx: ReceiptContext }) {
  const spec = getSpec(sectionScenario(ctx));
  const table = spec.tables?.find((t) => t.dataset === section.dataset);
  if (!table) return null;
  const cols = (section.columns ?? table.columns.map((c) => c.key))
    .map((k) => table.columns.find((c) => c.key === k))
    .filter((c): c is NonNullable<typeof c> => !!c);
  const rows = spec.tableRows?.(table.dataset, ctx) ?? [];
  if (cols.length === 0) return null;
  return (
    <div className="mt-2">
      {section.title && <p className="mb-0.5 text-[11px] font-bold">{section.title}</p>}
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-black/5">
            {cols.map((c) => (
              <th key={c.key} className="border border-black px-2 py-1 text-left">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c.key} className={`border border-black px-2 py-1 ${c.kind === "money" || c.kind === "weight" ? "text-right font-mono" : ""}`}>
                  {r[c.key] ?? "—"}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={cols.length} className="border border-black px-2 py-1 text-center text-black/50">
                暂无数据
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SignBlock({ section }: { section: ReceiptSection }) {
  const signers = section.signers ?? [];
  if (signers.length === 0) return null;
  const cols = signers.length <= 2 ? 2 : 4;
  return (
    <div className="mt-3">
      {section.title && <p className="mb-0.5 text-[11px] font-bold">{section.title}</p>}
      <table className="w-full border-collapse text-[11px]">
        <tbody>
          <tr>
            {signers.map((s) => (
              <td key={s} className={`w-1/${cols} border border-black px-2 py-4`}>
                {s}：＿＿＿＿＿＿
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** 从上下文判断当前场景（模板与上下文应同源，这里兜底推导） */
function sectionScenario(ctx: ReceiptContext) {
  if (ctx.order) return "weigh_order" as const;
  if (ctx.qc) return "quality_report" as const;
  if (ctx.settlement) return "settlement_voucher" as const;
  if (ctx.payment) return "payment_receipt" as const;
  if (ctx.daily) return "daily_report" as const;
  return "ledger" as const;
}

export function ReceiptDocument({
  template,
  context,
  paperOverride,
}: {
  template: ReceiptTemplate;
  context: ReceiptContext;
  /** 本次打印临时改纸型（不改模板本身）时传入 */
  paperOverride?: PaperKind;
}) {
  const station = context.station;
  const { docNo, dateText } = docMeta(context);
  const showReprint = template.showReprintBadge && context.reprint;
  const paper = paperOverride ?? template.paper;
  const spec = PAPER_SPEC[paper];
  const m = spec.marginMm;

  return (
    <>
      {/* 打印页尺寸与预览同源：@page 用同一纸型的 mm，页边距交给页面 padding */}
      <style>{`@page { size: ${spec.cssSize}; margin: 0; }`}</style>
      <div
        id="print-root"
        className="receipt-paper relative text-[12px] leading-[1.6] text-black"
        style={{
          ...SONG,
          width: `${spec.widthMm}mm`,
          minHeight: spec.heightMm == null ? undefined : `${spec.heightMm}mm`,
          padding: `${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm`,
        }}
      >
        {showReprint && (
          <span className="absolute top-2 right-3 border border-black px-1.5 py-0.5 text-[11px] font-bold">补 打</span>
        )}

        <header className="text-center">
          <h1 className="text-[19px] font-bold tracking-[0.12em]">{station.name}</h1>
          <p className="mt-0.5 text-[15px] font-bold tracking-[0.3em]">{template.title}</p>
          <p className="mt-1 flex flex-wrap items-center justify-center gap-x-4 gap-y-0.5 text-[11px]">
            <span>单据号：{docNo}</span>
            <span>业务日期：{dateText}</span>
            <span>地址：{station.address}</span>
            <span>电话：{station.phone}</span>
          </p>
        </header>

        <div className="mt-3 border-t-2 border-black" />

        {template.sections.map((sec) => {
          if (sec.kind === "kv") return <KVBlock key={sec.id} section={sec} ctx={context} />;
          if (sec.kind === "table") return <TableBlock key={sec.id} section={sec} ctx={context} />;
          if (sec.kind === "sign") return <SignBlock key={sec.id} section={sec} />;
          if (sec.kind === "text")
            return (
              <p key={sec.id} className="mt-2 border border-black px-2 py-1">
                {renderText(sec.text ?? "", context)}
              </p>
            );
          return null;
        })}

        <div className="mt-2 border-t border-black" />
        <footer className="mt-1.5 flex items-center justify-between text-[10px]">
          <span>{template.copyNote}</span>
          <span>本单一式三联，涂改无效</span>
          <span>{station.code}</span>
        </footer>
      </div>
    </>
  );
}

/**
 * 屏幕上的"纸张托架"：把按真实 mm 排版的票据缩放到容器宽度内显示。
 *
 * 关键点是**只缩屏幕、不缩纸**：缩放只发生在这一层，打印时由 CSS 把
 * transform / 限定高度全部还原（见 App.css @media print），于是纸上就是 1:1 的真实毫米。
 */
export function PaperFrame({
  paper,
  zoom = "fit",
  children,
}: {
  paper: PaperKind;
  /** "fit" 适应宽度；或给具体比例（1 = 实际大小） */
  zoom?: number | "fit";
  children: ReactNode;
}) {
  const paperPx = mmToPx(PAPER_SPEC[paper].widthMm);
  const hostRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const [boxH, setBoxH] = useState<number>();

  useEffect(() => {
    const host = hostRef.current;
    const inner = innerRef.current;
    if (!host || !inner) return;
    const measure = () => {
      const avail = host.clientWidth;
      const s = avail > 0 ? Math.min(1, avail / paperPx) : 1;
      setFit(s);
      setBoxH(inner.offsetHeight * s);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [paperPx, children]);

  const scale = zoom === "fit" ? fit : zoom;

  return (
    <div ref={hostRef} className="receipt-fit-host flex w-full justify-center">
      <div className="receipt-fit" style={{ height: boxH, width: paperPx * scale }}>
        <div
          ref={innerRef}
          className="receipt-fit-inner"
          style={{ width: paperPx, transform: `scale(${scale})`, transformOrigin: "top left" }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
