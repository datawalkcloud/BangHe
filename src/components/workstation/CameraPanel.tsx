/**
 * ③′ 过磅摄像头画面（04 §4 方案 A：IP 摄像机 RTSP 连续流 / 本机 USB 摄像头实时画面，工作台常驻窗）。
 *
 * 为什么单独占一块：磅员判断「压边 / 不上全磅 / 中途换货 / 车厢夹带」靠的是眼睛，
 * 读数只能证明重量。所以画面必须常驻在工作台，而不是等结算完在角落看到几张缩略图。
 *
 * 展示口径（本次调整）：**台账里启用的相机一次全铺**，卡片内按容器宽度自动横排 / 竖排
 * （CSS grid `auto-fit`+`minmax`）；磅员用右上角「显示」菜单挑掉不看的镜头，隐藏集合按人存
 * 在 `user_preference`，重开工作台还是他那一套。
 *
 * 画面从哪来（三条通道，逐台按台账判）：
 *  - 本机 USB 摄像头（`transport=local`）：WebView2 `getUserMedia` 直接开流；
 *  - 内网 IP 摄像机（海康 ISAPI / 大华 CGI）：服务端按台账开**一条 RTSP 会话**、软解 H.264
 *    子码流，一帧一张 JPEG 由 `device://camera-frame` 推屏（`IpCameraLive` + `camera_stream_*`，
 *    见 `src/lib/camera-stream.ts`）。放在服务端是两桩硬事：海康只认 Digest，web 侧给不出认证头；
 *    且口令只存在于台账，不该下发到页面。子码流若是 H.265，这一格会直接说明去哪儿改。
 *  - 两者都不可得（Mock 档、没填地址）：这一格回一句人话，不当绿标也不拦作业。
 *
 * 三条边界不变：
 *  1. 画面不可用（离线、401、子码流不是 H.264、浏览器预览没有这条通道）时只降级为占位 + 文字说明，
 *     绝不阻断称重与结算（04 §4 失败降级、H6）；磅单上以「无抓拍」标记留痕。
 *  2. 画面里有人像与车牌，属个人信息：不外传、不上传云端；缩略图常驻，
 *     点开放大才按需拉原图并记 `pii.read` 审计（04 §4 隐私）。
 *  3. 多路摄像头（磅区 / 卸粮口）在同一块里同时显示，不再为了看第二路加窗口，
 *     也不再靠顶部两三个 tab 轮流切。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CctvIcon, FilterIcon, Maximize2Icon } from "lucide-react";
import type { CapturePhoto, DeviceConfig, WeighOrder } from "@/mock/types";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { localCameraSpec } from "@/lib/local-camera";
import { LocalCameraLive } from "@/components/business/LocalCameraLive";
import { IpCameraLive, ipCameraSpec } from "@/components/business/IpCameraLive";
import { useSession } from "@/store/session";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeviceStatusLight, ToneBadge } from "@/components/business/badges";
import { cn } from "cn";

/** 每路画面在够宽时的最小占位宽——低于这个宽度宁可换行竖排，也不压成一条横带 */
const TILE_MIN_WIDTH = 220;
/** 隐藏相机集合的偏好键（服务端 `user_preference`，键名走 `prefs.rs::check_key` 允许字符集） */
const HIDDEN_KEY = "workstation.camera.hidden";

