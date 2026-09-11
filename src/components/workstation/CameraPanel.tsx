/**
 * ③′ 过磅摄像头画面（04 §4 方案 A：IP 摄像机 HTTP 抓图，工作台常驻窗）。
 *
 * 为什么单独占一块：磅员判断「压边 / 不上全磅 / 中途换货 / 车厢夹带」靠的是眼睛，
 * 读数只能证明重量。所以画面必须常驻在工作台，而不是等结算完在角落看到几张缩略图。
 *
 * 三条边界：
 *  1. 画面不可用（离线、401、浏览器预览没有原生抓图通道）时只降级为占位 + 文字说明，
 *     绝不阻断称重与结算（04 §4 失败降级、H6）；磅单上以「无抓拍」标记留痕。
 *  2. 画面里有人像与车牌，属个人信息：不外传、不上传云端；缩略图常驻，
 *     点开放大才按需拉原图并记 `pii.read` 审计（04 §4 隐私）。
 *  3. 多路摄像头（磅区 / 卸粮口）在同一块里切换，避免为了看第二路再加一个窗口。
 */
import { useEffect, useMemo, useState } from "react";
import { CctvIcon, CctvOffIcon, ClockIcon } from "lucide-react";
import type { CapturePhoto, DeviceConfig, WeighOrder } from "@/mock/types";
import { DEVICE_STATUS } from "@/lib/constants";
import { dateTime, nowLocalISO } from "@/lib/format";
import { useDeviceStore } from "@/store/device";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DeviceStatusLight, ToneBadge } from "@/components/business/badges";
import { cn } from "cn";

/** 抓图刷新节拍：真实实现是 GET snapshotUrl，这里只用来驱动「刷新于」时间戳 */
const FRAME_TICK_MS = 5_000;

