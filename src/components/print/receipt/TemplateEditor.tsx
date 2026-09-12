/**
 * 小票模板编辑器（系统 → 小票模板）。
 *
 * 左侧改配置，右侧即时预览同一张样例数据；保存即覆盖该场景的出厂默认。
 * 核心交互是「动态挑选字段」：每种场景在 scenarios.tsx 里登记了全部可用数据，
 * 这里按分组列出复选项，勾上就出现在票面、去掉就消失，用户不必碰任何代码。
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowUpIcon, LoaderCircleIcon, PlusIcon, PrinterIcon, RotateCcwIcon, Trash2Icon, WrenchIcon } from "lucide-react";
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
import { SCENARIOS } from "./scenarios";
import { PaperFrame, ReceiptDocument } from "./render";
import { PAPER_SPEC } from "./paper";
import { effectiveTemplate, useReceiptStore } from "./store";
import { uid } from "./defaults";
import type { BlockKind, ReceiptScenario, ReceiptSection, ReceiptTemplate } from "./types";

/** 只有热敏纸能进小票机；A4 / 针式是系统打印队列的设备，不是同一台机器 */
const THERMAL: PaperKind[] = ["thermal80", "thermal58"];

const SCENARIO_LIST = Object.values(SCENARIOS) as { id: ReceiptScenario; label: string; entry: string }[];

