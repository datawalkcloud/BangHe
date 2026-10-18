/**
 * 设备中心（05 §3 `/devices`，验收口径见 02 §M9：现场排障能在 1 分钟内定位是哪台设备）。
 *
 * 左边是设备卡（按类型分组，一眼看清"该在线的有没有在线"），
 * 右边是测试面板 + 帧监视器——地磅排障全靠原始帧，
 * 所以把 store 里正在跑的读数流原样打成一行行的帧文本，
 * 让站长不用接串口工具就能确认"是仪表没发帧，还是发了帧但解析不出重量"。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CameraIcon,
  CheckIcon,
  CreditCardIcon,
  DownloadIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  PrinterIcon,
  ScanLineIcon,
  SquareIcon,
  Trash2Icon,
  UsbIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { nativeCamera, nativeIdcard, nativePrinter, nativeSerial, runningInTauri, toNativePaper, type NativeLocalCamera, type NativePaper, type NativePrinterDevice, type NativePrinterStatus, type NativeReaderStatus, type NativeWindowsPrinter } from "@/lib/native";
import { localCameraSpec, probeLocalCamera } from "@/lib/local-camera";
import { LocalCameraLive } from "@/components/business/LocalCameraLive";
import { IdCardText } from "@/components/business/IdCardText";
import { IpCameraLive, ipCameraSpec } from "@/components/business/IpCameraLive";
import { MEDIUM, READER_DRIVER_IDS, readerFields, readerSpec } from "@/lib/card-reader";
import { ESCPOS_DRIVERS, PAPER_COLS, parseHex, stamp, verifyReceiptPrinter, type PrintVerify } from "@/lib/print-guard";
import type { DeviceConfig } from "@/mock/types";
import type { DeviceKind, DeviceStatus, Tone } from "@/lib/constants";
import { DEVICE_KIND, DEVICE_STATUS, ROLE, TONE_DOT, TONE_TEXT } from "@/lib/constants";
import { orDash, weight } from "@/lib/format";
import { csvName } from "@/lib/csv";
import { exportCsvFile } from "@/lib/export-csv";
import { actorId, useActor, useSession } from "@/store/session";
import { useDeviceStore, useScaleTick, type ReaderProbe } from "@/store/device";
import { DeviceStatusLight, ToneBadge } from "@/components/business/badges";
import { Choose } from "@/components/business/Choose";
import { CallOut, EmptyState, InfoGrid, PageHeader, SectionTitle } from "@/components/business/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "cn";

/** 卡片的分组顺序：地磅排第一，它是现场最高频的故障源。
 *  户外显示屏、钱箱、签名板站点没装，不进分组也不进登记表单候选（枚举值仍留在库里，见 constants.ts）。
 *  串口扫码枪（scanner）已整条退役：不再登记、不再分组、工作台也不再开它的读线程；
 *  枚举值同样只因 0024 迁移的 CHECK 不可改而留在库里（与 led/cashbox/signpad 同处理） */
const KIND_ORDER: DeviceKind[] = ["scale", "idcard", "camera", "printer"];

/** 串口类设备：port 不由静态 fields 维护，而走本机扫描 + 下拉选择 */
const SERIAL_KINDS: DeviceKind[] = ["scale"];

const KIND_ICON: Record<DeviceKind, typeof UsbIcon> = {
  scale: UsbIcon,
  idcard: CreditCardIcon,
  camera: CameraIcon,
  printer: PrinterIcon,
  scanner: ScanLineIcon,
  led: UsbIcon,
  cashbox: UsbIcon,
  signpad: UsbIcon,
};

/* ---------------------------------------------------------- 新增设备表单 */

