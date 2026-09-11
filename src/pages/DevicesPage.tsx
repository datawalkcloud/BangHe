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
  PrinterIcon,
  SquareIcon,
  UsbIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { DeviceConfig } from "@/mock/types";
import type { DeviceKind } from "@/lib/constants";
import { DEVICE_KIND, DEVICE_STATUS, ROLE, TONE_DOT } from "@/lib/constants";
import { orDash, weight } from "@/lib/format";
import { csvName, downloadCsv } from "@/lib/csv";
import { useSession } from "@/store/session";
import { useDeviceStore, useScaleTick } from "@/store/device";
import { DeviceStatusLight, Dot, ToneBadge } from "@/components/business/badges";
import { DataTable, type Column } from "@/components/business/DataTable";
import { CallOut, EmptyState, InfoGrid, PageHeader, SectionTitle } from "@/components/business/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "cn";

/** 卡片的分组顺序：地磅排第一，它是现场最高频的故障源 */
const KIND_ORDER: DeviceKind[] = ["scale", "idcard", "camera", "printer", "led", "cashbox", "signpad"];

/** 每类设备在台账里最值得露一眼的寻址参数 */
const PRIMARY_CFG_KEY: Partial<Record<DeviceKind, string>> = {
  scale: "port",
  idcard: "port",
  camera: "host",
  printer: "rawQueue",
  led: "host",
  cashbox: "port",
  signpad: "vid",
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

export function DevicesPage() {
  const queryClient = useQueryClient();
  const can = useSession((s) => s.can);
  const operator = useSession((s) => s.operator);
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
            {operator ? `「${operator.display_name} · ${ROLE[operator.role]}」` : "未选择操作员"}没有 device.manage（仅站长可启用/停用设备、切换 Mock、动总开关）。点卡片标题仍能联机测试、看状态与原始帧——排障不需要权限，改配置才需要。要动手请在左侧栏底部「当前操作员」切到站长。
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
                <EmptyState title="没有可测试的设备" description="先在 Rust 侧登记设备档案。" />
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

        <CallOut className="mt-4" tone="info" title="配置写入与帧模板编辑尚未开放">
          这里的开关只改「启用 / Mock」两个标志位。串口参数、帧模板、判稳阈值的写入要走
          device_config.config_json 的完整校验（保存前必须联机测试通过，02 §M9），
          该接口在 Rust 侧与通用帧解析器一并实现；上方「导出配置」给出的是可核对的完整快照。
        </CallOut>
        {mockCount > 0 && <p className="pb-2 text-xs text-muted-foreground">另有 {mockCount} 台设备处于 Mock 模式。</p>}
      </div>
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

      <Button size="sm" variant="outline" onClick={() => testing.mutate()} disabled={testing.isPending || mockOff}>
        {testing.isPending ? "正在握手…" : "联机测试"}
      </Button>
      {mockOff && <p className="text-xs text-muted-foreground">Mock 总开关关闭期间不做任何真实探测。</p>}

      {result && (
        <div className={cn("flex flex-col gap-0.5 border p-2 text-xs", result.ok ? "border-success/40 bg-success-bg" : "border-destructive/40 bg-destructive/10")}>
          <span className={cn("font-medium", result.ok ? "text-success" : "text-destructive")}>{result.ok ? "测试通过" : "测试失败"}</span>
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
      {d.kind === "printer" && <PrinterPanel mockOff={mockOff} />}
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

function PrinterPanel({ mockOff }: { mockOff: boolean }) {
  const printer = useDeviceStore((s) => s.printer);
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>打印测试页</SectionTitle>
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
        打印一页测试
      </Button>
      <p className="text-xs text-muted-foreground">
        当前打印机：{printer.name || "未设置"}；{printer.lastError ? `最近错误：${printer.lastError}` : "无错误记录"}。
        码单/质检单/结算凭证的真实打印在工作台与详情页，走窗口预览、PDF 静默、RAW 直连三通道之一。
      </p>
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
          const k = PRIMARY_CFG_KEY[d.kind];
          const v = k ? d.config[k] : undefined;
          return <span className="font-mono text-[11px] text-muted-foreground">{v === undefined ? "—" : `${k}=${v}`}</span>;
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
