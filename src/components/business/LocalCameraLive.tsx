/**
 * 本机 USB 摄像头的实时画面（04 §4 方案 A 前端半边），工作台「过磅画面」与设备中心「抓图」共用。
 *
 * 流由 `local-camera.ts` 的引用计数槽位供给：同一台登记设备的多处画面汇到同一条
 * MediaStream（UVC 常被驱动限成单占用），卸载即归还。开不成流只在这块画面里回一句
 * 人话（04 §4.2 的失败降级），绝不往外报错、不弹框。
 */
import { useEffect, useRef, useState } from "react";
import { CctvIcon } from "lucide-react";
import { acquireLocalCamera, cameraUserHint, type LocalCameraHandle, type LocalCamSpec } from "@/lib/local-camera";
import { cn } from "cn";

export function LocalCameraLive({ spec, className }: { spec: LocalCamSpec; className?: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const handleRef = useRef<LocalCameraHandle | null>(null);
  const [status, setStatus] = useState<"opening" | "live" | "error">("opening");
  const [note, setNote] = useState<string | null>(null);

  const attach = () => {
    const el = videoRef.current;
    const handle = handleRef.current;
    if (el && handle && el.srcObject !== handle.stream) {
      el.srcObject = handle.stream;
      void el.play().catch(() => undefined);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setStatus("opening");
    setNote(null);
    void acquireLocalCamera(spec).then(
      (handle) => {
        if (cancelled) {
          handle.stop();
          return;
        }
        handleRef.current = handle;
        attach();
        setStatus("live");
        setNote(handle.fellBack ? `没找到登记的「${spec.deviceName || "摄像头"}」，画面来自：${handle.label}` : null);
      },
      (e) => {
        if (cancelled) return;
        setStatus("error");
        setNote(cameraUserHint(e));
      },
    );
    return () => {
      cancelled = true;
      handleRef.current?.stop();
      handleRef.current = null;
      const el = videoRef.current;
      if (el) el.srcObject = null;
    };
    // 同一台登记设备只按寻址两键重开；台账其它字段（名字展示用）改动不该掐流
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.deviceId, spec.deviceName]);

  return (
    <div className={cn("absolute inset-0", className)}>
      <video
        ref={(el) => {
          videoRef.current = el;
          if (el) attach();
        }}
        muted
        playsInline
        autoPlay
        className={cn("size-full object-contain", status !== "live" && "invisible")}
      />
      {status !== "live" && (
        <div className="absolute inset-0 flex items-center justify-center px-2 text-center">
          <p className="flex flex-col items-center gap-0.5 text-[11px] text-muted-foreground">
            <CctvIcon className="size-4" />
            {status === "opening" ? "正在打开本机摄像头…" : note}
          </p>
        </div>
      )}
      {status === "live" && note && (
        <span className="absolute right-1 top-1 max-w-[60%] truncate bg-warning-bg/90 px-1 py-0.5 text-[10px] text-warning leading-none">
          {note}
        </span>
      )}
    </div>
  );
}
