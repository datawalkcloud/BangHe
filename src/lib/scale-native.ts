/**
 * 地磅读数流的前端通道（04 §2）。
 *
 * 分两层出口：
 *  1. `nativeScale.start/stop/status` → invoke `scale_start` / `scale_stop` / `scale_status`
 *     （实现在 `src-tauri/src/scale.rs`），开始/停止串口读线程、查是否在流；
 *  2. `subscribeScale(handler)` → 订阅 tauri event `device://scale`，Rust 侧切帧/取数/判稳后
 *     推下来的**已是可用结论**，前端不再自己判稳（`src/store/device.ts` 里的 `tick()` 只是
 *     浏览器演示用的替身）。
 *
 * 三条约定，都和 `@/lib/native` 保持一致：
 *  - **永不 reject**：命令失败回 `{ available: true, error: "中文短句" }`，浏览器预览回
 *    `{ available: false, error: ... }`；界面据此把状态灯打灰并解释原因。
 *  - **不造数据**：浏览器预览里 `subscribeScale` 不会喂任何假读数，一个回调都不发。
 *    否则演示模式的随机数会顺着真实订阅口流进工作台，看起来像"接上真磅了"。
 *  - 事件 payload 用 snake_case（与 Rust `scale::ScaleEvent` 逐字一致），`toReading()` 一次
 *    性映射成 `ScaleState` 的 camelCase；改名只发生在这一处，两边才不会分叉。
 */
import { runningInTauri, type NativeResult } from "@/lib/native";

/** 事件名，与 Rust `scale::SCALE_EVENT` 同源 */
export const SCALE_EVENT = "device://scale";

/**
 * `device://scale` 的原始 payload，与 Rust `scale::ScaleEvent` 字段逐字对齐。
 * 前 8 项是 `ScaleState` 要吃的，后面是帧监视器/状态灯用的附加信息（只加不减）。
 */
export interface ScaleFrame {
  /** 串口打开且近 5 s 内收到过可解析帧 */
  connected: boolean;
  on_scale: boolean;
  /** 当前读数，0.1 kg 整数（稳定时为对齐值） */
  weight_01kg: number;
  /** 按 `align.division_01kg` 对齐后的读数 */
  aligned_01kg: number;
  stable: boolean;
  /** 原帧的可读形式（控制字符转义），落 `weigh_record.raw_frame` 用它 */
  raw_frame: string;
  /** 本地时间 ISO 串 */
  at: string;
  error: string | null;
  /** Offline / Timeout / BadFrame / Unsupported / Busy（04 §1.1 的分类） */
  error_kind: string | null;
  code: string;
  device_id: number;
  port: string;
  samples: number[];
  mean_01kg: number;
  division_01kg: number;
  /** 判稳依据快照（与 Rust `scale::ScaleEvent` 逐字一致）：极差 / 窗口时长 / 帧数下限 / 容差 / 所需时长 */
  spread_01kg: number;
  window_ms: number;
  window_frames: number;
  tolerance_01kg: number;
  stable_ms: number;
  frame_count: number;
  err_count: number;
}

/** 喂给 `useDeviceStore.getState().setScale(...)` 的形状：与 `ScaleState` 的键一致 */
export interface ScaleReading {
  connected: boolean;
  onScale: boolean;
  weight01kg: number;
  aligned01kg: number;
  stable: boolean;
  rawFrame: string;
  at: string;
  error: string | null;
  errorKind: string | null;
  code: string;
  deviceId: number;
  port: string;
  samples: number[];
  mean01kg: number;
  division01kg: number;
  spread01kg: number;
  windowMs: number;
  windowFrames: number;
  tolerance01kg: number;
  stableMs: number;
  frameCount: number;
  errCount: number;
}

