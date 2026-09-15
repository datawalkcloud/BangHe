/**
 * 工作台「过磅画面」的前端通道：Rust 侧一条 RTSP 会话 + H.264 软解，**帧由事件推下来**
 * （实现在 `src-tauri/src/camera_stream.rs`，04 §4 方案 A 的第二条路）。
 *
 * 为什么不像业务接口那样并进 `src/lib/api.ts` 的展开链：这条不是请求/响应，是每秒十来帧的
 * 推流，和 `scale-native.ts` 同一类（`mock_coverage_contract` 也只认 `xxxApi` 那种形状）。
 * 浏览器预览里根本没有这条路，硬套 mock 只会喂出假画面，所以这里一个假帧都不造。
 *
 * 三条约定，与 `scale-native.ts` 同口径：
 *  1. **永不 reject**：命令失败回 `{ available: true, error: "中文短句" }`，浏览器预览回
 *     `{ available: false, error: ... }`；那一格据此显示一句话，绝不弹框、绝不拦称重。
 *  2. **一处会话多处看**：`start`/`stop` 按 `code` 引用计数（服务端判的），工作台小卡与
 *     放大弹窗各订一次也只有一条 RTSP 会话，关弹窗不会把小卡的画面一起停掉。
 *  3. **帧序按 (generation, seq) 比**：`seq` 每趟会话从 1 重新开始，只比 `seq` 会在重连后
 *     停在重连前那一帧上——那正是"看着有画面其实是张冻图"的那种最难查的错。
 */
import { runningInTauri, type NativeResult } from "@/lib/native";

/** 帧事件名，与 Rust `camera_stream::CAMERA_FRAME_EVENT` 同源 */
export const CAMERA_FRAME_EVENT = "device://camera-frame";
/** 状态事件名，与 Rust `camera_stream::CAMERA_STATUS_EVENT` 同源 */
export const CAMERA_STATUS_EVENT = "device://camera-status";

/** 一帧：`dataUrl` 直接喂 `<img>`，其余用来把"这一帧多大、多久、第几张"说清。 */
export interface CameraFrame {
  code: string;
  dataUrl: string;
  width: number;
  height: number;
  seq: number;
  /** 第几路订阅：与 `CameraStreamStatus.generation` 同源，用它区分重连前后 */
  generation: number;
  bytes: number;
  at: string;
}

/**
 * 一路流的现状。`phase` 只有四个取值，中文说法在 [`phaseLabel`] 一处映射，
 * 免得小卡、放大弹窗、设备中心各翻一遍。
 */
export interface CameraStreamStatus {
  code: string;
  /** 线程在跑（还没被最后一个退订的人收走） */
  running: boolean;
  /** 此刻会话是否连着 */
  connected: boolean;
  phase: "connecting" | "waiting-keyframe" | "streaming" | "error" | string;
  generation: number;
  startedAt: string;
  frameCount: number;
  width: number;
  height: number;
  lastFrameAt: string | null;
  error: string | null;
  refs: number;
}

const NO_CHANNEL =
  "当前是浏览器预览，没有 RTSP 画面通道；请用「npm run tauri dev」启动桌面端后看实时画面";

/** 与 `@/lib/native` 的 `call` 同一套语义：区分"命令失败"与"没有这条通道"，且不抛。 */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<NativeResult<T>> {
  if (!runningInTauri()) return { available: false, error: NO_CHANNEL };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return { available: true, data: await invoke<T>(cmd, args) };
  } catch (e) {
    return { available: true, error: e instanceof Error ? e.message : String(e) };
  }
}

export const cameraStream = {
  /**
   * 订一路画面。已经在跑就只是引用 +1（回同一份快照），否则服务端起线程、开一条 RTSP 会话。
   * 台账非法（Mock 档 / 已停用 / 本机 USB 机 / 认不出该怎么拉流）回中文短句，由那一格显示。
   */
  start: (code: string): Promise<NativeResult<CameraStreamStatus>> =>
    call<CameraStreamStatus>("camera_stream_start", { code }),

  /** 退订一路：引用归零服务端才停线程并等它 TEARDOWN。没在流时回 `data: null`，不算错。 */
  stop: (code: string): Promise<NativeResult<CameraStreamStatus | null>> =>
    call<CameraStreamStatus | null>("camera_stream_stop", { code }),

  /** 纯内存快照，不碰网络、不碰库：界面重挂载时用它把"这一路现在怎么样"捡回来。 */
  status: (code: string): Promise<NativeResult<CameraStreamStatus | null>> =>
    call<CameraStreamStatus | null>("camera_stream_status", { code }),
};

/** 阶段 → 那一句人话。Rust 侧只发代码，文案只在这里有一份。 */
export function phaseLabel(phase: string): string {
  switch (phase) {
    case "connecting":
      return "正在连摄像机…";
    case "waiting-keyframe":
      return "已连上，在等第一个关键帧…";
    case "streaming":
      return "画面在流";
    case "error":
      return "画面中断";
    default:
      return phase;
  }
}

/**
 * 订这一路的两条事件，回注销函数（照 `subscribeScale` 的用法：`useEffect` 里
 * `return subscribeCameraStream(...)`）。两条通道都带着 `code`，这里按本路过滤，
 * 所以同屏多路摄像机各听各的。
 *
 * 浏览器预览里一条都订不上（不是错误，是"没有这条路"），只在 `onError` 说一次。
 */
export function subscribeCameraStream(
  code: string,
  onFrame: (frame: CameraFrame) => void,
  onStatus: (status: CameraStreamStatus) => void,
  onError?: (message: string) => void
): () => void {
  if (!runningInTauri()) {
    onError?.(NO_CHANNEL);
    return () => {};
  }
  let disposed = false;
  const unlisteners: Array<() => void> = [];
  const hook = Promise.all([
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen<CameraFrame>(CAMERA_FRAME_EVENT, (e) => {
        if (e.payload.code === code) onFrame(e.payload);
      })
    ),
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen<CameraStreamStatus>(CAMERA_STATUS_EVENT, (e) => {
        if (e.payload.code === code) onStatus(e.payload);
      })
    ),
  ]);
  void hook
    .then(([frame, status]) => {
      // 订阅建立前这一格可能已经卸载了：那时必须当场注销，否则回调会往已卸载的 state 里写
      if (disposed) {
        frame();
        status();
        return;
      }
      unlisteners.push(frame, status);
    })
    .catch((e: unknown) => {
      onError?.(e instanceof Error ? e.message : String(e));
    });
  return () => {
    disposed = true;
    unlisteners.splice(0).forEach((off) => off());
  };
}

/** 一帧约几十 KB：这一句用来把"画面卡住了"和"根本没连上"分开说。 */
export function frameKb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
