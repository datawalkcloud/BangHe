/**
 * 设备中心（05 §3 `/devices`，验收口径见 02 §M9：现场排障能在 1 分钟内定位是哪台设备）。
 *
 * 左边是设备卡（按类型分组，一眼看清"该在线的有没有在线"），
 * 右边是测试面板 + 帧监视器——地磅排障全靠原始帧，
 * 所以把 store 里正在跑的读数流原样打成一行行的帧文本，
 * 让站长不用接串口工具就能确认"是仪表没发帧，还是发了帧但解析不出重量"。
 *
 * Mock 总开关在标题右侧常驻：关掉之后所有外设不可用，用来验收
 * "无外设也能完成闭环（手录兜底）"这条硬性要求（05 §10-1）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CameraIcon,
  CreditCardIcon,
  DownloadIcon,
  PlayIcon,
  PlusIcon,
  PrinterIcon,
  SquareIcon,
  UsbIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { nativePrinter, toNativePaper, type NativePaper, type NativePrinterDevice, type NativePrinterStatus } from "@/lib/native";
import { PAPER_COLS, parseHex, stamp, verifyReceiptPrinter, type PrintVerify } from "@/lib/print-guard";
import type { DeviceConfig } from "@/mock/types";
import type { DeviceKind, DeviceStatus, Tone } from "@/lib/constants";
import { DEVICE_KIND, DEVICE_STATUS, ROLE, TONE_BOX, TONE_DOT, TONE_TEXT } from "@/lib/constants";
import { orDash, weight } from "@/lib/format";
import { csvName, downloadCsv } from "@/lib/csv";
import { actorId, useActor, useSession } from "@/store/session";
import { useDeviceStore, useScaleTick } from "@/store/device";
import { DeviceStatusLight, Dot, ToneBadge } from "@/components/business/badges";
import { Choose } from "@/components/business/Choose";
import { DataTable, type Column } from "@/components/business/DataTable";
import { CallOut, EmptyState, InfoGrid, PageHeader, SectionTitle } from "@/components/business/layout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "cn";

/** 卡片的分组顺序：地磅排第一，它是现场最高频的故障源 */
const KIND_ORDER: DeviceKind[] = ["scale", "idcard", "camera", "printer", "led", "cashbox", "signpad"];

/** 每类设备在台账里最值得露一眼的寻址参数（按优先级取第一个存在的键） */
const PRIMARY_CFG_KEY: Partial<Record<DeviceKind, string[]>> = {
  scale: ["port"],
  idcard: ["port"],
  camera: ["host"],
  // 热敏走 VID/PID 直写 usbprint.sys，针式走队列名，A4 走预览窗口
  printer: ["vid", "rawQueue", "queue"],
  led: ["host"],
  cashbox: ["port"],
  signpad: ["vid"],
};

const KIND_ICON: Record<DeviceKind, typeof UsbIcon> = {
  scale: UsbIcon,
  idcard: CreditCardIcon,
  camera: CameraIcon,
  printer: PrinterIcon,
  led: UsbIcon,
  cashbox: UsbIcon,
  signpad: UsbIcon,
};

/* ---------------------------------------------------------- 新增设备表单 */

/** 一栏关键参数：options 存在则渲染下拉，否则渲染文本框 */
interface FieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  options?: string[];
  required?: boolean;
}

/**
 * 每类设备在登记表单里暴露的驱动候选与值得现场填的关键参数。
 *
 * 只收"寻址必需"的少数几项：帧模板、判稳阈值这类精细配置仍走各自的联机面板，
 * 登记的目的只是让台账里先有这台机、能被联机测试摸到，而不是在这里配完所有参数。
 */
const DEVICE_SPEC: Record<DeviceKind, { prefix: string; drivers: string[]; fields: FieldSpec[] }> = {
  scale: {
    prefix: "scale",
    drivers: ["yaohua_xk3190", "toledo", "mock"],
    fields: [
      { key: "port", label: "串口", placeholder: "COM3", required: true },
      { key: "baud", label: "波特率", options: ["9600", "4800", "2400", "19200", "38400"] },
      { key: "frameFamily", label: "帧族", options: ["A", "B"] },
    ],
  },
  idcard: {
    prefix: "idcard",
    drivers: ["bridge_exe", "mock"],
    fields: [{ key: "exe", label: "桥接程序", placeholder: "idcard-bridge-x86.exe", required: true }],
  },
  camera: {
    prefix: "cam",
    drivers: ["hikvision_isapi", "dahua_cgi", "mock"],
    fields: [
      { key: "host", label: "地址（IP）", placeholder: "192.168.1.64", required: true },
      { key: "user", label: "登录用户", placeholder: "weigh" },
    ],
  },
  printer: {
    prefix: "prn",
    drivers: ["preview", "raw_escp", "escpos_usbprint", "raw_escpos"],
    fields: [{ key: "paper", label: "纸型", options: ["A4", "dot241", "thermal80", "thermal58"], required: true }],
  },
  led: {
    prefix: "led",
    drivers: ["mock"],
    fields: [{ key: "host", label: "地址（IP）", placeholder: "192.168.1.70", required: true }],
  },
  cashbox: {
    prefix: "cash",
    drivers: ["mock", "escpos_trigger"],
    fields: [{ key: "port", label: "串口", placeholder: "COM2", required: true }],
  },
  signpad: {
    prefix: "sign",
    drivers: ["hidapi"],
    fields: [
      { key: "vid", label: "VID", placeholder: "0x056a" },
      { key: "pid", label: "PID", placeholder: "0x00b1" },
    ],
  },
};

interface DeviceForm {
  kind: DeviceKind;
  code: string;
  name: string;
  driver: string;
  cfg: Record<string, string>;
  isDefault: boolean;
  isMock: boolean;
}

function emptyDeviceForm(): DeviceForm {
  const spec = DEVICE_SPEC.scale;
  return { kind: "scale", code: "", name: "", driver: spec.drivers[0], cfg: {}, isDefault: false, isMock: false };
}

