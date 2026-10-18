/**
 * 本机 USB 摄像头通道（04 §4 方案 A 的"画面在前端"半边）。
 *
 * 分工口径：台账里 `config.transport === "local"` 且勾了 `config.captureOnWeigh` 的抓拍机（设备中心
 * 「扫描本机摄像头」登记的）由 **WebView2 开流上屏**——工作台面板实时画面 + 捕获毛/皮重瞬间对每台
 * 各就地取一帧 JPEG，base64 随 `order_capture` 的 `frames`（每台一条 `{device_id, b64}`）回传，
 * Rust 侧只做解码/校验/落库（`src-tauri/src/camera.rs::store_frame_for`）。Rust 不自己开设备：MF 符号链接
 * 与 Chromium 的 deviceId 是两套体系，只有 webview 里能按名字对上机器。一次过磅最多 3 台相机各拍一张。
 *
 * 三条边界：
 *  1. **一条流多处用**：面板小窗、放大弹窗与抓拍取帧共享同一条 MediaStream（引用计数），
 *     谁都不许各开各的——UVC 摄像头常被驱动限成单占用，多开必翻车。
 *  2. **取帧绝不拦过磅**：开不成流/等不到帧一律回 `null`，调用方按"无抓拍"继续，
 *     原因写进设备台账（04 §4.2、H6），这里不弹框不报错。
 *  3. 失败话术回人话（`cameraUserHint`）：现场能分辨"权限没给"与"摄像头被别的程序占了"。
 */
import type { DeviceConfig } from "@/mock/types";

/** 台账里一台本机摄像头的寻址信息（DevicesPage「扫描本机摄像头」回填的那三键） */
export interface LocalCamSpec {
  /** Media Foundation 友好名（如 "Integrated Camera"）——webview 侧按它匹配设备 */
  deviceName: string;
  /** MF 符号链接，Chromium 不认；这里只当"同一台登记设备"的引用计数键 */
  deviceId: string;
}

/** 抓拍帧的长边上限（对齐 04 §4.2 的"长边 1600 px"；canvas 缩放比让摄像机降流更可控） */
const GRAB_MAX_EDGE = 1600;
const GRAB_JPEG_QUALITY = 0.85;
/** 冷开摄像头到第一帧的耐心上限：超了就按无抓拍，绝不让捕获干等 */
const GRAB_TIMEOUT_MS = 2_500;

/** 这台登记设备是不是本机 USB 摄像头；是则带回寻址信息，不是（IP 机/没配）回 null。 */
export function localCameraSpec(cam: DeviceConfig | null | undefined): LocalCamSpec | null {
  if (!cam || cam.kind !== "camera") return null;
  const transport = String(cam.config?.transport ?? "").toLowerCase();
  if (transport !== "local") return null;
  return {
    deviceName: String(cam.config?.deviceName ?? ""),
    deviceId: String(cam.config?.deviceId ?? ""),
  };
}

export interface LocalCameraHandle {
  stream: MediaStream;
  /** 实际开到的设备友好名（没匹配登记名时也能对上"眼前这是哪台机器"） */
  label: string;
  /** true = 没匹配到登记的摄像头、退而开了默认/唯一那台：面板要明说，别让磅员看错画面 */
  fellBack: boolean;
  /** 归还引用：最后一个使用者调用时才真正停流 */
  stop: () => void;
}

interface Holder {
  stream: MediaStream;
  label: string;
  fellBack: boolean;
  users: number;
}

/** 槽位按登记的 MF 符号链接分键：同一台设备的预览、放大与取帧必然汇到同一条流。 */
const slots = new Map<string, Promise<Holder>>();

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");

/** 带标签枚举：没授权前 Chromium 的 label 一律是空串，先摸开一次任意流换权限再重数。 */
async function listCamerasWithLabels(): Promise<MediaDeviceInfo[]> {
  const pick = () => navigator.mediaDevices.enumerateDevices().then((d) => d.filter((x) => x.kind === "videoinput"));
  let devs = await pick();
  if (devs.length > 0 && devs.every((d) => !d.label)) {
    const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    probe.getTracks().forEach((t) => t.stop());
    devs = await pick();
  }
  return devs;
}

/**
 * 登记名 ↔ 浏览器标签的匹配档位。浏览器标签常带 "(VID:PID)" 这类后缀（实测
 * "c922 Pro Stream Webcam" vs "c922 Pro Stream Webcam (046d:085c)"），互为包含就是**同一台机器**，
 * 只有落到"唯一设备猜/默认那台"才算没匹配上——fellBack 的语义必须是后者，别把成功说成凑合。
 */
