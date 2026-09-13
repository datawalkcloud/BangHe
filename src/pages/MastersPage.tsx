/**
 * 基础档案（05 §3 `/masters/$section`）。
 *
 * 四个分区共用一个页面壳，切片的导航在标题下方，链接可直接贴给同事。
 * 之所以不做成四个路由文件：它们的骨架（列表 + 抽屉表单 + 权限闸门）完全同构，
 * 分开四份只会让"改一处交互要改四个文件"。
 *
 * 「员工与岗位」不在这里：它是账号与权限的档案，改动会直接影响谁能登录、谁可见什么，
 * 与操作审计、登录与权限属同一件事，因此挪到 `/system/staff` 与它们并列。
 * 本页只剩下与业务作业直接相关的品种、仓房、价目、参数——这些改了只影响磅单怎么打。
 *
 * 权限：档案写入一律要 `setting.write` 或 `price.edit`，
 * 页面上的表现是按钮 disabled + 旁边一句话说明当前岗位为什么不能改，
 * 而不是点了才报错——磅房没时间读弹窗（05 §6.1）。
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link, Navigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LockIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { AppSetting, GrainVariety, PriceList, Warehouse } from "@/mock/types";
import type { Grade } from "@/lib/constants";
import { GRADES, INDICATORS } from "@/lib/constants";
import { density, fromPercent, fromYuanPerKg, percent, price as fmtPrice, priceNumber, toYuanPerKg, todayISO, weight } from "@/lib/format";
import { needsPrintVerify, verifyReceiptPrinter, type PrintVerify } from "@/lib/print-guard";
import { SETTINGS_GROUP } from "@/lib/settings-catalog";
import { useStaff, useVarieties, useWarehouses, usePrices, useSettings } from "@/hooks/useLookups";
import { actorId, useActor, useSession } from "@/store/session";
import { Choose } from "@/components/business/Choose";
import { DataTable, type Column } from "@/components/business/DataTable";
import { ToneBadge } from "@/components/business/badges";
import { WeightField } from "@/components/business/NumField";
import { CallOut, EmptyState, InfoGrid, PageHeader, SectionBar } from "@/components/business/layout";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { digitKeys, KeypadInput } from "@/components/ui/keypad";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export type MastersSection = "varieties" | "warehouses" | "prices" | "settings";

const SECTIONS: { key: MastersSection; label: string }[] = [
  { key: "varieties", label: "品种与指标" },
  { key: "warehouses", label: "仓房与货位" },
  { key: "prices", label: "收购价目表" },
  { key: "settings", label: "站点参数" },
];

export function MastersPage({ section }: { section: MastersSection }) {
  const current = SECTIONS.find((s) => s.key === section);
  // 分区名打错（比如 /masters/price 少了个 s）不能白屏，也不能页头说 A、正文演 B：
  // 直接重定向到真实分区，让地址栏、页头、正文三者一致
  if (!current) return <Navigate to="/masters/$section" params={{ section: SECTIONS[0].key }} replace />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="基础档案"
        description={`当前分区：${current.label}`}
        tabs={
          <nav className="flex flex-wrap gap-1 pb-1 text-sm">
            {SECTIONS.map((s) => (
              <Link
                key={s.key}
                to="/masters/$section"
                params={{ section: s.key }}
                className={
                  s.key === section
                    ? "border border-b-background bg-background px-2.5 py-1 font-medium"
                    : "border border-transparent px-2.5 py-1 text-muted-foreground hover:text-foreground"
                }
              >
                {s.label}
              </Link>
            ))}
          </nav>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {section === "varieties" && <VarietiesSection />}
        {section === "warehouses" && <WarehousesSection />}
        {section === "prices" && <PricesSection />}
        {section === "settings" && <SettingsSection />}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 品种 */

/** 品种的国标基准以 0.01% 存，表单里一律用「%」文本，提交时才换算 */
interface VarietyForm {
  id: number | null;
  code: string;
  name: string;
  category: string;
  moisture: string;
  impurity: string;
  unsound: string;
  bulkDensity: string;
  rejectMoisture: string;
  package01kg: number | null;
  indicators: string[];
  sortOrder: string;
  active: boolean;
}