/** `scale_status` 的回参，与 Rust `scale::LiveStatus` 对齐（serde camelCase） */
export interface ScaleLiveStatus {
  running: boolean;
  code: string;
  deviceId: number;
  port: string;
  connected: boolean;
  /** 第几次启动：界面用它判断这条状态是不是来自当前这轮订阅 */
  generation: number;
  startedAt: string;
  frameCount: number;
  errCount: number;
  errStreak: number;
  bytesIn: number;
  droppedFrames: number;
  lastFrameAt: string | null;
  /** 最后一次**成功解析**的读数快照；没收到过帧时是 null */
  last: ScaleFrame | null;
  error: string | null;
}

const NO_CHANNEL =
  "当前是浏览器预览，没有地磅串口通道；请用「npm run tauri dev」启动桌面端后重试，工作台可用手工录入继续过磅";

/**
 * 与 `@/lib/native` 里的 `call` 同一套语义（不抛异常、区分"命令失败"与"没有通道"）。
 * 那份 `call` 是模块私有的，而 native.ts 此刻由另一路会话在写，这里宁可重复 8 行也不去动它。
 */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<NativeResult<T>> {
  if (!runningInTauri()) return { available: false, error: NO_CHANNEL };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return { available: true, data: await invoke<T>(cmd, args) };
  } catch (e) {
    return { available: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 事件 → 界面状态。字段名只在这里映射一次。 */
export function toReading(f: ScaleFrame): ScaleReading {
  return {
    connected: f.connected,
    onScale: f.on_scale,
    weight01kg: f.weight_01kg,
    aligned01kg: f.aligned_01kg,
    stable: f.stable,
    rawFrame: f.raw_frame,
    at: f.at,
    error: f.error,
    errorKind: f.error_kind,
    code: f.code,
    deviceId: f.device_id,
    port: f.port,
    samples: f.samples ?? [],
    mean01kg: f.mean_01kg,
    division01kg: f.division_01kg,
    spread01kg: f.spread_01kg ?? 0,
    windowMs: f.window_ms ?? 0,
    windowFrames: f.window_frames ?? 0,
    tolerance01kg: f.tolerance_01kg ?? 0,
    stableMs: f.stable_ms ?? 0,
    frameCount: f.frame_count,
    errCount: f.err_count,
  };
}

export const nativeScale = {
  /**
   * 打开台账里这台磅的串口并开始推流。重复调用是安全的：Rust 侧先停掉旧线程再起新的。
   * 台账是 Mock / 已停用 / 模板没写 COM 口时回中文短句（`available: true, error`）。
   */
  start: (code: string): Promise<NativeResult<ScaleLiveStatus>> =>
    call<ScaleLiveStatus>("scale_start", { code }),

  /** 停掉读线程并归还端口；没在流时调用也回一份当前快照 */
  stop: (): Promise<NativeResult<ScaleLiveStatus>> => call<ScaleLiveStatus>("scale_stop"),

  /** 纯内存快照，不开串口、不碰库，可以跟着界面轮询 */
  status: (): Promise<NativeResult<ScaleLiveStatus>> => call<ScaleLiveStatus>("scale_status"),
};

/**
 * 订阅读数流，回注销函数（照 `nativeIdcard` 的用法：`useEffect` 里 `return subscribeScale(...)`）。
 *
 * 浏览器预览里注册不上事件，**不会喂任何假读数**，只在 `onError` 里说明一次；
 * 演示模式该走 `useScaleTick()` 那条前端模拟路径，由调用方自己决定。
 */
export function subscribeScale(
  handler: (reading: ScaleReading) => void,
  onError?: (message: string) => void,
): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  if (!runningInTauri()) {
    onError?.(NO_CHANNEL);
    return () => {};
  }
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen<ScaleFrame>(SCALE_EVENT, (e) => handler(toReading(e.payload))))
    .then((fn) => {
      // 订阅建立前组件可能已经卸载：那时必须立刻注销，否则回调会继续写已卸载的 store
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch((e: unknown) => {
      onError?.(e instanceof Error ? e.message : String(e));
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** 0.1 kg 整数 → kg 显示值；单位换算的唯一出口，避免各处再手写 `/10` */
export function toKg(weight01kg: number): number {
  return weight01kg / 10;
}