function matchCamera(
  devs: MediaDeviceInfo[],
  deviceName: string,
): { dev: MediaDeviceInfo | undefined; tier: "exact" | "partial" | "fallback" } {
  const want = norm(deviceName);
  if (!want) return { dev: devs[0], tier: "fallback" };
  const exact = devs.find((d) => norm(d.label) === want);
  if (exact) return { dev: exact, tier: "exact" };
  const partial = devs.find((d) => {
    const have = norm(d.label);
    return have !== "" && (have.includes(want) || want.includes(have));
  });
  if (partial) return { dev: partial, tier: "partial" };
  return { dev: devs.length === 1 ? devs[0] : undefined, tier: "fallback" };
}

async function openHolder(spec: LocalCamSpec): Promise<Holder> {
  const devs = await listCamerasWithLabels();
  if (devs.length === 0) throw new DOMException("本机没有可用的视频输入设备", "NotFoundError");
  const { dev, tier } = matchCamera(devs, spec.deviceName);
  const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: dev ? { deviceId: { exact: dev.deviceId }, ...size } : size,
    });
  } catch (e) {
    // 枚举与打开之间设备被拔掉/换了：exact 失败就退一路开默认摄像头，仍失败才向上抛
    if (!(dev && e instanceof DOMException && (e.name === "OverconstrainedError" || e.name === "NotFoundError"))) throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: size });
    // 兜底开的是默认那台，不是登记的那台——如实标 fellBack
    const label0 = stream.getVideoTracks()[0]?.label || "";
    return { stream, label: label0, fellBack: true, users: 0 };
  }
  const label = dev?.label || stream.getVideoTracks()[0]?.label || "";
  return { stream, label, fellBack: tier === "fallback", users: 0 };
}

/** 打开（或复用）这台本机摄像头的流。失败抛 DOMException，由调用方用 `cameraUserHint` 翻成人话。 */
export async function acquireLocalCamera(spec: LocalCamSpec): Promise<LocalCameraHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    // 非安全上下文（http://局域网IP 直连）与老浏览器根本没有这个 API
    throw new DOMException("当前环境不提供摄像头访问", "SecurityError");
  }
  const key = spec.deviceId || spec.deviceName || "default";
  let pending = slots.get(key);
  if (!pending) {
    pending = openHolder(spec).catch((e) => {
      slots.delete(key); // 开流失败不占槽：下一次（重试/插回来）重新来过
      throw e;
    });
    slots.set(key, pending);
  }
  const holder = await pending;
  holder.users += 1;
  let stopped = false;
  return {
    stream: holder.stream,
    label: holder.label,
    fellBack: holder.fellBack,
    stop: () => {
      if (stopped) return;
      stopped = true;
      holder.users -= 1;
      if (holder.users <= 0) {
        holder.stream.getTracks().forEach((t) => t.stop());
        if (slots.get(key) === pending) slots.delete(key);
      }
    },
  };
}