export function CameraPanel({
  cameras,
  order,
  photos,
  mockOff,
}: {
  cameras: DeviceConfig[];
  order: WeighOrder | null;
  photos: CapturePhoto[];
  mockOff: boolean;
}) {
  const lastCaptureAt = useDeviceStore((s) => s.camera.lastCaptureAt);
  const [pickId, setPickId] = useState<number | null>(null);
  const [compact, setCompact] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [frameAt, setFrameAt] = useState(() => nowLocalISO());

  const cam = useMemo(
    () => cameras.find((c) => c.id === pickId) ?? cameras.find((c) => c.is_default === 1) ?? cameras[0] ?? null,
    [cameras, pickId],
  );

  // 画面定时刷新（真实环境是重新 GET 一张 snapshot，浏览器预览阶段只走时标）
  useEffect(() => {
    const id = window.setInterval(() => setFrameAt(nowLocalISO()), FRAME_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const online = !mockOff && cam?.last_status === "online";
  const snapshotHint = cam ? `${cam.config?.host ?? "—"}${String(cam.config?.snapshotUrl ?? "")}` : "未配置摄像头";

  return (
    <Card size="sm" className="min-w-0 py-0 gap-0">
      <CardHeader className="grid-cols-[1fr_auto] items-center border-b py-1 px-2.5">
        <CardTitle className="flex min-w-0 items-center gap-1.5 text-xs font-semibold">
          <span className="shrink-0">③′ 过磅画面</span>
          {cameras.length > 1 && (
            <span className="flex shrink-0 items-center gap-0.5">
              {cameras.map((c) => (
                <Button
                  key={c.id}
                  size="xs"
                  variant={c.id === cam?.id ? "default" : "ghost"}
                  onClick={() => setPickId(c.id)}
                  title={`${c.name} · ${DEVICE_STATUS[c.last_status].label}`}
                  className="h-5 px-1 text-[10px]"
                >
                  {c.name.split("（")[0]}
                </Button>
              ))}
            </span>
          )}
          {cam && <DeviceStatusLight status={cam.last_status} />}
        </CardTitle>
        <CardAction className="flex items-center gap-1 self-center">
          <Button size="xs" variant="ghost" onClick={() => setCompact((v) => !v)} className="h-5 px-1 text-[10px]">
            {compact ? "展开" : "收起"}
          </Button>
          <Button size="xs" variant="outline" onClick={() => setZoom(true)} className="h-5 px-1 text-[10px]">
            放大
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-1 p-2">
        <div
          className={cn(
            "relative w-full overflow-hidden border bg-muted/60 transition-all",
            compact ? "h-[56px]" : "h-[130px]",
            !online && "border-destructive/40",
          )}
        >
          {/* 覆盖层：左上设备、左下车牌、右下时标，都是黑白打印/回看时对得上号的字段 */}
          <div className="absolute inset-0 flex items-center justify-center px-2 text-center">
            {online ? (
              !compact && (
                <p className="text-[11px] leading-tight text-muted-foreground">
                  {snapshotHint} 实时抓图
                  <br />
                  <span className="text-[10px] opacity-75">（桌面端加载监控帧，支持点击放大）</span>
                </p>
              )
            ) : (
              <p className="flex flex-col items-center gap-0.5 text-[11px] text-muted-foreground">
                {mockOff ? <CctvOffIcon className="size-4" /> : <CctvIcon className="size-4" />}
                {mockOff
                  ? "外设已关闭（Mock 关闭），本单将标「无抓拍」"
                  : (cam?.last_error ?? "摄像机离线，本单将标「无抓拍」")}
              </p>
            )}
          </div>

          <span className="absolute left-1 top-1 max-w-[70%] truncate bg-background/85 px-1 py-0.5 text-[10px] text-foreground leading-none">
            {cam?.name ?? "未配置摄像头"}
            {order ? ` · ${order.order_no.slice(-6)}` : ""}
          </span>
          {order?.vehicle_no && (
            <span className="absolute bottom-1 left-1 bg-background/85 px-1 py-0.5 text-[10px] tnum text-foreground leading-none">
              {order.vehicle_no}
            </span>
          )}
          <span className="absolute bottom-1 right-1 flex items-center gap-0.5 bg-background/85 px-1 py-0.5 text-[10px] tnum text-foreground leading-none">
            <ClockIcon className="size-2.5" />
            {dateTime(frameAt).slice(5)}
            {lastCaptureAt ? ` · 抓拍 ${lastCaptureAt.slice(11, 19)}` : ""}
          </span>
        </div>

        {photos.length > 0 ? (
          <div className="flex items-center gap-1">
            <span className="shrink-0 text-[10px] text-muted-foreground">本单抓拍 {photos.length} 张</span>
            {photos.map((p) => (
              <Button key={p.id} size="xs" variant={p.missing ? "destructive" : "outline"} onClick={() => setZoom(true)} className="min-w-0">
                <span className="truncate">{p.missing ? `${p.label}缺失` : p.label}</span>
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">
            本单暂无抓拍{order ? "：捕获毛/皮重时自动取图；摄像机离线只标记，不拦作业。" : "：先取号制单后才会触发。"}
          </p>
        )}
      </CardContent>

      <Dialog open={zoom} onOpenChange={setZoom}>
        <DialogContent className="max-w-[860px]">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 text-sm">
              过磅画面放大查看
              {cam && <ToneBadge tone={online ? "success" : "danger"}>{cam.name}</ToneBadge>}
              {order && <span className="tnum text-xs text-muted-foreground">{order.order_no}</span>}
            </DialogTitle>
          </DialogHeader>
          <div className="relative aspect-video w-full overflow-hidden border bg-muted/60">
            <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">
              {online
                ? `桌面端在此按需要显示 ${snapshotHint} 的原图（查看原图会写 pii.read 审计）`
                : (cam?.last_error ?? "摄像机离线，无画面")}
            </div>
            {order?.vehicle_no && (
              <span className="absolute bottom-1 left-1 bg-background/85 px-1.5 py-0.5 text-[10px] tnum">{order.vehicle_no}</span>
            )}
          </div>
          {photos.length > 0 && (
            <div className="grid grid-cols-3 gap-1.5">
              {photos.map((p) => (
                <div key={p.id} className="flex flex-col gap-1">
                  <div className={cn("flex h-20 items-end border bg-muted/60 p-1 text-[10px]", p.missing && "border-destructive/40 text-destructive")}>
                    {p.missing ? `${p.label}：抓拍缺失` : p.label}
                  </div>
                  <span className="tnum truncate text-[10px] text-muted-foreground">{dateTime(p.captured_at)}</span>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            画面与缩略图仅本机留存，按 attachment_keep_days 到期清理；缺失只标文字，不用颜色单独表达（05 §6.2）。
          </p>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
