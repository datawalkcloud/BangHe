/**
 * 基础档案（05 §3 `/masters/$section`）。
 *
 * 五个分区共用一个页面壳，切片的导航在标题下方，链接可直接贴给同事。
 * 之所以不做成五个路由文件：它们的骨架（列表 + 抽屉表单 + 权限闸门）完全同构，
 * 分开五份只会让"改一处交互要改五个文件"。
 *
 * 权限：档案写入一律要 `setting.write` 或 `price.edit`，
 * 页面上的表现是按钮 disabled + 旁边一句话说明当前岗位为什么不能改，
 * 而不是点了才报错——磅房没时间读弹窗（05 §6.1）。
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link, Navigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LockIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { AppSetting, GrainVariety, PriceList, UserAccount, Warehouse } from "@/mock/types";
import type { Grade, Role } from "@/lib/constants";
import { GRADES, INDICATORS, ROLE } from "@/lib/constants";
import { fromPercent, orDash, percent, price as fmtPrice, fromYuanPerTon, todayISO, weight } from "@/lib/format";
import { needsPrintVerify, verifyReceiptPrinter, type PrintVerify } from "@/lib/print-guard";
import { useStaff, useVarieties, useWarehouses, usePrices, useSettings } from "@/hooks/useLookups";
import { PERMISSIONS, actorId, useActor, useSession } from "@/store/session";
import { Choose } from "@/components/business/Choose";
import { DataTable, type Column } from "@/components/business/DataTable";
import { ToneBadge } from "@/components/business/badges";
import { WeightField } from "@/components/business/NumField";
import { CallOut, EmptyState, InfoGrid, PageHeader } from "@/components/business/layout";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export type MastersSection = "varieties" | "warehouses" | "prices" | "settings" | "staff";

const SECTIONS: { key: MastersSection; label: string }[] = [
  { key: "varieties", label: "品种与指标" },
  { key: "warehouses", label: "仓房与货位" },
  { key: "prices", label: "收购价目表" },
  { key: "settings", label: "站点参数" },
  { key: "staff", label: "员工与岗位" },
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
        {section === "staff" && <StaffSection />}
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
  if (!v)
    return {
      id: null,
      code: "",
      name: "",
      category: "小麦",
      moisture: "12.5",
      impurity: "1.0",
      unsound: "5.0",
      bulkDensity: "750",
      rejectMoisture: "18.0",
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
    moisture: String(v.std_moisture_001pct / 100),
    impurity: String(v.std_impurity_001pct / 100),
    unsound: String(v.std_unsound_001pct / 100),
    bulkDensity: String(v.std_bulk_density),
    rejectMoisture: String(v.reject_moisture_001pct / 100),
    package01kg: v.default_package_deduct_01kg,
    indicators: v.enabled_indicators.slice(),
    sortOrder: String(v.sort_order),
    active: v.is_active === 1,
  };
}

function VarietiesSection() {
  const { data: rows = [] } = useVarieties();
  const queryClient = useQueryClient();
  const can = useSession((s) => s.can);
  const editable = can("setting.write");

  const [open, setOpen] = useState(false);
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
        std_moisture_001pct: fromPercent(form.moisture),
        std_impurity_001pct: fromPercent(form.impurity),
        std_unsound_001pct: fromPercent(form.unsound),
        std_bulk_density: Number(form.bulkDensity) || 0,
        reject_moisture_001pct: fromPercent(form.rejectMoisture),
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
    { key: "d", header: "容重基准", align: "right", cell: (v) => <span className="tnum">{v.std_bulk_density} g/L</span> },
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
            <DialogDescription className="text-xs">停用品种不影响历史磅单，只挡住新单。</DialogDescription>
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
            <Field label="排序号">
              <Input value={form.sortOrder} onChange={(e) => patch({ sortOrder: e.target.value })} inputMode="numeric" className="tnum text-sm" />
            </Field>
            <Field label="水分基准（%）">
              <Input value={form.moisture} onChange={(e) => patch({ moisture: e.target.value })} inputMode="decimal" className="tnum text-sm" />
            </Field>
            <Field label="拒收水分（%）">
              <Input value={form.rejectMoisture} onChange={(e) => patch({ rejectMoisture: e.target.value })} inputMode="decimal" className="tnum text-sm" />
            </Field>
            <Field label="杂质基准（%）">
              <Input value={form.impurity} onChange={(e) => patch({ impurity: e.target.value })} inputMode="decimal" className="tnum text-sm" />
            </Field>
            <Field label="不完善粒（%）">
              <Input value={form.unsound} onChange={(e) => patch({ unsound: e.target.value })} inputMode="decimal" className="tnum text-sm" />
            </Field>
            <Field label="容重基准（g/L）">
              <Input value={form.bulkDensity} onChange={(e) => patch({ bulkDensity: e.target.value })} inputMode="numeric" className="tnum text-sm" />
            </Field>
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
    </div>
  );
}

/* ---------------------------------------------------------------- 仓房 */

