/**
 * 系统与审计（05 §3 `/system/$section`，六个分区均为 P1，先把界面立起来）。
 *
 * 分区的存在理由各不相同：
 * - users / staff：前者讲"当前登录的是谁、能做什么"，后者管"档案与岗位权限矩阵"。
 *   两块都动账号体系，必须紧挨着放，否则改一处忘了另一处就出事。
 * - audit：迎检第一张表。谁、什么时候、对哪张单、做了什么、谁授权的，五件事缺一不可；
 * - backup：把"留存年限 / 备份份数"这类硬指标做成页面可见的自查，而不是写在文档里没人看；
 * - shift：日结前得先知道还有什么没闭环，否则封账等于把窟窿埋进历史；
 * - window / appearance / templates：关窗口是退出还是藏进托盘、显示模式、配色与票据版式
 *   都是**本机**偏好（磅房里每台屏的光照不一样，每台打印机走纸也不一样），所以它们
 *   不需要站长权限，也不写审计、不进站点参数——与上面五个分区正好相反。
 *
 * 与仓房分区同样的处理：没有接口的动作一律标只读并写明原因，绝不做只弹 toast 的假按钮。
 */
import { useMemo, useState } from "react";
import { Link, Navigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, FolderOpenIcon, LockIcon, PlusIcon, PrinterIcon, ShieldAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { AuditLog, UserAccount, WeighOrder } from "@/mock/types";
import type { Role } from "@/lib/constants";
import { ROLE } from "@/lib/constants";
import { dateTime, fileSize, money, orDash, shiftDay, sinceText, todayISO, weight, varietyLabel } from "@/lib/format";
import { csvName } from "@/lib/csv";
import { exportCsvFile } from "@/lib/export-csv";
import { runningInTauri } from "@/lib/native";
import { resetPassword } from "@/lib/auth";
import { RESTORE_CONFIRM_TEXT, systemApi, type AuditRow, type BackupFile, type HealthReport, type Preflight, type RestoreResult, type VerifyReport } from "@/lib/system-native";
import { searchKeyword } from "@/lib/ticket-code";
import { SETTLEMENT_SCAN_LIMIT } from "@/lib/reports-native";
import { useHotkey } from "@/hooks/useHotkey";
import { actorId, PERMISSIONS, useActor, useSession } from "@/store/session";
import { useSetting, useStaff, useStation } from "@/hooks/useLookups";
import { StatCard, StatCardGrid } from "@/components/business/StatCard";
import { detailColumn, QuickDetailLink } from "@/components/business/quickDetail";
import { ALL, Choose } from "@/components/business/Choose";
import { IdCardText } from "@/components/business/IdCardText";
import { DataTable, type Column } from "@/components/ui/data-table";
import { OrderStatusBadge, ToneBadge } from "@/components/business/badges";
import { CallOut, EmptyState, InfoGrid, PageHeader, SectionBar, SectionTitle } from "@/components/business/layout";
import { ThemeSettingsPanel } from "@/components/business/ThemeSettingsPanel";
import { WindowBehaviorPanel } from "@/components/business/WindowBehaviorPanel";
import { SoftKeyboardPanel } from "@/components/business/SoftKeyboardPanel";
import { ReceiptTemplateEditor } from "@/components/print/receipt/TemplateEditor";
import { OperatorPanel } from "@/components/business/OperatorSwitch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "cn";
import { digitKeys, KeypadInput, type KeypadKey } from "@/components/ui/keypad";

export type SystemSection = "users" | "staff" | "audit" | "backup" | "shift" | "window" | "appearance" | "templates";

const SECTIONS: { key: SystemSection; label: string; desc: string }[] = [
  { key: "users", label: "登录与权限", desc: "当前操作员与岗位可见范围" },
  { key: "staff", label: "员工与岗位", desc: "人员档案、岗位权限矩阵（仅站长可改）" },
  { key: "audit", label: "操作审计", desc: "关键动作留痕，迎检必查" },
  { key: "backup", label: "备份与恢复", desc: "留存参数自查与体检" },
  { key: "shift", label: "日结交班", desc: "封账前的挂起清单" },
  { key: "window", label: "窗口", desc: "关闭主窗口是退出还是藏进托盘，只影响本机" },
  { key: "appearance", label: "外观与主题", desc: "显示模式与色板，只影响本机" },
  { key: "templates", label: "小票模板", desc: "各场景票据版式与可打印字段" },
];

export function SystemPage({ section }: { section: SystemSection }) {
  const current = SECTIONS.find((s) => s.key === section);
  // 同上：分区名打错就重定向，不给“页头写 A 、正文空着”的机会
  if (!current) return <Navigate to="/system/$section" params={{ section: SECTIONS[0].key }} replace />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="系统与审计"
        description={`${current.label} · ${current.desc}`}
        tabs={
          <Tabs value={section} className="gap-0">
            <TabsList className="mb-1 h-auto max-w-full flex-wrap justify-start">
              {SECTIONS.map((s) => (
                <TabsTrigger
                  key={s.key}
                  value={s.key}
                  className="flex-none text-sm"
                  nativeButton={false}
                  render={<Link to="/system/$section" params={{ section: s.key }} />}
                >
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4">
        {section === "users" && <UsersSection />}
        {section === "staff" && <StaffSection />}
        {section === "audit" && <AuditSection />}
        {section === "backup" && <BackupSection />}
        {section === "shift" && <ShiftSection />}
        {section === "window" && (
          <div className="flex flex-col gap-3">
            <WindowBehaviorPanel />
            <SoftKeyboardPanel />
          </div>
        )}
        {section === "appearance" && <ThemeSettingsPanel />}
        {section === "templates" && <ReceiptTemplateEditor />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ 登录与权限 */

/** 某个岗位能做的事，直接从 PERMISSIONS 反推，界面不再抄一份清单 */
function permissionsOf(role: Role): string[] {
  if (role === "station_master") return Object.keys(PERMISSIONS);
  return Object.entries(PERMISSIONS)
    .filter(([, roles]) => roles.includes(role))
    .map(([k]) => k);
}

function UsersSection() {
  const actor = useActor();
  // 空闲锁屏时长：桌面端以后端随会话下发的值为准（站点参数 idle_lock_minutes），
  // 浏览器演示没有真会话，直接读参数页的当前值。两条路都不在前端抄常量。
  const demo = useSession((s) => s.demo);
  const idleTtlSecs = useSession((s) => s.session?.idleTtlSecs);
  const idleSetting = useSetting("idle_lock_minutes").raw;
  const idleMinutes = demo
    ? idleSetting == null
      ? null
      : Number(idleSetting) || 0
    : idleTtlSecs == null
      ? null
      : Math.round(idleTtlSecs / 60);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid items-start gap-3 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <Card size="sm" className="gap-3 p-3">
          <OperatorPanel />
          {actor && (
            <div className="flex flex-col gap-1 text-xs">
              <p className="text-muted-foreground">
                岗位 <span className="text-foreground">{ROLE[actor.role]}</span>，可见 {permissionsOf(actor.role).length} 项写操作。
              </p>
              <p className="flex flex-wrap gap-1">
                {permissionsOf(actor.role).map((p) => (
                  <Badge key={p} variant="outline" className="h-4 font-mono text-[10px] font-normal text-muted-foreground">
                    {p}
                  </Badge>
                ))}
              </p>
            </div>
          )}
        </Card>

        <CallOut title="账号与安全">
          空闲锁屏与连错锁定在登录页提示；
          {idleMinutes == null ? null : idleMinutes === 0 ? (
            <>当前设为「从不」，只能手动锁屏；</>
          ) : (
            <>
              无操作<span className="tnum"> {idleMinutes} </span>分钟后自动锁屏，输本人密码即解锁；
            </>
          )}
          关闭程序后需重新登录。新增账号、调整岗位与权限矩阵在
          <Link to="/system/$section" params={{ section: "staff" }} className="underline">
            {" "}
            系统与审计 → 员工与岗位
          </Link>
          （仅站长）。浏览器预览为演示模式：只认在职名单，不校验密码。
        </CallOut>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- 员工与岗位 */

const ROLE_LIST = Object.keys(ROLE) as Role[];

/** 岗位权限矩阵的紧凑排版：shadcn Table 默认 h-12 表头 / p-3 单元格会把矩阵撑得过高，
 *  这里用后代选择器压回 px-3 / py-1.5，特异性高于组件内置类，能稳定覆盖。 */
const PERM_TABLE =
  "border-collapse text-sm [&_th]:h-auto [&_th]:px-3 [&_th]:py-1.5 [&_th]:font-normal [&_th]:text-inherit [&_td]:px-3 [&_td]:py-1.5";

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
  // 重置密码只在桌面端摆出来：浏览器演示没有真密码，按"没有通道的动作不摆假按钮"处理
  const desktop = runningInTauri();
  const [resetTarget, setResetTarget] = useState<UserAccount | null>(null);

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
      // 登录名可能是系统补的，回显一次站长才知道拿什么让人登录
      toast.success(`员工「${u.display_name}」已保存，登录名 ${u.username}`);
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["staff"] });
      void queryClient.invalidateQueries({ queryKey: ["audits"] });
    },
    onError: (e: Error) => toast.error(`保存失败：${e.message}`),
  });

  const reset = useMutation({
    mutationFn: async (u: UserAccount) => {
      const r = await resetPassword(u.id);
      if (r.error) throw new Error(r.error);
      if (!r.data?.ok) throw new Error(r.data?.error ?? "重置失败");
      return u;
    },
    onSuccess: (u) => {
      toast.success(`「${u.display_name}」的密码已重置为待设置，下次登录须改密`);
      setResetTarget(null);
    },
    onError: (e: Error) => toast.error(`重置失败：${e.message}`),
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
        <span className="flex items-center gap-1">
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
          {desktop && (
            <Button
              size="xs"
              variant="ghost"
              disabled={!editable}
              onClick={(e) => {
                e.stopPropagation();
                setResetTarget(u);
              }}
            >
              重置密码
            </Button>
          )}
        </span>
      ),
    },
  ];

  const perms = Object.entries(PERMISSIONS);

  return (
    <div className="flex flex-col gap-3">
      <SectionBar
        note="制单 / 称重 / 化验 / 结算的留痕一律署名当前登录人。"
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

      <Card size="sm" className="gap-0 p-0">
        <CardHeader className="px-3 py-2">
          <CardTitle className="text-sm font-semibold">
            岗位权限矩阵
            <span className="ml-2 text-xs font-normal text-muted-foreground">✔ 表示该岗位可直接执行；留空的必须站长授权</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
        <Table className={PERM_TABLE}>
          <TableHeader>
            <TableRow className="border-b text-xs text-muted-foreground hover:bg-transparent">
              <TableHead>权限</TableHead>
              {ROLE_LIST.map((r) => (
                <TableHead key={r} className="text-center">
                  {ROLE[r]}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {perms.map(([perm, roles]) => (
              <TableRow key={perm} className="border-b hover:bg-transparent">
                <TableCell className="font-mono text-xs">{perm}</TableCell>
                {ROLE_LIST.map((r) => (
                  <TableCell key={r} className="text-center">
                    {roles.includes(r) ? (
                      <span className="text-success" aria-label="允许">
                        ✔
                      </span>
                    ) : (
                      <span className="text-muted-foreground" aria-label="不允许">
                        ·
                      </span>
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="text-sm">{form.id == null ? "新增员工" : `编辑员工 ${form.display_name}`}</DialogTitle>
            <DialogDescription className="text-xs">
              登录名唯一，留空则由系统补号、保存后回显；停用后不能再用该身份制单，但历史留痕保持不变。新员工首次登录用装机初始密码，进去后被强制改密，此后只有本人知道。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              姓名 *
              <Input
                value={form.display_name}
                onChange={(e) => patch({ display_name: e.target.value })}
                aria-invalid={!form.display_name.trim() ? true : undefined}
                className="text-sm"
              />
              {!form.display_name.trim() && <span className="text-destructive">姓名必填：留痕与台账上显示的就是这几个字</span>}
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              登录名（选填）
              <Input
                value={form.username}
                onChange={(e) => patch({ username: e.target.value })}
                placeholder="留空自动生成，如 u05"
                className="tnum text-sm"
                disabled={form.id != null}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              岗位
              <Choose
                aria-label="岗位"
                value={form.role}
                onChange={(v) => patch({ role: v as Role })}
                options={ROLE_LIST.map((r) => ({ value: r, label: ROLE[r] }))}
              />
            </Label>
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>电话</span>
              <KeypadInput
                aria-label="电话"
                value={form.phone}
                onChangeValue={(v) => patch({ phone: v.replace(/[^\d\s-]/g, "") })}
                keys={digitKeys()}
                columns={6}
                maxLength={20}
                toggleLabel="数字"
                inputMode="tel"
                autoComplete="off"
                inputClassName="tnum text-sm"
              />
            </div>
            <Label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={form.active} onCheckedChange={(v) => patch({ active: v === true })} aria-label="在职" />
              在职
            </Label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={!form.display_name.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetTarget != null} onOpenChange={(v) => { if (!v) setResetTarget(null); }}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-sm">重置 {resetTarget?.display_name} 的密码</DialogTitle>
            <DialogDescription className="text-xs">
              重置后「{resetTarget?.display_name}」的密码回到装机初始密码，下次登录会被强制改密；
              改密之前，知道初始密码的人也能登进这个账号。继续？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResetTarget(null)}>
              取消
            </Button>
            <Button disabled={reset.isPending} onClick={() => resetTarget && reset.mutate(resetTarget)}>
              {reset.isPending ? "重置中…" : "确认重置"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------------------- 操作审计 */

/** 动作码 → 现场话术。表里没有的原样显示，避免把未知动作误标成已知 */
const AUDIT_ACTION: Record<string, string> = {
  "order.create": "制单",
  // 这条早就在写、只是没进表。话术不写死"车牌/备注"：`update_meta` 今天只改那两列，
  // 具体改了哪一格由 reason 带（"车牌 X → Y"），动作码这一层保持通用才不会日后加列时撒谎。
  "order.update": "修改磅单登记项",
  "order.void": "作废磅单",
  "order.reverse": "红冲",
  "order.destination": "登记入仓去向",
  "tare.override": "皮重越差授权",
  "weigh.manual": "称重手录",
  "price.override": "改单价",
  "qc.save": "保存化验",
  "settle.create": "生成结算单",
  // 作废一张已结算的磅单时，它那张结算单在同一事务里被撤掉（02 §F2.3）：
  // 这一行说的是"挂账为什么凭空少了一笔"，不补进表里就只能看见一串机器码
  "settle.revoke": "撤销结算单",
  "pay.record": "登记付款",
  "party.create": "新建售粮人档案",
  "party.update": "修改售粮人档案",
  // 读卡核对通过才盖「已核验」：这一行的价值就是说得出标记的来源，话术里必须带上"刷卡"
  "party.verify": "读卡核对档案",
  // 磅房那一格就地改电话：reason 带着改前改后的完整号码，迎检时这一行要读得懂是谁改的
  "party.phone.update": "改档案联系电话",
  "party.photo.update": "更新档案人像照片",
  "party.photo.clear": "移除档案人像照片",
  // 查看农户人像属于 PII 访问：迎检时这一行要一眼读得懂，不能留成机器码
  "pii.read": "查看个人信息",
  "variety.create": "新建品种",
  "variety.update": "修改品种",
  "price.create": "新增价目",
  "price.update": "调价",
  "setting.update": "改站点参数",
  "device.create": "新增设备",
  "device.update": "改设备配置",
  "staff.create": "新增员工",
  "staff.update": "修改员工",
  "password.reset": "重置员工密码",
};

const AUDIT_RESULT: Record<AuditLog["result"], { label: string; tone: "success" | "warning" | "danger" }> = {
  ok: { label: "成功", tone: "success" },
  denied: { label: "被拒绝", tone: "warning" },
  error: { label: "失败", tone: "danger" },
};

const AUDIT_ENTITY: Record<string, string> = {
  weigh_order: "磅单",
  qc_report: "质检单",
  settlement: "结算单",
  party: "售粮人",
  grain_variety: "品种",
  price_list: "价目",
  app_setting: "站点参数",
  device_config: "设备配置",
  user_account: "员工",
};

/** 只有两侧都能解析成对象时才谈"变化"；一行脏数据不该把整张表带崩 */
function diffOf(before: string | null, after: string | null): { field: string; before: string; after: string }[] {
  const parse = (raw: string | null): Record<string, unknown> | null => {
    if (!raw) return null;
    try {
      const v: unknown = JSON.parse(raw);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const b = parse(before);
  const a = parse(after);
  if (!b || !a) return [];
  const show = (v: unknown) => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return Object.keys({ ...b, ...a })
    .filter((k) => show(b[k]) !== show(a[k]))
    .slice(0, 4)
    .map((k) => ({ field: k, before: show(b[k]), after: show(a[k]) }));
}

function AuditDiff({ row }: { row: AuditRow }) {
  const lines = useMemo(() => diffOf(row.before_json, row.after_json), [row.before_json, row.after_json]);
  if (lines.length === 0) return null;
  return (
    <span className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
      {lines.map((l) => (
        <span key={l.field} className="flex flex-wrap items-center gap-1">
          <span className="font-mono">{l.field}</span>
          <span className="tnum line-through">{l.before}</span>
          <span aria-hidden>→</span>
          <span className="tnum text-foreground">{l.after}</span>
        </span>
      ))}
    </span>
  );
}

function AuditSection() {
  const [kw, setKw] = useState("");
  const [result, setResult] = useState<string>(ALL);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const exportGuard = useSession((s) => s.can("data.export"));
  // 筛条件全部下给库里：留痕是只增表，越往下条数越多，在前端过滤等于把
  // "最近 300 条"当成全部历史，迎检时会少给人家记录。
  // 这框也随打随查，所以扫**老纸**那一枪在这里同样要先剥掉多出来的前缀（02 §F1.4）：
  // 留痕记的 `entity_no` 是单号本体，带着前缀去 `instr` 永远零条。
  const eff = searchKeyword(kw);
  const { data: rows = [], isPending } = useQuery({
    queryKey: ["audits", eff, result, from, to],
    queryFn: () =>
      api.listAudits({
        keyword: eff,
        result: result === ALL ? undefined : (result as "ok" | "denied" | "error"),
        dateFrom: from || undefined,
        dateTo: to || undefined,
      }),
  });

  const columns = useMemo<Column<AuditRow>[]>(
    () => [
      { key: "at", header: "时间", cell: (a) => <span className="tnum text-xs">{dateTime(a.at)}</span>, sortValue: (a) => a.at },
      { key: "actor", header: "操作人", cell: (a) => a.actor_name, sortValue: (a) => a.actor_name },
      {
        key: "action",
        header: "动作",
        cell: (a) => (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm">{AUDIT_ACTION[a.action] ?? a.action}</span>
            {!AUDIT_ACTION[a.action] && <span className="font-mono text-[10px] text-muted-foreground">{a.action}</span>}
          </span>
        ),
        sortValue: (a) => a.action,
      },
      { key: "entity", header: "对象", cell: (a) => <span className="text-xs text-muted-foreground">{AUDIT_ENTITY[a.entity] ?? a.entity}</span> },

      {
        key: "no",
        header: "单据号",
        cell: (a) =>
          a.entity === "weigh_order" && a.entity_no ? (
            <QuickDetailLink type="order" id={a.entity_no} className="tnum text-xs text-primary">
              {a.entity_no}
            </QuickDetailLink>
          ) : a.entity === "settlement" && a.entity_no ? (
            <QuickDetailLink type="settlement" id={a.entity_no} className="tnum text-xs text-primary">
              {a.entity_no}
            </QuickDetailLink>
          ) : (
            <span className="tnum text-xs">{orDash(a.entity_no)}</span>
          ),
      },
      {
        key: "reason",
        header: "事由 / 变化",
        cell: (a) => (
          <span className="flex flex-col gap-0.5">
            {orDash(a.reason)}
            <AuditDiff row={a} />
          </span>
        ),
      },
      { key: "auth", header: "授权人", cell: (a) => <span className="text-xs">{orDash(a.authorized_by)}</span> },
      {
        key: "result",
        header: "结果",
        cell: (a) => {
          const r = AUDIT_RESULT[a.result];
          return <ToneBadge tone={r.tone}>{r.label}</ToneBadge>;
        },
      },
    ],
    [],
  );

  async function doExport() {
    if (!exportGuard) {
      toast.error("当前岗位没有导出权限（需 data.export）");
      return;
    }
    if (rows.length === 0) {
      toast.error("没有可导出的审计记录");
      return;
    }
    await exportCsvFile({
      filename: csvName(`操作审计_${todayISO()}`),
      headers: ["时间", "操作人", "动作码", "动作", "对象", "单据号", "事由", "授权人", "结果"],
      rows: rows.map((a) => [dateTime(a.at), a.actor_name, a.action, AUDIT_ACTION[a.action] ?? "", AUDIT_ENTITY[a.entity] ?? a.entity, a.entity_no ?? "", a.reason ?? "", a.authorized_by ?? "", AUDIT_RESULT[a.result].label]),
      unit: "条审计记录",
    });
  }

  useHotkey("ctrl+e", doExport, { allowInInput: true });

  const denied = rows.filter((a) => a.result !== "ok").length;
  const authorized = rows.filter((a) => a.authorized_by != null).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Label className="flex min-w-56 flex-1 flex-col gap-1 text-xs text-muted-foreground">
          按人名 / 动作 / 单号检索
          <Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="如 张伟、BD2026…、tare.override" className="h-8 text-sm" />
        </Label>
        <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
          结果
          <Choose
            value={result}
            onChange={setResult}
            options={[
              { value: ALL, label: "全部" },
              { value: "ok", label: "成功" },
              { value: "denied", label: "被拒绝" },
              { value: "error", label: "失败" },
            ]}
            size="sm"
            aria-label="按结果筛选"
          />
        </Label>
        <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
          时间范围
          <DateRangePicker
            value={{ from, to }}
            onChange={(f, t) => { setFrom(f); setTo(t); }}
            presets={false}
            allowClear
            placeholder="全部时间"
            className="w-auto"
            aria-label="留痕时间范围"
          />
        </Label>
        <div className="flex gap-2 pb-0.5">
          <Button size="sm" variant="outline" onClick={() => window.print()}>
            <PrinterIcon />
            打印
          </Button>
          <Button size="sm" variant="outline" onClick={doExport} disabled={!exportGuard}>
            <DownloadIcon />
            导出（Ctrl+E）
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span>
          当前列表 <span className="tnum text-foreground">{rows.length}</span> 条
        </span>
        <span>
          未成功 <span className={cn("tnum", denied > 0 ? "text-warning" : "text-foreground")}>{denied}</span> 条
        </span>
        <span>
          需授权动作 <span className="tnum text-foreground">{authorized}</span> 条
        </span>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(a) => a.id}
        loading={isPending}
        dense
        rowClassName={(a) => (a.result === "denied" ? "bg-warning-bg" : a.result === "error" ? "bg-destructive/5" : undefined)}
        empty={<EmptyState title="没有匹配的审计记录" description="清空检索词，或扩大结果筛选范围。" />}
        toolbar={
          <span className="text-xs text-muted-foreground">
            按留痕时间倒序取最近 300 条；未成功的操作同样有记录。
          </span>
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------ 备份与恢复 */

/** 验收口径（02 非功能指标）：单据与附件保存 ≥ 3 年，备份保留 30 份 */
const REQUIRE_DOC_YEARS = 3;
const REQUIRE_BACKUP_KEEP = 30;
const REQUIRE_CAPTURE_DAYS = REQUIRE_DOC_YEARS * 365;

/**
 * 换库口令的键阵：把 `恢复备份` 逐字摊开点选。
 * 口令仍然要逐字相等才放行，这里只是把"必须敲中文"这一步换成"点四个中文"。
 */
const restoreConfirmKeys: KeypadKey[] = [
  ...[...RESTORE_CONFIRM_TEXT].map((ch) => ({ label: ch, insert: ch })),
  { action: "backspace", label: "退格", span: 2, title: "删掉最后一个字" },
  { action: "clear", label: "清空", span: 2, title: "全部重来" },
];

function BackupSection() {
  const desktop = runningInTauri();
  const { data: station } = useStation();
  const canBackup = useSession((s) => s.can("backup.manage"));
  const canRestore = useSession((s) => s.can("backup.restore"));
  const { data: status, isPending, error, refetch } = useQuery({
    queryKey: ["backupStatus"],
    queryFn: () => systemApi.backupStatus(),
    enabled: desktop,
    retry: 0,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [verify, setVerify] = useState<{ name: string; report: VerifyReport } | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [restored, setRestored] = useState<RestoreResult | null>(null);

  /** 每个动作各自标忙，避免"备份"按钮转圈时把"体检"也一起灰掉 */
  async function act(key: string, fn: () => Promise<unknown>, ok: (r: unknown) => string) {
    setBusy(key);
    try {
      const r = await fn();
      toast.success(ok(r));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * 从 U 盘 / 移动硬盘导入一份副本。选择框只负责给出一个绝对路径，
   * 合法性判定与落盘全在后端 `import_backup`（同名不同内容绝不覆盖、拷完重算校验和）。
   * 导入成功后立刻替站长跑一次预检：拷回来的目的本来就是恢复，别让预检再等一次点击。
   */
  async function importFromOutside() {
    setBusy("import");
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        title: "选择要导入的备份副本",
        multiple: false,
        filters: [{ name: "磅房数据库备份", extensions: ["db"] }],
      });
      if (typeof picked !== "string") return; // 站长按了取消
      const file = await systemApi.backupImport(picked);
      setPreflight(await systemApi.restorePreflight(file.name));
      setConfirmText("");
      setRestored(null);
      await refetch();
      toast.success(`已导入 ${file.name}，预检结果见下方`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!desktop) {
    return (
      <CallOut tone="warning" title="浏览器预览不支持备份与恢复">
        备份、校验、体检与恢复都要读写本机文件，请在桌面端打开本页操作。
      </CallOut>
    );
  }

  const keepCount = status?.keep_count ?? 0;
  const captureDays = status?.attachment_keep_days ?? 0;
  const idCardReads = status?.id_card_reads_30d ?? 0;
  const sampleDays = status?.retention_sample_days;

  const checks = [
    {
      label: `附件留存 ${captureDays} 天`,
      need: captureDays >= REQUIRE_CAPTURE_DAYS,
      text: `要求保存 ${REQUIRE_DOC_YEARS} 年（≥ ${REQUIRE_CAPTURE_DAYS} 天），当前 ${captureDays} 天`,
    },
    {
      label: `备份保留 ${keepCount} 份`,
      need: keepCount >= REQUIRE_BACKUP_KEEP,
      text: `要求保留 ${REQUIRE_BACKUP_KEEP} 份，当前 ${keepCount} 份`,
    },
    {
      label: status?.last_backup_at ? `最近备份 ${sinceText(status.last_backup_at)}前` : "还没有过备份",
      need: status?.last_backup_at != null,
      text: "恢复只能回到有过副本的那天，请立即备份一次",
    },
  ];
  const failed = checks.filter((c) => !c.need);

  return (
    <div className="flex flex-col gap-3">
      {isPending ? (
        <p className="text-xs text-muted-foreground">读取备份目录与库状态…</p>
      ) : error ? (
        <CallOut tone="danger" title="读不到备份状态">
          {error.message}
        </CallOut>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={!canBackup || busy !== null} onClick={() => void act("run", () => systemApi.backupRun("manual"), (r) => `已备份 ${(r as BackupFile).name}`)}>
          <ShieldAlertIcon />
          {busy === "run" ? "备份中…" : "立即备份"}
        </Button>
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("health", () => systemApi.dbHealth(), () => "体检完成，结果见下")}>
          {busy === "health" ? "体检中…" : "库体检"}
        </Button>
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("reveal", () => systemApi.backupReveal(), (p) => `已打开 ${String(p)}`)}>
          <DownloadIcon />
          打开备份目录
        </Button>
        <Button size="sm" variant="outline" disabled={!canBackup || busy !== null} onClick={() => void importFromOutside()}>
          <FolderOpenIcon />
          {busy === "import" ? "导入中…" : "从其它位置导入副本"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void refetch()}>
          刷新
        </Button>
        {!canBackup && <span className="text-xs text-warning">当前岗位无权发起备份（需 backup.manage）</span>}
      </div>

      <InfoGrid
        cols={4}
        items={[
          { label: "站点名称", value: station?.name ?? "—" },
          { label: "站点编码", value: <span className="tnum">{station?.code ?? "—"}</span> },
          { label: "留样保存", value: sampleDays == null ? <span className="text-muted-foreground">库中未设此参数</span> : `${sampleDays} 天` },
          { label: "抓拍留存", value: `${captureDays} 天` },
          { label: "备份保留", value: `${status?.backups.length ?? 0} / ${keepCount} 份` },
          { label: "最近备份", value: status?.last_backup_at ? dateTime(status.last_backup_at) : "从未" },
          {
            label: "自动备份",
            value: status ? (
              <span
                className={status.auto_last && !status.auto_last.ok ? "text-destructive" : undefined}
                title={status.auto_last?.detail ?? "本次运行还没跑过第一轮到期检查"}
              >
                每 {status.auto_interval_days} 天
                {status.auto_last
                  ? ` · ${status.auto_last.ok ? "正常" : "上次检查失败"} · ${dateTime(status.auto_last.ran_at)}`
                  : ""}
              </span>
            ) : (
              "—"
            ),
          },
          { label: "库文件", value: <span className="tnum">{status ? fileSize(status.db_size_bytes) : "—"}</span> },
          { label: "临时文件", value: <span className="tnum">{status ? fileSize(status.wal_size_bytes) : "—"}</span> },
          { label: "最早单据", value: <span className="tnum">{status?.doc_oldest_date ?? "—"}</span> },
          { label: "审计留痕", value: <span className="tnum">{status?.audit_rows ?? 0}</span> },
          { label: "备份目录", value: <span className="break-all font-mono text-xs">{status?.backup_dir ?? "—"}</span> },
          {
            label: "证号明文查看",
            // 0028 把那枚"界面掩码"假开关请出去之后，掩码是代码默认、不是可配项，
            // 这一格能如实回答的只剩"最近有没有人在翻"——数取自 audit_log 里的 pii.read
            value: (
              <span className="tnum" title="近 30 天点开证号全号、或导出含证号台账的次数；要看是谁在哪天做的，到「操作审计」页查">
                {idCardReads} 次（近 30 天）
              </span>
            ),
          },
        ]}
      />

      <SectionTitle extra={<span className="text-xs text-muted-foreground">按留存要求逐条自查</span>}>留存合规自查</SectionTitle>
      {failed.length === 0 ? (        <CallOut tone="success" title="留存项全部达标">
          留存参数在「基础档案 → 站点参数」调整，仅站长可改；更旧的备份会在下次备份时自动清理。
        </CallOut>
      ) : (
        <CallOut tone="danger" title={`${failed.length} 项留存参数低于验收口径`}>
          <ul className="list-disc pl-4">
            {failed.map((c) => (
              <li key={c.label}>{c.text}</li>
            ))}
          </ul>
        </CallOut>
      )}
      <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
        {/* 「无法判定」那一档随 0028 一起消失：它当初只为 `pii_mask_id_card` 一枚键存在
            （库里没这个键就没法说它开没开）。剩下三项读的都是有历史默认的真值或文件事实，
            要么达标要么不足，没有第三种可说 */}
        {checks.map((c) => (
          <li key={c.label} className="flex items-center gap-2">
            <ToneBadge tone={c.need ? "success" : "danger"}>{c.need ? "达标" : "不足"}</ToneBadge>
            <span>{c.label}</span>
            <span className="min-w-0 flex-1 truncate" title={c.text}>— {c.text}</span>
          </li>
        ))}
      </ul>

      {health && (
        <CallOut
          tone={health.integrity_ok && health.fk_violations.length === 0 ? "success" : "danger"}
          title={`体检结果：${health.integrity}，关联异常 ${health.fk_violations.length} 条`}
          action={<Button size="xs" variant="outline" onClick={() => setHealth(null)}>收起</Button>}
        >
          <p>
            库 {fileSize(health.db_size_bytes)}（临时文件 {fileSize(health.wal_size_bytes)}）；
            版本 {health.app_version ?? "未知"}；
            单据 {health.counts.weigh_order} 张、结算 {health.counts.settlement} 张、留痕 {health.counts.audit_log} 条、附件 {health.counts.attachment} 个。
          </p>
          {health.fk_violations.length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {health.fk_violations.map((v) => (
                <li key={v} className="font-mono text-[11px]">{v}</li>
              ))}
            </ul>
          )}
        </CallOut>
      )}

      <SectionTitle extra={<span className="text-xs text-muted-foreground">每份副本落盘时算 SHA-256 并写同名 .sha256；校验只读副本，不碰现库</span>}>
        备份清单 {status ? `（${status.backups.length} 份）` : ""}
      </SectionTitle>
      {!status || status.backups.length === 0 ? (
        <EmptyState title="备份目录里还没有副本" description="点上面的「立即备份」生成第一份，或在收工后由站长定期备份。" />
      ) : (
        <ul className="flex flex-col divide-y">
          {status.backups.map((b) => (
            <li key={b.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm">
              <span className="font-mono text-xs">{b.name}</span>
              <ToneBadge tone={b.kind === "imported" || b.kind === "pre_migrate" || b.kind === "pre_upgrade" ? "info" : b.kind === "pre-restore" ? "warning" : "neutral"}>{b.kind}</ToneBadge>
              <span className="text-xs text-muted-foreground">{dateTime(b.created_at)}</span>
              <span className="tnum text-xs">{fileSize(b.size_bytes)}</span>
              <ToneBadge tone={b.sha256_ok === true ? "success" : b.sha256_ok === false ? "danger" : "neutral"}>
                {b.sha256_ok == null ? "无校验和" : b.sha256_ok ? "校验和相符" : "校验和不符"}
              </ToneBadge>
              {verify?.name === b.name && (
                <span className={cn("text-xs", verify.report.ok ? "text-success" : "text-destructive")}>
                  副本完整性「{verify.report.integrity}」，内含单据 {verify.report.orders} 张 / 结算 {verify.report.settlements} 张 / 留痕 {verify.report.audit_rows} 条
                </span>
              )}
              <span className="ml-auto flex gap-1.5">
                <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void act(`verify:${b.name}`, () => systemApi.backupVerify(b.name).then((r) => (setVerify({ name: b.name, report: r }), r)), () => "副本校验完成")}>
                  {busy === `verify:${b.name}` ? "校验中…" : "校验此份"}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canRestore || busy !== null}
                  onClick={() =>
                    void act(`pre:${b.name}`, async () => {
                      const p = await systemApi.restorePreflight(b.name);
                      setPreflight(p);
                      setConfirmText("");
                      setRestored(null);
                      return p;
                    }, (p) => ((p as Preflight).ok ? "预检通过，可恢复" : "预检未通过，见下方原因"))
                  }
                >
                  恢复预检
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {preflight && (
        <CallOut
          tone={preflight.ok ? "warning" : "danger"}
          title={preflight.ok ? `预检通过：可回到 ${preflight.station_name ?? "该站点"} 的 ${preflight.orders} 张单据状态` : "预检未通过，这份副本不能用来恢复"}
        >
          <p className="text-xs">
            副本 {preflight.name}（{fileSize(preflight.size_bytes)}，{preflight.created_at ? dateTime(preflight.created_at) : "时间未知"}），
            结构版本 {preflight.schema_version ?? "未知"} / 现库 {preflight.current_schema_version ?? "未知"}，
            单据 {preflight.orders} 张、结算 {preflight.settlements} 张，最早业务日 {preflight.oldest_date ?? "—"}，完整性「{preflight.integrity}」。
          </p>
          {preflight.warnings.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs">
              {preflight.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {preflight.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs text-destructive">
              {preflight.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}

          {preflight.ok && !restored && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="flex min-w-64 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                <span>
                  换库会覆盖当前库。点输入框右侧「点字」展开，再点下面四个字凑出{" "}
                  <span className="font-mono text-foreground">{RESTORE_CONFIRM_TEXT}</span> 才会执行；执行前会先强制备份当前库
                </span>
                <KeypadInput
                  aria-label="换库确认口令"
                  value={confirmText}
                  onChangeValue={setConfirmText}
                  keys={restoreConfirmKeys}
                  columns={4}
                  maxLength={RESTORE_CONFIRM_TEXT.length}
                  toggleLabel="点字"
                  placeholder={RESTORE_CONFIRM_TEXT}
                  inputClassName="h-9 text-sm"
                />
              </div>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy !== null || confirmText.trim() !== RESTORE_CONFIRM_TEXT}
                onClick={() =>
                  void act(
                    "restore",
                    async () => {
                      const r = await systemApi.restoreApply(preflight.name, confirmText.trim());
                      setRestored(r);
                      return r;
                    },
                    () => "已换库，程序需要重启才能读到新库",
                  )
                }
              >
                {busy === "restore" ? "恢复中…" : "恢复此备份"}
              </Button>
            </div>
          )}

          {restored && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CallOut tone="danger" title="已换库：当前库改名留底，程序必须重启">
                旧库留在 <span className="break-all font-mono text-xs">{restored.old_db_path}</span>
                ，换库前的自动备份是 <span className="font-mono text-xs">{restored.safety_backup}</span>。
                在重启之前，界面上看到的仍是换库前的数据。
              </CallOut>
              <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => void act("restart", () => systemApi.restart(), () => "正在重启")}>
                立即重启程序
              </Button>
            </div>
          )}
        </CallOut>
      )}

      <p className="text-xs text-muted-foreground">
        备份不影响正在进行的业务；恢复是唯一不可逆的操作，执行前会自动把当前库改名留底。
      </p>
    </div>
  );
}

/* -------------------------------------------------------------- 日结交班 */

function ShiftSection() {
  const [date] = useState(todayISO());
  const { data: open = [] } = useQuery({ queryKey: ["openOrders"], queryFn: () => api.openOrders() });
  const { data: daily } = useQuery({ queryKey: ["report", "daily", date], queryFn: () => api.reportDaily(date) });
  const { data: unpaid = [] } = useQuery({ queryKey: ["settlements", "unpaid"], queryFn: () => api.listSettlements({ paymentStatus: "unpaid", limit: SETTLEMENT_SCAN_LIMIT }) });
  const { data: partial = [] } = useQuery({ queryKey: ["settlements", "partial"], queryFn: () => api.listSettlements({ paymentStatus: "partial", limit: SETTLEMENT_SCAN_LIMIT }) });

  const due = useMemo(() => [...unpaid, ...partial], [unpaid, partial]);
  const unpaidFen = due.reduce((n, s) => n + (s.payable_fen - s.paid_fen), 0);
  // 撞上服务端上限=库里还有没读回来的挂账，下面那个金额只能算部分和
  const capped = unpaid.length >= SETTLEMENT_SCAN_LIMIT || partial.length >= SETTLEMENT_SCAN_LIMIT;

  const openColumns = useMemo<Column<WeighOrder>[]>(
    () => [
      {
        key: "no",
        header: "磅单号",
        cell: (o) => <span className="tnum font-medium">{o.order_no}</span>,
      },
      { key: "party", header: "售粮人", cell: (o) => o.party_name },
      { key: "var", header: "品种", cell: (o) => varietyLabel(o.variety_name) },
      { key: "status", header: "状态", cell: (o) => <OrderStatusBadge status={o.status} /> },
      { key: "net", header: "净重", align: "right", cell: (o) => <span className="tnum">{weight(o.net_weight_01kg)}</span> },
      { key: "payable", header: "应付", align: "right", cell: (o) => <span className="tnum">{money(o.payable_amount_fen)}</span> },
      { key: "证", header: "证号", cell: (o) => <IdCardText value={o.id_card_no} partyId={o.party_id} className="tnum text-xs text-muted-foreground" /> },
      detailColumn("order", (o) => o.order_no),
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border bg-muted/20 p-2.5">
        <div className="text-sm">
          日结日期 <span className="tnum font-medium">{date}</span>
          <span className="ml-2 text-xs text-muted-foreground">（口径为业务日期，跨天单归过磅完成那天）</span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => window.print()} disabled={!daily}>
            <PrinterIcon />
            打印交接表
          </Button>
          <Button size="sm" disabled title="封账接口未提供">
            <ShieldAlertIcon />
            封账并锁定当日
          </Button>
        </div>
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">
        「封账」需要写入一条不可撤销的当日记录，该功能尚未开放，按钮暂不可用。
      </p>

      <StatCardGrid>
        <StatCard label="当日单数" value={String(daily?.total.orders ?? "—")} unit="单" hint={`${daily?.rows.length ?? 0} 个品种`} />
        <StatCard label="当日净重" value={daily ? weight(daily.total.net_01kg, false) : "—"} unit="kg" hint={daily ? `前一日 ${shiftDay(date, -1)}` : undefined} />
        <StatCard label="当日应付" value={daily ? money(daily.total.payable_fen, false) : "—"} unit="元" />
        <StatCard
          label="当日未付"
          value={daily ? money(daily.total.credit_fen, false) : "—"}
          unit="元"
          tone={daily && daily.total.credit_fen > 0 ? "danger" : "success"}
          hint={daily && daily.total.credit_fen > 0 ? "交接前催清" : undefined}
        />
      </StatCardGrid>

      {open.length > 0 ? (
        <CallOut tone="warning" title={`${open.length} 张单还没走完流程`}>
          封账前必须处理完：继续过磅结算，或作废并写明事由。
        </CallOut>
      ) : (
        <CallOut tone="success" title="没有在途单据">
          当日所有磅单都已结算或作废，可以交接。
        </CallOut>
      )}

      <DataTable
        columns={openColumns}
        rows={open}
        rowKey={(o) => o.order_no}
        dense
        empty={<EmptyState title="没有在途单" description="今天的单都走完了。" />}
        toolbar={<span className="text-xs text-muted-foreground">末列「详情」在本页右侧弹出完整磅单。</span>}
      />

      <Card size="sm" className="gap-2 p-3">
        <SectionTitle
          extra={
            capped ? (
              <span className="text-xs text-warning">
                单次最多取回 {SETTLEMENT_SCAN_LIMIT} 条，下面这个金额只是部分和；请到结算台账按日期段分段核对
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">交接时必须当面点清的挂账</span>
            )
          }
        >
          未付清结算单 {due.length} 张 · {money(unpaidFen)}
        </SectionTitle>
        {due.length === 0 ? (
          <p className="text-sm text-muted-foreground">今日粮款已全部付清。</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm">
            {due.map((s) => (
              <li key={s.settle_no} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <QuickDetailLink type="settlement" id={s.settle_no} className="tnum font-medium text-primary">
                  {s.settle_no}
                </QuickDetailLink>
                <span className="text-xs text-muted-foreground">{s.payee_name}</span>
                <span className="tnum">{money(s.payable_fen - s.paid_fen)}</span>
                <ToneBadge tone={s.payment_status === "unpaid" ? "danger" : "warning"}>
                  {s.payment_status === "unpaid" ? "分文未付" : "部分付款"}
                </ToneBadge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
