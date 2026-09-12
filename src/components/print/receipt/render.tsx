/**
 * 通用小票渲染器：拿到「模板 + 上下文」就能画出任意场景的票据。
 *
 * 与旧 sheets.tsx 的区别——这里没有任何业务字段的硬编码，全部走模板里的区块定义，
 * 区块的取值靠 scenarios.tsx 的 resolveField / tableRows。新增字段、改版式都不动这里。
 *
 * 两种版式（`ReceiptLayout`）：
 *  - `receipt` 小票风格：窄条、居中抬头、虚线分隔、标签左值右、无框表格、下划线署名。
 *    这一版的行序与 `escpos.ts` 一一对齐（票头 → 分隔线 → 区块 → 票尾），
 *    所以"预览什么样，热敏纸上就什么样"是有依据的，不是靠肉眼调出来的近似。
 *  - `sheet` 单据风格：分栏网格 + 带框表格 + 方框署名，给 A4 台账 / 日报表这类宽表用。
 *
 * 页面几何（纸宽 mm、页边距 mm）只写在这里，打印通道（`../printPage.ts`）直接把这块 DOM
 * 克隆进打印文档，因此屏幕与纸张是同一份排版，不存在"预览一套、打印一套"。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PaperKind } from "@/lib/constants";
import { getSpec } from "./scenarios";
import { PAPER_SPEC, defaultLayout, isRollPaper, mmToPx, type ReceiptLayout } from "./paper";
import { QrGraphic } from "./QrGraphic";
import type { FieldKind, ReceiptContext, ReceiptScenario, ReceiptSection, ReceiptTemplate } from "./types";

const SONG = { fontFamily: '"SimSun", "宋体", "NSimSun", serif' } as const;

/** 数字类字段用等宽：票面上的金额/重量要能一列对齐地读 */
function valueClass(kind: FieldKind): string {
  if (kind === "money" || kind === "weight" || kind === "ton" || kind === "percent") return "font-mono";
  return "";
}

const isNumericField = (kind: FieldKind) => kind === "money" || kind === "weight" || kind === "ton" || kind === "percent";

/** 场景 → 该场景的"这是哪张单、哪一天" */
const DOC_BY_SCENARIO: Record<ReceiptScenario, (ctx: ReceiptContext) => { docNo: string; dateText: string } | null> = {
  weigh_order: (c) => (c.order ? { docNo: c.order.order_no, dateText: c.order.business_date } : null),
  quality_report: (c) => (c.qc ? { docNo: c.qc.report_no, dateText: c.qc.inspected_at.slice(0, 10) } : null),
  settlement_voucher: (c) => (c.settlement ? { docNo: c.settlement.settle_no, dateText: c.settlement.business_date } : null),
  payment_receipt: (c) => (c.payment ? { docNo: c.payment.pay_no, dateText: c.payment.paid_at.slice(0, 10) } : null),
  daily_report: (c) => (c.daily ? { docNo: `日报 ${c.daily.date}`, dateText: c.daily.date } : null),
  ledger: (c) => (c.ledgerRows?.length ? { docNo: `台账 ${c.ledgerRows[0].business_date}`, dateText: c.ledgerRows[0].business_date } : null),
};

/**
 * 票头用的单据号与日期。
 *
 * 传 scenario 就照模板的场景取，不传才从上下文倒推——倒推这件事本身是有坑的：
 * 付款小票的上下文里同时挂着 payment 和 settlement，先判 settlement 就会把票头印成结算单号。
 */
