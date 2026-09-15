/**
 * 模板 → 小票机行序列（ESC/POS）。
 *
 * 与 `render.tsx` 的关系：两者读同一份模板、同一份场景目录，**顺序也必须一致**
 * （票头 → 分隔线 → 各区块 → 票尾）。区别只在落点——那边画 HTML 给屏幕，这边排行给热敏纸。
 * 于是"预览里有什么，纸上就有什么"这条承诺才有依据：改版式只改模板，两处同时跟着变。
 *
 * 两处刻意的差异：
 *  1. **表格不排窄表**。48 / 32 列放不下多列，硬排必然折行把票面打散，所以每行折成
 *     「首列 → 其余列并排」两段——热敏票的惯例，也保住了"至少看得见"。
 *  2. **不折行**。长文本的折行交给 Rust（`write_lines` 里的 `wrap`），
 *     因为列宽是纸的属性、由 `Paper::cols()` 说了算；前端再写一份必然分叉。
 *  3. **一行放不下的"标签 + 数值"会拆成两行**（标签一行、数值右对齐一行），也在 Rust
 *     的 `kv` 里判断，理由同 2——放不下该怎么让，只有知道纸宽的那一侧说了算。
 *     热敏机会在边界上自己硬折，那才是"打印效果和预览不一样"的元凶。
 *
 * 还有一处是**只有这里才有**的：码的横向落点。预览用 flex 把码居中画在纸宽里，
 * 那一侧不需要知道任何机身参数；热敏这边一旦交给固件的 `ESC a 1`，机器就按自己的头宽
 * 居中，装 58 卷的 80 机会把条码推出纸外（详见 `code-size.ts::codeOffsetDots`）。
 * 所以这里额外算出 `padLeft`（点），由 Rust 补在栅格左边。
 */
import type { NativePrintLine } from "@/lib/native";
import type { PaperKind } from "@/lib/constants";
import { docMeta, kvClusters } from "./render";
import { getSpec } from "./scenarios";
import { measureCode128 } from "./code128";
import { qrSideDots } from "./QrGraphic";
import { BARCODE_HEIGHT_DOTS, CODE_SCALE_DOTS, codeBudgetDots, codeOffsetDots, scaleOf } from "./code-size";
import type { ReceiptContext, ReceiptTemplate } from "./types";

/**
 * ReactNode → 纯文本。
 * 场景目录里的 `resolveField` / `tableRows` 目前一律返回字符串，这里只做兜底：
 * 真出现非文本节点时给空串，绝不把 `[object Object]` 打到票上。
 */
function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** 把 text 区块里的 {{key}} 占位换成字段值（与 render.tsx 的 renderText 同一套规则） */
function fillText(tpl: string, resolve: (key: string) => string): string {
  return tpl.replace(/\{\{(.+?)\}\}/g, (_, key: string) => resolve(key.trim()));
}

/**
 * 把一张小票排成 ESC/POS 行序列。
 *
 * 只做"票面由哪些行组成"这一件事——编码、列宽、折行、切纸全在 Rust 侧。
 *
 * `opts.machinePaper` = 这次出纸**告诉机器的**那张纸（`print_receipt` 的 paper 参数）。
 * 只有热敏直打会传：它决定码的宽度预算与横向落点（见 `code-size.ts` 的两个函数）。
 * 不传 = 按票面纸型算，屏幕预览、A4/针式队列与编辑器的测试票都走这个口径
 * （定长纸的落点由驱动的可打区说了算，`padLeft` 恒为 0）。
 */