const WAREHOUSE_KIND: Record<Warehouse["kind"], string> = {
  house: "库房",
  barn: "仓棚",
  shed: "简易罩棚",
  silo: "立筒仓",
};

function WarehousesSection() {
  const { data: rows = [] } = useWarehouses();

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
    { key: "kind", header: "类型", cell: (w) => WAREHOUSE_KIND[w.kind] },
    { key: "cap", header: "容量", align: "right", cell: (w) => <span className="tnum">{w.capacity_ton} 吨</span>, sortValue: (w) => w.capacity_ton },
    { key: "slots", header: "货位数", align: "right", cell: (w) => <span className="tnum">{w.slots.length}</span> },
    {
      key: "slotList",
      header: "货位",
      cell: (w) => (
        <span className="text-xs text-muted-foreground">
          {w.slots.filter((s) => s.is_active === 1).map((s) => s.label).join("、") || "无启用货位"}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <SectionBar note="仓房与货位是粮食去向的落点：一张磅单必须能回答「这批粮压在哪个货位」。" />
      <CallOut tone="info" title="本分区在当前 mock 层是只读的">
        仓房/货位的增删改涉及容量与库存占用校验，接口尚未提供（Rust 侧与 03 §5 一并实现）。
        这里先呈现结构与数量，工作台与档案页的"默认仓房"下拉读取的就是这张表。
      </CallOut>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(w) => w.id}
        empty={<EmptyState title="还没有仓房档案" description="请在 Rust 侧初始化仓房数据。" />}
      />
      <InfoGrid
        cols={4}
        items={[
          { label: "仓房总数", value: String(rows.length) },
          { label: "启用", value: String(rows.filter((w) => w.is_active === 1).length) },
          { label: "货位总数", value: String(rows.reduce((n, w) => n + w.slots.length, 0)) },
          { label: "核定总容量", value: `${rows.reduce((n, w) => n + w.capacity_ton, 0)} 吨` },
        ]}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- 价目 */

interface PriceForm {
  id: number | null;
  varietyId: string;
  grade: Grade;
  yuanPerTon: string;
  from: string;
  to: string;
  basis: string;
  remark: string;
}

function PricesSection() {
  const { data: rows = [] } = usePrices();
  const { data: varieties = [] } = useVarieties();
  const queryClient = useQueryClient();
  const actor = useActor();
  const can = useSession((s) => s.can);
  const editable = can("price.edit");
  // 用 todayISO 而不是 toISOString().slice(0,10)：后者在 UTC+8 的早上八点前会返回昨天，“当前生效”就判错了
  const today = todayISO();

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PriceForm>(() => emptyPrice());
  const patch = (p: Partial<PriceForm>) => setForm((f) => ({ ...f, ...p }));

  function emptyPrice(): PriceForm {
    return {
      id: null,
      varietyId: "",
      grade: "二等",
      yuanPerTon: "",
      from: today,
      to: `${today.slice(0, 4)}-12-31`,
      basis: "",
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
        price_fen_per_ton: fromYuanPerTon(form.yuanPerTon),
        effective_from: form.from,
        effective_to: form.to,
        basis: form.basis.trim(),
        remark: form.remark.trim() || null,
      }),
    onSuccess: (p) => {
      const v = varieties.find((x) => x.id === p.variety_id);
      toast.success(`已发布新价目：${v?.name ?? `#${p.variety_id}`} ${p.grade} ${fmtPrice(p.price_fen_per_ton).perTon}`);
      setOpen(false);
      setForm(emptyPrice());
      void queryClient.invalidateQueries({ queryKey: ["prices"] });
      void queryClient.invalidateQueries({ queryKey: ["audits"] });
    },
    onError: (e: Error) => toast.error(`保存失败：${e.message}`),
  });

  const errors: string[] = [];
  if (!form.varietyId) errors.push("请选择品种");
  if (!(Number(form.yuanPerTon) > 0)) errors.push("单价必须是大于 0 的元/吨");
  if (form.from > form.to) errors.push("生效起始日不能晚于截止日");
  if (form.basis.trim().length < 4) errors.push("定价依据必填（如「省内小麦收购指导价的公告文号」）");

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
      header: "单价",
      align: "right",
      cell: (p) => (
        <span className="tnum">
          {fmtPrice(p.price_fen_per_ton).perTon}
          <span className="ml-1 text-xs text-muted-foreground">{fmtPrice(p.price_fen_per_ton).perJin}</span>
        </span>
      ),
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
    { key: "basis", header: "定价依据", cell: (p) => <span className="block max-w-[18rem] truncate text-xs">{orDash(p.basis)}</span> },
    { key: "made", header: "制单", cell: (p) => <span className="text-xs">{`#${p.made_by}`}</span> },
    { key: "approved", header: "审批", cell: (p) => <span className="text-xs">{p.approved_by == null ? "—" : `#${p.approved_by}`}</span> },
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
              yuanPerTon: String(p.price_fen_per_ton / 100),
              from: p.effective_from,
              to: p.effective_to,
              basis: p.basis,
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
              单价单位是「分/吨」定点存储，界面上按元/吨录入并同步显示元/斤，避免口算出错。
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
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              单价（元/吨）*
              <Input value={form.yuanPerTon} onChange={(e) => patch({ yuanPerTon: e.target.value })} inputMode="decimal" className="tnum text-sm" />
              {Number(form.yuanPerTon) > 0 && (
                <span className="tnum text-xs text-muted-foreground">
                  约合 {fmtPrice(fromYuanPerTon(form.yuanPerTon)).perJin} / {fmtPrice(fromYuanPerTon(form.yuanPerTon)).perKg}
                </span>
              )}
            </Label>
            <div className="grid grid-cols-2 gap-2">
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                生效起始
                <Input type="date" value={form.from} onChange={(e) => patch({ from: e.target.value })} className="tnum text-sm" />
              </Label>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                生效截止
                <Input type="date" value={form.to} onChange={(e) => patch({ to: e.target.value })} className="tnum text-sm" />
              </Label>
            </div>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
              定价依据 *
              <Input value={form.basis} onChange={(e) => patch({ basis: e.target.value })} placeholder="文件号 / 市场报价来源" className="text-sm" />
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

const SETTING_GROUP: Record<AppSetting["group"], string> = {
  doc: "单证与编号",
  weigh: "过磅计量",
  settle: "结算与付款",
  print: "打印与联次",
  retain: "留样与数据保留",
};

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
            <span className="text-sm font-semibold">{SETTING_GROUP[group]}</span>
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

/* ---------------------------------------------------------------- 员工 */

const ROLE_LIST = Object.keys(ROLE) as Role[];

interface StaffForm {
  id: number | null;
  username: string;
  display_name: string;
  role: Role;
  phone: string;
  active: boolean;
}

function StaffSection() {
  const { data: rows = [] } = useStaff();
  const queryClient = useQueryClient();
  const actor = useActor();
  const can = useSession((s) => s.can);
  const editable = can("setting.write");

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<StaffForm>({ id: null, username: "", display_name: "", role: "weigher", phone: "", active: true });
  const patch = (p: Partial<StaffForm>) => setForm((f) => ({ ...f, ...p }));

  const save = useMutation({
    mutationFn: () =>
      api.saveStaff({
        id: form.id ?? undefined,
        operator_id: actorId(),
        username: form.username.trim(),
        display_name: form.display_name.trim(),
        role: form.role,
        phone: form.phone.trim(),
        is_active: form.active ? 1 : 0,
      }),
    onSuccess: (u) => {
      toast.success(`员工「${u.display_name}」已保存`);
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["staff"] });
      void queryClient.invalidateQueries({ queryKey: ["audits"] });
    },
    onError: (e: Error) => toast.error(`保存失败：${e.message}`),
  });

  const columns: Column<UserAccount>[] = [
    { key: "username", header: "登录名", cell: (u) => <span className="tnum">{u.username}</span>, sortValue: (u) => u.username },
    {
      key: "display_name",
      header: "姓名",
      cell: (u) => (
        <span className="flex items-center gap-1.5">
          <span className="font-medium">{u.display_name}</span>
          {actor?.id === u.id && <ToneBadge tone="info">当前值班</ToneBadge>}
        </span>
      ),
      sortValue: (u) => u.display_name,
    },
    { key: "role", header: "岗位", cell: (u) => ROLE[u.role], sortValue: (u) => u.role },
    { key: "phone", header: "电话", cell: (u) => <span className="tnum">{orDash(u.phone)}</span> },
    {
      key: "last",
      header: "最近使用",
      cell: (u) => <span className="tnum text-xs text-muted-foreground">{u.last_login_at ? u.last_login_at.slice(0, 16) : "从未"}</span>,
    },
    {
      key: "active",
      header: "状态",
      cell: (u) => (u.is_active === 1 ? <ToneBadge tone="success">在职</ToneBadge> : <ToneBadge tone="neutral">停用</ToneBadge>),
    },
    {
      key: "op",
      header: "操作",
      cell: (u) => (
        <Button
          size="xs"
          variant="ghost"
          disabled={!editable}
          onClick={(e) => {
            e.stopPropagation();
            setForm({
              id: u.id,
              username: u.username,
              display_name: u.display_name,
              role: u.role,
              phone: u.phone,
              active: u.is_active === 1,
            });
            setOpen(true);
          }}
        >
          编辑
        </Button>
      ),
    },
  ];

  const perms = Object.entries(PERMISSIONS);

  return (
    <div className="flex flex-col gap-3">
      <SectionBar
        note="身份来源已从「选择操作员」换成口令登录：制单 / 称重 / 化验 / 结算的留痕一律署名当前登录人，署名机制未变，只是拿人的入口换了。"
        action={
          <Button
            size="sm"
            disabled={!editable}
            onClick={() => {
              setForm({ id: null, username: "", display_name: "", role: "weigher", phone: "", active: true });
              setOpen(true);
            }}
          >
            {editable ? <PlusIcon /> : <LockIcon />}
            新增员工
          </Button>
        }
      />
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(u) => u.id}
        rowClassName={(u) => (u.is_active === 0 ? "text-muted-foreground" : undefined)}
        empty={<EmptyState title="还没有员工档案" description="至少要有一名站长，否则授权类操作无法完成。" />}
      />

      <section className="border bg-card">
        <header className="border-b px-3 py-2 text-sm font-semibold">
          岗位权限矩阵
          <span className="ml-2 text-xs font-normal text-muted-foreground">✔ 表示该岗位可直接执行；留空的必须站长授权</span>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-3 py-1.5 text-left font-normal">权限</th>
                {ROLE_LIST.map((r) => (
                  <th key={r} className="px-3 py-1.5 text-center font-normal">
                    {ROLE[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {perms.map(([perm, roles]) => (
                <tr key={perm} className="border-b last:border-0">
                  <td className="px-3 py-1.5 font-mono text-xs">{perm}</td>
                  {ROLE_LIST.map((r) => (
                    <td key={r} className="px-3 py-1.5 text-center">
                      {roles.includes(r) ? (
                        <span className="text-success" aria-label="允许">
                          ✔
                        </span>
                      ) : (
                        <span className="text-muted-foreground" aria-label="不允许">
                          ·
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="text-sm">{form.id == null ? "新增员工" : `编辑员工 ${form.display_name}`}</DialogTitle>
            <DialogDescription className="text-xs">登录名唯一，停用后不能再用该身份制单，但历史留痕保持不变。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Field label="登录名 *">
              <Input value={form.username} onChange={(e) => patch({ username: e.target.value })} className="tnum text-sm" disabled={form.id != null} />
            </Field>
            <Field label="姓名 *">
              <Input value={form.display_name} onChange={(e) => patch({ display_name: e.target.value })} className="text-sm" />
            </Field>
            <Field label="岗位">
              <Choose
                aria-label="岗位"
                value={form.role}
                onChange={(v) => patch({ role: v as Role })}
                options={ROLE_LIST.map((r) => ({ value: r, label: ROLE[r] }))}
              />
            </Field>
            <Field label="电话">
              <Input value={form.phone} onChange={(e) => patch({ phone: e.target.value })} className="tnum text-sm" />
            </Field>
            <Label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={form.active} onCheckedChange={(v) => patch({ active: v === true })} aria-label="在职" />
              在职
            </Label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              disabled={!form.username.trim() || !form.display_name.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------------------------------------------------------------- 公共壳 */

function SectionBar({ note, action }: { note: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="min-w-[16rem] flex-1 text-xs text-muted-foreground">{note}</p>
      {action}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      {children}
    </Label>
  );
}