export function docMeta(ctx: ReceiptContext, scenario?: ReceiptScenario): { docNo: string; dateText: string } {
  if (scenario) {
    const hit = DOC_BY_SCENARIO[scenario](ctx);
    if (hit) return hit;
  }
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
function renderText(tpl: string, ctx: ReceiptContext, scenario: ReceiptScenario): ReactNode {
  const spec = getSpec(scenario);
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

/**
 * ReactNode → 纯文本。
 *
 * 与 `escpos.ts` 的 `asText` 同规则：字段解析器目前一律返回字符串，真出现节点时宁可给空串，
 * 也绝不把 `[object Object]` 编进二维码——那是一张扫不出来、又看不出哪儿错的废票。
 */
function asPlainText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** 只做 {{key}} 替换、返回字符串（二维码载荷要的是字符串，不是节点） */
function fillPlaceholders(tpl: string, resolve: (key: string) => string): string {
  return tpl.replace(/\{\{(.+?)\}\}/g, (_, key: string) => resolve(key.trim()));
}

/**
 * 分隔线。
 *
 * 小票机上是一整行 `-`；这里用 1px 虚线，物理宽度与纸同宽，视觉上就是那一行点。
 * 单据风格沿用原来的粗实线——A4 上那样更像一张表。
 */
function Rule({ layout }: { layout: ReceiptLayout }) {
  return layout === "receipt" ? (
    <div className="my-1 border-t border-dashed border-black" />
  ) : (
    <div className="my-1 border-t-2 border-black" />
  );
}

function KVBlock({
  section,
  ctx,
  scenario,
  layout,
}: {
  section: ReceiptSection;
  ctx: ReceiptContext;
  scenario: ReceiptScenario;
  layout: ReceiptLayout;
}) {
  const spec = getSpec(scenario);
  const fields = section.fields ?? [];
  if (fields.length === 0) return null;
  const rows = fields.map((key) => {
    const def = spec.fields.find((f) => f.key === key);
    return { key, label: def?.label ?? key, kind: def?.kind ?? ("text" as FieldKind), v: spec.resolveField(key, ctx) };
  });

  // 小票风格：一行一项，标签靠左、值靠右（与热敏机 `kv` 行同一形状）
  if (layout === "receipt") {
    return (
      <div className="mt-1.5">
        {section.title && <p className="font-bold">{section.title}</p>}
        {rows.map((r) => (
          <div key={r.key} className="flex items-baseline justify-between gap-2">
            <span className="shrink-0">{r.label}</span>
            <span className={`min-w-0 text-right font-medium ${valueClass(r.kind)}`}>{r.v}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="mt-2">
      {section.title && <p className="mb-0.5 text-[11px] font-bold">{section.title}</p>}
      <div className="grid grid-cols-2 border-t border-black/60">
        {rows.map((r) => (
          <div key={r.key} className="flex items-baseline justify-between gap-2 border-b border-black/40 px-2 py-1">
            <span className="shrink-0 text-black/70">{r.label}</span>
            <span className={`min-w-0 truncate text-right font-medium ${valueClass(r.kind)}`}>{r.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TableBlock({
  section,
  ctx,
  scenario,
  layout,
}: {
  section: ReceiptSection;
  ctx: ReceiptContext;
  scenario: ReceiptScenario;
  layout: ReceiptLayout;
}) {
  const spec = getSpec(scenario);
  const table = spec.tables?.find((t) => t.dataset === section.dataset);
  if (!table) return null;
  const cols = (section.columns ?? table.columns.map((c) => c.key))
    .map((k) => table.columns.find((c) => c.key === k))
    .filter((c): c is NonNullable<typeof c> => !!c);
  const rows = spec.tableRows?.(table.dataset, ctx) ?? [];
  if (cols.length === 0) return null;

  // 小票风格：不要方格网（热敏纸上没有格子，画出来也只是糊成一片灰），
  // 表头一条实线 + 数值列右对齐即可，窄纸上反而更好读。
  if (layout === "receipt") {
    return (
      <div className="mt-1.5">
        {section.title && <p className="font-bold">{section.title}</p>}
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="border-b border-black">
              {cols.map((c, i) => (
                <th key={c.key} className={`py-0.5 font-bold ${i > 0 && isNumericField(c.kind) ? "text-right" : "text-left"}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="break-inside-avoid">
                {cols.map((c, j) => (
                  <td
                    key={c.key}
                    className={`py-0.5 align-top ${j > 0 && isNumericField(c.kind) ? `text-right ${valueClass(c.kind)}` : "text-left"}`}
                  >
                    {r[c.key] ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={cols.length} className="py-0.5 text-center text-black/50">
                  暂无数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

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
            <tr key={i} className="break-inside-avoid">
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

/**
 * 二维码区块：`text` 里的 {{字段}} 占位解析完就是码的内容。
 *
 * 与其他区块不同，这里取字段用的是**模板自己的 scenario**，不走 `sectionScenario(ctx)` 的上下文倒推：
 * 付款小票的上下文里同时挂着 settlement 和 payment，倒推会把场景认成结算凭证，于是码里编进去的是
 * 另一张单的单号——票面看不出任何异常，扫出来才对不上。"能扫对"是这块的唯一职责，所以宁可多传一个参数。
 */
function QrBlock({
  section,
  ctx,
  scenario,
  layout,
}: {
  section: ReceiptSection;
  ctx: ReceiptContext;
  scenario: ReceiptScenario;
  layout: ReceiptLayout;
}) {
  const spec = getSpec(scenario);
  const payload = fillPlaceholders(section.text ?? "", (key) => asPlainText(spec.resolveField(key, ctx)));
  if (!payload) return null;
  return (
    <div className={`flex flex-col items-center gap-0.5 ${layout === "receipt" ? "mt-2" : "mt-2 py-1"}`}>
      {section.title && <p className="mb-0.5 text-[11px] font-bold">{section.title}</p>}
      <QrGraphic text={payload} scale={section.qrScale ?? 2} />
      {section.qrCaption && <p className="font-mono text-[10px] tracking-[0.06em]">{payload}</p>}
    </div>
  );
}

function SignBlock({ section, layout }: { section: ReceiptSection; layout: ReceiptLayout }) {
  const signers = section.signers ?? [];
  if (signers.length === 0) return null;

  // 小票风格：一行一条虚线下划线（对应热敏机上的 `署名：＿＿＿＿＿＿`），
  // 不再画方框表格——58mm 上四个方框每个只有十几毫米宽，签不了字。
  if (layout === "receipt") {
    return (
      <div className="mt-3">
        {section.title && <p className="font-bold">{section.title}</p>}
        <div className="mt-1 space-y-2.5">
          {signers.map((s) => (
            <div key={s} className="flex items-end gap-2">
              <span className="shrink-0 whitespace-nowrap">{s}：</span>
              <span className="h-[1.5em] min-w-0 flex-1 border-b border-dashed border-black" />
            </div>
          ))}
        </div>
      </div>
    );
  }

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

function TextBlock({
  section,
  ctx,
  scenario,
  layout,
}: {
  section: ReceiptSection;
  ctx: ReceiptContext;
  scenario: ReceiptScenario;
  layout: ReceiptLayout;
}) {
  const node = renderText(section.text ?? "", ctx, scenario);
  return layout === "receipt" ? (
    <p className="mt-1.5">{node}</p>
  ) : (
    <p className="mt-2 border border-black px-2 py-1">{node}</p>
  );
}

/**
 * 场景一律由模板自己带（`template.scenario`），这里不再从上下文倒推。
 *
 * 倒推在"上下文里同时挂着两张单"的票上必然出错：付款小票要带 settlement（票面有「关联单据」栏），
 * 于是 `ctx.settlement` 先命中，字段目录取成结算凭证那一套，pay_no / amount / trade_no 全都对不上号，
 * 打出来的是一张整版「—」的空白小票。浏览器里点一次就能复现，只是从前没人打付款小票的 A4 版式。
 */
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
  const { docNo, dateText } = docMeta(context, template.scenario);
  const showReprint = template.showReprintBadge && context.reprint;
  const paper = paperOverride ?? template.paper;
  const spec = PAPER_SPEC[paper];
  const m = spec.marginMm;
  const layout = template.layout ?? defaultLayout(paper);
  const receipt = layout === "receipt";

  return (
    <div
      id="print-root"
      className={`receipt-paper relative text-black ${receipt ? "text-[12px] leading-[1.45] [overflow-wrap:anywhere]" : "text-[12px] leading-[1.6]"}`}
      style={{
        ...SONG,
        width: `${spec.widthMm}mm`,
        minHeight: spec.heightMm == null ? undefined : `${spec.heightMm}mm`,
        padding: `${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm`,
      }}
      // 定长纸（A4 / 241）：页边距交给 @page，纸面自身不留白，这样第二页起也有同样的页边距；
      // 卷纸：页边距由纸面 padding 承担，打印通道按实测内容高度给一个刚好的 @page 高度。
      data-page-fixed={isRollPaper(paper) ? undefined : "1"}
    >
      {receipt ? (
        <>
          <header className="text-center">
            {/* 站名倍宽倍高：与小票机 `wide:2 tall:2` 同档，热敏票的第一眼要认出是哪家的票 */}
            <h1 className="text-[24px] font-bold leading-[1.2]">{station.name}</h1>
            <p className="mt-0.5 font-bold">{template.title}</p>
            {showReprint && <p className="font-bold">【补打，已经站长授权】</p>}
            {template.copyNote && <p>{template.copyNote}</p>}
          </header>
          <Rule layout={layout} />
          {/* 票头到"单号 / 日期"为止：热敏机打的就是这几行（`escpos.ts` 的票头），
              地址电话不往里塞——58mm 上它们要占掉三四行，而这行信息对"拿票去结算"毫无用处。
              A4 / 241 的单据风格仍然带地址电话，那边有纸宽。 */}
          <div className="flex items-baseline justify-between gap-2">
            <span className="shrink-0">单号</span>
            <span className="min-w-0 text-right font-mono">{docNo}</span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="shrink-0">日期</span>
            <span className="min-w-0 text-right font-mono">{dateText}</span>
          </div>
          <Rule layout={layout} />
        </>
      ) : (
        <>
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
        </>
      )}

      {template.sections.map((sec) => {
        if (sec.kind === "kv") return <KVBlock key={sec.id} section={sec} ctx={context} scenario={template.scenario} layout={layout} />;
        if (sec.kind === "table") return <TableBlock key={sec.id} section={sec} ctx={context} scenario={template.scenario} layout={layout} />;
        if (sec.kind === "sign") return <SignBlock key={sec.id} section={sec} layout={layout} />;
        if (sec.kind === "qr") return <QrBlock key={sec.id} section={sec} ctx={context} scenario={template.scenario} layout={layout} />;
        if (sec.kind === "text") return <TextBlock key={sec.id} section={sec} ctx={context} scenario={template.scenario} layout={layout} />;
        return null;
      })}

      <div className="mt-2">
        <Rule layout={layout} />
      </div>
      {receipt ? (
        <footer>
          {template.copyNote && <p className="text-center">{template.copyNote}</p>}
          <p className="text-right font-mono text-[11px]">{station.code}</p>
        </footer>
      ) : (
        <footer className="mt-1.5 flex items-center justify-between text-[10px]">
          <span>{template.copyNote}</span>
          <span>本单一式三联，涂改无效</span>
          <span>{station.code}</span>
        </footer>
      )}
    </div>
  );
}

/** 屏幕预览允许的放大上限：58 热敏只有 219px 宽，不放到这个倍数根本看不清写的什么 */
const MAX_FIT = 2.5;

/**
 * 屏幕上的"纸张托架"：把按真实 mm 排版的票据缩放到容器宽度内显示。
 *
 * 只缩屏幕、不缩纸：缩放只发生在外层 `transform`，纸面自身始终是 `Wmm` 宽、mm 级内边距，
 * 打印通道克隆的是纸面那一层（#print-root），因此纸上就是 1:1 的真实毫米。
 */
export function PaperFrame({
  paper,
  zoom = "fit",
  children,
}: {
  paper: PaperKind;
  /** "fit" 适应容器宽度（允许放大到 MAX_FIT）；或给具体比例（1 = 实际大小） */
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
      // offsetHeight 不受祖先 transform 影响，量到的始终是未缩放的真实排版高度
      const s = avail > 0 ? Math.min(MAX_FIT, avail / paperPx) : 1;
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
    <div ref={hostRef} className="receipt-fit-host flex w-full flex-col items-center">
      <div className="receipt-fit" style={{ height: boxH, width: paperPx * scale }}>
        <div
          ref={innerRef}
          className="receipt-fit-inner"
          style={{ width: paperPx, transform: `scale(${scale})`, transformOrigin: "top left" }}
        >
          {children}
        </div>
      </div>
      {/* 放大过就报一句真实尺寸：预览是为了看清，不是为了让人误以为票有这么宽 */}
      {scale > 1.02 && (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          按 {Math.round(scale * 100)}% 显示，实际纸宽 {PAPER_SPEC[paper].widthMm} mm
        </p>
      )}
    </div>
  );
}
