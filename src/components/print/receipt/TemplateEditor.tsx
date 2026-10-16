/**
 * 小票模板编辑器（系统 → 小票模板）。
 *
 * 左侧改配置，右侧即时预览同一张样例数据；保存即覆盖该场景的出厂默认。
 * 核心交互是「动态挑选字段」：每种场景在 scenarios.tsx 里登记了全部可用数据，
 * 这里按分组列出复选项，勾上就出现在票面、去掉就消失，用户不必碰任何代码。
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, PrinterIcon, RotateCcwIcon, Trash2Icon, WrenchIcon, XIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { PAPER } from "@/lib/constants";
import type { PaperKind } from "@/lib/constants";
import { nativePrinter, toNativePaper } from "@/lib/native";
import { useSession } from "@/store/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Choose } from "@/components/business/Choose";
import { CallOut, EmptyState, PageHeader } from "@/components/business/layout";
import { defaultTemplate } from "./defaults";
import { receiptLines } from "./escpos";
import { printJob } from "../printPage";
import { SCENARIOS } from "./scenarios";
import { PaperFrame, ReceiptDocument } from "./render";
import { measureQr } from "./QrGraphic";
import { measureCode128 } from "./code128";
import { CODE_SCALE_DOTS, CODE_SCALE_LABEL, type CodeScale, dotsToMm, printableDots, printableMm, scaleOf } from "./code-size";
import { defaultLayout, LAYOUT, PAPER_SPEC } from "./paper";
import type { ReceiptLayout } from "./paper";
import { effectiveTemplate, useReceiptStore } from "./store";
import { uid } from "./defaults";
import type { BlockKind, CodeStyle, ReceiptContext, ReceiptScenario, ReceiptSection, ReceiptTemplate } from "./types";
import { BLOCK_LABEL, CODE_STYLE_LABEL } from "./types";

/** 只有热敏纸能进小票机；A4 / 针式是系统打印队列的设备，不是同一台机器 */
const THERMAL: PaperKind[] = ["thermal80", "thermal58"];

const SCENARIO_LIST = Object.values(SCENARIOS) as { id: ReceiptScenario; label: string; entry: string }[];