function scaledSize(w: number, h: number) {
  const edge = Math.max(w, h);
  if (edge <= 0) return null;
  const k = edge > GRAB_MAX_EDGE ? GRAB_MAX_EDGE / edge : 1;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

function canvasJpeg(source: CanvasImageSource, w: number, h: number): string | null {
  const size = scaledSize(w, h);
  if (!size) return null;
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, size.w, size.h);
  return canvas.toDataURL("image/jpeg", GRAB_JPEG_QUALITY);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer = 0;
  try {
    return await Promise.race([p, new Promise<null>((r) => (timer = window.setTimeout(() => r(null), ms)))]);
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 从一条已开的流里取一帧 JPEG（dataURL 形态，base64 部分随 `photo_b64` 回传，
 * Rust 解码器容忍前缀）。首选 `ImageCapture.grabFrame()`：不用上屏也能拍，
 * 面板被收起/隐藏时照样出图；不支持就退到隐藏 `<video>` 等一帧再画。
 */
async function frameFromStream(stream: MediaStream): Promise<string | null> {
  const track = stream.getVideoTracks()[0];
  if (!track) return null;
  if (typeof ImageCapture !== "undefined") {
    try {
      const bitmap = await new ImageCapture(track).grabFrame();
      const url = canvasJpeg(bitmap, bitmap.width, bitmap.height);
      bitmap.close();
      if (url) return url;
    } catch {
      /* 部分 UVC 帧格式 grabFrame 会失败：落到视频帧路子 */
    }
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    const seen = await withTimeout(
      new Promise<boolean>((resolve) => {
        if (video.readyState >= 2 && video.videoWidth > 0) return resolve(true);
        const on = () => video.videoWidth > 0 && resolve(true);
        video.addEventListener("loadeddata", on, { once: true });
        video.addEventListener("timeupdate", on, { once: true });
      }),
      GRAB_TIMEOUT_MS,
    );
    if (!seen || video.videoWidth === 0) return null;
    return canvasJpeg(video, video.videoWidth, video.videoHeight);
  } catch {
    return null;
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

/**
 * 抓拍取帧的一站式入口：非本机摄像头直接回 null（IP 机走服务端 HTTP 抓图）；
 * 本机机开流→取帧→立刻归还引用。**永不抛错**——取不到就是"无抓拍"。
 */
export async function grabLocalCameraFrame(cam: DeviceConfig | null | undefined): Promise<string | null> {
  const spec = localCameraSpec(cam);
  if (!spec) return null;
  let handle: LocalCameraHandle | null = null;
  try {
    handle = await withTimeout(acquireLocalCamera(spec), GRAB_TIMEOUT_MS);
    if (!handle) return null;
    return await withTimeout(frameFromStream(handle.stream), GRAB_TIMEOUT_MS);
  } catch {
    return null;
  } finally {
    handle?.stop();
  }
}

/** 一台本机摄像头就地取到的一帧（随 `order_capture` 的 `frames` 回传，与 Rust `CaptureFrame` 对齐）。 */
export interface GrabbedFrame {
  /** `device_config.id`——服务端按它对号入座到勾了「过磅抓拍」的那台相机，对不上就丢弃 */
  device_id: number;
  /** dataURL 形态的 JPEG，base64 部分由 Rust 解码/校验/落库 */
  b64: string;
}

/**
 * 捕获瞬间对**一组**参与过磅抓拍的相机各取一帧（04 §4：一次最多 3 台）。
 *
 * - 只处理本机 USB 摄像头（`transport=local`）；内网 IP 摄像机由服务端自己 HTTP 抓图，这里跳过。
 * - 逐台独立：某台开流/取帧失败只是它这一帧为 null，不影响其它台——与"取帧绝不拦过磅"同口径。
 * - **永不抛错**，返回的是"成功取到帧的那几台"，缺的就按无抓拍继续。
 */
export async function grabCaptureFrames(cams: (DeviceConfig | null | undefined)[]): Promise<GrabbedFrame[]> {
  const out: GrabbedFrame[] = [];
  for (const cam of cams) {
    if (!cam || localCameraSpec(cam) == null) continue;
    const b64 = await grabLocalCameraFrame(cam);
    if (b64 != null) out.push({ device_id: cam.id, b64 });
  }
  return out;
}

/** 一次本机摄像头自检的结论，形状对齐设备中心 TestPanel 的测试结果（ok/message/elapsedMs）。 */
export interface LocalCameraProbe {
  ok: boolean;
  message: string;
  elapsedMs: number;
}

/**
 * 设备中心「联机测试」的真机探测：开一次真流 + 取一帧，走的就是工作台抓拍那条通道——
 * 测得过＝工作台也拍得出；测不过当场把原因（占用/权限/插口）回给人看，并由调用方写进台账。
 * 服务端 `device_test` 不碰这条设备：本机摄像头的探测通道只存在于 WebView2 里。
 */
export async function probeLocalCamera(cam: DeviceConfig): Promise<LocalCameraProbe> {
  const spec = localCameraSpec(cam);
  const t0 = performance.now();
  if (!spec) {
    return { ok: false, message: "这台不是本机 USB 摄像头，此处不探测（IP 摄像机看工作台的抓拍画面）", elapsedMs: 0 };
  }
  try {
    const handle = await acquireLocalCamera(spec);
    try {
      const frame = await withTimeout(frameFromStream(handle.stream), GRAB_TIMEOUT_MS);
      const elapsedMs = Math.round(performance.now() - t0);
      if (!frame) {
        return { ok: false, message: `已打开「${handle.label}」但 ${Math.round(GRAB_TIMEOUT_MS / 1000)} 秒内没出帧：可能被其它程序间歇占用`, elapsedMs };
      }
      const s = handle.stream.getVideoTracks()[0]?.getSettings();
      const size = s?.width && s?.height ? `${s.width}×${s.height} · ` : "";
      const kb = Math.round(((frame.length * 3) / 4 / 1024) * 10) / 10;
      return {
        ok: true,
        message: `已打开「${handle.label}」并取到一帧（${size}JPEG 约 ${kb} KB）${handle.fellBack ? "；注意：未匹配到登记的摄像头，开的是默认那台" : ""}`,
        elapsedMs,
      };
    } finally {
      handle.stop();
    }
  } catch (e) {
    return { ok: false, message: cameraUserHint(e), elapsedMs: Math.round(performance.now() - t0) };
  }
}

/** 把 getUserMedia 的 DOMException 翻成现场能照着做的中文短句（面板占位文案用）。 */
export function cameraUserHint(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "相机权限被拒绝：Windows 设置 → 隐私和安全性 → 相机 → 允许桌面应用访问";
    case "NotReadableError":
    case "AbortError":
      return "相机打不开：可能被其它程序占用（如 Windows 相机），关掉它再试";
    case "NotFoundError":
    case "OverconstrainedError":
      return "找不到登记的摄像头：确认它还插着，或到设备中心重新扫描本机摄像头";
    default:
      return e instanceof Error && e.message ? `打开摄像头失败：${e.message}` : "打开摄像头失败";
  }
}