export function CameraPanel({
  cameras,
  order,
  photos,
}: {
  cameras: DeviceConfig[];
  order: WeighOrder | null;
  photos: CapturePhoto[];
}) {
  const actorId = useSession((s) => s.session?.actor.id ?? null);
  const [compact, setCompact] = useState(false);
  /** 放大弹窗的目标相机；null = 只从「本单抓拍」入口打开（弹窗只给照片网格 + 说明） */
  const [zoomId, setZoomId] = useState<number | null>(null);
  const [showPhotosOnly, setShowPhotosOnly] = useState(false);

  // 隐藏的相机按人存偏好：跟工作台布局同一张 `user_preference` 表、同一次登录一份，
  // 换账号 / 换工位不串味；写失败静默——重开面板还会回到上次那份，作业本身不受影响。
  const hiddenQuery = useQuery({
    queryKey: ["pref", HIDDEN_KEY, actorId],
    queryFn: () => api.getPref(HIDDEN_KEY),
    enabled: actorId != null,
    staleTime: Infinity,
  });
  const [hidden, setHidden] = useState<number[]>([]);
  const hiddenLoadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (actorId == null || !hiddenQuery.isFetched) return;
    const stamp = `${actorId}:${hiddenQuery.data ?? ""}`;
    if (hiddenLoadedFor.current === stamp) return;
    hiddenLoadedFor.current = stamp;
    try {
      const raw = hiddenQuery.data ? JSON.parse(hiddenQuery.data) : [];
      setHidden(Array.isArray(raw) ? raw.filter((v): v is number => typeof v === "number") : []);
    } catch {
      setHidden([]);
    }
  }, [actorId, hiddenQuery.isFetched, hiddenQuery.data]);
  const toggleHidden = (id: number, show: boolean) => {
    const next = show ? hidden.filter((x) => x !== id) : [...hidden, id];
    setHidden(next);
    hiddenLoadedFor.current = null; // 别等下一次 query 数据把刚改的盖回去
    void api.setPref(HIDDEN_KEY, JSON.stringify(next)).catch(() => undefined);
  };

  const visible = useMemo(() => cameras.filter((c) => !hidden.includes(c.id)), [cameras, hidden]);
  const zoomCam = zoomId == null ? null : cameras.find((c) => c.id === zoomId) ?? null;
  const zoomOpen = showPhotosOnly || zoomCam != null;

  return (
    <Card size="sm" className="min-w-0 py-0 gap-0">
      <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center border-b px-2.5">
        <CardTitle className="flex min-w-0 items-center gap-1.5 text-xs font-semibold">
          <span className="shrink-0">过磅画面</span>
          {cameras.length > 0 && (
            <span className="shrink-0 text-[10px] font-normal text-muted-foreground">
              {visible.length}/{cameras.length}
            </span>
          )}
        </CardTitle>
        <CardAction className="flex items-center gap-1 self-center">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  className="h-5 gap-0.5 px-1 text-[10px]"
                  title="选择要显示的相机（隐藏记住本人）"
                />
              }
            >
              <FilterIcon className="size-3" />
              显示
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>显示哪些相机</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {cameras.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">台账里还没有启用的摄像头</p>
              ) : (
                cameras.map((c) => {
                  const shown = !hidden.includes(c.id);
                  return (
                    <DropdownMenuCheckboxItem
                      key={c.id}
                      checked={shown}
                      onCheckedChange={(v) => toggleHidden(c.id, v === true)}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <DeviceStatusLight status={c.last_status} />
                        <span className="truncate text-xs">{c.name}</span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  );
                })
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="xs" variant="ghost" onClick={() => setCompact((v) => !v)} className="h-5 px-1 text-[10px]">
            {compact ? "展开" : "收起"}
          </Button>
        </CardAction>
      </CardHeader>

      {/* 整卡高度都让给画面：内容区撑满格子（ws-tile 那条 CSS 已给 card-content flex-1），
          画面网格 flex-1 吃掉剩余高度——把面板拖大画面就跟着变大，不再固定 130 px 裁掉上下。 */}
      <CardContent className="flex h-full min-h-0 flex-col gap-1 p-2">
        {cameras.length === 0 ? (
          <div className="flex h-[80px] items-center justify-center border bg-muted/60 text-[11px] text-muted-foreground">
            <p className="flex flex-col items-center gap-0.5">
              <CctvIcon className="size-4" />
              台账里没有启用的摄像头：请到设备中心登记
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-[80px] items-center justify-center border bg-muted/60 text-[11px] text-muted-foreground">
            相机已全部隐藏，点右上角「显示」挑一路
          </div>
        ) : (
          <div
            className="grid min-h-0 flex-1 gap-1"
            style={{
              // 容器宽 → 相机自动横排；面板被拖窄 → 自动换行竖排。每格保持同样板高，
              // 用 minmax(min(...,100%),1fr) 防止一格也撑破容器（老 grid 溢出坑）。
              gridTemplateColumns: `repeat(auto-fit, minmax(min(${TILE_MIN_WIDTH}px, 100%), 1fr))`,
            }}
          >
            {visible.map((c) => (
              <CameraTile
                key={c.id}
                cam={c}
                order={order}
                compact={compact}
                onZoom={() => {
                  setShowPhotosOnly(false);
                  setZoomId(c.id);
                }}
              />
            ))}
          </div>
        )}

        {photos.length > 0 ? (
          <div className="flex shrink-0 items-center gap-1">
            <span className="shrink-0 text-[10px] text-muted-foreground">本单抓拍 {photos.length} 张</span>
            {photos.map((p) => (
              <Button
                key={p.id}
                size="xs"
                variant={p.missing ? "destructive" : "outline"}
                onClick={() => {
                  setZoomId(null);
                  setShowPhotosOnly(true);
                }}
                className="min-w-0"
              >
                <span className="truncate">{p.missing ? `${p.label}缺失` : p.device_label ? `${p.label} · ${p.device_label}` : p.label}</span>
              </Button>
            ))}
          </div>
        ) : (
          <p className="shrink-0 text-[10px] text-muted-foreground">
            本单暂无抓拍{order ? "：捕获毛/皮重时自动取图；摄像机离线只标记，不拦作业。" : "：先取号制单后才会触发。"}
          </p>
        )}
      </CardContent>

      <Dialog
        open={zoomOpen}
        onOpenChange={(v) => {
          if (!v) {
            setZoomId(null);
            setShowPhotosOnly(false);
          }
        }}
      >
        <DialogContent className="max-w-[860px]">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 text-sm">
              过磅画面放大查看
              {zoomCam && (
                <ToneBadge tone={localCameraSpec(zoomCam) != null || ipCameraSpec(zoomCam) != null || zoomCam.last_status === "online" ? "success" : "danger"}>
                  {zoomCam.name}
                </ToneBadge>
              )}
              {order && <span className="tnum text-xs text-muted-foreground">{order.order_no}</span>}
            </DialogTitle>
          </DialogHeader>
          {zoomCam && <ZoomBody cam={zoomCam} order={order} />}
          {photos.length > 0 && (
            <div className={cn("grid gap-1.5", zoomCam ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-3")}>
              {photos.map((p) => (
                <div key={p.id} className="flex flex-col gap-1">
                  <div
                    className={cn(
                      "flex h-20 items-end border bg-muted/60 p-1 text-[10px]",
                      p.missing && "border-destructive/40 text-destructive",
                    )}
                  >
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

/** 单路画面：占位框 + 左上设备/车牌覆盖层，右上角「放大」图标按钮 */
function CameraTile({
  cam,
  order,
  compact,
  onZoom,
}: {
  cam: DeviceConfig;
  order: WeighOrder | null;
  compact: boolean;
  onZoom: () => void;
}) {
  // 三条通道各走各的：本机 USB 摄像头在 WebView2 里直接开流；内网 IP 机由服务端按台账
  // 拉一条 RTSP 子码流、解出的帧推回这一格（见 `IpCameraLive`）；剩下的才降级成一句占位说明。
  const spec = localCameraSpec(cam);
  const ip = spec == null ? ipCameraSpec(cam) : null;
  const online = spec != null || ip != null || cam.last_status === "online";
  return (
    <div
      className={cn(
        "group relative w-full overflow-hidden border transition-all",
        // 高度跟着面板走：非紧凑态只保底 130 px，往上由 grid 行拉伸填满（画面是 object-contain，
        // 拉多高都不会裁掉上下）；黑底让 16:9 之外的留影像播放器信箱，而不是灰块。
        compact ? "h-[56px]" : "min-h-[130px]",
        spec != null || ip != null ? "bg-black" : "bg-muted/60",
        !online && "border-destructive/40",
      )}
    >
      {spec ? (
        <LocalCameraLive spec={spec} />
      ) : ip ? (
        <IpCameraLive spec={ip} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center px-2 text-center">
          {!compact && (
            <p className="flex flex-col items-center gap-0.5 text-[11px] leading-tight text-muted-foreground">
              <CctvIcon className="size-4" />
              {noFrameHint(cam)}
            </p>
          )}
        </div>
      )}

      <span className="absolute left-1 top-1 flex max-w-[75%] items-center gap-1 truncate bg-background/85 px-1 py-0.5 text-[10px] leading-none text-foreground">
        <DeviceStatusLight status={cam.last_status} />
        <span className="truncate">{cam.name}</span>
        {order && <span className="tnum shrink-0 opacity-75">· {order.order_no.slice(-6)}</span>}
      </span>
      <Button
        size="xs"
        variant="ghost"
        onClick={onZoom}
        title="放大"
        className="absolute right-1 top-1 z-10 h-5 w-5 min-w-0 bg-background/85 p-0 opacity-80 hover:opacity-100"
      >
        <Maximize2Icon className="size-3" />
      </Button>
      {order?.vehicle_no && (
        <span className="absolute bottom-1 left-1 bg-background/85 px-1 py-0.5 text-[10px] leading-none tnum text-foreground">
          {order.vehicle_no}
        </span>
      )}
    </div>
  );
}

/** 放大画面里的实时画面块——跟小卡走同一套通道判断，只是拿 aspect-video 撑大并带上帧信息 */
function ZoomBody({ cam, order }: { cam: DeviceConfig; order: WeighOrder | null }) {
  const spec = localCameraSpec(cam);
  const ip = spec == null ? ipCameraSpec(cam) : null;
  const online = spec != null || ip != null || cam.last_status === "online";
  return (
    <div className="relative aspect-video w-full overflow-hidden border bg-muted/60">
      {spec ? (
        <LocalCameraLive spec={spec} />
      ) : ip ? (
        <IpCameraLive spec={ip} meta />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">
          {online ? noFrameHint(cam) : (cam.last_error ?? "摄像机离线，无画面")}
        </div>
      )}
      {order?.vehicle_no && (
        <span className="absolute bottom-1 left-1 bg-background/85 px-1.5 py-0.5 text-[10px] tnum">{order.vehicle_no}</span>
      )}
    </div>
  );
}

/**
 * 没画面时的那句话：只说"此刻为什么没画面、去设备中心拧哪一颗螺丝"。
 * 拉流本身的失败（401、连不上、子码流是 H.265）由 `IpCameraLive` 带着服务端原话显示，不到这里来。
 */
function noFrameHint(cam: DeviceConfig): string {
  if (cam.is_mock === 1) return "这台是 Mock 模拟档：到设备中心切回真实设备才出画面";
  if (!String(cam.config?.host ?? "").trim()) return "台账里没填摄像机地址：到设备中心补「地址（IP）」";
  return cam.last_error ?? "摄像机离线，本单将标「无抓拍」";
}