export function ReceiptTemplateEditor() {
  const canEdit = useSession((s) => s.can("setting.write"));
  const save = useReceiptStore((s) => s.saveTemplate);
  const reset = useReceiptStore((s) => s.resetTemplate);
  // 站点级小票机实测列数：票面折行的头号原因是它比实机大
  const thermalCols = useReceiptStore((s) => s.thermalCols);
  const setThermalCols = useReceiptStore((s) => s.setThermalCols);

  const [scenario, setScenario] = useState<ReceiptScenario>("weigh_order");
  const spec = SCENARIOS[scenario];
  const [draft, setDraft] = useState<ReceiptTemplate>(() => effectiveTemplate(scenario));

  /**
   * 左栏当前选中的区块：预览里对应的那一格会被描一圈。
   *
   * 这条联动同时管住了"排序看起来不一致"——票面上每一格都对应得上左栏第几块，
   * 空的区块也不再从票面上凭空消失（见 ReceiptDocument 的 markEmptySections）。
   */
  const [activeSection, setActiveSection] = useState<string | null>(null);

  // 切换场景时载入该场景当前生效模板（用户覆盖优先；effectiveTemplate 会补回流程必备区块）
  useEffect(() => {
    setDraft(effectiveTemplate(scenario));
    // 区块 id 是"每个场景各自一套"，留着上一个场景的选中会把高亮指到不存在的那一格
    setActiveSection(null);
  }, [scenario]);

  function focusSection(id: string) {
    setActiveSection(id);
    // 纸面通常比预览框长得多：只描边不滚过去，等于让人自己找那格在哪儿
    requestAnimationFrame(() => {
      document
        .getElementById("print-root")
        ?.querySelector(`[data-receipt-section="${id}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  const sample = useMemo(() => spec.sampleContext(), [scenario]);

  /** 正在跑哪一种出纸动作：测试票 / 自检票。同时只允许一个——两条设备命令会抢同一台机器 */
  const [printing, setPrinting] = useState<null | "test" | "self">(null);

  // "本机能连上哪台小票机"的实时结论，不在前端抄常量（与设备中心同一条 usbprint 通道）
  const printers = useQuery({
    queryKey: ["receipt", "printers"],
    queryFn: async () => {
      const res = await nativePrinter.list();
      return res.available
        ? { ok: true as const, devices: res.data ?? [] }
        : { ok: false as const, error: res.error };
    },
    staleTime: 60_000,
  });
  const printerNote = (() => {
    const d = printers.data;
    if (!d) return "正在查找小票机…";
    if (!d.ok) return `设备通道不可用：${d.error}`;
    if (d.devices.length === 0) return "未发现可直连的小票机：请确认 USB 小票机已插好并装了驱动";
    const [first, ...rest] = d.devices;
    return `小票机：${first.label}${rest.length ? ` 等 ${d.devices.length} 台` : ""}`;
  })();

  function patch(p: Partial<ReceiptTemplate>) {
    setDraft((d) => ({ ...d, ...p }));
  }
  function updateSection(id: string, p: Partial<ReceiptSection>) {
    setDraft((d) => ({ ...d, sections: d.sections.map((s) => (s.id === id ? { ...s, ...p } : s)) }));
  }
  function moveSection(id: string, dir: -1 | 1) {
    setDraft((d) => {
      const i = d.sections.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.sections.length) return d;
      const next = [...d.sections];
      [next[i], next[j]] = [next[j], next[i]];
      return { ...d, sections: next };
    });
  }
  function removeSection(id: string) {
    // 必备区块（码单上的凭票码）不给删：删了这张票就到窗口扫不出来，主路径直接断
    setDraft((d) => ({ ...d, sections: d.sections.filter((s) => s.id !== id || s.required) }));
  }
  function addSection(kind: BlockKind) {
    const base: ReceiptSection =
      kind === "kv"
        ? { id: uid(), kind, title: "新字段区", fields: [] }
        : kind === "table"
          ? { id: uid(), kind, title: spec.tables?.[0]?.label ?? "表格", dataset: spec.tables?.[0]?.dataset, columns: spec.tables?.[0]?.columns.map((c) => c.key) }
          : kind === "sign"
            ? { id: uid(), kind, title: "署名", signers: ["经办人", "复核"] }
            : kind === "qr"
              // 不写 codeStyle = 只出二维码，与历史模板一致；要条码在区块里切「码制」
              ? { id: uid(), kind, title: "条码 / 二维码", text: "{{ticket_code}}", qrCaption: true }
              : { id: uid(), kind, text: "说明：{{空缺}}" };
    setDraft((d) => ({ ...d, sections: [...d.sections, base] }));
    // 票面动辄比预览框长几屏，接在末尾的新块不选中就等于"加了却不知道加在哪儿"
    focusSection(base.id);
  }

  function doSave() {
    if (!canEdit) {
      toast.error("只有站长能保存小票模板");
      return;
    }
    save(draft);
    toast.success(`${spec.label}模板已保存，此后该场景打印均用此版式`);
  }
  function doReset() {
    if (!canEdit) {
      toast.error("只有站长能恢复默认模板");
      return;
    }
    reset(scenario);
    setDraft(defaultTemplate(scenario));
    toast.success(`${spec.label}已恢复出厂默认`);
  }
  /**
   * 打印测试：把右侧预览（当前版式 + 样例数据）打成一张**真票**。
   *
   * 热敏纸走小票机——ESC/POS 直连出字节，和业务打印是同一条通道，
   * 所以"测试打出来对，正式单就一样对"。A4 / 针式由系统打印队列输出，
   * 小票机吃不了这种纸，只能回落到窗口打印预览。
   */
  async function doPrintTest() {
    if (!THERMAL.includes(draft.paper)) {
      toast.message("该纸型不走小票机", {
        description: `${PAPER[draft.paper]}已改为窗口打印预览，小票机只支持 58 / 80 热敏纸。`,
      });
      // 与业务打印同一条通道：预览里这块纸原样进打印文档，打出来就是右侧这一版
      const node = document.getElementById("print-root");
      if (!node) return;
      const spec = PAPER_SPEC[draft.paper];
      await printJob({
        title: `${draft.name} 测试票`,
        widthMm: spec.widthMm,
        heightMm: spec.heightMm,
        marginMm: spec.marginMm,
        node,
      });
      return;
    }
    setPrinting("test");
    try {
      // 测试票按票面纸型出：它要证明的是"这一版在大纸上长这样"，
      // 现场那台机器装的是哪卷纸是另一回事（那由设备台账说了算，业务出票时才参与）
      const res = await nativePrinter.receipt(receiptLines(draft, sample, { machinePaper: draft.paper }), {
        paper: toNativePaper(draft.paper),
        cols: thermalCols ?? undefined,
        copies: 1,
      });
      if (!res.available) {
        toast.error(res.error);
        return;
      }
      const out = res.data;
      if (out?.ok) {
        toast.success(`测试票已送到小票机 · ${out.device} · ${out.elapsedMs}ms`);
        return;
      }
      toast.error(`小票机没有出纸：${out?.error ?? res.error ?? "未知原因"}`, {
        description: "可按「小票机自检」判断是机器的问题，还是这一版票面排得放不下。",
      });
    } finally {
      setPrinting(null);
    }
  }

  /**
   * 小票机自检：与现场排障工装（tools/escpos-probe）同一份票面，
   * 一张纸判读通道 / 中文字库 / 栅格列数 / 切刀四件事。
   * 与"打印测试"配对使用——出纸异常时，先分清是机器的问题还是版面的问题。
   */
  async function doSelfTest() {
    setPrinting("self");
    try {
      const res = await nativePrinter.selfTest({ paper: toNativePaper(draft.paper) });
      if (!res.available) {
        toast.error(res.error);
        return;
      }
      const out = res.data;
      if (out?.ok) toast.success(`自检票已送出 · ${out.device} · ${out.elapsedMs}ms`);
      else toast.error(`自检票没有出纸：${out?.error ?? res.error ?? "未知原因"}`);
    } finally {
      setPrinting(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="小票模板"
        description={`${spec.label} · 触发于${spec.entry}`}
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={doPrintTest} disabled={printing !== null}>
              {printing === "test" ? <Spinner /> : <PrinterIcon />}
              打印测试
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={doSelfTest}
              disabled={printing !== null}
              title="自检票：分清是机器问题还是版式问题"
            >
              {printing === "self" ? <Spinner /> : <WrenchIcon />}
              小票机自检
            </Button>
            <Button size="sm" variant="outline" onClick={doReset}>
              <RotateCcwIcon />
              恢复默认
            </Button>
            <Button size="sm" onClick={doSave}>
              保存模板
            </Button>
          </div>
        }
      />

      {/* 场景切换 */}
      <Tabs
        value={scenario}
        onValueChange={(v) => setScenario(v as ReceiptScenario)}
        className="gap-0 border-b px-6"
      >
        <TabsList className="mb-2 h-auto max-w-full flex-wrap justify-start">
          {SCENARIO_LIST.map((s) => (
            <TabsTrigger key={s.id} value={s.id} className="flex-none">
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {!canEdit && (
        <div className="px-6 pt-3">
          <CallOut tone="info" title="保存需站长权限">
            改动只在这次打开时有效，点保存也不会写入该场景的模板。
          </CallOut>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden px-6 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* 左：配置 */}
        <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
          <section className="space-y-2 border bg-card p-3">
            <h3 className="text-sm font-semibold">基础设置</h3>
            <div className="grid grid-cols-2 gap-2">
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                票据标题
                <Input value={draft.title} onChange={(e) => patch({ title: e.target.value })} className="h-8 text-sm" />
              </Label>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                联次说明
                <Input value={draft.copyNote} onChange={(e) => patch({ copyNote: e.target.value })} className="h-8 text-sm" />
              </Label>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                纸型（换纸型会同步换成该纸型的默认版式）
                <Choose
                  value={draft.paper}
                  onChange={(v) => {
                    const p = v as PaperKind;
                    patch({ paper: p, layout: defaultLayout(p) });
                  }}
                  options={(Object.keys(PAPER) as PaperKind[]).map((k) => ({ value: k, label: PAPER[k] }))}
                  size="sm"
                  aria-label="纸型"
                />
              </Label>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                版式
                <Choose
                  value={draft.layout ?? defaultLayout(draft.paper)}
                  onChange={(v) => patch({ layout: v as ReceiptLayout })}
                  options={(Object.keys(LAYOUT) as ReceiptLayout[]).map((k) => ({ value: k, label: LAYOUT[k] }))}
                  size="sm"
                  aria-label="版式"
                />
                <span className="text-[10px] text-muted-foreground">热敏小票用「小票风格」</span>
              </Label>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                补打角标
                <span className="flex h-8 items-center gap-2">
                  <Switch checked={draft.showReprintBadge} onCheckedChange={(v) => patch({ showReprintBadge: v })} />
                  <span className="text-xs">{draft.showReprintBadge ? "显示" : "隐藏"}</span>
                </span>
              </Label>
              <Label className="col-span-2 flex flex-col gap-1 text-xs text-muted-foreground">
                小票机列数（汉字占 2 列）
                <Choose
                  value={thermalCols === null ? "auto" : String(thermalCols)}
                  onChange={(v) => setThermalCols(v === "auto" ? null : Number(v))}
                  options={[
                    { value: "auto", label: "自动（按纸型：80 → 48 列 / 58 → 32 列）" },
                    { value: "48", label: "48 列" },
                    { value: "42", label: "42 列" },
                    { value: "32", label: "32 列" },
                    { value: "24", label: "24 列" },
                  ]}
                  size="sm"
                  aria-label="小票机列数"
                />
                <span className="text-[10px] text-muted-foreground">
                  票面折行几乎都是这个数比实机大。点「小票机自检」打一张，标尺折到第几格就填几。
                </span>
              </Label>
            </div>
          </section>

          <section className="space-y-2 border bg-card p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">区块（{draft.sections.length}）</h3>
              <div className="flex gap-1">
                {(["kv", "table", "sign", "text", "qr"] as BlockKind[]).map((k) => (
                  <Button key={k} size="xs" variant="outline" onClick={() => addSection(k)}>
                    <PlusIcon />
                    {BLOCK_LABEL[k]}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              {draft.sections.map((sec, idx) => (
                <SectionEditor
                  key={sec.id}
                  sec={sec}
                  scenario={scenario}
                  paper={draft.paper}
                  sample={sample}
                  index={idx}
                  total={draft.sections.length}
                  active={sec.id === activeSection}
                  onFocus={() => focusSection(sec.id)}
                  onPatch={(p) => updateSection(sec.id, p)}
                  onMove={(d) => moveSection(sec.id, d)}
                  onRemove={() => removeSection(sec.id)}
                />
              ))}
              {draft.sections.length === 0 && <EmptyState title="还没有区块" description="点上方按钮添加区块。" />}
            </div>
          </section>
        </div>

        {/* 右：实时预览（按真实纸型 mm 排版，所见即所得）。标题行固定，只有票面滚 */}
        <div className="flex min-h-0 flex-col rounded-md border bg-muted/30">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b p-3">
            <p className="text-xs text-muted-foreground">
              实时预览 · 样例数据，按真实纸张尺寸排版
              <span className="ml-2 text-[10px]">点左栏区块会描出票上对应那一格；虚线框是空区块，打印时跳过</span>
            </p>
            <span className="text-[10px] text-muted-foreground">{PAPER_SPEC[draft.paper].note}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {/* 出纸去向：热敏走小票机（ESC/POS 直连），A4 / 针式走系统打印队列——打印测试据此分流 */}
            <p className="mb-2 text-[10px] text-muted-foreground">
              {THERMAL.includes(draft.paper)
                ? printerNote
                : `${PAPER[draft.paper]}不进小票机，「打印测试」将走窗口打印预览`}
            </p>
            <PaperFrame paper={draft.paper} zoom={1}>
              <ReceiptDocument template={draft} context={sample} highlightId={activeSection ?? undefined} markEmptySections />
            </PaperFrame>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------- 单个区块编辑器 */

function SectionEditor({
  sec,
  scenario,
  paper,
  sample,
  index,
  total,
  active,
  onFocus,
  onPatch,
  onMove,
  onRemove,
}: {
  sec: ReceiptSection;
  scenario: ReceiptScenario;
  paper: PaperKind;
  sample: ReceiptContext;
  index: number;
  total: number;
  active: boolean;
  onFocus: () => void;
  onPatch: (p: Partial<ReceiptSection>) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
}) {
  const spec = SCENARIOS[scenario];

  return (
    // 点卡片任意一处 = 选中这一格，预览里对应的那块跟着描边。
    // 上下移的按钮点击也会冒泡到这里，正好：挪完的那一格仍是当前选中，眼睛不用重新找。
    <div
      onClick={onFocus}
      className={`relative space-y-2 border bg-muted/30 p-2 ${active ? "border-primary pl-3" : ""}`}
    >
      {active && <span className="absolute left-0 top-0 h-full w-1 bg-primary" aria-hidden />}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{BLOCK_LABEL[sec.kind]}</span>
          {sec.required && (
            <span className="rounded border border-primary/40 px-1.5 py-0.5 text-[10px] text-primary" title="结算窗口要靠它扫码找单，删不掉">
              必备
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <Button size="xs" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)} aria-label="上移">
            <ArrowUpIcon />
          </Button>
          <Button size="xs" variant="ghost" disabled={index === total - 1} onClick={() => onMove(1)} aria-label="下移">
            <ArrowDownIcon />
          </Button>
          {/* 必备区块不给删除入口，而不是给一个点了没反应的灰色按钮：删不掉是设计，不是故障 */}
          {!sec.required && (
            <Button size="xs" variant="ghost" onClick={onRemove} aria-label="删除">
              <Trash2Icon />
            </Button>
          )}
        </div>
      </div>

      {(sec.kind === "kv" || sec.kind === "table" || sec.kind === "sign" || sec.kind === "qr") && (
        <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
          区块标题
          <Input value={sec.title ?? ""} onChange={(e) => onPatch({ title: e.target.value })} className="h-7 text-xs" />
          {sec.kind === "kv" && (
            <span className="text-[10px] text-muted-foreground">
              字段区建一个就够：标题留空时，票面小标题按字段分组自动带出。
            </span>
          )}
        </Label>
      )}

      {sec.kind === "kv" && <KvPicker sec={sec} scenario={scenario} onPatch={onPatch} />}
      {sec.kind === "table" && spec.tables && (
        <TablePicker sec={sec} scenario={scenario} onPatch={onPatch} />
      )}
      {sec.kind === "sign" && <SignEditor sec={sec} onPatch={onPatch} />}
      {sec.kind === "qr" && <CodeEditor sec={sec} scenario={scenario} paper={paper} sample={sample} onPatch={onPatch} />}
      {sec.kind === "text" && (
        <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
          文本（支持 {"{{字段key}}"} 占位，如 {"{{remark}}"}）
          <Textarea
            value={sec.text ?? ""}
            onChange={(e) => onPatch({ text: e.target.value })}
            rows={2}
            className="h-14 min-h-0 resize-y bg-background px-2 py-1 text-xs"
          />
        </Label>
      )}
    </div>
  );
}

/**
 * 码区块：能改的是"出哪种码、码画多大、要不要在旁边印一行字"，不改载荷。
 *
 * 载荷（`{{ticket_code}}`）是结算窗口扫码定位单据的唯一依据，改错一个字符的票仍然印得出来、
 * 只是永远扫不到单——这种错在票面上完全看不出来，等到客户站在窗口才发现。所以必备区块的载荷
 * 一律只读；站长自己新加的码（收款码、小程序码之类）没有这个风险，放开编辑。
 *
 * 尺寸这一档从前只管 A4 与预览（小票机恒用固件默认的 4 点），现在三条出纸路都读它，
 * 所以下面报出来的毫米数在热敏纸上也成立。
 */
function CodeEditor({
  sec,
  scenario,
  paper,
  sample,
  onPatch,
}: {
  sec: ReceiptSection;
  scenario: ReceiptScenario;
  paper: PaperKind;
  sample: ReceiptContext;
  onPatch: (p: Partial<ReceiptSection>) => void;
}) {
  const spec = SCENARIOS[scenario];
  // 本场景里能当载荷用的凭据字段（约定：key 以 _code 结尾的都是"可扫码的定位符"）
  const codeFields = spec.fields.filter((f) => f.key.endsWith("_code"));
  const style: CodeStyle = sec.codeStyle ?? "qr";
  const scale = scaleOf(sec.qrScale);

  // 拿样例数据把 {{字段}} 解析成真实载荷，只为报尺寸用（真票上解析的是这一张单自己的号）
  const payload = (sec.text ?? "")
    .replace(/\{\{(.+?)\}\}/g, (_, key: string) => {
      const v = spec.resolveField(String(key).trim(), sample);
      return typeof v === "string" ? v : v == null ? "" : String(v);
    })
    .trim();
  const qr = payload && style !== "barcode" ? measureQr(payload, scale, printableDots(paper)) : null;
  const bar = payload && style !== "qr" ? measureCode128(payload, paper, scale) : null;

  return (
    <div className="space-y-1.5">
      <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
        码的内容（支持 {"{{字段key}}"} 占位）
        <Input
          value={sec.text ?? ""}
          onChange={(e) => onPatch({ text: e.target.value })}
          readOnly={sec.required}
          className={`h-7 text-xs font-mono ${sec.required ? "bg-muted/50 text-muted-foreground" : "bg-background"}`}
        />
        <span className="text-[10px] text-muted-foreground">
          {sec.required
            ? "流程必备件，只读：这一栏错了照样能打票，但那张票永远扫不出单号。"
            : `本场景可用作载荷的字段：${codeFields.map((f) => `{{${f.key}}} ${f.label}`).join("　") || "（无）"}`}
        </span>
      </Label>

      <div className="grid grid-cols-2 gap-2">
        <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
          码制
          <Choose
            aria-label="码制"
            size="sm"
            value={style}
            onChange={(v) => onPatch({ codeStyle: v as CodeStyle })}
            options={(["qr", "barcode", "both"] as CodeStyle[]).map((k) => ({ value: k, label: CODE_STYLE_LABEL[k] }))}
          />
        </Label>
        <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
          尺寸
          <Choose
            aria-label="码的尺寸"
            size="sm"
            value={String(scale)}
            onChange={(v) => onPatch({ qrScale: Number(v) as CodeScale })}
            options={([1, 2, 3, 4, 5] as CodeScale[]).map((k) => ({
              value: String(k),
              label: `${CODE_SCALE_LABEL[k]}（${dotsToMm(CODE_SCALE_DOTS[k])}mm/模块）`,
            }))}
          />
        </Label>
      </div>

      {/* 选了码制就报它在这张纸上的真实尺寸：能不能扫，看的是毫米，不是"大/中/小"这种形容词 */}
      {(qr != null || bar != null) && (
        <p className="text-[10px] text-muted-foreground">
          {[
            qr ? `二维码约 ${qr.sideMm.toFixed(1)}mm 见方${qr.shrunk ? `（${PAPER[paper]}放不下，已压到 ${qr.dots} 点/模块）` : ""}` : null,
            bar ? `条码约 ${bar.widthMm.toFixed(1)}mm 宽${bar.shrunk ? `（${PAPER[paper]}放不下，已压到 ${bar.dots.toFixed(2)} 点/模块）` : ""}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          {bar?.shrunk
            ? "。再宽就得换纸型或只扫二维码"
            : qr?.shrunk
              ? "。再宽就得换纸型"
              : `；本纸型可打宽度 ${printableMm(paper).toFixed(0)}mm`}
        </p>
      )}
      <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
        码下方印码内容
        <span className="flex h-8 items-center gap-2">
          <Switch checked={sec.qrCaption === true} onCheckedChange={(v) => onPatch({ qrCaption: v })} />
          <span className="text-xs">{sec.qrCaption ? "印" : "不印"}</span>
        </span>
      </Label>
      <p className="text-[10px] text-muted-foreground">
        建议保持开启：票面晒白或码被磨花时，还能照着这行字人工认出是哪张单。想省纸才关。
      </p>
      <p className="text-[10px] text-muted-foreground">
        结算窗口的枪扫不动二维码时，把码制切成「二维码 + 条码都打」，两种枪都能读。
      </p>
    </div>
  );
}

/** 字段区：按分组列出全部可选数据，勾选即加入票面；票面顺序 = 下面这份清单的顺序 */
function KvPicker({
  sec,
  scenario,
  onPatch,
}: {
  sec: ReceiptSection;
  scenario: ReceiptScenario;
  onPatch: (p: Partial<ReceiptSection>) => void;
}) {
  const spec = SCENARIOS[scenario];
  const selected = sec.fields ?? [];
  const defOf = (k: string) => spec.fields.find((f) => f.key === k);

  function setFields(next: string[]) {
    onPatch({ fields: next });
  }
  function toggle(key: string, on: boolean) {
    // 新勾的接在末尾：票面顺序就是这份清单的顺序，不再被字段目录悄悄重排
    setFields(on ? [...selected, key] : selected.filter((k) => k !== key));
  }
  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= selected.length) return;
    const next = [...selected];
    [next[i], next[j]] = [next[j], next[i]];
    setFields(next);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">已选 {selected.length} 项</span>
        {selected.length > 0 && (
          <Button size="xs" variant="ghost" onClick={() => setFields([])}>
            清空
          </Button>
        )}
      </div>
      {spec.groups.map((g) => {
        const groupFields = spec.fields.filter((f) => f.group === g);
        if (groupFields.length === 0) return null;
        return (
          <div key={g} className="rounded border bg-background/60 p-1.5">
            <p className="mb-1 text-[10px] font-medium text-muted-foreground">{g}</p>
            <div className="grid grid-cols-2 gap-x-2 gap-y-1">
              {groupFields.map((f) => (
                <label key={f.key} className="flex items-center gap-1.5 text-xs">
                  <Checkbox checked={selected.includes(f.key)} onCheckedChange={(v) => toggle(f.key, v === true)} />
                  <span className="truncate" title={f.label}>
                    {f.label}
                  </span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
      {selected.length > 0 && (
        <Collapsible className="rounded border bg-background/60 p-1.5">
          <CollapsibleTrigger className="cursor-pointer text-[10px] font-medium text-muted-foreground">
            票面顺序（{selected.length} 项 · 这一列就是打印顺序，可上下调）
          </CollapsibleTrigger>
          <CollapsibleContent>
          <ol className="mt-1 space-y-0.5">
            {selected.map((k, i) => {
              const def = defOf(k);
              return (
                <li key={k} className="flex items-center gap-1 text-xs">
                  <span className="tnum w-5 shrink-0 text-right text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate" title={def?.label ?? k}>
                    {def?.label ?? k}
                  </span>
                  {def?.group && <span className="shrink-0 text-[10px] text-muted-foreground">{def.group}</span>}
                  <Button size="xs" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`上移 ${def?.label ?? k}`}>
                    <ArrowUpIcon />
                  </Button>
                  <Button size="xs" variant="ghost" disabled={i === selected.length - 1} onClick={() => move(i, 1)} aria-label={`下移 ${def?.label ?? k}`}>
                    <ArrowDownIcon />
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => toggle(k, false)} aria-label={`从票面移除 ${def?.label ?? k}`}>
                    <XIcon />
                  </Button>
                </li>
              );
            })}
          </ol>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

/** 表格区：选数据集 + 选列 */
function TablePicker({
  sec,
  scenario,
  onPatch,
}: {
  sec: ReceiptSection;
  scenario: ReceiptScenario;
  onPatch: (p: Partial<ReceiptSection>) => void;
}) {
  const spec = SCENARIOS[scenario];
  const tables = spec.tables ?? [];
  const current = tables.find((t) => t.dataset === sec.dataset) ?? tables[0];
  const cols = sec.columns ?? current?.columns.map((c) => c.key) ?? [];

  function setDataset(dataset: string) {
    const t = tables.find((x) => x.dataset === dataset);
    onPatch({ dataset, columns: t?.columns.map((c) => c.key) ?? [] });
  }
  function toggleCol(key: string, on: boolean) {
    onPatch({ columns: on ? [...cols, key] : cols.filter((k) => k !== key) });
  }

  if (!current) return <p className="text-xs text-muted-foreground">该场景没有可打印的表格数据。</p>;

  return (
    <div className="space-y-2">
      <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
        数据集
        <Choose value={sec.dataset ?? current.dataset} onChange={setDataset} options={tables.map((t) => ({ value: t.dataset, label: t.label }))} size="sm" aria-label="数据集" />
      </Label>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1 rounded border bg-background/60 p-1.5">
        {current.columns.map((c) => (
          <label key={c.key} className="flex items-center gap-1.5 text-xs">
            <Checkbox checked={cols.includes(c.key)} onCheckedChange={(v) => toggleCol(c.key, v === true)} />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** 署名区：可增删署名栏 */
function SignEditor({ sec, onPatch }: { sec: ReceiptSection; onPatch: (p: Partial<ReceiptSection>) => void }) {
  const signers = sec.signers ?? [];
  function setSigners(next: string[]) {
    onPatch({ signers: next });
  }
  return (
    <div className="space-y-1.5">
      {signers.map((s, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input value={s} onChange={(e) => setSigners(signers.map((x, j) => (j === i ? e.target.value : x)))} className="h-7 text-xs" />
          <Button size="xs" variant="ghost" onClick={() => setSigners(signers.filter((_, j) => j !== i))} aria-label="删除署名">
            <Trash2Icon />
          </Button>
        </div>
      ))}
      <Button size="xs" variant="outline" onClick={() => setSigners([...signers, "新署名"])}>
        <PlusIcon />
        添加署名栏
      </Button>
    </div>
  );
}
