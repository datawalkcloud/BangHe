/**
 * 系统与审计（05 §3 `/system/$section`，五分区均为 P1，先把界面立起来）。
 *
 * 分区的存在理由各不相同：
 * - users：P0 没有口令，只能"选择操作员"，但署名机制必须现在就与 P1 一致（actor_id 不变）；
 * - audit：迎检第一张表。谁、什么时候、对哪张单、做了什么、谁授权的，五件事缺一不可；
 * - backup：把"留存年限 / 备份份数"这类硬指标做成页面可见的自查，而不是写在文档里没人看；
 * - shift：日结前得先知道还有什么没闭环，否则封账等于把窟窿埋进历史；
 * - appearance：显示模式与色板是**本机**偏好（磅房里每台屏的光照不一样），
 *   所以它既不需要站长权限，也不写审计、不进站点参数——与上面四个分区正好相反。
 *
 * 与仓房分区同样的处理：没有接口的动作一律标只读并写明原因，绝不做只弹 toast 的假按钮。
 */
import { useMemo, useState } from "react";
import { Link, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { DownloadIcon, PrinterIcon, ShieldAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { AuditLog, UserAccount, WeighOrder } from "@/mock/types";
import type { Role } from "@/lib/constants";
import { ROLE } from "@/lib/constants";
import { dateTime, maskIdCard, money, orDash, shiftDay, todayISO, weight } from "@/lib/format";
import { csvName, downloadCsv } from "@/lib/csv";
import { useHotkey } from "@/hooks/useHotkey";
import { PERMISSIONS, useActor, useSession } from "@/store/session";
import { useSetting, useStaff, useStation } from "@/hooks/useLookups";
import { StatCard } from "@/components/business/StatCard";
import { ALL, Choose } from "@/components/business/Choose";
import { DataTable, type Column } from "@/components/business/DataTable";
import { OrderStatusBadge, ToneBadge } from "@/components/business/badges";
import { CallOut, EmptyState, InfoGrid, PageHeader, SectionTitle } from "@/components/business/layout";
import { ThemeSettingsPanel } from "@/components/business/ThemeSettingsPanel";
import { OperatorPanel } from "@/components/business/OperatorSwitch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "cn";

export type SystemSection = "users" | "audit" | "backup" | "shift" | "appearance";

const SECTIONS: { key: SystemSection; label: string; desc: string }[] = [
  { key: "users", label: "登录与权限", desc: "当前操作员与岗位可见范围" },
  { key: "audit", label: "操作审计", desc: "关键动作留痕，迎检必查" },
  { key: "backup", label: "备份与恢复", desc: "留存参数自查与体检" },
  { key: "shift", label: "日结交班", desc: "封账前的挂起清单" },
  { key: "appearance", label: "外观与主题", desc: "显示模式与色板，只影响本机" },
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
        {section === "audit" && <AuditSection />}
        {section === "backup" && <BackupSection />}
        {section === "shift" && <ShiftSection />}
        {section === "appearance" && <ThemeSettingsPanel />}
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
  const { data: staff = [] } = useStaff();
  const actor = useActor();
  // 空闲失效时长由后端随会话下发，这里只换算成分钟，不在前端抄一份常量
  const idleMinutes = Math.round((useSession((s) => s.session?.idleTtlSecs) ?? 0) / 60);

  const columns = useMemo<Column<UserAccount>[]>(
    () => [
      {
        key: "who",
        header: "员工",
        cell: (u) => (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{u.display_name}</span>
            <span className="tnum text-xs text-muted-foreground">{u.username}</span>
            {actor?.id === u.id && <ToneBadge tone="info">当前</ToneBadge>}
          </span>
        ),
        sortValue: (u) => u.display_name,
      },
      { key: "role", header: "岗位", cell: (u) => ROLE[u.role], sortValue: (u) => u.role },
      { key: "perms", header: "可执行动作", align: "right", cell: (u) => <span className="tnum">{permissionsOf(u.role).length}</span> },
      { key: "phone", header: "联系电话", cell: (u) => <span className="tnum text-xs">{orDash(u.phone)}</span> },
      { key: "logins", header: "最后登录", cell: (u) => <span className="text-xs text-muted-foreground">{u.last_login_at ? dateTime(u.last_login_at) : "从未登录"}</span> },
      {
        key: "active",
        header: "状态",
        cell: (u) => (u.is_active === 1 ? <ToneBadge tone="success">在职</ToneBadge> : <ToneBadge tone="neutral">已停用</ToneBadge>),
      },
    ],
    [actor?.id],
  );

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

        <CallOut title="口令与会话都在本机校验，问不到会话就当作没登录">
          登录、设口令、重置与授权全部走桌面端的 <span className="font-mono">auth.rs</span>：
          argon2id 校验、连错若干次临时锁定并在登录页倒计时、无操作
          <span className="tnum"> {idleMinutes} </span>
          分钟后需重新登录；会话只存内存，重启程序必须重登。未登录进不了任何业务页，
          写操作的署名由这个会话给出，而不是前端传进来的 id。新增账号与重置他人口令在
          <Link to="/masters/$section" params={{ section: "staff" }} className="underline">
            {" "}
            基础档案 → 员工与岗位
          </Link>
          （仅站长）。浏览器预览没有原生通道，属演示模式：只认在职名单、不校验口令。
        </CallOut>
      </div>

      <DataTable
        columns={columns}
        rows={staff}
        rowKey={(u) => u.id}
        empty={<EmptyState title="还没有员工档案" description="先到基础档案录人员，否则无法署名。" />}
        toolbar={<span className="text-xs text-muted-foreground">「可执行动作」由岗位反查权限表得出，不是手填的数字，因此改权限表这里就跟着变。</span>}
      />
    </div>
  );
}

/* -------------------------------------------------------------- 操作审计 */

/** 动作码 → 现场话术。表里没有的原样显示，避免把未知动作误标成已知 */
const AUDIT_ACTION: Record<string, string> = {
  "order.create": "制单",
  "order.void": "作废磅单",
  "order.reverse": "红冲",
  "tare.override": "皮重越差授权",
  "weigh.manual": "称重手录",
  "price.override": "改单价",
  "qc.save": "保存化验",
  "settle.create": "生成结算单",
  "pay.record": "登记付款",
  "party.create": "新建售粮人档案",
  "party.update": "修改售粮人档案",
  "variety.create": "新建品种",
  "variety.update": "修改品种",
  "price.create": "新增价目",
  "price.update": "调价",
  "setting.update": "改站点参数",
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

function AuditSection() {
  const [kw, setKw] = useState("");
  const [result, setResult] = useState<string>(ALL);
  const exportGuard = useSession((s) => s.can("data.export"));
  const { data = [], isPending } = useQuery({ queryKey: ["audits", kw], queryFn: () => api.listAudits(kw) });
  const rows = useMemo(() => (result === ALL ? data : data.filter((a) => a.result === result)), [data, result]);

  const columns = useMemo<Column<AuditLog>[]>(
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
            <Link to="/orders/$orderNo" params={{ orderNo: a.entity_no }} className="tnum text-xs underline underline-offset-2">
              {a.entity_no}
            </Link>
          ) : (
            <span className="tnum text-xs">{orDash(a.entity_no)}</span>
          ),
      },
      { key: "reason", header: "事由 / 变化", cell: (a) => <span className="text-xs">{orDash(a.reason)}</span> },
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

  const denied = data.filter((a) => a.result !== "ok").length;
  const authorized = data.filter((a) => a.authorized_by != null).length;

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
            列表只保留最近 200 条（真实实现按 03 §留存 参数全量入库，页面加日期区间分页）。
            被拒绝的记录同样留痕——它证明有人试图越权。
          </span>
        }
      />

      <CallOut tone="info" title="字段级前后值对比（diff）尚未实现">
        现在只有「改站点参数」把旧值与新值写进了事由（形如 12 → 24）。价目、磅单等修改需要
        audit_log_detail 表逐字段记录 before/after，该表与写入钩子在 Rust 侧一并落地（03 §5）；
        届时这一列会变成可展开的两栏对比，而不是靠事由文本猜。
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
  const { data: station } = useStation();
  const keepCount = useSetting("backup_keep_count").num;
  const captureDays = useSetting("capture_keep_days").num;
  const sampleDays = useSetting("retention_sample_days").num;
  const maskId = useSetting("pii_mask_id_card").bool;

  const checks = [
    {
      label: `抓拍留存 ${captureDays} 天`,
      need: captureDays >= REQUIRE_CAPTURE_DAYS,
      text: `附件与单据要求保存 ${REQUIRE_DOC_YEARS} 年（≥ ${REQUIRE_CAPTURE_DAYS} 天），当前只留 ${captureDays} 天`,
    },
    {
      label: `备份保留 ${keepCount} 份`,
      need: keepCount >= REQUIRE_BACKUP_KEEP,
      text: `要求保留 ${REQUIRE_BACKUP_KEEP} 份，当前 ${keepCount} 份；旺季一天一备的话不够撑过一个月`,
    },
    {
      label: "界面掩码身份证号",
      need: maskId,
      text: "关闭后身份证明文会出现在屏幕与导出里，属个人信息合规风险",
    },
  ];
  const failed = checks.filter((c) => !c.need);

  return (
    <div className="flex flex-col gap-3">
      <InfoGrid
        cols={4}
        items={[
          { label: "站点名称", value: station?.name ?? "—" },
          { label: "站点编码", value: <span className="tnum">{station?.code ?? "—"}</span> },
          { label: "地址", value: <span className="whitespace-normal break-all">{station?.address ?? "—"}</span> },
          { label: "联系电话", value: <span className="tnum">{station?.phone ?? "—"}</span> },
          { label: "留样保存", value: `${sampleDays} 天` },
          { label: "抓拍留存", value: `${captureDays} 天` },
          { label: "备份保留", value: `${keepCount} 份` },
          { label: "身份证掩码", value: maskId ? "开启" : "关闭" },
        ]}
      />

      <SectionTitle extra={<span className="text-xs text-muted-foreground">对照 02 §非功能指标逐条自查</span>}>留存合规自查</SectionTitle>
      {failed.length === 0 ? (
        <CallOut tone="success" title="留存参数均满足验收口径">
          改任何一个参数都要在「基础档案 → 站点参数」里由站长操作，并会留下一条含前后值的审计。
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
        {checks.map((c) => (
          <li key={c.label} className="flex items-center gap-2">
            <ToneBadge tone={c.need ? "success" : "danger"}>{c.need ? "达标" : "不足"}</ToneBadge>
            <span>{c.label}</span>
            <span className="min-w-0 flex-1 truncate" title={c.text}>— {c.text}</span>
          </li>
        ))}
      </ul>

      <CallOut tone="warning" title="备份、恢复、体检的实际动作需要 Rust 侧提供" action={<Button size="xs" variant="outline" disabled>手动备份</Button>}>
        <p>这些按钮目前是灰的，因为背后没有接口，点了只弹 toast 的假动作在磅房等于骗人。真实实现是：</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>备份：用 <span className="font-mono">VACUUM INTO</span> 生成带日期的副本，并做校验和比对</li>
          <li>导出：复制到 U 盘，选盘后交给系统资源管理器</li>
          <li>恢复：向导先做只读预检再换库；恢复前强制先备份当前库，这是唯一的不可逆操作</li>
          <li>体检：跑 <span className="font-mono">PRAGMA integrity_check</span> 与 <span className="font-mono">foreign_key_check</span> 出报告</li>
        </ul>
      </CallOut>
    </div>
  );
}

/* -------------------------------------------------------------- 日结交班 */

function ShiftSection() {
  const [date] = useState(todayISO());
  const { data: open = [] } = useQuery({ queryKey: ["openOrders"], queryFn: () => api.openOrders() });
  const { data: daily } = useQuery({ queryKey: ["report", "daily", date], queryFn: () => api.reportDaily(date) });
  const { data: unpaid = [] } = useQuery({ queryKey: ["settlements", "unpaid"], queryFn: () => api.listSettlements({ paymentStatus: "unpaid" }) });
  const { data: partial = [] } = useQuery({ queryKey: ["settlements", "partial"], queryFn: () => api.listSettlements({ paymentStatus: "partial" }) });

  const due = useMemo(() => [...unpaid, ...partial], [unpaid, partial]);
  const unpaidFen = due.reduce((n, s) => n + (s.payable_fen - s.paid_fen), 0);

  const openColumns = useMemo<Column<WeighOrder>[]>(
    () => [
      {
        key: "no",
        header: "磅单号",
        cell: (o) => (
          <Link to="/orders/$orderNo" params={{ orderNo: o.order_no }} className="tnum underline underline-offset-2">
            {o.order_no}
          </Link>
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
        这三件都在 Rust 侧事务里，当前没有接口，所以按钮是灰的。
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
        <SectionTitle extra={<span className="text-xs text-muted-foreground">交接时必须当面点清的挂账</span>}>
          未付清结算单 {due.length} 张 · {money(unpaidFen)}
        </SectionTitle>
        {due.length === 0 ? (
          <p className="text-sm text-muted-foreground">今日货款已全部付清。</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm">
            {due.map((s) => (
              <li key={s.settle_no} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link to="/settlements/$settleNo" params={{ settleNo: s.settle_no }} className="tnum underline underline-offset-2">
                  {s.settle_no}
                </Link>
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
