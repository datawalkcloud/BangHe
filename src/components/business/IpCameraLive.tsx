/**
 * 内网 IP 摄像机的实时画面（04 §4 方案 A 的第二条通道：服务端拉 RTSP 子码流、H.264 软解、
 * 一帧一张 JPEG 由事件推屏）。
 *
 * 这里经历过一次换骨：先前这一格是"一秒向摄像机 HTTP 抓一张整图"，看着像预览、其实是截图。
 * 现在改成连续流——一台机一条 RTSP/TCP 会话、只订子码流（768×432 量级），摄像机侧的负担从
 * "每秒重做一次整图编码"变回"它本来就在发的码流"，磅员看到的是真正的连续动作。
 * 通道全在 `@/lib/camera-stream`（永不 reject 的那三条约定在那里），本文件只管一格的渲染。
 *
 * 三条边界与本机摄像头（`LocalCameraLive`）同口径：
 *  1. **只降级不报错**：连不上、401、子码流是 H.265、等不到关键帧——都只在这格里回一句人话，
 *     绝不弹框、绝不拦过磅（04 §4.2、H6）；
 *  2. **一码流多处看**：小卡与放大弹窗各自订一次，服务端按引用计数共用同一条会话，
 *     关弹窗不会把小卡一起停掉（见 `camera-stream.ts` 约定 2）；
 *  3. **别拿冻图当画面**：帧只按 (generation, seq) 单调前进才收，重连后的新会话一定盖掉旧帧。
 */
import { useEffect, useState } from "react";
import { CctvIcon } from "lucide-react";
import type { DeviceConfig } from "@/mock/types";
import {
  cameraStream,
  frameKb,
  phaseLabel,
  subscribeCameraStream,
  type CameraFrame,
  type CameraStreamStatus,
} from "@/lib/camera-stream";
import { localCameraSpec } from "@/lib/local-camera";
import { cn } from "cn";

/** 一台内网摄像机的取流寻址：服务端按台账里的 `code` 拼 RTSP 端点，前端拿不到也不该拿口令。 */
export interface IpCamSpec {
  code: string;
  host: string;
}

/**
 * 这台相机该不该由服务端拉流。三种情况回 null：本机 USB 摄像头（画面在 WebView2 里）、
 * Mock 档（演示机不出真画面）、以及没填地址的（父组件保留原占位文案更贴事实）。
 */
export function ipCameraSpec(cam: DeviceConfig | null | undefined): IpCamSpec | null {
  if (!cam || cam.kind !== "camera" || cam.is_mock === 1) return null;
  if (localCameraSpec(cam) != null) return null;
  const host = String(cam.config?.host ?? "").trim();
  return host ? { code: cam.code, host } : null;
}

/** 一格要看的东西：最新一帧 + 服务端状态 + 命令层的错 + 这一格的实测帧率。 */
export interface IpCameraLiveState {
  frame: CameraFrame | null;
  status: CameraStreamStatus | null;
  /** 台账非法、浏览器预览没有这条通道——会话内的错在 `status.error` 里，两边不混 */
  error: string | null;
  fps: number;
}

/**
 * 订一路流：挂载即 `start`、卸载即 `stop`，帧与状态从事件回来。
 *
 * `stop` 只在 `start` 已回之后才发（`started` 那个闸）：命令在途时提前退订，服务端可能
 * 先收到 stop（那时还没有这一路，白退一次）、后收到 start，结果就是留下一条没人看的会话
 * 一直流到程序退出。让每个订户的 stop 严格排在自己的 start 之后，计数就怎么也乱不了。
 */
export function useIpCameraStream(code: string): IpCameraLiveState {
  const [frame, setFrame] = useState<CameraFrame | null>(null);
  const [status, setStatus] = useState<CameraStreamStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);

  useEffect(() => {
    let live = true;
    let started = false;
    let seen = 0;
    const tick = window.setInterval(() => {
      setFps(seen);
      seen = 0;
    }, 1000);
    const unsubscribe = subscribeCameraStream(
      code,
      (f) => {
        if (!live) return;
        seen += 1;
        setFrame((cur) => (isNewerFrame(cur, f) ? f : cur));
      },
      (s) => {
        if (live) setStatus(s);
      },
      (message) => {
        if (live) setError(message);
      }
    );
    void cameraStream.start(code).then((r) => {
      started = true;
      // 命令在途时这一格已经卸了：由这里补发那一次退订（见函数头注的闸）
      if (!live) {
        void cameraStream.stop(code);
        return;
      }
      if (r.error) setError(r.error);
      if (r.available && r.data) setStatus(r.data);
    });
    return () => {
      live = false;
      window.clearInterval(tick);
      unsubscribe();
      if (started) void cameraStream.stop(code);
    };
  }, [code]);

  return { frame, status, error, fps };
}

/** (generation, seq) 字典序比较：同一趟会话里 seq 单调，跨趟则新趟整体作数。 */
function isNewerFrame(cur: CameraFrame | null, next: CameraFrame): boolean {
  if (!cur) return true;
  if (cur.generation !== next.generation) return next.generation > cur.generation;
  return next.seq > cur.seq;
}

/**
 * 一格里外框之内的实时画面。`meta` 给放大画面用：右下角标出这一帧多大、哪来的分辨率、
 * 这一格实测看到几帧——网慢、解码慢还是摄像机根本没发，当场分得开。
 */
export function IpCameraLive({ spec, className, meta }: { spec: IpCamSpec; className?: string; meta?: boolean }) {
  const { frame, status, error, fps } = useIpCameraStream(spec.code);
  // 会话内的错优先于命令层的错：那一句是摄像机原话（"401"、"没有 H.264 轨"），更有用
  const why = status?.error ?? error ?? null;
  const stalled = frame != null && (status?.phase === "error" || (why != null && status?.connected === false));

  let note: string | null = null;
  if (!frame) note = why ?? (status ? phaseLabel(status.phase) : `正在连 ${spec.host}…`);
  else if (stalled) note = `画面停在上一帧：${why ?? "连接已断"}`;

  return (
    <div className={cn("absolute inset-0", className)}>
      {/* 旧帧留在 DOM 里当底：换帧只是改 src，重连那一小段不会闪成一块空框 */}
      {frame && <img src={frame.dataUrl} alt="" className="size-full object-cover" />}
      {!frame && (
        <div className="absolute inset-0 flex items-center justify-center px-2 text-center">
          <p className="flex flex-col items-center gap-0.5 text-[11px] leading-tight text-muted-foreground">
            <CctvIcon className="size-4" />
            {note}
          </p>
        </div>
      )}
      {frame && note && (
        <span className="absolute bottom-1 left-1 max-w-[85%] truncate bg-warning-bg/90 px-1 py-0.5 text-[10px] leading-none text-warning">
          {note}
        </span>
      )}
      {frame && meta && (
        <span className="absolute bottom-1 right-1 bg-background/85 px-1 py-0.5 text-[10px] leading-none tnum text-foreground">
          {frameKb(frame.bytes)} · {frame.width}×{frame.height} · {fps} fps
          {status && status.refs > 1 ? ` · ${status.refs} 处在看` : ""}
        </span>
      )}
    </div>
  );
}
