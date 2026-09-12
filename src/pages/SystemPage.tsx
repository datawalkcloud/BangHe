/**
 * 系统与审计（05 §3 `/system/$section`，六个分区均为 P1，先把界面立起来）。
 *
 * 分区的存在理由各不相同：
 * - users / staff：前者讲"当前登录的是谁、能做什么"，后者管"档案与岗位权限矩阵"。
 *   两块都动账号体系，必须紧挨着放，否则改一处忘了另一处就出事。
 * - audit：迎检第一张表。谁、什么时候、对哪张单、做了什么、谁授权的，五件事缺一不可；
 * - backup：把"留存年限 / 备份份数"这类硬指标做成页面可见的自查，而不是写在文档里没人看；
 * - shift：日结前得先知道还有什么没闭环，否则封账等于把窟窿埋进历史；
 * - appearance / templates：显示模式、配色与票据版式都是**本机**偏好（磅房里每台屏的光照不一样，
 *   每台打印机走纸也不一样），所以它们不需要站长权限，也不写审计、不进站点参数——与上面五个分区正好相反。
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
import { dateTime, fileSize, maskIdCard, money, orDash, shiftDay, sinceText, todayISO, weight } from "@/lib/format";
import { csvName, downloadCsv } from "@/lib/csv";
import { runningInTauri } from "@/lib/native";
import { RESTORE_CONFIRM_TEXT, systemApi, type AuditRow, type BackupFile, type HealthReport, type Preflight, type RestoreResult, type VerifyReport } from "@/lib/system-native";
import { SETTLEMENT_SCAN_LIMIT } from "@/lib/reports-native";
import { useHotkey } from "@/hooks/useHotkey";
import { actorId, PERMISSIONS, useActor, useSession } from "@/store/session";
import { useStaff, useStation } from "@/hooks/useLookups";
import { StatCard } from "@/components/business/StatCard";
import { QuickDetailLink } from "@/components/business/QuickDetailSheet";
import { ALL, Choose } from "@/components/business/Choose";
import { DataTable, type Column } from "@/components/business/DataTable";
import { OrderStatusBadge, ToneBadge } from "@/components/business/badges";
import { CallOut, EmptyState, InfoGrid, PageHeader, SectionBar, SectionTitle } from "@/components/business/layout";
import { ThemeSettingsPanel } from "@/components/business/ThemeSettingsPanel";
import { ReceiptTemplateEditor } from "@/components/print/receipt/TemplateEditor";
import { OperatorPanel } from "@/components/business/OperatorSwitch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "cn";

export type SystemSection = "users" | "staff" | "audit" | "backup" | "shift" | "appearance" | "templates";

const SECTIONS: { key: SystemSection; label: string; desc: string }[] = [
  { key: "users", label: "登录与权限", desc: "当前操作员与岗位可见范围" },
  { key: "staff", label: "员工与岗位", desc: "人员档案、岗位权限矩阵（仅站长可改）" },
  { key: "audit", label: "操作审计", desc: "关键动作留痕，迎检必查" },
  { key: "backup", label: "备份与恢复", desc: "留存参数自查与体检" },
  { key: "shift", label: "日结交班", desc: "封账前的挂起清单" },
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
          <nav className="flex flex-wrap gap-1 pb-1 text-sm">
            {SECTIONS.map((s) => (
              <Link
                key={s.key}
                to="/system/$section"
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
        {section === "users" && <UsersSection />}
        {section === "staff" && <StaffSection />}
        {section === "audit" && <AuditSection />}
        {section === "backup" && <BackupSection />}
        {section === "shift" && <ShiftSection />}
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
  // 空闲失效时长由后端随会话下发，这里只换算成分钟，不在前端抄一份常量
  const idleMinutes = Math.round((useSession((s) => s.session?.idleTtlSecs) ?? 0) / 60);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid items-start gap-3 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <section className="flex flex-col gap-3 border bg-card p-3">
          <OperatorPanel />
          {actor && (
            <div className="flex flex-col gap-1 text-xs">
              <p className="text-muted-foreground">
                岗位 <span className="text-foreground">{ROLE[actor.role]}</span>，可见 {permissionsOf(actor.role).length} 项写操作。
              </p>
              <p className="flex flex-wrap gap-1">
                {permissionsOf(actor.role).map((p) => (
                  <span key={p} className="border bg-muted/40 px-1 font-mono text-[10px] text-muted-foreground">
                    {p}
                  </span>
                ))}
              </p>
            </div>
          )}
        </section>

        <CallOut title="密码与会话都在本机校验，问不到会话就当作没登录">
          登录、设密码、重置与授权全部走桌面端的 <span className="font-mono">auth.rs</span>：
          argon2id 校验、连错若干次临时锁定并在登录页倒计时、
          {idleMinutes > 0 ? (
            <>
              无操作<span className="tnum"> {idleMinutes} </span>分钟后需重新登录；
            </>
          ) : (
            <>空闲失效时长由桌面端会话下发（当前拿不到该值，前端不抄一份常量兜底）；</>
          )}
          会话只存内存，重启程序必须重登。未登录进不了任何业务页，
          写操作的署名由这个会话给出，而不是前端传进来的 id。新增账号、调整岗位与权限矩阵在
          <Link to="/system/$section" params={{ section: "staff" }} className="underline">
            {" "}
            系统与审计 → 员工与岗位
          </Link>
          （仅站长）。浏览器预览没有原生通道，属演示模式：只认在职名单、不校验密码。
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
        note="身份来源已从「选择操作员」换成密码登录：制单 / 称重 / 化验 / 结算的留痕一律署名当前登录人，署名机制未变，只是拿人的入口换了。"
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
      </section>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="text-sm">{form.id == null ? "新增员工" : `编辑员工 ${form.display_name}`}</DialogTitle>
            <DialogDescription className="text-xs">
              登录名唯一，停用后不能再用该身份制单，但历史留痕保持不变。新员工首次登录用装机初始密码，进去后被强制改密，此后只有本人知道。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              登录名 *
              <Input value={form.username} onChange={(e) => patch({ username: e.target.value })} className="tnum text-sm" disabled={form.id != null} />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              姓名 *
              <Input value={form.display_name} onChange={(e) => patch({ display_name: e.target.value })} className="text-sm" />
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
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              电话
              <Input value={form.phone} onChange={(e) => patch({ phone: e.target.value })} className="tnum text-sm" />
            </Label>
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

/* -------------------------------------------------------------- 操作审计 */