function varietyForm(v?: GrainVariety): VarietyForm {
  // 空表单不再预填基准值：以前只是演示数据无所谓，现在点保存是真落库的，
  // 一套编出来的"国标限量"进了档案就会出现在化验提示和定级参考里。
  if (!v)
    return {
      id: null,
      code: "",
      name: "",
      category: "主粮",
      moisture: "",
      impurity: "",
      unsound: "",
      bulkDensity: "",
      rejectMoisture: "",
      package01kg: 0,
      indicators: ["moisture", "impurity"],
      sortOrder: "",
      active: true,
    };
  return {
    id: v.id,
    code: v.code,
    name: v.name,
    category: v.category,
    // NULL 回填成空串而不是 0：打开编辑框就该看得出"这项还没定"
    moisture: pctText(v.std_moisture_001pct),
    impurity: pctText(v.std_impurity_001pct),
    unsound: pctText(v.std_unsound_001pct),
    bulkDensity: v.std_bulk_density == null ? "" : String(v.std_bulk_density),
    rejectMoisture: pctText(v.reject_moisture_001pct),
    package01kg: v.default_package_deduct_01kg,
    indicators: v.enabled_indicators.slice(),
    sortOrder: String(v.sort_order),
    active: v.is_active === 1,
  };
}

/** 0.01% 存、% 录：NULL ↔ 空串，两边都只在这一处换算 */
function pctText(v001pct: number | null): string {
  return v001pct == null ? "" : String(v001pct / 100);
}

/** 空串和 0 一律按"没填"落 NULL——0.00% 的水分基准不是国标，是占位符 */
function pctOrNull(text: string): number | null {
  return fromPercent(text) || null;
}