export function DevicesPage() {
  const queryClient = useQueryClient();
  const can = useSession((s) => s.can);
  const actor = useActor();
  const mockOff = useDeviceStore((s) => s.mockOff);
  const setMockOff = useDeviceStore((s) => s.setMockOff);

  const { data: devices = [], isPending } = useQuery({ queryKey: ["devices"], queryFn: () => api.listDevices() });
  const [selected, setSelected] = useState<string | null>(null);
  const active = devices.find((d) => d.code === selected) ?? devices.find((d) => d.is_default === 1) ?? devices[0] ?? null;

  const toggle = useMutation({
    mutationFn: (input: { code: string; enabled?: boolean; mock?: boolean }) =>
      input.enabled !== undefined ? api.setDeviceEnabled(input.code, input.enabled) : api.setDeviceMock(input.code, input.mock ?? false),
    onSuccess: (_r, input) => {
      // 开关只有徽标变化容易“看不到生效”，补一句中文反馈；停用的设备仍列在台账里，不隐身
      const name = devices.find((d) => d.code === input.code)?.name ?? input.code;
      toast.success(
        input.enabled !== undefined
          ? `${name} 已${input.enabled ? "启用" : "停用"}`
          : `${name} 已切到${input.mock ? " Mock 模拟" : "真实设备"}`,
      );
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => toast.error(`操作失败：${e.message}`),
  });

  /* ------------------------------------------------------- 登记新设备 */

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<DeviceForm>(emptyDeviceForm);

  /** 同类型已有编码里最大的序号 +1，作为默认建议编码（仍可手改） */
  function nextCode(kind: DeviceKind): string {
    const prefix = DEVICE_SPEC[kind].prefix;
    const nums = devices
      .filter((d) => d.code.startsWith(prefix))
      .map((d) => Number.parseInt(d.code.slice(prefix.length), 10))
      .filter((n) => Number.isFinite(n));
    return `${prefix}${(nums.length ? Math.max(...nums) : 0) + 1}`;
  }

  function openAdd() {
    setForm({ ...emptyDeviceForm(), code: nextCode("scale") });
    setAddOpen(true);
  }

  function patchDeviceForm(p: Partial<DeviceForm>) {
    setForm((f) => ({ ...f, ...p }));
  }

  /** 换类型时同步重置建议编码、驱动候选与关键参数，避免带着上一类的不兼容字段提交 */
  function patchKind(kind: DeviceKind) {
    setForm((f) => ({ ...f, kind, code: nextCode(kind), driver: DEVICE_SPEC[kind].drivers[0], cfg: {} }));
  }

  function patchCfg(key: string, v: string) {
    setForm((f) => ({ ...f, cfg: { ...f.cfg, [key]: v } }));
  }

  /** 下拉字段未手动改过时以第一项为准，避免"界面显示了值、校验却说必填缺失" */
  function fieldValue(f: FieldSpec): string {
    return (form.cfg[f.key] ?? (f.options ? f.options[0] : "")).trim();
  }

  const addSpec = DEVICE_SPEC[form.kind];
  const addErrors: string[] = [];
  const trimmedCode = form.code.trim();
  if (!form.name.trim()) addErrors.push("名称必填");
  if (!trimmedCode) addErrors.push("编码必填");
  else if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(trimmedCode)) addErrors.push("编码需字母开头，仅含字母/数字/下划线/连字符");
  else if (devices.some((d) => d.code === trimmedCode)) addErrors.push(`编码 ${trimmedCode} 已存在`);
  for (const f of addSpec.fields) {
    if (f.required && !fieldValue(f)) addErrors.push(`${f.label}必填`);
  }

  const createDevice = useMutation({
    mutationFn: () => {
      const config: Record<string, string> = {};
      for (const f of DEVICE_SPEC[form.kind].fields) {
        const v = fieldValue(f);
        if (v) config[f.key] = v;
      }
      return api.createDevice({
        code: form.code.trim(),
        name: form.name.trim(),
        kind: form.kind,
        driver: form.driver,
        config,
        is_default: form.isDefault,
        is_mock: form.isMock,
        operator_id: actorId(),
      });
    },
    onSuccess: (d) => {
      toast.success(`已登记「${d.name}」，请在右侧做联机测试`);
      setSelected(d.code);
      setAddOpen(false);
      setForm(emptyDeviceForm());
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["audits"] });
    },
    onError: (e: Error) => toast.error(`登记失败：${e.message}`),
  });

  const offlineCount = devices.filter((d) => d.is_enabled === 1 && d.last_status !== "online").length;
  const mockCount = devices.filter((d) => d.is_mock === 1).length;

  function exportConfig() {
    const n = downloadCsv(
      csvName(`设备配置_${mockOff ? "mock关" : "mock开"}`),
      ["编码", "名称", "类型", "驱动", "启用", "Mock", "默认", "状态", "最后成功", "错误计数", "最后错误", "配置JSON"],
      devices.map((d) => [
        d.code,
        d.name,
        DEVICE_KIND[d.kind],
        d.driver,
        d.is_enabled ? "是" : "否",
        d.is_mock ? "是" : "否",
        d.is_default ? "是" : "否",
        DEVICE_STATUS[d.last_status].label,
        d.last_ok_at ?? "",
        d.err_count,
        d.last_error ?? "",
        JSON.stringify(d.config),
      ]),
    );
    toast.success(`已导出 ${n} 台设备的配置快照（换机时按此表重建）`);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="设备中心"
        description={`${devices.length} 台已登记设备，${offlineCount > 0 ? `${offlineCount} 台已启用但非在线` : "启用设备全部在线"}`}
        actions={
          <>
            <Button
              size="sm"
              onClick={openAdd}
              disabled={!can("device.manage")}
              title={can("device.manage") ? undefined : "登记设备需要站长岗位（device.manage）"}
            >
              <PlusIcon />
              添加设备
            </Button>
            <Button size="sm" variant="outline" onClick={exportConfig} disabled={devices.length === 0}>
              <DownloadIcon />
              导出配置
            </Button>
            <Label className="flex h-9 items-center gap-2 border px-2.5 text-xs">
              <Switch
                checked={!mockOff}
                disabled={!can("device.manage")}
                onCheckedChange={(v) => setMockOff(v !== true)}
                aria-label="外设 Mock 总开关"
              />
              Mock {mockOff ? "已关闭（走手录兜底）" : "开启"}
            </Label>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {mockOff && (
          <CallOut
            tone="warning"
            title="Mock 已关闭：所有外设不可用"
            action={
              can("device.manage") ? (
                <Button size="xs" variant="outline" onClick={() => setMockOff(false)}>
                  恢复 Mock
                </Button>
              ) : undefined
            }
          >
            这正是"没有任何硬件也要能收粮"的验收场景：读卡改成手工检索农户档案，称重改成手录并强制填原因。工作台上的每个外设按钮此刻都应当是灰的，并且旁边写着为什么。
          </CallOut>
        )}

        {/* 灰按钮必须自己解释原因，否则现场只会得出"软件坏了"的结论（05 §6.5） */}
        {!can("device.manage") && (
          <CallOut
            tone="info"
            title="只读视图：当前操作员无权改动设备"
            action={
              <Button size="xs" variant="outline" render={<Link to="/masters/$section" params={{ section: "staff" }} />}>
                去员工与岗位
              </Button>
            }
          >
            {actor ? `「${actor.displayName} · ${ROLE[actor.role]}」` : "—"}没有 device.manage（仅站长可启用/停用设备、切换 Mock、动总开关）。点卡片标题仍能联机测试、看状态与原始帧——排障不需要权限，改配置才需要。要动手得用站长账号：换人走左侧栏底部「当前操作员」入口，切换需要口令。
          </CallOut>
        )}

        {isPending ? (
          <p className="text-sm text-muted-foreground">正在读取设备清单…</p>
        ) : (
          <div className="mt-3 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_26rem]">
            <div className="flex min-w-0 flex-col gap-4">
              {KIND_ORDER.map((kind) => {
                const list = devices.filter((d) => d.kind === kind);
                if (list.length === 0) return null;
                return (
                  <section key={kind} className="flex min-w-0 flex-col gap-2">
                    <SectionTitle extra={<span className="text-xs text-muted-foreground">{list.length} 台</span>}>
                      {DEVICE_KIND[kind]}
                    </SectionTitle>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {list.map((d) => (
                        <DeviceCard
                          key={d.code}
                          d={d}
                          active={active?.code === d.code}
                          locked={!can("device.manage")}
                          onSelect={() => setSelected(d.code)}
                          onToggleEnabled={(v) => toggle.mutate({ code: d.code, enabled: v })}
                          onToggleMock={(v) => toggle.mutate({ code: d.code, mock: v })}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>

            <div className="flex min-w-0 flex-col gap-3 border bg-card p-3 xl:sticky xl:top-4">
              {active ? (
                <TestPanel d={active} mockOff={mockOff} />
              ) : (
                <EmptyState
                  title="还没有登记任何设备"
                  description="现场硬件按类型录入后即可联机测试、排障。"
                  action={
                    can("device.manage") ? (
                      <Button size="sm" onClick={openAdd}>
                        <PlusIcon />
                        添加设备
                      </Button>
                    ) : undefined
                  }
                />
              )}
            </div>
          </div>
        )}

        <section className="mt-4 flex flex-col gap-2">
          <SectionTitle extra={<span className="text-xs text-muted-foreground">Mock 标记用于培训与演示，正式收粮前应全部关闭</span>}>
            设备台账
          </SectionTitle>
          <DeviceTable devices={devices} onSelect={(c) => setSelected(c)} />
        </section>

        <CallOut className="mt-4" tone="info" title="已开放：小票机配置写入；仍未开放：地磅串口参数与帧模板">
          小票机（ESC/POS 直连）的 VID / PID / 纸宽在右侧面板「配置…」里改，
          <span className="font-medium">保存前必须先联机测试通过</span>（02 §M9）：改任一字段旧的测试结果立即作废，
          测不过就不写入；浏览器预览问不到设备时允许保存，但状态标成"未检测 · 未经真机验证"，不会伪装成在线。
          串口参数、帧模板、判稳阈值的写入仍要走 device_config.config_json 的完整校验（保存前同样必须联机测试通过），
          该接口随 Rust 侧通用帧解析器一并实现；上方「导出配置」给出的是可核对的完整快照。
        </CallOut>
        {mockCount > 0 && <p className="pb-2 text-xs text-muted-foreground">另有 {mockCount} 台设备处于 Mock 模式。</p>}
      </div>

      <Dialog
        open={addOpen}
        onOpenChange={(v) => {
          setAddOpen(v);
          if (!v) createDevice.reset();
        }}
      >
        <DialogContent className="max-w-[600px]">
          <DialogHeader>
            <DialogTitle className="text-sm">添加设备</DialogTitle>
            <DialogDescription className="text-xs">
              登记现场硬件到台账。新设备一律先记「未检测」，保存后在右侧面板做一次联机测试通过才会转绿——
              登记不等于验证（02 §M9）。编码是台账主键，导出配置与换机重建都按它核对，需唯一。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              设备类型
              <Choose
                aria-label="设备类型"
                value={form.kind}
                onChange={(v) => patchKind(v as DeviceKind)}
                options={KIND_ORDER.map((k) => ({ value: k, label: DEVICE_KIND[k] }))}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              驱动 / 协议
              <Choose
                aria-label="驱动协议"
                value={form.driver}
                onChange={(v) => patchDeviceForm({ driver: v })}
                options={addSpec.drivers.map((d) => ({ value: d, label: d }))}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              设备名称 *
              <Input
                value={form.name}
                onChange={(e) => patchDeviceForm({ name: e.target.value })}
                placeholder="如：3 号地磅（耀华 XK3190-A9）"
                className="text-sm"
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              设备编码 *
              <Input
                value={form.code}
                onChange={(e) => patchDeviceForm({ code: e.target.value })}
                placeholder={nextCode(form.kind)}
                className="tnum text-sm font-mono"
              />
            </Label>

            {addSpec.fields.map((f) => (
              <Label key={f.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
                {f.label}
                {f.required ? " *" : ""}
                {f.options ? (
                  <Choose
                    aria-label={f.label}
                    value={fieldValue(f)}
                    onChange={(v) => patchCfg(f.key, v)}
                    options={f.options.map((o) => ({ value: o, label: o }))}
                  />
                ) : (
                  <Input
                    value={form.cfg[f.key] ?? ""}
                    onChange={(e) => patchCfg(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    className="tnum text-sm font-mono"
                  />
                )}
              </Label>
            ))}

            <Label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={form.isDefault} onCheckedChange={(v) => patchDeviceForm({ isDefault: v === true })} aria-label="设为默认" />
              设为该类默认设备（工作台优先用它）
            </Label>
            <Label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={form.isMock} onCheckedChange={(v) => patchDeviceForm({ isMock: v === true })} aria-label="Mock 模拟" />
              先按 Mock 登记（培训/演示用，正式收粮前应切回真实设备）
            </Label>
          </div>

          {addErrors.length > 0 && (
            <CallOut tone="warning" title="还不能保存">
              <ul className="list-disc pl-4">
                {addErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </CallOut>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button onClick={() => createDevice.mutate()} disabled={addErrors.length > 0 || createDevice.isPending}>
              <PlusIcon />
              {createDevice.isPending ? "登记中…" : "登记设备"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------------------------------------------------------------- 卡片 */

function DeviceCard({
  d,
  active,
  locked,
  onSelect,
  onToggleEnabled,
  onToggleMock,
}: {
  d: DeviceConfig;
  active: boolean;
  locked: boolean;
  onSelect: () => void;
  onToggleEnabled: (v: boolean) => void;
  onToggleMock: (v: boolean) => void;
}) {
  const Icon = KIND_ICON[d.kind];
  const st = DEVICE_STATUS[d.last_status];
  return (
    // 卡片本身不能是 <button>：里面已有「启用 / 切 Mock」两个按钮，button 套 button 是非法 HTML，
    // React 会报 hydration 错。选中动作挂在标题按钮上（可键盘聚焦），卡片空白处的点击只是鼠标便利。
    <div
      onClick={onSelect}
      className={cn(
        "flex min-w-0 cursor-pointer flex-col gap-1.5 border bg-card p-2.5 text-left text-sm hover:border-ring",
        active && "border-foreground",
        d.is_enabled === 0 && "opacity-70",
      )}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        className="flex min-w-0 items-center gap-2 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{d.name}</span>
        <span className={cn("ml-auto size-2.5 shrink-0 rounded-full", TONE_DOT[st.tone])} aria-hidden />
      </button>
      <span className="flex flex-wrap items-center gap-1 text-xs">
        <ToneBadge tone={st.tone}>{st.label}</ToneBadge>
        {d.is_default === 1 && <ToneBadge tone="info">默认</ToneBadge>}
        {d.is_mock === 1 && <ToneBadge tone="warning">Mock</ToneBadge>}
        {d.is_enabled === 0 && <ToneBadge tone="neutral">已停用</ToneBadge>}
        {d.err_count > 0 && <span className="text-destructive">错误 {d.err_count} 次</span>}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {orDash(d.last_ok_at) === "—" ? "从未成功" : `最后成功 ${d.last_ok_at}`} · 驱动 {d.driver}
      </span>
      {d.last_error && <span className="truncate text-xs text-destructive">{d.last_error}</span>}
      <span className="flex flex-wrap gap-1 pt-0.5" onClick={(e) => e.stopPropagation()}>
        <Button
          size="xs"
          variant="ghost"
          disabled={locked}
          onClick={(e) => {
            e.stopPropagation();
            onToggleEnabled(d.is_enabled === 0);
          }}
        >
          {d.is_enabled === 1 ? "停用" : "启用"}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={locked}
          onClick={(e) => {
            e.stopPropagation();
            onToggleMock(d.is_mock === 0);
          }}
        >
          {d.is_mock === 1 ? "切真实" : "切 Mock"}
        </Button>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------ 测试面板 */

interface TestResult {
  ok: boolean;
  message: string;
  elapsedMs: number;
  at: string;
}

function TestPanel({ d, mockOff }: { d: DeviceConfig; mockOff: boolean }) {
  const [result, setResult] = useState<TestResult | null>(null);
  const testing = useMutation({
    mutationFn: () => api.testDevice(d.code),
    onSuccess: (r) => setResult({ ...r, at: new Date().toLocaleTimeString("zh-CN", { hour12: false }) }),
    onError: (e: Error) => setResult({ ok: false, message: e.message, elapsedMs: 0, at: new Date().toLocaleTimeString("zh-CN", { hour12: false }) }),
  });

  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{d.name}</p>
          <p className="text-xs text-muted-foreground">
            {DEVICE_KIND[d.kind]} · {d.code}
          </p>
        </div>
        <DeviceStatusLight status={d.last_status} label={DEVICE_STATUS[d.last_status].label} />
      </div>

      <div className="flex flex-col gap-2">
        {d.kind === "printer" && (d.driver === "escpos_usbprint" || d.driver === "raw_escpos") ? (
          <p className="text-xs text-muted-foreground">
            这台机的联机测试在下方小票机面板里，走真设备状态查询（<span className="font-mono">DLE EOT</span>），不用这里的模拟探测。
          </p>
        ) : (
          <Button size="sm" variant="outline" onClick={() => testing.mutate()} disabled={testing.isPending || mockOff}>
            {testing.isPending ? "正在握手…" : "联机测试"}
          </Button>
        )}
      </div>
      {mockOff && <p className="text-xs text-muted-foreground">Mock 总开关关闭期间不做任何真实探测。</p>}

      {result && (
        <div className={cn("flex flex-col gap-0.5 border p-2 text-xs", TONE_BOX[result.ok ? "success" : "danger"])}>
          <span className={cn("font-medium", TONE_TEXT[result.ok ? "success" : "danger"])}>{result.ok ? "测试通过" : "测试失败"}</span>
          <span className="text-muted-foreground">{result.message}</span>
          <span className="tnum text-muted-foreground">
            {result.at} · 耗时 {result.elapsedMs} ms
          </span>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <SectionTitle>通信参数</SectionTitle>
        <InfoGrid
          cols={2}
          items={Object.entries(d.config).map(([k, v]) => ({ label: k, value: <span className="tnum text-xs">{String(v)}</span> }))}
        />
      </div>

      {d.kind === "scale" && <ScalePanel mockOff={mockOff} />}
      {d.kind === "idcard" && <IdCardPanel mockOff={mockOff} />}
      {d.kind === "camera" && <CameraPanel />}
      {d.kind === "printer" && <PrinterPanel key={d.code} d={d} mockOff={mockOff} />}
      {(d.kind === "led" || d.kind === "cashbox" || d.kind === "signpad") && (
        <CallOut tone="neutral" title="该外设为后续期实现">
          LED 播报、钱箱联动、签名板在 02 §M9 里标为 P2，首版不接线；这里保留卡片是为了现场清点硬件时知道有没有插对。
        </CallOut>
      )}
    </>
  );
}

/* ------------------------------------------------------ 地磅：帧监视器 */

interface Frame {
  at: string;
  line: string;
  w: number;
  stable: boolean;
}

/** 把 store 里正在跑的读数打成 A 族连续帧的样子，便于比对现场抓到的字节流 */
function frameLine(weight01kg: number, stable: boolean): string {
  const kg = (weight01kg / 10).toFixed(1).padStart(8, " ");
  return `=+${kg}kg  ${stable ? "ST" : "US"}`;
}

function ScalePanel({ mockOff }: { mockOff: boolean }) {
  useScaleTick(220);
  const scale = useDeviceStore((s) => s.scale);
  const driveOn = useDeviceStore((s) => s.scale.driveOn);
  const driveOff = useDeviceStore((s) => s.scale.driveOff);
  const setConnected = useDeviceStore((s) => s.scale.setConnected);
  const [streaming, setStreaming] = useState(true);
  const [setpoint, setSetpoint] = useState("48600");
  const [frames, setFrames] = useState<Frame[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  const paused = !streaming || mockOff;

  useEffect(() => {
    if (paused) return;
    setFrames((prev) => {
      const next = prev.concat({
        at: new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(new Date().getMilliseconds()).padStart(3, "0"),
        line: frameLine(scale.weight01kg, scale.stable),
        w: scale.weight01kg,
        stable: scale.stable,
      });
      return next.slice(-60);
    });
  }, [scale.weight01kg, scale.stable, paused]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [frames]);

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle extra={<span className="text-xs text-muted-foreground">{scale.connected ? "串口已打开" : "串口未连接"}</span>}>
        帧监视器
      </SectionTitle>

      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-baseline gap-1">
          <span className="tnum text-2xl font-semibold tabular-nums">{weight(scale.weight01kg, false)}</span>
          <span className="text-xs text-muted-foreground">kg</span>
        </span>
        <ToneBadge tone={scale.stable ? "success" : "warning"}>{scale.stable ? "稳定" : "波动中"}</ToneBadge>
        <span className="text-xs text-muted-foreground">{scale.onScale ? "车在磅上" : "空磅"}</span>
        <span className="ml-auto flex gap-1">
          <Button size="xs" variant={streaming ? "outline" : "secondary"} onClick={() => setStreaming((v) => !v)}>
            {streaming ? <SquareIcon /> : <PlayIcon />}
            {streaming ? "暂停" : "继续"}
          </Button>
          <Button size="xs" variant="outline" onClick={() => setConnected(!scale.connected)}>
            {scale.connected ? "拔线模拟" : "重新连线"}
          </Button>
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
          模拟上车重量（kg）
          <Input value={setpoint} onChange={(e) => setSetpoint(e.target.value)} inputMode="decimal" className="h-8 tnum text-sm" disabled={mockOff} />
        </Label>
        <Button
          size="sm"
          disabled={mockOff}
          onClick={() => {
            const kg = Number(setpoint);
            if (!kg || kg <= 0) {
              toast.error("请输入大于 0 的公斤数");
              return;
            }
            driveOn(kg);
          }}
        >
          开上磅
        </Button>
        <Button size="sm" variant="outline" disabled={mockOff} onClick={() => driveOff()}>
          开下磅
        </Button>
      </div>

      <div ref={boxRef} className="h-44 min-w-0 overflow-y-auto border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
        {frames.length === 0 ? (
          <p className="font-sans text-xs text-muted-foreground">
            {mockOff ? "Mock 已关闭，没有读数流。" : paused ? "已暂停，点「继续」恢复。" : "等待仪表发帧…"}
          </p>
        ) : (
          frames.map((f, i) => (
            <p key={i} className={cn("flex gap-2 whitespace-pre", f.stable && "text-success")}>
              <span className="shrink-0 text-muted-foreground">{f.at}</span>
              <span className="min-w-0 flex-1 truncate">{f.line}</span>
              <span className="shrink-0 text-muted-foreground">{f.stable ? "稳" : "—"}</span>
            </p>
          ))
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        判稳窗口 5 帧、容差 50（= 5.0 kg）、分度 100（= 10 kg）：极差达标后读数才向分度对齐，
        因此稳定帧永远是整十公斤。窗口与容差来自站点参数，改参数在「基础档案 → 站点参数」。
      </p>
    </div>
  );
}

/* ------------------------------------------------------ 身份证阅读器 */

function IdCardPanel({ mockOff }: { mockOff: boolean }) {
  const idcard = useDeviceStore((s) => s.idcard);
  const read = useDeviceStore((s) => s.idcard.read);

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle extra={<span className="text-xs text-muted-foreground">x86 桥接子进程</span>}>读卡测试</SectionTitle>
      <Button size="sm" variant="outline" disabled={mockOff || idcard.status !== "online"} onClick={() => void read()}>
        {idcard.reading ? "正在读卡…" : "读一张卡"}
      </Button>
      {idcard.error && <p className="text-xs text-destructive">{idcard.error}</p>}
      {idcard.reading && <p className="text-xs text-muted-foreground">冷启动 300–1500 ms，别重复点。</p>}
      {idcard.last && (
        <div className="flex flex-col gap-1 border p-2 text-xs">
          <p className="font-medium">{idcard.last.name}</p>
          <p className="tnum text-muted-foreground">
            证号 {idcard.last.id_card_no.slice(0, 6)}********{idcard.last.id_card_no.slice(-4)}
          </p>
          <p className="text-muted-foreground">{idcard.last.address}</p>
          <p className="text-muted-foreground">
            出生 {idcard.last.born.slice(0, 4)}-{idcard.last.born.slice(4, 6)}-{idcard.last.born.slice(6, 8)} · {idcard.last.sex}
          </p>
          <p className="text-muted-foreground">
            命中档案 <span className="tnum">#{idcard.last.party_id}</span>
          </p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        读到的明文只存在内存，界面一律脱敏显示；写库时按 03 §4 的字段级加密处理。
      </p>
    </div>
  );
}

/* ------------------------------------------------------------ 摄像机 */

function CameraPanel() {
  const camera = useDeviceStore((s) => s.camera);
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>抓图</SectionTitle>
      <div className="flex aspect-video min-w-0 items-center justify-center border bg-muted/40">
        <p className="text-xs text-muted-foreground">
          {camera.busy ? "正在抓图…" : camera.lastCaptureAt ? `上次抓图 ${camera.lastCaptureAt}` : "尚无抓图记录"}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        真实抓图发生在工作台捕获读数的瞬间（触发时机 triggerOn=capture），图片随磅单入附件表。
        这里不单独发起，是为了避免产生没有单据归属的野图。测试抓图接口待 Rust 侧 DeviceHub 提供。
      </p>
    </div>
  );
}

/* ------------------------------------------------------------ 打印机 */

/** 一次联机探测的结论：状态灯 + 一句人话 + 实际设备名，工作台 store 与设备台账共用同一份 */
interface LiveProbe {
  status: DeviceStatus;
  error: string | null;
  name: string;
  at: string;
}

/**
 * 把设备回的状态翻成台账四态。口径只写这一次，卡片、面板、工作台不会出现三种说法。
 *
 * 关键是"只有类驱动状态字"这一档必须落在**未检测**而不是在线或故障：usbprint.sys 上
 * `DLE EOT` 不回话很常见，而那位状态字的位定义各厂商不一致（本机实测纸是满的时它也置纸位），
 * 拿它报绿是骗人，拿它报缺纸是冤枉现场——只能承认"设备在，但状态没问到可信的"。
 */
function liveOf(p: {
  data?: { device: NativePrinterDevice; status: NativePrinterStatus };
  error: unknown;
  isError: boolean;
}): LiveProbe | null {
  const at = stamp();
  if (p.isError) {
    // 枚举不到或打不开设备：这台机此刻真的不在，不是"没测"
    return { status: "offline", error: p.error instanceof Error ? p.error.message : String(p.error), name: "", at };
  }
  const s = p.data?.status;
  if (!s) return null;
  const name = p.data!.device.label;
  if (!s.responding) {
    return s.source === "ioctl"
      ? { status: "unknown", error: null, name, at }
      : { status: "offline", error: s.note || "设备未应答状态查询", name, at };
  }
  if (!s.online) return { status: "error", error: "打印机未联机（检查脱机键、上盖与纸卷）", name, at };
  if (!s.paperAdequate) return { status: "error", error: "纸将尽或缺纸", name, at };
  return { status: "online", error: null, name, at };
}

function PrinterPanel({ d, mockOff }: { d: DeviceConfig; mockOff: boolean }) {
  const queryClient = useQueryClient();
  const setPrinter = useDeviceStore((s) => s.setPrinter);
  const escpos = d.driver === "escpos_usbprint" || d.driver === "raw_escpos";
  const paper = toNativePaper(d.config.paper == null ? "thermal80" : String(d.config.paper));
  const [pickedPath, setPickedPath] = useState<string | null>(null);

  const devices = useQuery({
    queryKey: ["printer", "usbprint-devices"],
    enabled: escpos && !mockOff,
    retry: 0,
    queryFn: async () => {
      const r = await nativePrinter.list();
      if (!r.available) throw new Error(r.error);
      if (r.error) throw new Error(r.error);
      return r.data ?? [];
    },
  });

  // 台账里的 VID/PID 只代表"上次现场用的是哪台"，一切以枚举结果为准：
  // 换 USB 口或换机后枚举可能不同，此时按实际枚举打，而不是瘫在一条旧配置上。
  const known = useMemo(() => {
    const vid = parseHex(d.config.vid);
    const pid = parseHex(d.config.pid);
    return vid !== null && pid !== null ? { vid, pid } : null;
  }, [d.config.vid, d.config.pid]);

  const list = devices.data ?? [];
  let picked: NativePrinterDevice | null = list.length > 0 ? list[0] : null;
  if (known !== null) {
    picked = list.find((x) => x.vendorId === known.vid && x.productId === known.pid) ?? picked;
  }
  if (pickedPath !== null) {
    picked = list.find((x) => x.devicePath === pickedPath) ?? picked;
  }

  const probe = useQuery({
    queryKey: ["printer", "status", picked?.vendorId ?? null, picked?.productId ?? null],
    enabled: escpos && !mockOff && picked !== null,
    retry: 0,
    queryFn: async () => {
      const r = await nativePrinter.status({
        vid: picked?.vendorId ?? undefined,
        pid: picked?.productId ?? undefined,
      });
      if (!r.available) throw new Error(r.error);
      if (r.error) throw new Error(r.error);
      return r.data!;
    },
  });

  // 探测结论：store 与台账都从这里取，不再各判一遍。
  // 依赖只列 data/error/isError——react-query 每次渲染都返回新的 result 对象，
  // 直接依赖 probe 会让 live 每次换身份，下面的回写 effect 就会无限触发。
  const live = useMemo(
    () => liveOf({ data: probe.data, error: probe.error, isError: probe.isError }),
    [probe.data, probe.error, probe.isError],
  );

  const selfTest = useMutation({
    mutationFn: async () => {
      const r = await nativePrinter.selfTest({
        vid: picked?.vendorId ?? undefined,
        pid: picked?.productId ?? undefined,
        paper,
      });
      if (!r.available) throw new Error(r.error);
      if (r.error) throw new Error(r.error);
      return r.data!;
    },
    onSuccess: (out) => {
      if (out.ok) toast.success(`自检票已送出（${out.device} · ${out.elapsedMs} ms）`);
      else toast.error(`自检失败：${out.error ?? "未知原因"}`);
      void queryInvalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function queryInvalidate() {
    // 打完票状态可能变化（缺纸、故障），把状态卡刷新一遍
    return probe.refetch();
  }

  useEffect(() => {
    if (!live) return;
    setPrinter({ status: live.status, name: live.name, lastError: live.error });
  }, [live, setPrinter]);

  // 台账的状态灯读的是 last_status，而它只有安装时录入的值：不回写，真机明明在线应答，
  // 卡片也会一直挂着"未检测"，现场读到的是"软件没认出这台机"。
  const report = useMutation({
    mutationFn: (p: LiveProbe) => api.reportDeviceProbe(d.code, p),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["devices"] }),
    onError: (e: Error) => toast.error(`状态回写失败：${e.message}`),
  });
  useEffect(() => {
    if (!live) return;
    if (live.status === d.last_status && (live.error ?? null) === (d.last_error ?? null)) return;
    report.mutate(live);
  }, [live, d.last_status, d.last_error, report.mutate]);

  /* ------------------------------------------- 配置写入：改任一项，上一次联机测试立即作废 */

  const can = useSession((s) => s.can);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [draft, setDraft] = useState({
    vid: String(d.config.vid ?? ""),
    pid: String(d.config.pid ?? ""),
    paper,
  });
  const [verify, setVerify] = useState<PrintVerify | null>(null);

  function editDraft(patch: Partial<typeof draft>) {
    setDraft((x) => ({ ...x, ...patch }));
    // 参数一变，之前的"测试通过"就不作数了：否则存进去的是从没验过的配置
    setVerify(null);
  }

  const testDraft = useMutation({
    mutationFn: () =>
      verifyReceiptPrinter({
        vid: parseHex(draft.vid) ?? undefined,
        pid: parseHex(draft.pid) ?? undefined,
        paper: draft.paper,
      }),
    onSuccess: (v) => {
      setVerify(v);
      if (v.mode === "device" && v.ok) toast.success(`联机测试通过：${v.message}`);
      else if (v.mode === "device") toast.error(v.message);
      else toast.warning(v.message);
    },
    onError: (e: Error) => setVerify({ mode: "device", ok: false, at: "", message: e.message }),
  });

  const saveCfg = useMutation({
    mutationFn: () => {
      if (!verify) throw new Error("请先联机测试：配置必须验证过才允许保存（02 §M9）");
      if (verify.mode === "device" && !verify.ok) throw new Error(`联机测试未通过：${verify.message}`);
      const paperKind = draft.paper === "p80" ? "thermal80" : "thermal58";
      return api.updateDeviceConfig({
        code: d.code,
        operator_id: actorId(),
        verify,
        config: {
          paper: paperKind,
          cols: PAPER_COLS[draft.paper],
          vid: draft.vid.trim(),
          pid: draft.pid.trim(),
        },
      });
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setCfgOpen(false);
      toast.success(
        saved.last_status === "online"
          ? `${saved.name} 配置已保存并通过联机测试`
          : `${saved.name} 配置已保存，但${saved.last_error ?? "未经真机验证"}`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!escpos) {
    return (
      <div className="flex flex-col gap-2">
        <SectionTitle>窗口预览通道（通道 A）</SectionTitle>
        <Button
          size="sm"
          variant="outline"
          disabled={mockOff}
          onClick={() => {
            toast.info("已调用系统打印对话框，请在其中确认打印机与纸型");
            window.print();
          }}
        >
          <PrinterIcon />
          打开打印对话框
        </Button>
        <p className="text-xs text-muted-foreground">
          A4 与 241 针式仍走窗口预览：Tauri v2 没有静默打印 API，这条通道一定能用，但每单需人工点一次确认（04 文档 H4）。
          热敏小票不走这条路——它由 ESC/POS 直写设备，不弹对话框。
        </p>
      </div>
    );
  }

  const st = probe.data?.status;
  // 配色跟着台账四态走：卡片是灰是绿，面板就是灰是绿，不会出现两处各说一套
  const tone: Tone = live ? DEVICE_STATUS[live.status].tone : "neutral";
  const headline = st?.responding
    ? st.online
      ? "设备在线并应答 ESC/POS"
      : "设备在线但未联机"
    : st?.source === "ioctl"
      ? "设备已连接（仅类驱动应答，未回 ESC/POS 状态）"
      : "设备未应答状态查询";

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle extra={<span className="text-xs text-muted-foreground">ESC/POS 直写 usbprint.sys，不经打印队列</span>}>
        小票机自检（{paper === "p80" ? "80mm / 48 列" : "58mm / 32 列"}）
      </SectionTitle>

      {devices.isPending && <p className="text-xs text-muted-foreground">正在枚举 usbprint 设备…</p>}
      {devices.isError && (
        <CallOut tone="danger" title="拿不到设备清单">
          {(devices.error as Error).message}
        </CallOut>
      )}
      {!devices.isPending && !devices.isError && list.length === 0 && (
        <CallOut tone="warning" title="没有枚举到 usbprint 设备">
          按顺序排查：打印机是否开机 → USB 线是否插到位 → 设备管理器里该设备是否显示为「USB 打印支持」。
          若显示为厂商私有驱动，直写通道就用不了，需先在「站点参数」把这台机改回窗口预览通道。
        </CallOut>
      )}

      {list.length > 0 && (
        <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
          直连设备（{list.length} 台）
          <Choose
            size="sm"
            aria-label="小票机设备"
            value={picked?.devicePath ?? ""}
            onChange={setPickedPath}
            options={list.map((x) => ({ value: x.devicePath, label: x.label }))}
          />
        </Label>
      )}

      {probe.isError && (
        <CallOut tone="danger" title="状态查询失败">
          {(probe.error as Error).message}
        </CallOut>
      )}
      {st && (
        <div className={cn("flex flex-col gap-1 border p-2 text-xs", TONE_BOX[tone])}>
          <div className="flex items-center justify-between">
            <span className={cn("font-medium", TONE_TEXT[tone])}>{headline}</span>
            <Button size="xs" variant="ghost" onClick={() => void probe.refetch()} disabled={probe.isFetching}>
              {probe.isFetching ? "查询中…" : "重查"}
            </Button>
          </div>
          <InfoGrid
            cols={2}
            items={[
              { label: "状态来源", value: <span className="tnum">{st.source}</span> },
              // 没有 ESC/POS 应答时绝不替打印机断言纸量：类驱动状态字的纸位各厂商不一致
              { label: "纸量", value: st.source === "escpos" ? (st.paperAdequate ? "充足" : "缺纸 / 将尽") : "未确认" },
              { label: "原始状态字节", value: <span className="tnum">{st.rawByte === null ? "—" : `0x${st.rawByte.toString(16).toUpperCase().padStart(2, "0")}`}</span> },
              { label: "类驱动状态字", value: <span className="tnum">{st.ioctl === null ? "—" : `0x${st.ioctl.toString(16).toUpperCase().padStart(8, "0")}`}</span> },
            ]}
          />
          {st.note && <span className="text-muted-foreground">{st.note}</span>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={mockOff || picked === null || selfTest.isPending} onClick={() => selfTest.mutate()}>
          <PrinterIcon />
          {selfTest.isPending ? "正在送出…" : "打印自检票"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={mockOff || !can("device.manage")}
          onClick={() => setCfgOpen(true)}
        >
          配置…
        </Button>
      </div>
      {mockOff && <p className="text-xs text-muted-foreground">Mock 总开关关闭期间不允许写设备配置，也不做真实探测。</p>}
      {!can("device.manage") && <p className="text-xs text-muted-foreground">改设备配置需要站长岗位（device.manage）；这里置灰是权限不足，不是设备问题。</p>}
      {selfTest.data && (
        <div className={cn("flex flex-col gap-0.5 border p-2 text-xs", TONE_BOX[selfTest.data.ok ? "success" : "danger"])}>
          <span className={cn("font-medium", TONE_TEXT[selfTest.data.ok ? "success" : "danger"])}>
            {selfTest.data.ok ? "已提交设备" : "打印失败"}
          </span>
          <span className="text-muted-foreground">
            设备 {selfTest.data.device || "—"} · 目标 {picked?.label ?? "—"} · 纸宽 {paper === "p80" ? "80mm" : "58mm"}
          </span>
          <span className="tnum text-muted-foreground">耗时 {selfTest.data.elapsedMs} ms</span>
          {selfTest.data.error && <span className="text-destructive">{selfTest.data.error}</span>}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        自检票一次判读四件事：RAW 字节是否直达（通道）、中文是否清晰（内置 GBK 字库）、
        那条分隔线是否折行（栅格列数）、末尾有没有切痕（切刀）。工装
        <span className="font-mono"> tools/escpos-probe</span> 与这张票同源同码，两边打出来必然一致。
      </p>

      <Dialog
        open={cfgOpen}
        onOpenChange={(v) => {
          setCfgOpen(v);
          if (!v) setVerify(null);
        }}
      >
        <DialogContent className="max-w-[560px] gap-0 p-0">
          <DialogHeader className="border-b px-4 py-3">
            <DialogTitle className="text-sm">小票机配置 · {d.code}</DialogTitle>
            <DialogDescription className="text-xs">
              保存前必须先联机测试通过（02 §M9）。改动任意一项，上一次测试结果即刻作废——存进去的必须是刚验过的那套参数。
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 px-4 py-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                VID（留空＝用枚举到的第一台）
                <Input
                  value={draft.vid}
                  className="tnum h-8 font-mono text-sm"
                  placeholder="0x0483"
                  onChange={(e) => editDraft({ vid: e.target.value })}
                />
              </Label>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                PID
                <Input
                  value={draft.pid}
                  className="tnum h-8 font-mono text-sm"
                  placeholder="0x5720"
                  onChange={(e) => editDraft({ pid: e.target.value })}
                />
              </Label>
            </div>

            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              纸宽
              <Choose
                size="sm"
                aria-label="纸宽"
                className="w-48"
                value={draft.paper}
                onChange={(v) => editDraft({ paper: v as NativePaper })}
                options={[
                  { value: "p80", label: `80mm（一行 ${PAPER_COLS.p80} 列）` },
                  { value: "p58", label: `58mm（一行 ${PAPER_COLS.p58} 列）` },
                ]}
              />
            </Label>
            <p className="text-xs text-muted-foreground">
              栅格 {PAPER_COLS[draft.paper]} 列由纸宽决定，票面排版按这一列数分行；改错纸宽不会报错，只会把行打折。
              本机 80mm 的 48 列是实机打一行分隔线验证过的。
            </p>

            <div
              className={cn(
                "border p-2 text-xs",
                verify === null
                  ? "border-dashed text-muted-foreground"
                  : verify.mode === "device" && !verify.ok
                    ? "border-destructive/40 bg-destructive/10"
                    : "border-success/40 bg-success-bg",
              )}
            >
              {verify === null ? (
                <>尚未测试。点「联机测试」问一次设备状态（只发状态查询，不出纸）。</>
              ) : (
                <>
                  <span className="font-medium">
                    {verify.mode === "none" ? "未经真机验证" : verify.ok ? "联机测试通过" : "联机测试未通过"}
                  </span>
                  <span className="ml-1">{verify.message}</span>
                  {verify.mode === "none" && (
                    <p className="mt-1 text-muted-foreground">
                      这样保存的配置会标成"未检测"，等桌面端验过才转绿——不允许把没验过的配置显示成在线。
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          <DialogFooter className="mx-0 flex items-center gap-2 border-t px-4 py-3 sm:justify-end">
            <Button
              variant="outline"
              onClick={() => testDraft.mutate()}
              disabled={testDraft.isPending || saveCfg.isPending}
            >
              {testDraft.isPending ? "正在握手…" : "联机测试"}
            </Button>
            <Button
              onClick={() => saveCfg.mutate()}
              disabled={verify === null || (verify.mode === "device" && !verify.ok) || saveCfg.isPending}
            >
              {saveCfg.isPending ? "保存中…" : "保存配置"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------ 设备台账 */

function DeviceTable({ devices, onSelect }: { devices: DeviceConfig[]; onSelect: (code: string) => void }) {
  const columns = useMemo<Column<DeviceConfig>[]>(
    () => [
      { key: "code", header: "编码", cell: (d) => <span className="tnum">{d.code}</span>, sortValue: (d) => d.code },
      { key: "name", header: "名称", cell: (d) => d.name, sortValue: (d) => d.name },
      { key: "kind", header: "类型", cell: (d) => DEVICE_KIND[d.kind] },
      { key: "driver", header: "驱动 / 协议", cell: (d) => <span className="text-xs text-muted-foreground">{d.driver}</span> },
      { key: "status", header: "状态", cell: (d) => <DeviceStatusLight status={d.last_status} label={DEVICE_STATUS[d.last_status].label} /> },
      {
        key: "enabled",
        header: "启用",
        cell: (d) => (d.is_enabled === 1 ? <Dot tone="success" /> : <Dot tone="neutral" />),
      },
      { key: "mock", header: "Mock", cell: (d) => (d.is_mock === 1 ? <ToneBadge tone="warning">是</ToneBadge> : <span className="text-xs text-muted-foreground">否</span>) },
      { key: "default", header: "默认", cell: (d) => (d.is_default === 1 ? <ToneBadge tone="info">默认</ToneBadge> : <span className="text-xs text-muted-foreground">—</span>) },
      { key: "ok", header: "最后成功", cell: (d) => <span className="text-xs">{orDash(d.last_ok_at)}</span> },
      { key: "err", header: "错误次数", align: "right", cell: (d) => <span className={cn("tnum", d.err_count > 0 && "text-destructive")}>{d.err_count}</span>, sortValue: (d) => d.err_count },
      { key: "lastError", header: "最后错误", cell: (d) => <span className="text-xs text-destructive">{orDash(d.last_error)}</span> },
      {
        key: "cfg",
        header: "关键参数",
        // 只展一个寻址参数：整排 JSON 铺进表格既读不动又把列宽撑到 1800px，完整配置在右侧面板看
        cell: (d) => {
          const keys = PRIMARY_CFG_KEY[d.kind] ?? [];
          const k = keys.find((key) => d.config[key] !== undefined);
          return <span className="font-mono text-[11px] text-muted-foreground">{k === undefined ? "—" : `${k}=${d.config[k]}`}</span>;
        },
      },
    ],
    [],
  );

  return (
    <DataTable
      columns={columns}
      rows={devices}
      rowKey={(d) => d.code}
      onRowClick={(d) => onSelect(d.code)}
      dense
      empty={<EmptyState title="没有登记任何设备" description="真实部署时由安装人员按现场硬件录入。" />}
      toolbar={<span className="text-xs text-muted-foreground">点任意一行在右侧打开它的测试面板。</span>}
    />
  );
}