/** 动作码 → 现场话术。表里没有的原样显示，避免把未知动作误标成已知 */
const AUDIT_ACTION: Record<string, string> = {
  "order.create": "制单",
  "order.void": "作废磅单",
  "order.reverse": "红冲",
  "order.destination": "登记入仓去向",
  "tare.override": "皮重越差授权",
  "weigh.manual": "称重手录",
  "price.override": "改单价",
  "qc.save": "保存化验",
  "settle.create": "生成结算单",
  "pay.record": "登记付款",
  "party.create": "新建售粮人档案",
  "party.update": "修改售粮人档案",
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
  const { data: rows = [], isPending } = useQuery({
    queryKey: ["audits", kw, result, from, to],
    queryFn: () =>
      api.listAudits({
        keyword: kw,
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

  function doExport() {
    if (!exportGuard) {
      toast.error("当前岗位没有导出权限（需 data.export）");
      return;
    }
    if (rows.length === 0) {
      toast.error("没有可导出的审计记录");
      return;
    }
    const n = downloadCsv(
      csvName(`操作审计_${todayISO()}`),
      ["时间", "操作人", "动作码", "动作", "对象", "单据号", "事由", "授权人", "结果"],
      rows.map((a) => [dateTime(a.at), a.actor_name, a.action, AUDIT_ACTION[a.action] ?? "", AUDIT_ENTITY[a.entity] ?? a.entity, a.entity_no ?? "", a.reason ?? "", a.authorized_by ?? "", AUDIT_RESULT[a.result].label]),
    );
    toast.success(`已导出 ${n} 条审计记录`);
  }

  useHotkey("ctrl+e", doExport, { allowInInput: true });

  const denied = rows.filter((a) => a.result !== "ok").length;
  const authorized = rows.filter((a) => a.authorized_by != null).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2 border bg-muted/20 p-2.5">
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
          起始日
          <DatePicker value={from} onChange={(v) => setFrom(v)} className="w-auto" aria-label="留痕起始日" />
        </Label>
        <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
          截止日
          <DatePicker value={to} onChange={(v) => setTo(v)} className="w-auto" aria-label="留痕截止日" />
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
            读的是 <span className="font-mono">audit_log</span>，按留痕时间倒序取最近 300 条，检索词与日期区间在库里就筛完（不是先取一批再在前端过滤）。
            被拒绝的记录同样留痕——它证明有人试图越权。
          </span>
        }
      />

      <CallOut tone="info" title="字段级前后值对比只在写入方回填了 before_json / after_json 的行上出现">
        库里的 <span className="font-mono">audit_log</span> 有这两列，本页把它们解析成逐字段
        <span className="text-foreground"> 旧 → 新 </span>
        显示。目前站点参数与改单价把变化写进了事由文本（形如 12 → 24），磅单与价目的修改
        还没有在写入侧回填结构化的前后值——补那一段属于各模块写入自己的轮次，不在本页。
      </CallOut>
    </div>
  );
}

/* ------------------------------------------------------------ 备份与恢复 */

/** 验收口径（02 非功能指标）：单据与附件保存 ≥ 3 年，备份保留 30 份 */
const REQUIRE_DOC_YEARS = 3;
const REQUIRE_BACKUP_KEEP = 30;
const REQUIRE_CAPTURE_DAYS = REQUIRE_DOC_YEARS * 365;

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
      <CallOut tone="warning" title="备份、校验、体检与恢复都要落文件系统，浏览器预览里没有">
        这一节不再放"点了只弹 toast"的灰按钮：读的是站点机 AppData 下的
        <span className="font-mono"> banghe.db </span>
        与备份目录。要看真实状态请在桌面端打开本页；站点参数与留存自查同样取自
        <span className="font-mono">app_setting</span>。
      </CallOut>
    );
  }

  const keepCount = status?.keep_count ?? 0;
  const captureDays = status?.attachment_keep_days ?? 0;
  const maskId = status?.pii_mask_id_card;
  const sampleDays = status?.retention_sample_days;

  const checks = [
    {
      label: `附件留存 ${captureDays} 天`,
      need: captureDays >= REQUIRE_CAPTURE_DAYS,
      text: `单据与附件要求保存 ${REQUIRE_DOC_YEARS} 年（≥ ${REQUIRE_CAPTURE_DAYS} 天），库里 attachment_keep_days = ${captureDays}`,
    },
    {
      label: `备份保留 ${keepCount} 份`,
      need: keepCount >= REQUIRE_BACKUP_KEEP,
      text: `要求保留 ${REQUIRE_BACKUP_KEEP} 份，库里 backup_keep_count = ${keepCount}；淘汰更旧的备份时按这个数收`,
    },
    {
      label: status?.last_backup_at ? `最近备份 ${sinceText(status.last_backup_at)}前` : "还没有过备份",
      need: status?.last_backup_at != null,
      text: "恢复只能回到有过副本的那天，没备份就等于没有退路",
    },
    {
      label: "界面掩码身份证号",
      need: maskId === true,
      text:
        maskId == null
          ? "库里没有 pii_mask_id_card 这个键（现有的是 pii_encrypt_enabled，说的是字段加密，不是界面掩码），此项无法自查"
          : maskId
            ? "已开启：屏幕与导出里证号带掩码"
            : "关闭后身份证明文会出现在屏幕与导出里，属个人信息合规风险",
    },
  ];
  // 库里没有对应键的项目"不足"不算失败，只是无法判定——灰掉比红着诚实
  const unknown = checks.filter((c) => c.label.includes("掩码") && maskId == null);
  const failed = checks.filter((c) => !c.need && !unknown.includes(c));

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
          {busy === "health" ? "体检中…" : "库体检（integrity_check）"}
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
          { label: "WAL 未合并", value: <span className="tnum">{status ? fileSize(status.wal_size_bytes) : "—"}</span> },
          { label: "最早单据", value: <span className="tnum">{status?.doc_oldest_date ?? "—"}</span> },
          { label: "审计留痕", value: <span className="tnum">{status?.audit_rows ?? 0}</span> },
          { label: "备份目录", value: <span className="break-all font-mono text-xs">{status?.backup_dir ?? "—"}</span> },
          { label: "身份证掩码", value: maskId == null ? "库中未设" : maskId ? "开启" : "关闭" },
        ]}
      />

      <SectionTitle extra={<span className="text-xs text-muted-foreground">对照 02 §非功能指标逐条自查，数值取自真库参数与文件</span>}>留存合规自查</SectionTitle>
      {failed.length === 0 ? (
        <CallOut tone="success" title="可判定的留存项均满足验收口径">
          参数改在「基础档案 → 站点参数」由站长操作并留审计；备份保留份数取自
          <span className="font-mono"> backup_keep_count</span>，超过该数的更旧副本会在下次备份时成对删掉（.db 与 .sha256）。
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
        {checks.map((c) => {
          const skippable = unknown.includes(c);
          return (
            <li key={c.label} className="flex items-center gap-2">
              <ToneBadge tone={skippable ? "neutral" : c.need ? "success" : "danger"}>{skippable ? "无法判定" : c.need ? "达标" : "不足"}</ToneBadge>
              <span>{c.label}</span>
              <span className="min-w-0 flex-1 truncate" title={c.text}>— {c.text}</span>
            </li>
          );
        })}
      </ul>

      {health && (
        <CallOut
          tone={health.integrity_ok && health.fk_violations.length === 0 ? "success" : "danger"}
          title={`体检结果：integrity_check「${health.integrity}」，外键违反 ${health.fk_violations.length} 条`}
          action={<Button size="xs" variant="outline" onClick={() => setHealth(null)}>收起</Button>}
        >
          <p>
            模式 <span className="font-mono">{health.journal_mode}</span>，页大小 {health.page_size}，
            库 {fileSize(health.db_size_bytes)} + WAL {fileSize(health.wal_size_bytes)}；
            应用版本 {health.app_version ?? "未知"} / 结构版本 {health.schema_version ?? "未知"}。
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
              <ToneBadge tone={b.kind === "imported" || b.kind === "pre_migrate" ? "info" : b.kind === "pre-restore" ? "warning" : "neutral"}>{b.kind}</ToneBadge>
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
              <Label className="flex min-w-64 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                换库会覆盖当前库。逐字输入 <span className="font-mono text-foreground">{RESTORE_CONFIRM_TEXT}</span> 才会执行；执行前会先强制备份当前库
                <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={RESTORE_CONFIRM_TEXT} className="h-8 text-sm" />
              </Label>
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
        备份用 <span className="font-mono">VACUUM INTO</span> 在线生成一致副本，不锁业务写入；
        恢复是唯一不可逆动作，所以顺序固定为「预检 → 强制备份现库 → WAL 收敛 → 旧库改名留底 → 复制副本入库」，
        任何一步失败都会把已完成的部分写在错误里，留底文件不会被删。
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
        cell: (o) => (
          <QuickDetailLink type="order" id={o.order_no} className="tnum font-medium text-primary">
            {o.order_no}
          </QuickDetailLink>
        ),
      },
      { key: "party", header: "售粮人", cell: (o) => o.party_name },
      { key: "var", header: "品种", cell: (o) => o.variety_name },
      { key: "status", header: "状态", cell: (o) => <OrderStatusBadge status={o.status} /> },
      { key: "net", header: "净重", align: "right", cell: (o) => <span className="tnum">{weight(o.net_weight_01kg)}</span> },
      { key: "payable", header: "应付", align: "right", cell: (o) => <span className="tnum">{money(o.payable_amount_fen)}</span> },
      { key: "证", header: "证号", cell: (o) => <span className="tnum text-xs text-muted-foreground">{maskIdCard(o.id_card_no)}</span> },
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
        「封账」按下去要做三件事：当日未结算单清零、单据状态转 archived、写入一条不可撤销的日结记录。
        前两件在现有表里做得到，第三件缺一张日结记录表（<span className="font-mono">shift_close</span>）——
        没有它，"这天封过账"这件事只存在于记忆里，事后无法证明哪天封的、谁封的、封的时候是什么数。
        所以按钮仍然是灰的：补一张表和一支事务命令是它自己的那一轮，不在这里偷偷先按下去。
      </p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
      </div>

      {open.length > 0 ? (
        <CallOut tone="warning" title={`${open.length} 张单还没走完流程`}>
          这些单封账前必须处理完：要么继续过磅结算，要么作废并写明事由。留成"在途"过夜的后果是
          第二天对不上现金，而且农户已经不记得当时说的是哪个价。
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
        toolbar={<span className="text-xs text-muted-foreground">点单号直接进入该单，可在工作台继续未完成的操作。</span>}
      />

      <section className="flex flex-col gap-2 border bg-card p-3">
        <SectionTitle
          extra={
            capped ? (
              <span className="text-xs text-warning">
                单次最多取回 {SETTLEMENT_SCAN_LIMIT} 条，下面这个金额是部分和——挂账已多到需要按日期段在结算台账里逐段核对
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">交接时必须当面点清的挂账</span>
            )
          }
        >
          未付清结算单 {due.length} 张 · {money(unpaidFen)}
        </SectionTitle>
        {due.length === 0 ? (
          <p className="text-sm text-muted-foreground">今日货款已全部付清。</p>
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
      </section>
    </div>
  );
}