function VarietiesSection() {
  const { data: rows = [] } = useVarieties();
  const queryClient = useQueryClient();
  const can = useSession((s) => s.can);
  const editable = can("setting.write");

  const [open, setOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<GrainVariety | null>(null);
  const [form, setForm] = useState<VarietyForm>(() => varietyForm());
  const patch = (p: Partial<VarietyForm>) => setForm((f) => ({ ...f, ...p }));

  const save = useMutation({
    mutationFn: () =>
      api.saveVariety({
        id: form.id ?? undefined,
        operator_id: actorId(),
        code: form.code.trim().toUpperCase(),
        name: form.name.trim(),
        category: form.category.trim(),
        std_moisture_001pct: pctOrNull(form.moisture),
        std_impurity_001pct: pctOrNull(form.impurity),
        std_unsound_001pct: pctOrNull(form.unsound),
        std_bulk_density: Number(form.bulkDensity) || null,
        reject_moisture_001pct: pctOrNull(form.rejectMoisture),
        default_package_deduct_01kg: form.package01kg ?? 0,
        enabled_indicators: form.indicators,
        sort_order: Number(form.sortOrder) || rows.length + 1,
        is_active: form.active ? 1 : 0,
      }),
    onSuccess: (v) => {
      toast.success(`品种「${v.name}」已保存`);
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["varieties"] });
      void queryClient.invalidateQueries({ queryKey: ["audits"] });
    },
    onError: (e: Error) => toast.error(`保存失败：${e.message}`),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.deleteVariety({ id, operator_id: actorId() }),
    onSuccess: (v) => {
      toast.success(`已删除品种「${v.name}」`);
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ["varieties"] });
      void queryClient.invalidateQueries({ queryKey: ["audits"] });
    },
    onError: (e: Error) => toast.error(`删除失败：${e.message}`),
  });

  const columns: Column<GrainVariety>[] = [
    { key: "code", header: "编码", cell: (v) => <span className="tnum font-medium">{v.code}</span>, sortValue: (v) => v.code },
    {
      key: "name",
      header: "名称",
      cell: (v) => (
        <span className="flex items-center gap-1.5">
          <span>{v.name}</span>
          {v.is_active === 0 && <ToneBadge tone="neutral">停用</ToneBadge>}
        </span>
      ),
      sortValue: (v) => v.name,
    },
    { key: "category", header: "类别", cell: (v) => v.category },
    { key: "m", header: "水分基准", align: "right", cell: (v) => <span className="tnum">{percent(v.std_moisture_001pct)}</span> },
    { key: "i", header: "杂质基准", align: "right", cell: (v) => <span className="tnum">{percent(v.std_impurity_001pct)}</span> },
    { key: "u", header: "不完善粒", align: "right", cell: (v) => <span className="tnum">{percent(v.std_unsound_001pct)}</span> },
    { key: "d", header: "容重基准", align: "right", cell: (v) => <span className="tnum">{density(v.std_bulk_density)}</span> },
    { key: "r", header: "拒收水分", align: "right", cell: (v) => <span className="tnum text-destructive">{percent(v.reject_moisture_001pct)}</span> },
    { key: "pk", header: "默认扣包", align: "right", cell: (v) => <span className="tnum">{weight(v.default_package_deduct_01kg)}</span> },
    {
      key: "ind",
      header: "检测项目",
      cell: (v) => <span className="text-xs text-muted-foreground">{v.enabled_indicators.map((c) => INDICATORS[c]?.name ?? c).join("、")}</span>,
    },
    { key: "sort", header: "排序", align: "right", cell: (v) => <span className="tnum">{v.sort_order}</span>, sortValue: (v) => v.sort_order },
    {
      key: "op",
      header: "操作",
      cell: (v) => (
        <span className="flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={!editable}
            onClick={(e) => {
              e.stopPropagation();
              setForm(varietyForm(v));
              setOpen(true);
            }}
          >
            编辑
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={!editable}
            onClick={(e) => {
              e.stopPropagation();
              setPendingDelete(v);
            }}
          >
            <Trash2Icon /> 删除
          </Button>
        </span>
      ),
    },
  ];

  const errors: string[] = [];
  if (!form.code.trim()) errors.push("编码必填，建议 2 位大写字母");
  if (!form.name.trim()) errors.push("名称必填");
  if (form.indicators.length === 0) errors.push("至少勾选一个检测项目");

  return (
    <div className="flex flex-col gap-3">
      <SectionBar
        note="基准值只用于化验超标提示与定级参考，不参与自动扣量——计价引擎首版不做（02 §F4.4）。"
        action={
          <Button
            size="sm"
            disabled={!editable}
            onClick={() => {
              setForm(varietyForm());
              setOpen(true);
            }}
          >
            {editable ? <PlusIcon /> : <LockIcon />}
            新增品种
          </Button>
        }
      />
      <DataTable columns={columns} rows={rows} rowKey={(v) => v.id} empty={<EmptyState title="还没有品种" description="先建品种才能制单。" />} />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[640px]">
          <DialogHeader>
            <DialogTitle className="text-sm">{form.id == null ? "新增品种" : `编辑品种 ${form.name}`}</DialogTitle>
            <DialogDescription className="text-xs">
              停用品种不影响历史磅单，只挡住新单。国标基准留空即"本站尚未核定"，不会写 0 进库。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="品种编码 *">
              <Input value={form.code} onChange={(e) => patch({ code: e.target.value })} placeholder="如 XM" className="tnum text-sm" />
            </Field>
            <Field label="品种名称 *">
              <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} className="text-sm" />
            </Field>
            <Field label="类别">
              <Input value={form.category} onChange={(e) => patch({ category: e.target.value })} className="text-sm" />
            </Field>
            <DecimalField label="排序号" value={form.sortOrder} onChange={(v) => patch({ sortOrder: v })} />
            <DecimalField label="水分基准（%）" decimal value={form.moisture} onChange={(v) => patch({ moisture: v })} />
            <DecimalField label="拒收水分（%）" decimal value={form.rejectMoisture} onChange={(v) => patch({ rejectMoisture: v })} />
            <DecimalField label="杂质基准（%）" decimal value={form.impurity} onChange={(v) => patch({ impurity: v })} />
            <DecimalField label="不完善粒（%）" decimal value={form.unsound} onChange={(v) => patch({ unsound: v })} />
            <DecimalField label="容重基准（g/L）" value={form.bulkDensity} onChange={(v) => patch({ bulkDensity: v })} />
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">默认扣包</span>
              <WeightField label="" value01kg={form.package01kg} onChange={(v) => patch({ package01kg: v })} hint="每车固定皮扣" />
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-xs text-muted-foreground">检测项目（决定化验面板显示哪些指标）</span>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {Object.values(INDICATORS).map((m) => (
                  <Label key={m.code} className="flex items-center gap-1.5 text-xs">
                    <Checkbox
                      checked={form.indicators.includes(m.code)}
                      aria-label={m.name}
                      onCheckedChange={(c) =>
                        patch({
                          indicators:
                            c === true ? [...form.indicators, m.code] : form.indicators.filter((x) => x !== m.code),
                        })
                      }
                    />
                    {m.name}
                  </Label>
                ))}
              </div>
            </div>
            <Label className="flex items-center gap-2 text-xs text-muted-foreground sm:col-span-2">
              <Switch checked={form.active} onCheckedChange={(v) => patch({ active: v === true })} aria-label="启用品种" />
              启用（停用后不可再用此品种制单）
            </Label>
          </div>
          {errors.length > 0 && (
            <CallOut tone="warning" title="还不能保存">
              <ul className="list-disc pl-4">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </CallOut>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={errors.length > 0 || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(v) => {
          if (!v) setPendingDelete(null);
        }}
      >
        <DialogContent className="max-w-[460px]">
          <DialogHeader>
            <DialogTitle className="text-sm">删除品种</DialogTitle>
            <DialogDescription className="text-xs">
              将彻底移除
              {pendingDelete ? <span className="font-medium"> {pendingDelete.name} · {pendingDelete.code}</span> : null}
              。已被价目表或历史磅单引用过的品种不可删除，只能「停用」（在编辑里关掉启用，留档保追溯）。此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={del.isPending}
              onClick={() => pendingDelete && del.mutate(pendingDelete.id)}
            >
              {del.isPending ? "删除中…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------------------------------------------------------------- 仓房 */

/** 与 Rust 侧 `WarehouseKind::VALUES`（domain/enums.rs §9.9）逐字一致 */
const WAREHOUSE_KINDS = [
  { value: "house", label: "库房" },
  { value: "barn", label: "仓棚" },
  { value: "shed", label: "简易罩棚" },
  { value: "silo", label: "立筒仓" },
];

/** 读回来的类型可能为空（建仓房时没填）或不在值域内（将来扩了枚举），都不能崩 */
function kindLabel(kind: string | null): string {
  if (kind == null) return "—";
  return WAREHOUSE_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

interface WarehouseForm {
  id: number | null;
  code: string;
  name: string;
  kind: string;
  capacity: string;
  active: boolean;
}

interface SlotForm {
  id: number | null;
  warehouse_id: number;
  warehouseName: string;
  code: string;
  label: string;
  active: boolean;
}

function WarehousesSection() {
  const { data: rows = [] } = useWarehouses();
  const queryClient = useQueryClient();
  const can = useSession((s) => s.can);
  const editable = can("setting.write");

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<WarehouseForm | null>(null);
  const [slotOpen, setSlotOpen] = useState(false);
  const [slotForm, setSlotForm] = useState<SlotForm | null>(null);

  /** 仓房/货位两张表被工作台的去向下拉、库存占用一起读，保存后要一并失效 */
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["warehouses"] });
    void queryClient.invalidateQueries({ queryKey: ["slots"] });
    void queryClient.invalidateQueries({ queryKey: ["audits"] });
  };

  const saveWarehouse = useMutation({
    mutationFn: () =>
      api.saveWarehouse({
        id: form?.id ?? undefined,
        operator_id: actorId(),
        code: (form?.code ?? "").trim().toUpperCase(),
        name: (form?.name ?? "").trim(),
        kind: form?.kind ?? "house",
        // 空着是"容量尚未核定"（NULL），填 0 是一句"这处不许存粮"，两者不能混
        capacity_ton: Number(form?.capacity) || null,
        is_active: form?.active ? 1 : 0,
      }),
    onSuccess: (w) => {
      toast.success(`仓房「${w.name}」已保存`);
      setOpen(false);
      refresh();
    },
    onError: (e: Error) => toast.error(`保存失败：${e.message}`),
  });

  const saveSlot = useMutation({
    mutationFn: () =>
      api.saveSlot({
        id: slotForm?.id ?? undefined,
        operator_id: actorId(),
        warehouse_id: slotForm?.warehouse_id ?? 0,
        code: (slotForm?.code ?? "").trim().toUpperCase(),
        label: (slotForm?.label ?? "").trim(),
        is_active: slotForm?.active ? 1 : 0,
      }),
    onSuccess: (s) => {
      toast.success(`货位「${s.label || s.code}」已保存`);
      setSlotOpen(false);
      refresh();
    },
    onError: (e: Error) => toast.error(`保存失败：${e.message}`),
  });

  const columns: Column<Warehouse>[] = [
    { key: "code", header: "编码", cell: (w) => <span className="tnum font-medium">{w.code}</span>, sortValue: (w) => w.code },
    {
      key: "name",
      header: "名称",
      cell: (w) => (
        <span className="flex items-center gap-1.5">
          {w.name}
          {w.is_active === 0 && <ToneBadge tone="neutral">停用</ToneBadge>}
        </span>
      ),
      sortValue: (w) => w.name,
    },
    { key: "kind", header: "类型", cell: (w) => kindLabel(w.kind) },
    {
      key: "cap",
      header: "容量",
      align: "right",
      cell: (w) => <span className="tnum">{w.capacity_ton == null ? "—" : `${w.capacity_ton} 吨`}</span>,
      sortValue: (w) => w.capacity_ton ?? 0,
    },
    { key: "slots", header: "货位数", align: "right", cell: (w) => <span className="tnum">{w.slots.length}</span> },
    {
      key: "slotList",
      header: "货位",
      cell: (w) =>
        w.slots.length === 0 ? (
          <span className="text-xs text-muted-foreground">尚无货位</span>
        ) : (
          <span className="flex flex-wrap items-center gap-1">
            {w.slots.map((s) => (
              <Button
                key={s.id}
                type="button"
                variant="outline"
                size="xs"
                disabled={!editable}
                title={editable ? "点击改名或停用" : undefined}
                className={
                  s.is_active === 1
                    ? "h-auto rounded-none bg-muted/40 px-1.5 py-0.5 text-xs hover:bg-muted"
                    : "h-auto rounded-none border-dashed px-1.5 py-0.5 text-xs text-muted-foreground line-through"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  setSlotForm({
                    id: s.id,
                    warehouse_id: w.id,
                    warehouseName: w.name,
                    code: s.code,
                    label: s.label,
                    active: s.is_active === 1,
                  });
                  setSlotOpen(true);
                }}
              >
                {s.label || s.code}
              </Button>
            ))}
          </span>
        ),
    },
    {
      key: "op",
      header: "操作",
      cell: (w) => (
        <span className="flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={!editable}
            onClick={(e) => {
              e.stopPropagation();
              setForm({
                id: w.id,
                code: w.code,
                name: w.name,
                kind: w.kind ?? "house",
                capacity: w.capacity_ton == null ? "" : String(w.capacity_ton),
                active: w.is_active === 1,
              });
              setOpen(true);
            }}
          >
            编辑
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!editable}
            onClick={(e) => {
              e.stopPropagation();
              setSlotForm({ id: null, warehouse_id: w.id, warehouseName: w.name, code: "", label: "", active: true });
              setSlotOpen(true);
            }}
          >
            加货位
          </Button>
        </span>
      ),
    },
  ];

  const whErrors: string[] = [];
  if (form && !form.code.trim()) whErrors.push("编码必填，如 CW01");
  if (form && !form.name.trim()) whErrors.push("名称必填");
  const slotErrors: string[] = [];
  if (slotForm && !slotForm.code.trim()) slotErrors.push("货位编码必填，如 C01-01");

  return (
    <div className="flex flex-col gap-3">
      <SectionBar
        note="仓房与货位是磅单「入仓去向」的备选项：多数站点制单时不登记，留空照样取号制单；只有要按去向统计的站点才需要维护到位。停用只挡住新单，历史磅单上的货位照旧可查。"
        action={
          <Button
            size="sm"
            disabled={!editable}
            onClick={() => {
              setForm({ id: null, code: "", name: "", kind: "house", capacity: "", active: true });
              setOpen(true);
            }}
          >
            {editable ? <PlusIcon /> : <LockIcon />}
            新增仓房
          </Button>
        }
      />
      {!editable && (
        <CallOut tone="neutral" title="当前岗位只能查看">
          仓房、货位的增改属基础档案写入，需站长岗位（02 §11 权限矩阵）。
        </CallOut>
      )}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(w) => w.id}
        empty={
          <EmptyState
            title="还没有仓房档案"
            description={editable ? "点右上「新增仓房」建第一处，再给它加货位；建完即时落库。" : "请以站长身份登录后维护仓房与货位。"}
          />
        }
      />
      <InfoGrid
        cols={4}
        items={[
          { label: "仓房总数", value: String(rows.length) },
          { label: "启用", value: String(rows.filter((w) => w.is_active === 1).length) },
          { label: "货位总数", value: String(rows.reduce((n, w) => n + w.slots.length, 0)) },
          { label: "核定总容量", value: `${rows.reduce((n, w) => n + (w.capacity_ton ?? 0), 0)} 吨` },
        ]}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="text-sm">{form?.id == null ? "新增仓房" : `编辑仓房 ${form?.name}`}</DialogTitle>
            <DialogDescription className="text-xs">容量留空表示尚未核定；容量 0 表示该处不允许存粮。</DialogDescription>
          </DialogHeader>
          {form && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="仓房编码 *">
                <Input
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  placeholder="如 CW01"
                  className="tnum text-sm"
                />
              </Field>
              <Field label="仓房名称 *">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="text-sm" />
              </Field>
              <Field label="类型">
                <Choose
                  aria-label="仓房类型"
                  value={form.kind}
                  onChange={(v) => setForm({ ...form, kind: v })}
                  options={WAREHOUSE_KINDS}
                />
              </Field>
              <DecimalField label="核定容量（吨）" decimal maxLength={10} value={form.capacity} onChange={(v) => setForm({ ...form, capacity: v })} placeholder="留空＝尚未核定" />
              <Label className="flex items-center gap-2 text-xs text-muted-foreground sm:col-span-2">
                <Switch checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v === true })} aria-label="启用仓房" />
                启用（停用后不可再作为新单去向）
              </Label>
            </div>
          )}
          {whErrors.length > 0 && (
            <CallOut tone="warning" title="还不能保存">
              <ul className="list-disc pl-4">
                {whErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </CallOut>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={whErrors.length > 0 || saveWarehouse.isPending} onClick={() => saveWarehouse.mutate()}>
              {saveWarehouse.isPending ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={slotOpen} onOpenChange={setSlotOpen}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {slotForm?.id == null ? `新增货位 · ${slotForm?.warehouseName}` : `编辑货位 ${slotForm?.code}`}
            </DialogTitle>
            <DialogDescription className="text-xs">货位编码在同一仓房内唯一；简称用于磅单与看板显示，留空则用编码。</DialogDescription>
          </DialogHeader>
          {slotForm && (
            <div className="grid gap-3">
              <Field label="所属仓房">
                <Input value={slotForm.warehouseName} readOnly className="text-sm" />
              </Field>
              <Field label="货位编码 *">
                <Input
                  value={slotForm.code}
                  onChange={(e) => setSlotForm({ ...slotForm, code: e.target.value })}
                  placeholder="如 C01-01"
                  className="tnum text-sm"
                />
              </Field>
              <Field label="货位简称">
                <Input
                  value={slotForm.label}
                  onChange={(e) => setSlotForm({ ...slotForm, label: e.target.value })}
                  placeholder="如 1号仓东列"
                  className="text-sm"
                />
              </Field>
              <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch
                  checked={slotForm.active}
                  onCheckedChange={(v) => setSlotForm({ ...slotForm, active: v === true })}
                  aria-label="启用货位"
                />
                启用
              </Label>
            </div>
          )}
          {slotErrors.length > 0 && (
            <CallOut tone="warning" title="还不能保存">
              <ul className="list-disc pl-4">
                {slotErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </CallOut>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSlotOpen(false)}>
              取消
            </Button>
            <Button disabled={slotErrors.length > 0 || saveSlot.isPending} onClick={() => saveSlot.mutate()}>
              {saveSlot.isPending ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------------------------------------------------------------- 价目 */

interface PriceForm {
  id: number | null;
  varietyId: string;
  grade: Grade;
  yuanPerKg: string;
  from: string;
  to: string;
  remark: string;
}

function PricesSection() {
  const { data: rows = [] } = usePrices();
  const { data: varieties = [] } = useVarieties();
  const { data: staff = [] } = useStaff();
  const queryClient = useQueryClient();
  const actor = useActor();
  const can = useSession((s) => s.can);
  const editable = can("price.edit");
  // 用 todayISO 而不是 toISOString().slice(0,10)：后者在 UTC+8 的早上八点前会返回昨天，“当前生效”就判错了
  const today = todayISO();

  /** 价目只存 user_account.id（§9.10）。查不到名字说明账号已删，退回显示 id */
  const staffName = (id: number | null) => (id == null ? "—" : staff.find((u) => u.id === id)?.display_name ?? `#${id}`);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PriceForm>(() => emptyPrice());
  const patch = (p: Partial<PriceForm>) => setForm((f) => ({ ...f, ...p }));

  function emptyPrice(): PriceForm {
    return {
      id: null,
      varietyId: "",
      grade: "二等",
      yuanPerKg: "",
      from: today,
      to: `${today.slice(0, 4)}-12-31`,
      remark: "",
    };
  }

  const save = useMutation({
    mutationFn: () =>
      api.savePrice({
        id: form.id ?? undefined,
        operator_id: actorId(),
        variety_id: Number(form.varietyId),
        grade: form.grade,
        price_fen_per_ton: fromYuanPerKg(form.yuanPerKg),
        effective_from: form.from,
        effective_to: form.to,
        basis: "",
        remark: form.remark.trim() || null,
      }),
    onSuccess: (p) => {
      const v = varieties.find((x) => x.id === p.variety_id);
      toast.success(`已发布新价目：${v?.name ?? `#${p.variety_id}`} ${p.grade} ${fmtPrice(p.price_fen_per_ton)}`);
      setOpen(false);
      setForm(emptyPrice());
      void queryClient.invalidateQueries({ queryKey: ["prices"] });
      void queryClient.invalidateQueries({ queryKey: ["audits"] });
    },
    onError: (e: Error) => toast.error(`保存失败：${e.message}`),
  });

  const errors: string[] = [];
  if (!form.varietyId) errors.push("请选择品种");
  if (!(Number(form.yuanPerKg) > 0)) errors.push("单价必须是大于 0 的元/公斤");
  if (form.from > form.to) errors.push("生效起始日不能晚于截止日");

  const columns: Column<PriceList>[] = [
    {
      key: "variety",
      header: "品种",
      cell: (p) => varieties.find((v) => v.id === p.variety_id)?.name ?? `#${p.variety_id}`,
      sortValue: (p) => String(p.variety_id),
    },
    { key: "grade", header: "等级", cell: (p) => p.grade, sortValue: (p) => p.grade },
    {
      key: "price",
      header: "单价（元/公斤）",
      align: "right",
      cell: (p) => <span className="tnum">{priceNumber(p.price_fen_per_ton)}</span>,
      sortValue: (p) => p.price_fen_per_ton,
    },
    {
      key: "period",
      header: "生效期间",
      cell: (p) => (
        <span className="tnum text-xs">
          {p.effective_from} ~ {p.effective_to}
        </span>
      ),
    },
    {
      key: "live",
      header: "当前生效",
      cell: (p) => (today >= p.effective_from && today <= p.effective_to ? <ToneBadge tone="success">生效中</ToneBadge> : <span className="text-xs text-muted-foreground">—</span>),
    },
    { key: "made", header: "制单", cell: (p) => <span className="text-xs">{staffName(p.made_by)}</span> },
    { key: "approved", header: "审批", cell: (p) => <span className="text-xs">{staffName(p.approved_by)}</span> },
    {
      key: "op",
      header: "操作",
      cell: (p) => (
        <Button
          size="xs"
          variant="ghost"
          disabled={!editable}
          onClick={(e) => {
            e.stopPropagation();
            setForm({
              id: p.id,
              varietyId: String(p.variety_id),
              grade: p.grade,
              yuanPerKg: String(toYuanPerKg(p.price_fen_per_ton)),
              from: p.effective_from,
              to: p.effective_to,
              remark: p.remark ?? "",
            });
            setOpen(true);
          }}
        >
          修改
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <SectionBar
        note="调价只追加新行，不改已生效过的历史价：历史价是已结算磅单的计算依据，改了等于伪造账目（01 §F2.3）。"
        action={
          <Button size="sm" disabled={!editable} onClick={() => { setForm(emptyPrice()); setOpen(true); }}>
            {editable ? <PlusIcon /> : <LockIcon />}
            发布新价目
          </Button>
        }
      />
      {!editable && (
        <CallOut tone="neutral" title="当前岗位不能调价">
          调价权限只给站长（`price.edit`）。你现在是 {actor ? actor.role : "—"}，只能查看。
        </CallOut>
      )}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(p) => p.id}
        defaultPageSize={100}
        rowClassName={(p) => (today >= p.effective_from && today <= p.effective_to ? undefined : "text-muted-foreground")}
        empty={<EmptyState title="还没有价目" description="没有价目时工作台只能手工定价，且必须填写改价事由。" />}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="text-sm">{form.id == null ? "发布新价目" : "修改价目"}</DialogTitle>
            <DialogDescription className="text-xs">
              单价按「元/公斤」录入，最多三位小数。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              品种 *
              <Choose
                aria-label="品种"
                value={form.varietyId}
                onChange={(v) => patch({ varietyId: v })}
                options={[{ value: "", label: "请选择…" }, ...varieties.map((v) => ({ value: String(v.id), label: `${v.name}（${v.code}）` }))]}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              等级
              <Choose
                aria-label="等级"
                value={form.grade}
                onChange={(v) => patch({ grade: v as Grade })}
                options={GRADES.map((g) => ({ value: g, label: g }))}
              />
            </Label>
            <DecimalField label="单价（元/公斤）*" decimal maxLength={10} value={form.yuanPerKg} onChange={(v) => patch({ yuanPerKg: v })} placeholder="如 2.680" />
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
              有效期
              <DateRangePicker
                value={{ from: form.from, to: form.to }}
                onChange={(f, t) => patch({ from: f, to: t })}
                presets={false}
                className="w-full tnum"
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
              备注
              <Input value={form.remark} onChange={(e) => patch({ remark: e.target.value })} className="text-sm" />
            </Label>
          </div>
          {errors.length > 0 && (
            <CallOut tone="warning" title="还不能保存">
              <ul className="list-disc pl-4">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </CallOut>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={errors.length > 0 || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "保存中…" : "发布"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------------------------------------------------------------- 参数 */

function SettingsSection() {
  const { data: rows = [] } = useSettings();
  const can = useSession((s) => s.can);
  const queryClient = useQueryClient();
  const editable = can("setting.write");

  const groups = useMemo(() => {
    const map = new Map<AppSetting["group"], AppSetting[]>();
    for (const s of rows) map.set(s.group, [...(map.get(s.group) ?? []), s]);
    return Array.from(map.entries());
  }, [rows]);

  const save = useMutation<{ rows: unknown; verify: PrintVerify | null }, Error, { key: string; value: string }>({
    mutationFn: async (v) => {
      // 只有"会把单据打到热敏机"的选项需要验一次，改联数这种不必拿设备状态卡用户
      const verify = needsPrintVerify(v.key, v.value) ? await verifyReceiptPrinter() : null;
      const rows = await api.saveSetting(v.key, v.value, actorId(), verify);
      return { rows, verify };
    },
    onSuccess: ({ verify }, v) => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["audits"] });
      if (verify?.mode === "none") {
        toast.warning(`${v.key} 已保存，但${verify.message}`);
      } else if (verify) {
        toast.success(`${v.key} 已保存（联机测试通过：${verify.message}）`);
      }
    },
    // 门禁拒绝时必须把原因原样递到眼前，只说"保存失败"会让人以为软件坏了
    onError: (e: Error) => toast.error(e.message),
  });

  if (!editable) {
    return (
      <CallOut tone="neutral" title="站点参数只读">
        参数写入需要站长岗位（`setting.write`）。改动会立刻影响正在进行的过磅作业，因此不允许磅员改。
      </CallOut>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionBar note="每项参数都写审计日志（改前值、改后值、谁改的），日对账异常时先回来看这里。" />
      {groups.map(([group, items]) => (
        <section key={group} className="border bg-card">
          <header className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">{SETTINGS_GROUP[group]}</span>
            <span className="text-xs text-muted-foreground">{items.length} 项</span>
          </header>
          <ul className="divide-y">
            {items.map((s) => (
              <SettingRow key={s.key} s={s} onSave={(v) => save.mutate({ key: s.key, value: v })} busy={save.isPending} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SettingRow({ s, onSave, busy }: { s: AppSetting; onSave: (value: string) => void; busy: boolean }) {
  const [draft, setDraft] = useState(s.value);
  const dirty = draft !== s.value;

  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <div className="min-w-[14rem] flex-1">
        <p className="text-sm">{s.label}</p>
        <p className="tnum text-[11px] text-muted-foreground">{s.key}</p>
        {s.hint && <p className="text-xs text-muted-foreground">{s.hint}</p>}
      </div>
      <div className="flex items-center gap-2">
        {s.kind === "bool" ? (
          <Switch
            checked={draft === "true" || draft === "1"}
            disabled={busy}
            aria-label={s.label}
            onCheckedChange={(v) => {
              const next = v === true ? "true" : "false";
              setDraft(next);
              onSave(next);
            }}
          />
        ) : s.kind === "select" && s.options ? (
          <Choose
            aria-label={s.label}
            className="w-44"
            value={draft}
            disabled={busy}
            onChange={(v) => {
              setDraft(v);
              onSave(v);
            }}
            options={s.options.map((o) => ({ value: o.value, label: o.label }))}
          />
        ) : s.kind === "number" ? (
          <KeypadInput
            aria-label={s.label}
            value={draft}
            onChangeValue={setDraft}
            keys={digitKeys()}
            columns={6}
            maxLength={8}
            toggleLabel="数字"
            disabled={busy}
            inputMode="numeric"
            className="w-56"
            inputClassName="tnum h-8 text-sm"
          />
        ) : (
          <Input
            value={draft}
            disabled={busy}
            aria-label={s.label}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && dirty) onSave(draft);
            }}
            className="tnum h-8 w-44 text-sm"
          />
        )}
        {dirty && (
          <Button size="xs" onClick={() => onSave(draft)} disabled={busy}>
            保存
          </Button>
        )}
      </div>
    </li>
  );
}

/* ---------------------------------------------------------------- 公共壳 */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      {children}
    </Label>
  );
}

/**
 * 配置表单里的数字项：点一下出一个数字，不必敲键盘。
 *
 * 标题走 `span` 而不套 `Field`（`<Label>`）：软键盘那颗展开按钮嵌在 label 里会被浏览器
 * 当成"点标签聚焦输入框"，反而把游标从刚点的键上抢走。控件自己带 `aria-label` 补名称。
 */
function DecimalField({
  label,
  value,
  onChange,
  decimal = false,
  maxLength = 8,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** 百分比、单价这类带小数的给 true；位数、份数、容量这类整数不给小数点键 */
  decimal?: boolean;
  maxLength?: number;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <KeypadInput
        aria-label={label}
        value={value}
        onChangeValue={onChange}
        keys={digitKeys({ decimalPoint: decimal })}
        columns={6}
        maxLength={maxLength}
        toggleLabel="数字"
        inputMode={decimal ? "decimal" : "numeric"}
        autoComplete="off"
        placeholder={placeholder}
        inputClassName="tnum text-sm"
      />
    </div>
  );
}