export function receiptLines(
  template: ReceiptTemplate,
  ctx: ReceiptContext,
  opts?: { machinePaper?: PaperKind },
): NativePrintLine[] {
  const spec = getSpec(template.scenario);
  const { docNo, dateText } = docMeta(ctx, template.scenario);
  const machine = opts?.machinePaper;
  const out: NativePrintLine[] = [];

  /* ---------------------------------------------------------------- 票头 */
  // 站名倍宽倍高：热敏票的第一眼必须能认出是哪家的票
  out.push({ kind: "text", text: ctx.station.name, align: "center", bold: true, wide: 2, tall: 2 });
  out.push({ kind: "text", text: template.title, align: "center", bold: true });
  if (template.showReprintBadge && ctx.reprint) {
    out.push({ kind: "text", text: "【补打，已经站长授权】", align: "center", bold: true });
  }
  if (template.copyNote) out.push({ kind: "text", text: template.copyNote, align: "center" });
  out.push({ kind: "rule" });
  out.push({ kind: "kv", label: "单号", value: docNo });
  out.push({ kind: "kv", label: "日期", value: dateText });
  out.push({ kind: "rule" });

  /* -------------------------------------------------------------- 各区块 */
  for (const sec of template.sections) {
    if (sec.kind === "kv") {
      const fields = sec.fields ?? [];
      if (fields.length === 0) continue;
      if (sec.title) out.push({ kind: "text", text: sec.title, bold: true });
      // 与 render.tsx 的 KVBlock 同一条规则：一个区块跨两个以上分组时，每段前打一行分组名
      const clusters = kvClusters(spec, fields, ctx);
      const titled = clusters.length > 1;
      for (const c of clusters) {
        if (titled && c.group) out.push({ kind: "text", text: c.group, bold: true });
        for (const r of c.rows) out.push({ kind: "kv", label: r.label, value: asText(r.value) });
      }
      continue;
    }

    if (sec.kind === "table") {
      const table = spec.tables?.find((t) => t.dataset === sec.dataset);
      if (!table) continue;
      const cols = (sec.columns ?? table.columns.map((c) => c.key))
        .map((k) => table.columns.find((c) => c.key === k))
        .filter((c): c is NonNullable<typeof c> => !!c);
      if (cols.length === 0) continue;
      if (sec.title) out.push({ kind: "text", text: sec.title, bold: true });
      const rows = spec.tableRows?.(table.dataset, ctx) ?? [];
      if (rows.length === 0) {
        out.push({ kind: "text", text: "暂无数据" });
        continue;
      }
      for (const row of rows) {
        const cells = cols.map((c) => asText(row[c.key] ?? "—"));
        const [head, ...rest] = cells;
        // 单列数据集就退化成一行文本，不必硬凑出"标签 + 值"的形状
        if (rest.length === 0) out.push({ kind: "text", text: head });
        else out.push({ kind: "kv", label: head, value: rest.join("  ") });
      }
      continue;
    }

    if (sec.kind === "sign") {
      const signers = sec.signers ?? [];
      if (signers.length === 0) continue;
      if (sec.title) out.push({ kind: "text", text: sec.title, bold: true });
      for (const s of signers) out.push({ kind: "kv", label: s, value: "＿＿＿＿＿＿" });
      continue;
    }

    if (sec.kind === "qr") {
      // 取字段一律用模板自己的 scenario：靠上下文倒推会在"付款小票"这种同时挂着
      // settlement 和 payment 的场景里拿错目录，编出一个扫出来对不上号的码
      const payload = fillText(sec.text ?? "", (key) => asText(spec.resolveField(key, ctx))).trim();
      if (!payload) continue;
      const style = sec.codeStyle ?? "qr";
      const scale = scaleOf(sec.qrScale);
      // 宽度预算按"票面纸型与机器纸型里更窄的那个"收：票面按 80 排、机器装的是 58 卷时，
      // 码按 64mm 算出来机器根本打不下，右半截直接消失
      const maxDots = codeBudgetDots(template.paper, machine);
      // 横向落点自己算，不交给固件居中——理由见 code-size.ts::codeOffsetDots。
      // 二维码与一维码共用同一条轴，两种码都打时才是上下对齐的
      const pad = (codeDots: number) => codeOffsetDots(codeDots, template.paper, machine);
      if (style !== "barcode") {
        // 档位换算成点数一起发过去：从前这里不带 size，机器恒用默认的 4 点，
        // 站长在编辑器里把码调大，纸上却纹丝不动
        const side = qrSideDots(payload, scale);
        out.push({ kind: "qr", text: payload, size: CODE_SCALE_DOTS[scale], padLeft: side == null ? 0 : pad(side) });
      }
      if (style !== "qr") {
        // 条空宽度是前端算的（CODE128 不在 ESC/POS 功能 A 的七种码制里），
        // 机器只负责把这段栅格原样排点。measureCode128 与预览共用，纸宽不够时两边一起缩
        const geo = measureCode128(payload, template.paper, scale, maxDots);
        if (geo) {
          out.push({
            kind: "barcode",
            runs: geo.runs,
            // 发整条的点宽而不是"每模块几点"：模块宽度可能是小数，栅格只认整数点
            width: geo.widthDots,
            height: BARCODE_HEIGHT_DOTS,
            // 落点按条身算（静区不打进栅格，纸边那圈白纸就是静区）
            padLeft: pad(geo.widthDots),
          });
        }
      }
      // 码下方那行可读内容：码被晒白、磨花、缺针断线之后，它是票上唯一还认得出是哪张单的东西，
      // 所以与 A4 那一侧统一——模板说印就印，不因为"热敏纸每一毫米都是钱"而省掉。
      // （从前这里不印，理由是票头已经有一行「单号」；但票头那行是**单号**，码里装的是**载荷**
      // `BH1:` + 单号，两者不是同一串；何况磨损的正是码本身，不是票头。）
      if (sec.qrCaption) out.push({ kind: "text", text: payload, align: "center" });
      continue;
    }

    if (sec.kind === "text") {
      const text = fillText(sec.text ?? "", (key) => asText(spec.resolveField(key, ctx)));
      out.push({ kind: "text", text });
    }
  }

  /* ---------------------------------------------------------------- 票尾 */
  out.push({ kind: "rule" });
  if (template.copyNote) out.push({ kind: "text", text: template.copyNote, align: "center" });
  // 站点编码右对齐：换机器、换站点时这是定位的第一线索（与 write_weigh_ticket 同处理）
  out.push({ kind: "text", text: ctx.station.code, align: "right" });

  return out;
}