const BLOCK_LABEL: Record<BlockKind, string> = {
  kv: "字段区",
  table: "表格区",
  sign: "署名区",
  text: "文本行",
  qr: "二维码",
};

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

  // 切换场景时载入该场景当前生效模板（用户覆盖优先；effectiveTemplate 会补回流程必备区块）
  useEffect(() => {
    setDraft(effectiveTemplate(scenario));
  }, [scenario]);

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
    if (!d.ok) return `没有原生设备通道：${d.error}`;
    if (d.devices.length === 0) return "未发现可直连的小票机——USB 小票机请确认已插好并装了驱动";
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
              ? { id: uid(), kind, title: "二维码", text: "{{ticket_code}}", qrCaption: true }
              : { id: uid(), kind, text: "说明：{{空缺}}" };
    setDraft((d) => ({ ...d, sections: [...d.sections, base] }));
  }

  function doSave() {
    if (!canEdit) {
      toast.error("只有站长能保存小票模板（需 setting.write）");
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
        description: `${PAPER[draft.paper]}由系统打印队列输出，已改为窗口打印预览；小票机只吃 58 / 80 热敏。`,
      });
      window.print();
      return;
    }
    setPrinting("test");
    try {
      const res = await nativePrinter.receipt(receiptLines(draft, sample), {
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
        description={`${spec.label} · 触发于${spec.entry}。勾选字段即可自定义每张票据打印哪些数据。`}
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={doPrintTest} disabled={printing !== null}>
              {printing === "test" ? <LoaderCircleIcon className="animate-spin" /> : <PrinterIcon />}
              打印测试
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={doSelfTest}
              disabled={printing !== null}
              title="打一张自检票：一次判读通道 / 中文字库 / 栅格列数 / 切刀"
            >
              {printing === "self" ? <LoaderCircleIcon className="animate-spin" /> : <WrenchIcon />}
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
        <TabsList variant="line" className="-mb-px flex-wrap">
          {SCENARIO_LIST.map((s) => (
            <TabsTrigger key={s.id} value={s.id} className="flex-none">
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {!canEdit && (
        <div className="px-6 pt-3">
          <CallOut tone="info" title="当前岗位只能预览，保存需站长权限">
            模板改动会被本地记住，但落盘写入要 station_master。下方预览始终基于已保存版本（若有）。
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
                纸型
                <Choose
                  value={draft.paper}
                  onChange={(v) => patch({ paper: v as PaperKind })}
                  options={(Object.keys(PAPER) as PaperKind[]).map((k) => ({ value: k, label: PAPER[k] }))}
                  size="sm"
                  aria-label="纸型"
                />
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
                  票面折行几乎都是这个数比实机大。点「小票机自检」打一张，标尺折在第几格就填几——填错了票面会自己折，
                  但不会再印出 {"&#165;"} 这类转义码。
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
                  index={idx}
                  total={draft.sections.length}
                  onPatch={(p) => updateSection(sec.id, p)}
                  onMove={(d) => moveSection(sec.id, d)}
                  onRemove={() => removeSection(sec.id)}
                />
              ))}
              {draft.sections.length === 0 && <EmptyState title="还没有区块" description="点上方按钮添加字段区 / 表格区 / 署名区。" />}
            </div>
          </section>
        </div>

        {/* 右：实时预览（按真实纸型 mm 排版，所见即所得） */}
        <div className="min-h-0 overflow-y-auto rounded-md border bg-muted/30 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-1">
            <p className="text-xs text-muted-foreground">实时预览 · 样例数据，按真实纸张尺寸排版</p>
            <span className="text-[10px] text-muted-foreground">{PAPER_SPEC[draft.paper].note}</span>
          </div>
          {/* 出纸去向：热敏走小票机（ESC/POS 直连），A4 / 针式走系统打印队列——打印测试据此分流 */}
          <p className="mb-2 text-[10px] text-muted-foreground">
            {THERMAL.includes(draft.paper)
              ? printerNote
              : `${PAPER[draft.paper]}不进小票机，「打印测试」将走窗口打印预览`}
          </p>
          <PaperFrame paper={draft.paper}>
            <ReceiptDocument template={draft} context={sample} />
          </PaperFrame>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------- 单个区块编辑器 */

function SectionEditor({
  sec,
  scenario,
  index,
  total,
  onPatch,
  onMove,
  onRemove,
}: {
  sec: ReceiptSection;
  scenario: ReceiptScenario;
  index: number;
  total: number;
  onPatch: (p: Partial<ReceiptSection>) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
}) {
  const spec = SCENARIOS[scenario];

  return (
    <div className="space-y-2 border bg-muted/30 p-2">
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
        </Label>
      )}

      {sec.kind === "kv" && <KvPicker sec={sec} scenario={scenario} onPatch={onPatch} />}
      {sec.kind === "table" && spec.tables && (
        <TablePicker sec={sec} scenario={scenario} onPatch={onPatch} />
      )}
      {sec.kind === "sign" && <SignEditor sec={sec} onPatch={onPatch} />}
      {sec.kind === "qr" && <QrEditor sec={sec} scenario={scenario} onPatch={onPatch} />}
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
 * 二维码区块：能改的是"码画多大、要不要在旁边印一行字"，不改载荷。
 *
 * 载荷（`{{ticket_code}}`）是结算窗口扫码定位单据的唯一依据，改错一个字符的票仍然印得出来、
 * 只是永远扫不到单——这种错在票面上完全看不出来，等到客户站在窗口才发现。所以必备区块的载荷
 * 一律只读；站长自己新加的码（收款码、小程序码之类）没有这个风险，放开编辑。
 */
function QrEditor({
  sec,
  scenario,
  onPatch,
}: {
  sec: ReceiptSection;
  scenario: ReceiptScenario;
  onPatch: (p: Partial<ReceiptSection>) => void;
}) {
  const spec = SCENARIOS[scenario];
  // 本场景里能当载荷用的凭据字段（约定：key 以 _code 结尾的都是"可扫码的定位符"）
  const codeFields = spec.fields.filter((f) => f.key.endsWith("_code"));

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
            ? "流程必备件，只读：这一栏错了照样能打票，但那张票永远扫不出单号。要改码的内容请连业务一起改（src/lib/ticket-code.ts）。"
            : `本场景可用作载荷的字段：${codeFields.map((f) => `{{${f.key}}} ${f.label}`).join("　") || "（无）"}`}
        </span>
      </Label>

      <div className="grid grid-cols-2 gap-2">
        <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
          尺寸
          <Choose
            aria-label="二维码尺寸"
            size="sm"
            value={String(sec.qrScale ?? 2)}
            onChange={(v) => onPatch({ qrScale: Number(v) as 1 | 2 | 3 })}
            options={[
              { value: "1", label: "小（0.35mm/点，约 13mm 见方）" },
              { value: "2", label: "中（0.5mm/点，约 19mm 见方）" },
              { value: "3", label: "大（0.7mm/点，约 26mm 见方）" },
            ]}
          />
        </Label>
        <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
          码下方印单号
          <span className="flex h-8 items-center gap-2">
            <Switch checked={sec.qrCaption === true} onCheckedChange={(v) => onPatch({ qrCaption: v })} />
            <span className="text-xs">{sec.qrCaption ? "印（晒白了还能手输）" : "不印"}</span>
          </span>
        </Label>
      </div>
      <p className="text-[10px] text-muted-foreground">
        「中」这一档和热敏机自己画的尺寸是同一种物理大小（203dpi、4 点/模块），所以 A4 预览里看着多大、纸上就多大。
        尺寸只影响 A4 与屏幕预览；热敏纸上的码由机器排点，改的是 ESC/POS 的 size 指令，不在这张模板里。
      </p>
    </div>
  );
}

/** 字段区：按分组列出全部可选数据，勾选即加入票面 */
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
  const order = new Map(spec.fields.map((f, i) => [f.key, i]));
  const sortedSelected = [...selected].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  function toggle(key: string, on: boolean) {
    const next = on ? [...selected, key] : selected.filter((k) => k !== key);
    onPatch({ fields: next });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">已选 {selected.length} 项</span>
        {selected.length > 0 && (
          <Button size="xs" variant="ghost" onClick={() => onPatch({ fields: [] })}>
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
      {sortedSelected.length > 0 && (
        <p className="text-[10px] text-muted-foreground">票面顺序：{sortedSelected.map((k) => spec.fields.find((f) => f.key === k)?.label ?? k).join(" · ")}</p>
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