/** 一栏关键参数：options 存在则渲染下拉，否则渲染文本框；input="password" 走掩码输入框 */
interface FieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  options?: string[];
  required?: boolean;
  input?: "text" | "password";
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
      { key: "baud", label: "波特率", options: ["9600", "4800", "2400", "19200", "38400"] },
      { key: "frameFamily", label: "帧族", options: ["A", "B"] },
    ],
  },
  idcard: {
    prefix: "idcard",
    // 驱动能读什么卡、该露哪些参数，由 lib/card-reader 的登记表说，这里只引用
    drivers: READER_DRIVER_IDS,
    fields: readerFields("routon_sdtapi"),
  },
  camera: {
    prefix: "cam",
    // local_uvc = 本机 USB / 内置摄像头（Media Foundation 扫描回填）；hikvision_isapi / dahua_cgi 走内网 IP
    drivers: ["local_uvc", "hikvision_isapi", "dahua_cgi", "mock"],
    // mock 驱动走这份兜底；真机网络（海康 / 大华）的字段由 networkCameraFields 按驱动给
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
  scanner: {
    // 串口扫码枪已整条退役：不再出现在 KIND_ORDER，也就进不了登记表单候选与分组。
    // 这一条只是为了让 DEVICE_SPEC 对 DeviceKind 保持全覆盖（枚举值因 0024 CHECK 不可改而留在库里），
    // 永远不会被读到——真机不再登记，工作台也不再开它的读线程。
    prefix: "scanner",
    drivers: [],
    fields: [],
  },
  led: {
    prefix: "led",
    drivers: ["mock"],
    fields: [{ key: "host", label: "地址（IP）", placeholder: "192.168.1.70", required: true }],
  },
  cashbox: {
    prefix: "cash",
    drivers: ["mock", "escpos_trigger"],
    fields: [],
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

/** ESC/POS 直写 usbprint.sys、靠 VID/PID 寻址的两类驱动（判据收在 print-guard，工作台直打同源） */

/**
 * 纸型候选随驱动收敛：热敏只给 80/58、A4 只给 A4、针式只给 241。
 * 修的是旧表单把四类纸型恒并列、和所选驱动对不上的问题（"表单不合理"点之一）。
 */
function paperOptionsFor(driver: string): string[] {
  if (ESCPOS_DRIVERS.includes(driver)) return ["thermal80", "thermal58"];
  if (driver === "raw_escp") return ["dot241"];
  return ["A4"];
}

/**
 * 内网摄像机（非本机 USB）按驱动给出的默认端点，逐字对齐 camera.rs `target_from_config`
 * 认的 `snapshotUrl` 键与海康 / 大华的实际端点，免得现场还要照文档抄一栏。
 *  - `snapshot`：过磅抓拍走的主码流整图；
 *  - `preview`：子码流的 HTTP 抓图——联机测试用它，`rtspUrl` 留空时实时画面的轨道号也是从这里的通道号推出来的；
 *  - `rtsp`：工作台实时画面拉的那条**子码流**轨道（`camera_stream.rs` 读 `rtspUrl`）。
 *    海康不填也能推出来（从 `channels/<数字>` 抄同一个通道号），大华推不出、必须填。
 */
const CAMERA_NET: Record<string, { snapshot?: string; preview?: string; rtsp?: string }> = {
  hikvision_isapi: {
    snapshot: "/ISAPI/Streaming/channels/101/picture",
    preview: "/ISAPI/Streaming/channels/102/picture",
    rtsp: "/Streaming/Channels/102",
  },
  dahua_cgi: { snapshot: "/cgi-bin/snapshot.cgi?channel=1", rtsp: "/cam/realmonitor?channel=1&subtype=1" },
};

/**
 * 内网摄像机的登记字段。
 *
 * 海康 ISAPI（`hikvision_isapi`）默认**只露 IP + 登录用户 + 口令**：HTTP 端口、认证方式、
 * 抓拍/预览路径、RTSP 地址与端口都由 `camera_detect` 探测回填（见「自动检测参数」按钮），
 * 现场不必照文档抄一栏。`advanced` 打开时才把这些项逐项摆出来，供特殊情况手改。
 * 大华 CGI（`dahua_cgi`）本轮没有可靠的自动探测，端口/路径/认证仍全程手填。
 */
function networkCameraFields(driver: string, advanced: boolean): FieldSpec[] {
  const net = CAMERA_NET[driver];
  const base: FieldSpec[] = [
    { key: "host", label: "地址（IP）", placeholder: "192.168.10.199", required: true },
    { key: "user", label: "登录用户", placeholder: "admin" },
    { key: "password", label: "登录密码", placeholder: "留空＝匿名", input: "password" },
  ];
  // 海康探测回填的这几项：折叠时不进表单，但仍在 buildSubmitConfig 里从 cfg 带出去落库
  const hikAdvanced: FieldSpec[] = [
    { key: "snapshotUrl", label: "抓图路径", placeholder: net?.snapshot ?? "/ISAPI/Streaming/channels/101/picture" },
    { key: "previewUrl", label: "预览路径", placeholder: net?.preview ?? "/ISAPI/Streaming/channels/102/picture" },
    { key: "rtspUrl", label: "RTSP 地址", placeholder: net?.rtsp ?? "/Streaming/Channels/102" },
    { key: "rtspPort", label: "RTSP 端口", placeholder: "554" },
    { key: "port", label: "HTTP 端口", placeholder: "80" },
    { key: "auth", label: "认证方式", options: ["digest", "basic", "none"] },
  ];
  if (driver !== "hikvision_isapi") {
    // 大华：地址 + 三条路径 + 两个端口 + 用户口令 + 认证，全程手填（口令排在中段，与旧表单一致）
    return [
      base[0],
      { key: "snapshotUrl", label: "抓图路径", placeholder: net?.snapshot ?? "/cgi-bin/snapshot.cgi?channel=1", required: true },
      { key: "previewUrl", label: "预览路径（可留空）", placeholder: net?.preview ?? "" },
      { key: "rtspUrl", label: "RTSP 地址", placeholder: net?.rtsp ?? "/cam/realmonitor?channel=1&subtype=1" },
      { key: "rtspPort", label: "RTSP 端口（默认 554）", placeholder: "554" },
      { key: "port", label: "端口（默认 80）", placeholder: "80" },
      base[1],
      base[2],
      { key: "auth", label: "认证方式", options: ["digest", "basic"] },
    ];
  }
  return advanced ? [...base, ...hikAdvanced] : base;
}

/** 一栏关键参数随驱动动态化：打印机纸型、本机摄像头靠扫描回填（无需手填 host），其余照 DEVICE_SPEC 原样 */
function fieldsFor(kind: DeviceKind, driver: string, camAdvanced: boolean): FieldSpec[] {
  if (kind === "printer") return [{ key: "paper", label: "纸型", options: paperOptionsFor(driver), required: true }];
  if (kind === "camera") {
    if (driver === "local_uvc") return [];
    if (driver === "mock") return DEVICE_SPEC.camera.fields;
    return networkCameraFields(driver, camAdvanced);
  }
  return DEVICE_SPEC[kind].fields;
}

/** 把 USB 的 VID/PID 数字写成台账里那种 `0x0483`，与 devices.rs parse_hex、print-guard parseHex 同口径 */
function toHexId(n: number | null): string {
  return n == null ? "" : `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;
}

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

  const { data: devices = [], isPending } = useQuery({ queryKey: ["devices"], queryFn: () => api.listDevices() });
  const [selected, setSelected] = useState<string | null>(null);
  const active = devices.find((d) => d.code === selected) ?? devices.find((d) => d.is_default === 1) ?? devices[0] ?? null;

  /** 分组视图：all 平铺全部设备；其余每个值对应一种设备类型，点该 tab 只看这一类 */
  const [groupTab, setGroupTab] = useState<"all" | DeviceKind>("all");
  const visibleDevices = groupTab === "all" ? devices : devices.filter((d) => d.kind === groupTab);

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
  /** 非空＝编辑这台已登记设备；null＝新增。编辑复用同一张表单，但编码与类型锁定 */
  const [editing, setEditing] = useState<DeviceConfig | null>(null);
  const isEdit = editing !== null;

  /** 待确认删除的设备（错录清理）；null＝无。有业务历史的真删会被后端拒 */
  const [pendingDelete, setPendingDelete] = useState<DeviceConfig | null>(null);

  /** 「扫描本机打印机」两路结果：热敏直连（VID/PID）与系统队列（按名字）各存一份，null＝还没扫过 */
  const [printScan, setPrintScan] = useState<{ escpos: NativePrinterDevice[]; queues: NativeWindowsPrinter[] } | null>(null);
  const [scanState, setScanState] = useState<"idle" | "running" | "done">("idle");
  const [scanHint, setScanHint] = useState<string | null>(null);

  /** 本机读卡器探测结果（进程内单台 USB 设备，非多选）：connected + SAM 号 + 是否支持指纹 */
  const [readerProbe, setReaderProbe] = useState<NativeReaderStatus | null>(null);
  const [readerScanState, setReaderScanState] = useState<"idle" | "running" | "done">("idle");
  const [readerHint, setReaderHint] = useState<string | null>(null);

  /** 本机 USB / 内置摄像头列表（Media Foundation 扫描回填，可多选一） */
  const [cameraScan, setCameraScan] = useState<NativeLocalCamera[] | null>(null);
  const [camScanState, setCamScanState] = useState<"idle" | "running" | "done">("idle");
  const [camHint, setCamHint] = useState<string | null>(null);

  /** 海康自动检测：状态 + 结论一句话；camAdvanced＝是否展开高级参数手改（默认折叠只填 IP+账号密码） */
  const [camDetectState, setCamDetectState] = useState<"idle" | "running" | "done">("idle");
  const [camDetectMsg, setCamDetectMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [camAdvanced, setCamAdvanced] = useState(false);

  /** 本机串口列表（地磅登记表单「串口」下拉的数据源） */
  const [serialScan, setSerialScan] = useState<string[] | null>(null);
  const [serialScanState, setSerialScanState] = useState<"idle" | "running" | "done">("idle");
  const [serialHint, setSerialHint] = useState<string | null>(null);

  /** 重开表单或换设备类型时清掉两类探测缓存，让它们各自重新扫一遍（现场可能刚插线/换机） */
  function resetDeviceProbeScans() {
    setPrintScan(null);
    setScanState("idle");
    setScanHint(null);
    setReaderProbe(null);
    setReaderScanState("idle");
    setReaderHint(null);
    setCameraScan(null);
    setCamScanState("idle");
    setCamHint(null);
    setCamDetectState("idle");
    setCamDetectMsg(null);
    setSerialScan(null);
    setSerialScanState("idle");
    setSerialHint(null);
  }

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
    setEditing(null);
    resetDeviceProbeScans();
    setAddOpen(true);
  }

  /** 编辑已登记设备：把台账行灌回同一张表单，编码与类型随后锁定 */
  function openEdit(d: DeviceConfig) {
    const cfg: Record<string, string> = {};
    for (const [k, v] of Object.entries(d.config)) cfg[k] = String(v);
    setForm({
      kind: d.kind,
      code: d.code,
      name: d.name,
      driver: d.driver,
      cfg,
      isDefault: d.is_default === 1,
      isMock: d.is_mock === 1,
    });
    setEditing(d);
    resetDeviceProbeScans();
    setAddOpen(true);
  }

  function patchDeviceForm(p: Partial<DeviceForm>) {
    setForm((f) => ({ ...f, ...p }));
  }

  /** 换类型时同步重置建议编码、驱动候选与关键参数，避免带着上一类的不兼容字段提交 */
  function patchKind(kind: DeviceKind) {
    setForm((f) => ({ ...f, kind, code: nextCode(kind), driver: DEVICE_SPEC[kind].drivers[0], cfg: {} }));
    resetDeviceProbeScans();
  }

  /** 换驱动时把纸型收敛到该驱动合法值：旧纸型不在新候选里就清掉，交给 fieldValue 回填驱动默认纸型 */
  function patchDriver(driver: string) {
    // 驱动一换，上一轮的自动检测结论就不再作数（海康 ↔ 大华 ↔ 本机是三套寻址）
    if (form.kind === "camera") {
      setCamDetectState("idle");
      setCamDetectMsg(null);
    }
    setForm((f) => {
      const cfg = { ...f.cfg };
      if (f.kind === "printer" && cfg.paper && !paperOptionsFor(driver).includes(cfg.paper)) delete cfg.paper;
      if (f.kind === "camera") {
        // 本机 ↔ 内网两套寻址互斥：切走就把另一套的键清掉，别让 local 的 deviceId 混进网络机的配置
        if (driver === "local_uvc") {
          delete cfg.host;
          delete cfg.user;
        } else {
          delete cfg.transport;
          delete cfg.deviceName;
          delete cfg.deviceId;
          // 内网机：抓图 / 预览 / 拉流三条路径预填成该驱动默认值，但已手填过的不动（现场换驱动不该丢掉自己配的通道号）
          const snap = CAMERA_NET[driver]?.snapshot;
          const preview = CAMERA_NET[driver]?.preview;
          const rtsp = CAMERA_NET[driver]?.rtsp;
          if (snap && !cfg.snapshotUrl) cfg.snapshotUrl = snap;
          if (preview && !cfg.previewUrl) cfg.previewUrl = preview;
          if (rtsp && !cfg.rtspUrl) cfg.rtspUrl = rtsp;
        }
      }
      return { ...f, driver, cfg };
    });
  }

  function patchCfg(key: string, v: string) {
    // 改了寻址三要素（IP / 用户 / 口令），之前的自动检测结论就作废：把状态打回未检测，
    // 提示现场重新检测，而不是拿一份对不上当前输入的旧配置去存。
    if ((key === "host" || key === "user" || key === "password") && form.kind === "camera") {
      setCamDetectState("idle");
      setCamDetectMsg(null);
    }
    setForm((f) => ({ ...f, cfg: { ...f.cfg, [key]: v } }));
  }

  /**
   * 海康「自动检测参数」：拿已填的 IP +（可选）端口 + 用户 + 口令去探一次，
   * 成功就把 HTTP 端口、认证方式、抓拍/预览路径、RTSP 地址与端口回填进配置，
   * 现场不用自己填。浏览器预览没有原生通道，明说一句并保留驱动默认路径（之后联机测试再验）。
   */
  async function runCameraDetect() {
    const host = (form.cfg.host ?? "").trim();
    if (!host) {
      setCamDetectMsg({ ok: false, text: "先填摄像机 IP 地址，再自动检测。" });
      return;
    }
    if (!runningInTauri()) {
      setCamDetectState("done");
      setCamDetectMsg({ ok: false, text: "浏览器预览探测不到内网摄像机。已按默认路径填好，请用桌面端自动检测，或在「高级参数」里手填后保存。" });
      return;
    }
    setCamDetectState("running");
    setCamDetectMsg(null);
    const r = await nativeCamera.detect({
      host,
      port: form.cfg.port,
      user: form.cfg.user,
      password: form.cfg.password,
    });
    setCamDetectState("done");
    if (!r.available) {
      setCamDetectMsg({ ok: false, text: r.error ?? "没有原生设备通道，无法探测" });
      return;
    }
    if (r.error) {
      setCamDetectMsg({ ok: false, text: `检测失败：${r.error}` });
      return;
    }
    const detected = r.data;
    if (!detected) {
      setCamDetectMsg({ ok: false, text: "检测没有返回结果，请在「高级参数」里手填。" });
      return;
    }
    setForm((f) => ({ ...f, cfg: { ...f.cfg, ...detected.config } }));
    setCamDetectMsg({ ok: true, text: detected.message });
  }

  /** 下拉字段未手动改过时以第一项为准，避免"界面显示了值、校验却说必填缺失" */
  function fieldValue(f: FieldSpec): string {
    return (form.cfg[f.key] ?? (f.options ? f.options[0] : "")).trim();
  }

  /**
   * 扫描本机打印机：usbprint 直连小票机 + Windows 打印队列两路并发。
   * 浏览器预览问不到设备，明说一句并允许退回盲登记（之后在右侧面板配置），不编一组假设备。
   */
  async function runPrinterScan() {
    setScanState("running");
    setScanHint(null);
    if (!runningInTauri()) {
      setPrintScan(null);
      setScanState("done");
      setScanHint("浏览器预览问不到本机打印机。请用桌面端扫描，或先按纸型登记、之后在右侧面板配置。");
      return;
    }
    const [e, q] = await Promise.all([nativePrinter.list(), nativePrinter.listQueues()]);
    const escpos = e.available && !e.error ? (e.data ?? []) : [];
    const queues = q.available && !q.error ? (q.data ?? []) : [];
    setPrintScan({ escpos, queues });
    setScanState("done");
    const errs = [e.error, q.error].filter((x): x is string => !!x);
    if (escpos.length === 0 && queues.length === 0) {
      setScanHint(errs.length ? `扫描失败：${errs.join("；")}` : "本机没有扫到打印机。确认已开机 / 接线，或改用手动登记后在右侧面板配置。");
    } else if (errs.length) {
      setScanHint(`部分通道未取到：${errs.join("；")}`);
    }
  }

  /**
   * 探测本机读卡器：进程内单台 USB 设备，走现成的 idcard_status（问得到 SAM 号才算真在线）。
   * 它不是"多选一"，而是"这台机在不在、凭什么说它在"——探测到就把 SAM 号写进名称建议，
   * 探测不到就明说原因，浏览器预览同样回退到手填，不编一个假读卡器。
   */
  async function runIdcardProbe() {
    setReaderScanState("running");
    setReaderHint(null);
    if (!runningInTauri()) {
      setReaderProbe(null);
      setReaderScanState("done");
      setReaderHint("浏览器预览探测不到读卡器。请用桌面端探测，或先按驱动登记、之后在工作台读卡时再验。");
      return;
    }
    const r = await nativeIdcard.status();
    setReaderScanState("done");
    if (!r.available) {
      setReaderProbe(null);
      setReaderHint(r.error ?? "没有原生设备通道，无法探测读卡器");
      return;
    }
    const st: NativeReaderStatus = r.data ?? { connected: false, samId: null, fingerprint: false, error: r.error ?? "探测失败" };
    setReaderProbe(st);
    if (st.connected) {
      setForm((f) => (f.name.trim() ? f : { ...f, name: `读卡器${st.samId ? ` · SAM ${st.samId}` : ""}` }));
    } else {
      setReaderHint(st.error ?? "本机没有探测到读卡器：确认已插到位、是免驱 USB-HID，或在配置里指定 Sdtapi.dll 路径。");
    }
  }

  /**
   * 扫描本机 USB / 内置摄像头（Media Foundation）。这是"扫描本机连接的摄像头"里本轮能真做的那半——
   * 局域网海康 / 大华摄像机没有可靠的本地枚举，走下面的手动登记（选内网 IP 驱动填地址）。
   */
  async function runCameraScan() {
    setCamScanState("running");
    setCamHint(null);
    if (!runningInTauri()) {
      setCameraScan(null);
      setCamScanState("done");
      setCamHint("浏览器预览扫描不到本机摄像头。请用桌面端扫描，或改用内网 IP 摄像机手动登记。");
      return;
    }
    const r = await nativeCamera.listLocal();
    setCamScanState("done");
    if (!r.available) {
      setCameraScan(null);
      setCamHint(r.error ?? "没有原生设备通道，无法扫描摄像头");
      return;
    }
    if (r.error) {
      setCameraScan(null);
      setCamHint(`扫描失败：${r.error}`);
      return;
    }
    const list = r.data ?? [];
    setCameraScan(list);
    if (list.length === 0) setCamHint("本机没有扫到 USB / 内置摄像头。确认已插好并被系统识别（设备管理器 → 照相机），或改用内网 IP 摄像机手动登记。");
  }

  /**
   * 扫描本机串口：地磅走 RS-232，现场通常记不住 COM 号。
   * 扫到就给下拉选择，扫不到回退手填并说明原因（浏览器预览没有原生通道）。
   */
  async function runSerialScan() {
    setSerialScanState("running");
    setSerialHint(null);
    if (!runningInTauri()) {
      setSerialScan(null);
      setSerialScanState("done");
      setSerialHint("浏览器预览问不到本机串口。请用桌面端扫描，或先手动输入串口号。");
      return;
    }
    const r = await nativeSerial.list();
    setSerialScanState("done");
    if (!r.available) {
      setSerialScan(null);
      setSerialHint(r.error ?? "没有原生设备通道，无法枚举串口");
      return;
    }
    if (r.error) {
      setSerialScan(null);
      setSerialHint(`扫描失败：${r.error}`);
      return;
    }
    const list = r.data ?? [];
    setSerialScan(list);
    if (list.length === 0) setSerialHint("本机没有扫到串口。确认称重仪表已接电、USB 转串口驱动已安装，或改用手动输入。");
  }

  /** 选中一个扫到的串口：回填到 cfg.port（仍可手改） */
  function pickSerial(v: string) {
    setForm((f) => ({ ...f, cfg: { ...f.cfg, port: v } }));
  }

  const serialOptions = useMemo(() => (serialScan ?? []).map((p) => ({ value: p, label: p })), [serialScan]);
  const currentSerialKey = serialScan?.includes(form.cfg.port ?? "") ? (form.cfg.port ?? "") : "";

  /** 选中一台本机摄像头：驱动定为 local_uvc，记 deviceId / deviceName 与名称建议（可再手改） */
  function pickCamera(v: string) {
    if (!v || !cameraScan) return;
    const dev = cameraScan.find((d) => d.deviceId === v);
    if (!dev) return;
    setForm((f) => ({
      ...f,
      kind: "camera",
      driver: "local_uvc",
      name: f.name.trim() ? f.name : `摄像头 ${dev.name}`,
      cfg: { ...f.cfg, transport: "local", deviceName: dev.name, deviceId: dev.deviceId },
    }));
  }

  const cameraOptions = useMemo(() => (cameraScan ?? []).map((d) => ({ value: d.deviceId, label: d.name || d.deviceId })), [cameraScan]);
  const currentCameraKey = cameraScan?.some((d) => d.deviceId === form.cfg.deviceId) ? (form.cfg.deviceId ?? "") : "";

  // 过磅抓拍勾选上限（04 §4）：一次过磅最多 3 台相机各拍一张，与真库
  // `camera::MAX_CAPTURE_CAMERAS` 同数。这里只数「已启用且已勾 captureOnWeigh」的相机，
  // 编辑当前这台时把它自己排除在外（它勾没勾由表单即时决定），勾第 4 台时挡住并说明。
  const captureOnWeighCount = useMemo(
    () =>
      devices.filter(
        (d) => d.kind === "camera" && d.is_enabled === 1 && d.config?.captureOnWeigh === true && d.code !== form.code,
      ).length,
    [devices, form.code],
  );
  const captureCheckedThis = form.cfg.captureOnWeigh === "true";
  const captureQuotaReached = captureCheckedThis && captureOnWeighCount >= 3;

  // 打开登记表单并选到打印机 / 读卡器 / 摄像头时各自动扫一次；换开表单或换类型（复位 idle）会重扫，现场可能刚插线
  useEffect(() => {
    if (!addOpen) return;
    if (form.kind === "printer" && scanState === "idle") void runPrinterScan();
    if (form.kind === "idcard" && readerScanState === "idle") void runIdcardProbe();
    if (form.kind === "camera" && camScanState === "idle") void runCameraScan();
    if (SERIAL_KINDS.includes(form.kind) && serialScanState === "idle") void runSerialScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addOpen, form.kind, scanState, readerScanState, camScanState, serialScanState]);

  /** 选中一台扫到的设备：回填对应驱动、纸型、名称建议与寻址参数（VID/PID 或队列名），仍可手改 */
  function pickPrinterScan(v: string) {
    if (!v || !printScan) return;
    if (v.startsWith("e:")) {
      const dev = printScan.escpos.find((d) => `e:${d.devicePath}` === v);
      if (!dev) return;
      const vid = toHexId(dev.vendorId);
      const pid = toHexId(dev.productId);
      setForm((f) => ({
        ...f,
        kind: "printer",
        driver: "escpos_usbprint",
        name: f.name.trim() ? f.name : `小票机 ${dev.label}`,
        cfg: { ...f.cfg, paper: "thermal80", transport: "usbprint.sys", ...(vid ? { vid } : {}), ...(pid ? { pid } : {}) },
      }));
      return;
    }
    const dev = printScan.queues.find((d) => `q:${d.name}` === v);
    if (!dev) return;
    setForm((f) => {
      // 选队列机意味着走打印队列：热敏驱动下切回窗口预览；已是 preview / raw_escp 则尊重当前选择
      const driver = ESCPOS_DRIVERS.includes(f.driver) ? "preview" : f.driver;
      return { ...f, kind: "printer", driver, name: f.name.trim() ? f.name : dev.name, cfg: { ...f.cfg, paper: paperOptionsFor(driver)[0], rawQueue: dev.name } };
    });
  }

  /** 分组下拉项：直连小票机在上、系统队列在下，标签带上端口 / 默认 / 网络帮现场对号入座 */
  const scanGroups = useMemo(() => {
    if (!printScan) return [];
    const groups: { label: string; options: { value: string; label: string }[] }[] = [];
    if (printScan.escpos.length) {
      groups.push({ label: "直连小票机（USB · ESC/POS）", options: printScan.escpos.map((d) => ({ value: `e:${d.devicePath}`, label: d.label })) });
    }
    if (printScan.queues.length) {
      groups.push({
        label: "本机打印机队列（窗口预览 / 针式）",
        options: printScan.queues.map((d) => ({ value: `q:${d.name}`, label: `${d.name}（${d.port}${d.isDefault ? " · 默认" : ""}${d.network ? " · 网络" : ""}）` })),
      });
    }
    return groups;
  }, [printScan]);
  const hasScanHits = scanGroups.some((g) => g.options.length > 0);

  /** 把当前配置回映到扫到的某台设备，让下拉显示"选中的是哪台"；改过参数对不上就是空（未选择） */
  const currentScanKey = useMemo(() => {
    if (!printScan) return "";
    if (ESCPOS_DRIVERS.includes(form.driver) && form.cfg.vid && form.cfg.pid) {
      const hit = printScan.escpos.find((d) => toHexId(d.vendorId) === form.cfg.vid && toHexId(d.productId) === form.cfg.pid);
      if (hit) return `e:${hit.devicePath}`;
    }
    if (form.cfg.rawQueue && printScan.queues.some((d) => d.name === form.cfg.rawQueue)) return `q:${form.cfg.rawQueue}`;
    return "";
  }, [printScan, form.driver, form.cfg]);

  const addFields = fieldsFor(form.kind, form.driver, camAdvanced);
  // 校验错误按字段归位：红框 + 紧贴控件的红字标在出错的表单项上，不在抽屉底部聚合清单
  const trimmedCode = form.code.trim();
  const nameErr = !form.name.trim() ? "名称必填" : "";
  // 编码留空＝交给后端按类型补号（见 devices.rs 的 next_code）；
  // 编辑时编码锁定（台账主键），不再校验其格式/唯一性
  const codeErr = !isEdit && trimmedCode
    ? !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(trimmedCode)
      ? "编码需字母开头，仅含字母/数字/下划线/连字符"
      : devices.some((d) => d.code === trimmedCode)
        ? `编码 ${trimmedCode} 已存在`
        : ""
    : "";
  /** 动态参数（addFields）逐项的必填错误，按 f.key 挂到对应控件上 */
  const dynErr = new Map<string, string>();
  for (const f of addFields) {
    if (f.required && !fieldValue(f)) dynErr.set(f.key, `${f.label}必填`);
  }
  // 串口类设备的 port 由扫描区/手动输入维护，不在 addFields 里
  const portErr = SERIAL_KINDS.includes(form.kind) && !(form.cfg.port ?? "").trim() ? "串口必填" : "";
  // 过磅抓拍一次最多 3 台：勾第 4 台就拦下，逼现场先取消一台再保存（04 §4）——挂在「过磅抓拍」开关下
  const quotaErr = form.kind === "camera" && captureQuotaReached ? "每次过磅最多 3 台相机抓拍：已有 3 台勾了「过磅抓拍」，请先取消其中一台" : "";
  const addHasErr = !!(nameErr || codeErr || portErr || quotaErr || dynErr.size > 0);

  /** 表单 → config：字段值 + 扫描/手填的寻址参数（这些键不在 addFields 里） */
  function buildSubmitConfig(): Record<string, string | number | boolean> {
    const config: Record<string, string | number | boolean> = {};
    for (const f of addFields) {
      const v = fieldValue(f);
      if (v) config[f.key] = v;
    }
    // 打印机：纸型之外的 vid/pid/transport/rawQueue 一并落库
    if (form.kind === "printer") {
      for (const k of ["vid", "pid", "transport", "rawQueue"]) {
        const v = (form.cfg[k] ?? "").trim();
        if (v) config[k] = v;
      }
    }
    // 摄像头：本机 USB 摄像头靠 deviceId / deviceName 寻址（transport=local），网络机走 host/user fields
    if (form.kind === "camera") {
      for (const k of ["transport", "deviceName", "deviceId"]) {
        const v = (form.cfg[k] ?? "").trim();
        if (v) config[k] = v;
      }
      // 海康默认折叠、由自动检测回填的这几项不在 addFields 里，但必须照样落库——
      // 否则「只填 IP+账号密码」检出来的端口/路径/认证会在提交时被静默抹掉。
      if (form.driver === "hikvision_isapi") {
        for (const k of ["port", "snapshotUrl", "previewUrl", "rtspUrl", "rtspPort", "auth"]) {
          const v = (form.cfg[k] ?? "").trim();
          if (v) config[k] = v;
        }
      }
      // 「过磅抓拍」以布尔落库（与迁移 0019、真库 `camera::capture_on_weigh_enabled` 同形）：
      // 勾了写 true，没勾就不写这个键——config 整体替换，取消勾选即从库里消失。
      if (form.cfg.captureOnWeigh === "true") config.captureOnWeigh = true;
    }
    // 串口类设备：port 由扫描区/手动输入维护，不在 addFields 里
    if (SERIAL_KINDS.includes(form.kind)) {
      const v = (form.cfg.port ?? "").trim();
      if (v) config.port = v;
    }
    return config;
  }
  const submitConfig = buildSubmitConfig();

  function afterSave(d: DeviceConfig, added: boolean) {
    toast.success(added ? `已登记「${d.name}」，请在右侧做联机测试` : `已更新「${d.name}」${d.last_status === "unknown" ? "，改动使驱动/配置回到未检测，请重测" : ""}`);
    setSelected(d.code);
    setAddOpen(false);
    setEditing(null);
    setForm(emptyDeviceForm());
    void queryClient.invalidateQueries({ queryKey: ["devices"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    void queryClient.invalidateQueries({ queryKey: ["audits"] });
  }

  const createDevice = useMutation({
    mutationFn: () =>
      api.createDevice({
        code: trimmedCode,
        name: form.name.trim(),
        kind: form.kind,
        driver: form.driver,
        config: submitConfig,
        is_default: form.isDefault,
        is_mock: form.isMock,
        operator_id: actorId(),
      }),
    onSuccess: (d) => afterSave(d, true),
    onError: (e: Error) => toast.error(`登记失败：${e.message}`),
  });

  const updateDevice = useMutation({
    mutationFn: () =>
      api.updateDevice({
        code: (editing as DeviceConfig).code,
        name: form.name.trim(),
        kind: form.kind,
        driver: form.driver,
        config: submitConfig,
        is_default: form.isDefault,
        operator_id: actorId(),
      }),
    onSuccess: (d) => afterSave(d, false),
    onError: (e: Error) => toast.error(`修改失败：${e.message}`),
  });

  const deviceSaving = createDevice.isPending || updateDevice.isPending;
  function submitDevice() {
    if (isEdit) updateDevice.mutate();
    else createDevice.mutate();
  }

  const deleteDevice = useMutation({
    mutationFn: (code: string) => api.deleteDevice(code, actorId()),
    onSuccess: (_list, code) => {
      const name = devices.find((d) => d.code === code)?.name ?? code;
      toast.success(`已删除「${name}」`);
      setPendingDelete(null);
      // 删除是从「编辑」弹窗里发起的，成功后一并关掉编辑弹窗并复位表单
      setAddOpen(false);
      setEditing(null);
      setForm(emptyDeviceForm());
      if (selected === code) setSelected(null);
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["audits"] });
    },
    onError: (e: Error) => {
      // 有业务历史时后端拒删：把原因原样透出去，并保留确认框让用户改点「停用」
      toast.error(e.message);
    },
  });

  const offlineCount = devices.filter((d) => d.is_enabled === 1 && d.last_status !== "online").length;
  const mockCount = devices.filter((d) => d.is_mock === 1).length;

  async function exportConfig() {
    await exportCsvFile({
      filename: csvName("设备配置"),
      headers: ["编码", "名称", "类型", "驱动", "启用", "Mock", "默认", "状态", "最后成功", "错误计数", "最后错误", "配置JSON"],
      rows: devices.map((d) => [
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
      unit: "台设备的配置快照",
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="设备中心"
        description={`${devices.length} 台已登记设备，${offlineCount > 0 ? `${offlineCount} 台已启用但非在线` : "启用设备全部在线"}`}
        tabs={
          <Tabs value={groupTab} onValueChange={(v) => setGroupTab(v as "all" | DeviceKind)} className="gap-0">
            <TabsList className="mb-1 h-auto max-w-full flex-wrap justify-start">
              <TabsTrigger value="all" className="flex-none text-sm">
                全部
                {devices.length > 0 && <span className="tnum text-muted-foreground">（{devices.length}）</span>}
              </TabsTrigger>
              {KIND_ORDER.map((kind) => {
                const n = devices.filter((d) => d.kind === kind).length;
                return (
                  <TabsTrigger key={kind} value={kind} className="flex-none text-sm">
                    {DEVICE_KIND[kind]}
                    <span className="tnum text-muted-foreground">（{n}）</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        }
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
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {/* 灰按钮必须自己解释原因，否则现场只会得出"软件坏了"的结论（05 §6.5） */}
        {!can("device.manage") && (
          <CallOut
            tone="info"
            title="只读视图：当前操作员无权改动设备"
            action={
              <Button size="xs" variant="outline" render={<Link to="/system/$section" params={{ section: "staff" }} />}>
                去员工与岗位
              </Button>
            }
          >
            {actor ? `「${actor.displayName} · ${ROLE[actor.role]}」` : "—"}没有设备管理权限，仅站长可启用 / 停用设备、切换 Mock。点卡片标题仍可联机测试、看状态与原始帧。要改得换站长账号：入口在左侧栏底部「当前操作员」，切换需要密码。
          </CallOut>
        )}

        {isPending ? (
          <p className="text-sm text-muted-foreground">正在读取设备清单…</p>
        ) : (
          <div className="mt-3 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_26rem]">
            <div className="flex min-w-0 flex-col gap-4">
              {groupTab === "all" ? (
                KIND_ORDER.map((kind) => {
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
                            onEdit={() => openEdit(d)}
                            onToggleEnabled={(v) => toggle.mutate({ code: d.code, enabled: v })}
                            onToggleMock={(v) => toggle.mutate({ code: d.code, mock: v })}
                          />
                        ))}
                      </div>
                    </section>
                  );
                })
              ) : visibleDevices.length === 0 ? (
                <EmptyState title="该分类下还没有设备" description="点击顶部「添加设备」登记一台。" />
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {visibleDevices.map((d) => (
                    <DeviceCard
                      key={d.code}
                      d={d}
                      active={active?.code === d.code}
                      locked={!can("device.manage")}
                      onSelect={() => setSelected(d.code)}
                      onEdit={() => openEdit(d)}
                      onToggleEnabled={(v) => toggle.mutate({ code: d.code, enabled: v })}
                      onToggleMock={(v) => toggle.mutate({ code: d.code, mock: v })}
                    />
                  ))}
                </div>
              )}
            </div>

            <Card size="sm" className="min-w-0 gap-3 self-start px-3 py-3 xl:sticky xl:top-4">
              {active ? (
                <TestPanel key={active.code} d={active} />
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
            </Card>
          </div>
        )}

        <CallOut className="mt-4" tone="info" title="小票机配置可写入，地磅串口参数暂未开放">
          小票机的 VID / PID / 纸宽在右侧面板「配置…」里改。
          <span className="font-medium">保存前必须先联机测试通过</span>：改任一字段，旧的测试结果即作废。
        </CallOut>
        {mockCount > 0 && <p className="pb-2 text-xs text-muted-foreground">另有 {mockCount} 台设备处于 Mock 模式。</p>}
      </div>

      <Dialog
        open={addOpen}
        onOpenChange={(v) => {
          setAddOpen(v);
          if (!v) {
            setEditing(null);
            createDevice.reset();
            updateDevice.reset();
          }
        }}
      >
        <DialogContent className="max-w-[600px]">
          <DialogHeader>
            <DialogTitle className="text-sm">{isEdit ? `编辑设备 · ${editing?.code}` : "添加设备"}</DialogTitle>
            <DialogDescription className="text-xs">
              {isEdit
                ? "名称、驱动与关键参数可改；编码与类型不可改，错录类型请停用本台后重新登记。改了驱动或配置需重测才转绿。"
                : "新登记的设备先记「未检测」，保存后在右侧联机测试通过才转绿。编码需唯一。"}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              设备类型{isEdit ? "（不可改）" : ""}
              <Choose
                aria-label="设备类型"
                value={form.kind}
                disabled={isEdit}
                onChange={(v) => patchKind(v as DeviceKind)}
                options={KIND_ORDER.map((k) => ({ value: k, label: DEVICE_KIND[k] }))}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              驱动 / 协议
              <Choose
                aria-label="驱动协议"
                value={form.driver}
                onChange={(v) => patchDriver(v)}
                options={DEVICE_SPEC[form.kind].drivers.map((d) => ({ value: d, label: d }))}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              设备名称 *
              <Input
                value={form.name}
                onChange={(e) => patchDeviceForm({ name: e.target.value })}
                placeholder="如：3 号地磅（耀华 XK3190-A9）"
                aria-invalid={nameErr ? true : undefined}
                className="text-sm"
              />
              {!!nameErr && <span className="text-destructive">{nameErr}</span>}
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              设备编码 {isEdit ? "（不可改）" : "（选填）"}
              <Input
                value={form.code}
                onChange={(e) => patchDeviceForm({ code: e.target.value })}
                placeholder={`留空自动生成，如 ${nextCode(form.kind)}`}
                disabled={isEdit}
                aria-invalid={codeErr ? true : undefined}
                className="tnum text-sm font-mono"
              />
              {!!codeErr && <span className="text-destructive">{codeErr}</span>}
            </Label>

            {form.kind === "printer" && (
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">本机打印机（自动扫描，选中即回填下方参数）</span>
                  <Button size="xs" variant="outline" onClick={() => void runPrinterScan()} disabled={scanState === "running"}>
                    {scanState === "running" ? "扫描中…" : "重新扫描"}
                  </Button>
                </div>
                {scanState === "running" ? (
                  <p className="text-xs text-muted-foreground">正在扫描本机打印机…</p>
                ) : hasScanHits ? (
                  <Choose
                    size="sm"
                    aria-label="本机打印机"
                    value={currentScanKey}
                    onChange={pickPrinterScan}
                    options={[{ value: "", label: "— 手动填写，不从扫描结果回填 —" }]}
                    groups={scanGroups}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">{scanHint ?? "尚未扫描到本机打印机，可先按下方纸型手动登记。"}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  选直连小票机回填 VID/PID，选系统打印队列回填打印机名。两者都会给出名称建议，可再手改。
                </p>
              </div>
            )}

            {form.kind === "idcard" && (
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">本机读卡器（自动探测，选一台）</span>
                  <Button size="xs" variant="outline" onClick={() => void runIdcardProbe()} disabled={readerScanState === "running"}>
                    {readerScanState === "running" ? "探测中…" : "重新探测"}
                  </Button>
                </div>
                {readerScanState === "running" ? (
                  <p className="text-xs text-muted-foreground">正在探测本机读卡器…</p>
                ) : readerProbe?.connected ? (
                  <CallOut tone="success" title="已探测到读卡器，登记后即可联机读卡">
                    <span className="tnum">
                      读卡器编号 {readerProbe.samId ?? "未读到"} · 指纹 {readerProbe.fingerprint ? "支持" : "不支持"}
                    </span>
                  </CallOut>
                ) : (
                  <p className="text-xs text-muted-foreground">{readerHint ?? "尚未探测到读卡器，可先按驱动登记，之后在工作台读卡时再验。"}</p>
                )}
              </div>
            )}

            {form.kind === "camera" && (
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">本机摄像头（自动扫描 USB / 内置，选一台即回填）</span>
                  <Button size="xs" variant="outline" onClick={() => void runCameraScan()} disabled={camScanState === "running"}>
                    {camScanState === "running" ? "扫描中…" : "重新扫描"}
                  </Button>
                </div>
                {camScanState === "running" ? (
                  <p className="text-xs text-muted-foreground">正在扫描本机摄像头…</p>
                ) : cameraOptions.length > 0 ? (
                  <Choose
                    size="sm"
                    aria-label="本机摄像头"
                    value={currentCameraKey}
                    onChange={pickCamera}
                    options={[{ value: "", label: "— 手动填内网 IP 摄像机（海康 ISAPI / 大华 CGI）—" }, ...cameraOptions]}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">{camHint ?? "尚未扫描到本机摄像头，可改用内网 IP 摄像机手动登记。"}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  选中本机摄像头即回填设备号；要登记内网 IP 摄像机，选上面「手动填」项后在下方填地址与登录用户。
                </p>
                {/* 海康 ISAPI：填完 IP + 登录用户 + 口令后，剩下的端口/路径/认证/RTSP 全部自动检测回填。 */}
                {form.driver === "hikvision_isapi" && (
                  <div className="flex flex-col gap-1.5 border-t pt-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">海康参数自动检测（填好上方地址与登录信息后点一下）</span>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => void runCameraDetect()}
                        disabled={camDetectState === "running" || !(form.cfg.host ?? "").trim()}
                      >
                        {camDetectState === "running" ? "检测中…" : "自动检测参数"}
                      </Button>
                    </div>
                    {camDetectState === "running" ? (
                      <p className="text-xs text-muted-foreground">正在探测这台摄像机…</p>
                    ) : camDetectMsg ? (
                      <CallOut
                        tone={camDetectMsg.ok ? "success" : "danger"}
                        title={camDetectMsg.ok ? "检测成功，已回填参数" : "未能自动检测"}
                      >
                        {camDetectMsg.text}
                      </CallOut>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        端口、认证方式与取图地址由自动探测填写，无需手填。
                      </p>
                    )}
                    <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch checked={camAdvanced} onCheckedChange={setCamAdvanced} aria-label="展开海康高级参数" />
                      高级参数（仅在自动检测不适用时手动改）
                    </Label>
                  </div>
                )}
                {/* 过磅抓拍：这台相机要不要在每次过磅（毛/皮各一捕）时拍一张。本机 USB 与内网 IP 可混着勾，一次最多 3 台。 */}
                <div className="flex flex-col gap-1 border-t pt-1.5">
                  <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      checked={form.cfg.captureOnWeigh === "true"}
                      disabled={captureOnWeighCount >= 3 && form.cfg.captureOnWeigh !== "true"}
                      onCheckedChange={(v) => patchCfg("captureOnWeigh", v ? "true" : "false")}
                      aria-label="过磅抓拍"
                    />
                    过磅时抓拍这台（每次过磅最多 3 台）
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    {captureOnWeighCount >= 3 && form.cfg.captureOnWeigh !== "true"
                      ? `已有 3 台勾了「过磅抓拍」，要先取消其中一台才能勾这台`
                      : `已勾选 ${captureOnWeighCount}${form.cfg.captureOnWeigh === "true" ? " +1" : ""}/3 台参与过磅抓拍`}
                  </p>
                  {!!quotaErr && <p className="text-[11px] text-destructive">{quotaErr}</p>}
                </div>
              </div>
            )}

            {SERIAL_KINDS.includes(form.kind) && (
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">本机串口（自动扫描，选中即回填）</span>
                  <Button size="xs" variant="outline" onClick={() => void runSerialScan()} disabled={serialScanState === "running"}>
                    {serialScanState === "running" ? "扫描中…" : "重新扫描"}
                  </Button>
                </div>
                {serialScanState === "running" ? (
                  <p className="text-xs text-muted-foreground">正在扫描本机串口…</p>
                ) : serialOptions.length > 0 ? (
                  <Choose
                    size="sm"
                    aria-label="本机串口"
                    value={currentSerialKey}
                    onChange={pickSerial}
                    options={[{ value: "", label: "— 手动输入串口号 —" }, ...serialOptions]}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">{serialHint ?? "尚未扫描到本机串口，可在下方手动输入。"}</p>
                )}
                <p className="text-xs text-muted-foreground">浏览器预览里扫不到串口，只能手动填写。</p>
              </div>
            )}

            {SERIAL_KINDS.includes(form.kind) && (
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                串口 *
                <Input
                  value={form.cfg.port ?? ""}
                  onChange={(e) => patchCfg("port", e.target.value)}
                  placeholder="COM3"
                  aria-invalid={portErr ? true : undefined}
                  className="tnum text-sm font-mono"
                />
                {!!portErr && <span className="text-destructive">{portErr}</span>}
              </Label>
            )}

            {addFields.map((f) => (
              <Label key={f.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
                {f.label}
                {f.required ? " *" : ""}
                {f.options ? (
                  <Choose
                    aria-label={f.label}
                    invalid={!!dynErr.get(f.key)}
                    value={fieldValue(f)}
                    onChange={(v) => patchCfg(f.key, v)}
                    options={f.options.map((o) => ({ value: o, label: o }))}
                  />
                ) : (
                  <Input
                    type={f.input === "password" ? "password" : "text"}
                    value={form.cfg[f.key] ?? ""}
                    onChange={(e) => patchCfg(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    aria-invalid={dynErr.get(f.key) ? true : undefined}
                    className="tnum text-sm font-mono"
                  />
                )}
                {!!dynErr.get(f.key) && <span className="text-destructive">{dynErr.get(f.key)}</span>}
              </Label>
            ))}

            <Label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={form.isDefault} onCheckedChange={(v) => patchDeviceForm({ isDefault: v === true })} aria-label="设为默认" />
              设为该类默认设备（工作台优先用它）
            </Label>
            {!isEdit && (
              <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={form.isMock} onCheckedChange={(v) => patchDeviceForm({ isMock: v === true })} aria-label="Mock 模拟" />
                先按 Mock 登记（培训/演示用，正式收粮前应切回真实设备）
              </Label>
            )}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            {isEdit ? (
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive"
                title="从台账删除这台设备（有业务历史的会被拒，只能停用）"
                onClick={() => editing && setPendingDelete(editing)}
              >
                <Trash2Icon />
                删除设备
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setAddOpen(false)}>
                取消
              </Button>
              <Button onClick={submitDevice} disabled={addHasErr || deviceSaving}>
                {isEdit ? <CheckIcon /> : <PlusIcon />}
                {deviceSaving ? (isEdit ? "保存中…" : "登记中…") : isEdit ? "保存修改" : "登记设备"}
              </Button>
            </div>
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
            <DialogTitle className="text-sm">删除设备</DialogTitle>
            <DialogDescription className="text-xs">
              将从台账移除
              {pendingDelete ? (
                <span className="font-medium"> {pendingDelete.name} · {pendingDelete.code}</span>
              ) : null}
              。已被磅单或抓拍引用过的设备不能删除，只能「停用」，台账与追溯都留着。此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={deleteDevice.isPending}
              onClick={() => pendingDelete && deleteDevice.mutate(pendingDelete.code)}
            >
              {deleteDevice.isPending ? "删除中…" : "确认删除"}
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
  onEdit,
  onToggleEnabled,
  onToggleMock,
}: {
  d: DeviceConfig;
  active: boolean;
  locked: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onToggleEnabled: (v: boolean) => void;
  onToggleMock: (v: boolean) => void;
}) {
  const Icon = KIND_ICON[d.kind];
  const st = DEVICE_STATUS[d.last_status];
  return (
    // 卡片本身不能是 <button>：里面已有「启用 / 切 Mock」两个按钮，button 套 button 是非法 HTML，
    // React 会报 hydration 错。选中动作挂在标题按钮上（可键盘聚焦），卡片空白处的点击只是鼠标便利。
    <Card
      size="sm"
      onClick={onSelect}
      className={cn(
        "min-w-0 cursor-pointer gap-1.5 px-2.5 py-2.5 text-sm hover:border-ring",
        active && "border-primary ring-1 ring-primary/50",
        d.is_enabled === 0 && "opacity-70",
      )}
    >
      <CardHeader className="gap-0 p-0">
        <Button
          type="button"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
          className="h-auto w-full min-w-0 shrink justify-start gap-2 px-0 text-left hover:bg-transparent"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{d.name}</span>
          <span className={cn("ml-auto size-2.5 shrink-0 rounded-full", TONE_DOT[st.tone])} aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 p-0">
        <span className="flex flex-wrap items-center gap-1 text-xs">
          <ToneBadge tone={st.tone}>{st.label}</ToneBadge>
          {d.is_default === 1 && <ToneBadge tone="info">默认</ToneBadge>}
          {d.kind === "camera" && d.config?.captureOnWeigh === true && <ToneBadge tone="success">过磅抓拍</ToneBadge>}
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
            title={locked ? "修改设备需要站长岗位（device.manage）" : "编辑名称 / 驱动 / 参数 / 默认"}
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <PencilIcon />
            编辑
          </Button>
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
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------ 测试面板 */

interface TestResult {
  ok: boolean;
  message: string;
  elapsedMs: number;
  at: string;
}

function TestPanel({ d }: { d: DeviceConfig }) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<TestResult | null>(null);
  const now = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

  // 地磅与 IP 摄像机的自检结论直接落台账：它们不像打印机/读卡器还有 VID、SAM 号那样的凭据可看，
  // "真机答上了"本身就是结论，测一次不写回灯就还挂着旧状态，等于白测。
  // （IP 摄像机尤其：灯会被过磅抓拍失败连续 5 次压成"离线"，没有这条回写，测通过也翻不了绿。）
  const reportProbe = useMutation({
    mutationFn: (r: { ok: boolean; message: string }) =>
      api.reportDeviceProbe(d.code, { status: r.ok ? "online" : "offline", error: r.ok ? null : r.message, at: stamp() }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["devices"] }),
    onError: (e: Error) => toast.error(`状态回写失败：${e.message}`),
  });
  const writesBackProbe = d.kind === "scale" || d.kind === "camera";
  const testing = useMutation({
    mutationFn: () => api.testDevice(d.code),
    onSuccess: (r) => {
      setResult({ ...r, at: now() });
      if (writesBackProbe) reportProbe.mutate(r);
    },
    onError: (e: Error) => {
      setResult({ ok: false, message: e.message, elapsedMs: 0, at: now() });
      // 命令回的是中文短句（台账没写 COM 口 / 波特率不对的那类），同样是一次真结论
      if (writesBackProbe) reportProbe.mutate({ ok: false, message: e.message });
    },
  });

  /**
   * 本机 USB 摄像头的联机测试只能在前端做：那条流活在 WebView2 里，服务端 device_test
   * 没有（也不该有）第二条开设备的通路。探测=真开流取一帧，和工作台抓拍同一条通道——
   * 这里绿了，过磅就拍得出；和地磅一样把结论当场回写台账，卡片与状态灯不会出现两种说法。
   */
  const localCam = d.kind === "camera" ? localCameraSpec(d) : null;
  const camProbe = useMutation({
    mutationFn: () => probeLocalCamera(d),
    onSuccess: (r) => {
      setResult({ ...r, at: now() });
      reportProbe.mutate(r);
    },
  });
  const autoProbedFor = useRef<string | null>(null);
  useEffect(() => {
    // 选中这台就探一次（读卡器面板同式）：新登记的本机摄像头停在"未检测"，不主动摸一遍永远灰着
    if (!localCam || d.is_mock === 1) return;
    if (autoProbedFor.current === d.code) return;
    autoProbedFor.current = d.code;
    camProbe.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.code, d.is_mock, localCam != null]);

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
            这台机的联机测试在下方小票机面板里做。
          </p>
        ) : d.kind === "idcard" ? (
          <p className="text-xs text-muted-foreground">
            这台机的联机测试在下方读卡器面板里做。
          </p>
        ) : d.kind === "scale" ? (
          <>
            <Button size="sm" variant="outline" onClick={() => testing.mutate()} disabled={testing.isPending}>
              {testing.isPending ? "正在读帧…" : "联机测试"}
            </Button>
            <p className="text-xs text-muted-foreground">
              工作台正在收数时按读数流判定在线；没开流时会临时读三帧再归还，结果当场更新上方状态灯。
            </p>
          </>
        ) : localCam ? (
          <>
            <Button size="sm" variant="outline" onClick={() => camProbe.mutate()} disabled={camProbe.isPending || d.is_mock === 1}>
              {camProbe.isPending ? "正在开流取帧…" : "联机测试"}
            </Button>
            <p className="text-xs text-muted-foreground">
              {d.is_mock === 1
                ? "这台是 Mock 模拟设备，不做真机探测。"
                : "测试会开一次真流取一帧，与工作台抓拍同一通道；被其它程序占用时报「打不开」，结果当场更新上方状态灯。"}
            </p>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => testing.mutate()} disabled={testing.isPending}>
            {testing.isPending ? "正在握手…" : "联机测试"}
          </Button>
        )}
      </div>

      {result && (
        <CallOut tone={result.ok ? "success" : "danger"} title={result.ok ? "测试通过" : "测试失败"}>
          {result.message}
          <span className="tnum block">
            {result.at} · 耗时 {result.elapsedMs} ms
          </span>
        </CallOut>
      )}

      <div className="flex flex-col gap-2">
        <SectionTitle>通信参数</SectionTitle>
        <InfoGrid
          cols={2}
          items={Object.entries(d.config).map(([k, v]) => ({ label: k, value: <span className="tnum text-xs">{String(v)}</span> }))}
        />
      </div>

      {d.kind === "scale" && <ScalePanel key={d.code} d={d} />}
      {d.kind === "idcard" && <CardReaderPanel key={d.code} d={d} />}
      {d.kind === "camera" && <CameraPanel d={d} live={result?.ok === true} />}
      {d.kind === "printer" && <PrinterPanel key={d.code} d={d} />}
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

function ScalePanel({ d }: { d: DeviceConfig }) {
  const queryClient = useQueryClient();
  useScaleTick();
  const scale = useDeviceStore((s) => s.scale);
  const setConnected = useDeviceStore((s) => s.scale.setConnected);
  const [streaming, setStreaming] = useState(true);
  const [frames, setFrames] = useState<Frame[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  const paused = !streaming;

  /**
   * 这条流是不是**眼前这台磅**的真机读数。三个条件缺一不可：
   *  - `d.is_mock === 0`：台账里标 Mock 的磅不去开它的串口，拿它报绿就是骗现场；
   *  - `source === "live"`：浏览器预览没有真帧；
   *  - `code === d.code`：读数流是全局单槽，选中别的磅时不能把别人的在线结论挂过来。
   */
  const mine = d.is_mock === 0 && scale.source === "live" && scale.code === d.code;
  const live: DeviceStatus | null = mine ? (scale.connected ? "online" : "offline") : null;
  useEffect(() => {
    if (paused) return;
    setFrames((prev) => {
      const next = prev.concat({
        at: new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(new Date().getMilliseconds()).padStart(3, "0"),
        // 真机帧一律原样上屏（`raw_frame` 是后端 `frame_display` 转义过的实帧，与落库进
        // `weigh_record.raw_frame` 的那串逐字一致）；只有演示心跳才合成 A 族样子。
        line: scale.rawFrame || frameLine(scale.weight01kg, scale.stable),
        w: scale.weight01kg,
        stable: scale.stable,
      });
      return next.slice(-60);
    });
  }, [scale.weight01kg, scale.stable, scale.rawFrame, paused]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [frames]);

  /* ---------------- 状态灯回写：正在收数就是这台磅在线的凭据，不靠站长手点一次联机测试 */

  const reported = useRef<DeviceStatus | null>(null);
  const report = useMutation({
    mutationFn: (p: { status: DeviceStatus; error: string | null; at: string }) => api.reportDeviceProbe(d.code, p),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["devices"] }),
    // 回写没落库就要放开闸门重试：否则 `reported` 记着"已报过"，灯会一直停在错的那一档
    onError: (e: Error) => {
      reported.current = null;
      toast.error(`状态回写失败：${e.message}`);
    },
  });
  // 防抖只有后端那一档（`STARVE_MS`：5 秒没有可解析帧才把 connected 压成 false）。
  // 界面**不能再等一轮**：掉线之后就没有新帧了，effect 不会被第二次触发，红永远报不出去。
  useEffect(() => {
    if (!live) return;
    if (reported.current === live) return; // 回写在途，别重复发（每发一次离线就加一次错误数）
    if (live === d.last_status && (live === "online" || (d.last_error ?? null) === (scale.error ?? null))) return;
    reported.current = live;
    report.mutate({
      status: live,
      error: live === "online" ? null : scale.error ?? `串口 ${scale.port ?? d.code} 已停止收到可解析读数帧`,
      at: stamp(),
    });
  }, [live, scale.error, scale.port, d.code, d.last_status, d.last_error, report.mutate]);

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
          {/* 只在演示流上给：真机流点它会直接改写 store 的 connected，
              而那个值现在就是台账状态灯的凭据——一键造出一个假掉线 */}
          {!mine && (
            <Button size="xs" variant="outline" onClick={() => setConnected(!scale.connected)}>
              {scale.connected ? "拔线模拟" : "重新连线"}
            </Button>
          )}
        </span>
      </div>

      {scale.error && mine && <CallOut tone="danger" title="读数流报错">{scale.error}</CallOut>}

      <div ref={boxRef} className="h-44 min-w-0 overflow-y-auto border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
        {frames.length === 0 ? (
          <p className="font-sans text-xs text-muted-foreground">
            {paused ? "已暂停，点「继续」恢复。" : "等待仪表发帧…"}
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

      {/* 判稳依据一律用后端随帧下发的数：界面再抄一份窗口/容差，就成了"说的是 5 kg、判的是 20 kg" */}
      {mine && scale.windowFrames > 0 ? (
        <p className="text-xs text-muted-foreground">
          判稳此刻的依据：窗口 <span className="tnum">{scale.samples.length}/{scale.windowFrames}</span> 帧、极差{" "}
          <span className="tnum">{weight(scale.spread01kg, false)}</span>（容差{" "}
          <span className="tnum">{weight(scale.tolerance01kg, false)}</span>）、持续{" "}
          <span className="tnum">{scale.windowMs}</span> ms（需 ≥ <span className="tnum">{scale.stableMs}</span> ms）、分度{" "}
          <span className="tnum">{weight(scale.division01kg, false)}</span>；累计 <span className="tnum">{scale.frameCount}</span>{" "}
          帧、坏帧 <span className="tnum">{scale.errCount}</span> 帧。
          <span className="text-foreground">三项里没达标的那一项，就是"还在波动中"的原因。</span>
          <br />
          窗口、容差与分度写在<span className="font-medium">这台磅的帧模板</span>里；上方「编辑」表单只给波特率与帧族，
          要改这几项需导出配置、修改后再导入。
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          这条流不是这台磅的真机帧（{d.is_mock === 1 ? "台账把它标成了 Mock，不会去开它的串口" : "没有收到真机帧"}），界面不会凭空造读数。
        </p>
      )}
    </div>
  );
}

/* -------------------------------------- 读卡器（一台机 · 身份证 / IC 两通道） */

/** 芯片里的日期是 CCYYMMDD；"长期"这类非数字值原样透出，不假装格式化成功 */
function chipDate(v: string | null | undefined): string {
  return /^\d{8}$/.test(v ?? "") ? `${v!.slice(0, 4)}-${v!.slice(4, 6)}-${v!.slice(6, 8)}` : orDash(v);
}

/**
 * 读卡器面板：一台设备 + 若干介质通道。
 *
 * 上半部分是设备级的（这台机此刻在不在、凭什么说它在），下半部分按 `lib/card-reader`
 * 登记表里这台驱动声明的 media 逐节渲染，所以面板不会替硬件编它没有的能力。
 */
function CardReaderPanel({ d }: { d: DeviceConfig }) {
  const queryClient = useQueryClient();
  const reader = useDeviceStore((s) => s.reader);
  const probe = useDeviceStore((s) => s.reader.probe);
  const spec = readerSpec(d.driver);

  // 选中这台机就探一次：卡片状态灯读的是台账 last_status，不主动探测会一直挂着安装时录入的旧值。
  // reader.registered 进依赖：刚登记/启用这台机时台账结论会晚于本面板挂载，闸门翻真后要自动重探，
  // 不能一直停在"台账里没有启用的证卡阅读器"那句刚入库时说的旧话上。
  useEffect(() => {
    void probe();
  }, [probe, d.is_mock, reader.registered]);

  // 探测结论回写台账（只动状态四字段），面板与卡片因此不会出现两种说法
  const report = useMutation({
    mutationFn: (p: ReaderProbe) => api.reportDeviceProbe(d.code, { status: p.status, error: p.error, at: p.at }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["devices"] }),
    onError: (e: Error) => toast.error(`状态回写失败：${e.message}`),
  });
  const lastProbe = reader.lastProbe;
  useEffect(() => {
    if (!lastProbe) return;
    if (lastProbe.status === d.last_status && (lastProbe.error ?? null) === (d.last_error ?? null)) return;
    report.mutate(lastProbe);
  }, [lastProbe, d.last_status, d.last_error, report.mutate]);

  const st = DEVICE_STATUS[reader.status];
  const demoMode = d.is_mock === 1 || !runningInTauri();
  const headline = !runningInTauri()
    ? "浏览器预览：没有原生设备通道"
    : spec.onlineProof === "none"
      ? "该驱动不做真机校验，状态只能停在未检测"
      : d.is_mock === 1
        ? "台账里这台机是 Mock：身份证通道回演示卡，IC 通道不造假"
        : lastProbe?.connected
          ? "设备已打开，SAM 应答正常"
          : "设备未连通";

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle extra={<span className="text-xs text-muted-foreground">{spec.label}</span>}>读卡器状态</SectionTitle>

      <CallOut
        tone={st.tone}
        title={headline}
        action={
          <Button size="xs" variant="ghost" disabled={reader.probing} onClick={() => void probe()}>
            {reader.probing ? "正在探测…" : "重新探测"}
          </Button>
        }
      >
        <InfoGrid
          cols={2}
          items={[
            { label: "台账状态", value: <span className={TONE_TEXT[st.tone]}>{st.label}</span> },
            // 没有 SAM 可问的驱动就别摆两行永远划横杠的字段出来
            ...(spec.onlineProof === "sam"
              ? [
                  { label: "SAM 序列号", value: <span className="tnum">{orDash(lastProbe?.samId ?? null)}</span> },
                  { label: "指纹模块", value: lastProbe ? (lastProbe.fingerprint ? "支持" : "不支持") : "—" },
                ]
              : []),
            { label: "探测时刻", value: <span className="tnum">{orDash(lastProbe?.at ?? null)}</span> },
          ]}
        />
        {lastProbe?.error && <p className="mt-1 text-destructive">{lastProbe.error}</p>}
        <p className="mt-1">
          {spec.onlineProof === "sam"
            ? "SAM 号只有设备真被打开、安全模块应答之后才有，所以它是\"在线\"的唯一凭据；没有它就不报绿。"
            : "这台驱动没有可校验的在线凭据，面板不会替它报绿。"}
        </p>
      </CallOut>

      {/* 一节一种介质：能读什么卡由登记表决定，换一台只读身份证的机型就不会多出 IC 这节 */}
      {spec.media.map((medium) =>
        medium === "idcard" ? (
          <IdCardMedium key={medium} d={d} demoMode={demoMode} canPhoto={spec.photo} />
        ) : (
          <IcMedium key={medium} d={d} />
        ),
      )}
    </div>
  );
}

/** 介质通道一：身份证（SAM 解密芯片） */
function IdCardMedium({
  d,
  demoMode,
  canPhoto,
}: {
  d: DeviceConfig;
  demoMode: boolean;
  canPhoto: boolean;
}) {
  const card = useDeviceStore((s) => s.reader.idcard);
  const read = useDeviceStore((s) => s.reader.idcard.read);
  const [photo, setPhoto] = useState(String(d.config.photo ?? "false") === "true");
  const m = MEDIUM.idcard;

  return (
    <div className="flex flex-col gap-1.5">
      <SectionTitle extra={<span className="text-xs text-muted-foreground">{m.qualifier}</span>}>{m.label}</SectionTitle>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={card.reading} onClick={() => void read({ photo })}>
          {card.reading ? m.pending : m.action}
        </Button>
        {canPhoto && (
          <Label className="flex h-8 items-center gap-2 border px-2.5 text-xs">
            <Switch
              checked={photo}
              disabled={demoMode}
              onCheckedChange={setPhoto}
              aria-label="读卡同时取照片"
            />
            同时取照片
          </Label>
        )}
      </div>
      {card.error && <p className="text-xs text-destructive">{card.error}</p>}
      {card.reading && (
        <p className="text-xs text-muted-foreground">
          放卡后约 0.3–2 秒出结果（芯片读不出来会自动重寻卡 5 次），别连着点。
        </p>
      )}
      {demoMode && !card.reading && (
        <p className="text-xs text-muted-foreground">
          {!runningInTauri()
            ? "此刻不碰真设备，读出来的是演示卡；用桌面端才会真机读卡。"
            : "此刻不碰真设备，读出来的是演示卡；要让现场证号进这里，把这台机切回真实设备。"}
        </p>
      )}

      {card.last && (
        <div className="flex flex-col gap-1 border p-2 text-xs">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {card.last.name}
            <ToneBadge tone={card.last.real ? "success" : "warning"}>{card.last.real ? "真机读取" : "演示卡"}</ToneBadge>
            {card.last.party_id == null && <ToneBadge tone="warning">未建档</ToneBadge>}
          </p>
          {/* B 类：这一串是刚从那张实体证上读下来的，操作员手上就捏着它，库里有没有档案都不改变
              "号本来就在手上"这件事。**不传 partyId**——即便 `card.last.party_id` 有值也不传：
              那不是"读了一次库里的证号"，给它记一条 pii.read 等于往审计里灌一条假动作。 */}
          <p className="text-muted-foreground">证号 <IdCardText value={card.last.id_card_no} className="tnum" /></p>
          <p className="text-muted-foreground">
            {card.last.sex} · {orDash(card.last.nation)} · 出生 {chipDate(card.last.born)}
          </p>
          <p className="text-muted-foreground">{card.last.address}</p>
          {(card.last.agency || card.last.valid_to) && (
            <p className="text-muted-foreground">
              签发 {orDash(card.last.agency)} · 有效 {chipDate(card.last.valid_from)} — {chipDate(card.last.valid_to)}
            </p>
          )}
          {card.last.photo_path && <p className="break-all text-muted-foreground">照片 {card.last.photo_path}</p>}
          <p className="text-muted-foreground">
            命中档案{" "}
            {card.last.party_id == null ? (
              <span className="text-warning">无（系统里没有这个证号，请到「农户与往来单位」建档）</span>
            ) : (
              <span className="tnum">#{card.last.party_id}</span>
            )}
          </p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{m.note}</p>
    </div>
  );
}

/** 介质通道二：IC（Mifare）卡，只读探测；结果与原因都取自 store 的 reader.ic */
function IcMedium({ d }: { d: DeviceConfig }) {
  const ic = useDeviceStore((s) => s.reader.ic);
  const readIc = useDeviceStore((s) => s.reader.ic.read);
  const m = MEDIUM.ic;
  const keyHex = typeof d.config.icKey === "string" && d.config.icKey ? d.config.icKey : null;

  return (
    <div className="flex flex-col gap-1.5">
      <SectionTitle extra={<span className="text-xs text-muted-foreground">{m.qualifier}</span>}>{m.label}</SectionTitle>
      <Button
        size="sm"
        variant="outline"
        disabled={ic.reading}
        onClick={() => void readIc(keyHex ? { keyHex } : undefined)}
      >
        {ic.reading ? m.pending : m.action}
      </Button>
      {ic.error && <p className="text-xs text-destructive">{ic.error}</p>}
      {ic.last && (
        <div className="flex flex-col gap-1 border p-2 text-xs">
          <p className="font-medium">
            {ic.last.kind_label} · 卡号 <span className="tnum">{ic.last.sn}</span>
            <span className="tnum ml-2 text-muted-foreground">{ic.last.at}</span>
          </p>
          {ic.last.blocks.map((b) => (
            <p key={`${b.sector}-${b.block}`} className="flex gap-2">
              <span className="tnum shrink-0 text-muted-foreground">
                扇区{b.sector} 块{b.block}
              </span>
              <span className={cn("tnum min-w-0 flex-1 truncate", b.ok ? "" : "text-destructive")}>
                {b.ok ? b.hex : (b.error ?? "读取失败")}
              </span>
            </p>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {keyHex && keyHex.toUpperCase() !== "FFFFFFFFFFFF" && (
          <>本机登记的 IC 密钥为 <span className="tnum">{keyHex}</span>。</>
        )}{" "}
        {m.note}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------ 摄像机 */

function CameraPanel({ d, live }: { d: DeviceConfig; live: boolean }) {
  // Mock 档不碰真机（与联机测试同一闸门）：演示机上这块画面不该悄悄把摄像头/网络打开
  const localSpec = d.is_mock === 0 ? localCameraSpec(d) : null;
  const netSpec = d.is_mock === 0 ? ipCameraSpec(d) : null;
  const showingLive = !!netSpec && live;
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle extra={netSpec && !localSpec ? <span className="text-xs text-muted-foreground">子码流 RTSP · 只预览不落库</span> : undefined}>
        {showingLive || localSpec ? "实时画面" : "抓图"}
      </SectionTitle>
      <div className="relative flex aspect-video min-w-0 items-center justify-center overflow-hidden border bg-muted/40">
        {localSpec ? (
          <LocalCameraLive spec={localSpec} />
        ) : showingLive && netSpec ? (
          <IpCameraLive spec={netSpec} meta />
        ) : (
          <p className="px-2 text-center text-xs text-muted-foreground">
            {netSpec
              ? "点上方「联机测试」通过后，这里显示这台 IP 摄像机的实时画面"
              : d.is_mock === 1
                ? "这台是 Mock 模拟档，不出真画面"
                : "填好地址并通过联机测试后显示实时画面"}
          </p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        这里只预览、不落库；真实抓拍发生在工作台捕获读数的瞬间，随磅单存档。
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

function PrinterPanel({ d }: { d: DeviceConfig }) {
  const queryClient = useQueryClient();
  const setPrinter = useDeviceStore((s) => s.setPrinter);
  const escpos = d.driver === "escpos_usbprint" || d.driver === "raw_escpos";
  const paper = toNativePaper(d.config.paper == null ? "thermal80" : String(d.config.paper));
  const [pickedPath, setPickedPath] = useState<string | null>(null);

  const devices = useQuery({
    queryKey: ["printer", "usbprint-devices"],
    enabled: escpos,
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
    enabled: escpos && picked !== null,
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
      if (!verify) throw new Error("请先联机测试，配置验证通过才能保存");
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
        <CallOut
          tone={tone}
          title={headline}
          action={
            <Button size="xs" variant="ghost" onClick={() => void probe.refetch()} disabled={probe.isFetching}>
              {probe.isFetching ? "查询中…" : "重查"}
            </Button>
          }
        >
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
          {st.note && <p className="mt-1">{st.note}</p>}
        </CallOut>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={picked === null || selfTest.isPending} onClick={() => selfTest.mutate()}>
          <PrinterIcon />
          {selfTest.isPending ? "正在送出…" : "打印自检票"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!can("device.manage")}
          onClick={() => setCfgOpen(true)}
        >
          配置…
        </Button>
      </div>
      {!can("device.manage") && <p className="text-xs text-muted-foreground">改设备配置需要站长岗位；这里置灰是权限不足，不是设备问题。</p>}
      {selfTest.data && (
        <CallOut
          tone={selfTest.data.ok ? "success" : "danger"}
          title={selfTest.data.ok ? "已提交设备" : "打印失败"}
        >
          设备 {selfTest.data.device || "—"} · 目标 {picked?.label ?? "—"} · 纸宽 {paper === "p80" ? "80mm" : "58mm"}
          <span className="tnum block">耗时 {selfTest.data.elapsedMs} ms</span>
          {selfTest.data.error && <span className="mt-1 block text-destructive">{selfTest.data.error}</span>}
        </CallOut>
      )}
      <p className="text-xs text-muted-foreground">
        自检票一次分出四件事：通道是否直达、中文是否清晰、分隔线是否折行、末尾有没有切痕。
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
              保存前必须先联机测试通过。改动任意一项，上一次测试结果即刻作废。
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
              纸宽决定每行可印的列数，票面排版按这一列数分行；改错纸宽不会报错，只会把行打折。
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
                      这样保存的配置会标成"未检测"，等桌面端验过才转绿。
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
