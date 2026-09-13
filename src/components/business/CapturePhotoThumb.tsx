/**
 * 过磅抓拍缩略图（04 §4.3、05 §6.5）。像素只来自 `api.capturePhoto(recordId)` 回的 `data:` URL，
 * 界面从头到尾不碰本机文件路径与 attachment.id——读图通道在 Rust 侧按称重记录 id 反查并记 `pii.read`。
 *
 * 三条口径收在这儿，免得每个用到它的页面各判一遍：
 *  ① **缺图是常态**（设备离线降级、手工跳过）：只给一格安静的"无画面"占位 + 文字，不上警示色、
 *     不画碎图标——05 §6.2「缺失只标文字，不用颜色单独表达」。
 *  ② 点开放大是"按需读原图"，会触发一次后端留痕；缩略图本身随详情页加载。
 *  ③ 读不出来（附件行在、盘上文件丢了）把后端那句人话原样显示，不假装成功。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ImageIcon } from "lucide-react";
import { api } from "@/lib/api";
import type { CapturePhoto } from "@/mock/types";
import { dateTime } from "@/lib/format";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "cn";

export function CapturePhotoThumb({ photo }: { photo: CapturePhoto }) {
  const [zoom, setZoom] = useState(false);
  const { data, isPending, error } = useQuery({
    queryKey: ["capture-photo", photo.id],
    queryFn: () => api.capturePhoto(photo.id),
    // 缺图不发这一枪：详情页一屏几张空查是纯空转，"无抓拍"这件事磅单本身已经说清
    enabled: !photo.missing,
    staleTime: 5 * 60_000,
  });

  const box = "flex aspect-[4/3] min-w-0 items-center justify-center overflow-hidden border bg-muted/30";

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {photo.missing ? (
        <div className={cn(box, "text-[11px] text-muted-foreground")}>
          <ImageIcon className="size-4" aria-hidden />
          <span className="ml-1">无画面</span>
        </div>
      ) : isPending ? (
        <Skeleton className={box} aria-label="正在读取抓拍" />
      ) : error || !data ? (
        <div
          className={cn(box, "border-warning bg-warning-bg px-1 text-center text-[10px] leading-tight text-warning")}
          title={error instanceof Error ? error.message : "抓拍读不出来"}
        >
          {error instanceof Error ? error.message : "抓拍已丢失"}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setZoom(true)}
          className={cn(box, "cursor-zoom-in")}
          title="点击查看原图（会记一次访问）"
        >
          <img src={data.dataUrl} alt={`${photo.label}`} className="size-full object-cover" />
        </button>
      )}
      <span className="truncate text-xs">{photo.label}</span>
      <span className="tnum text-[11px] text-muted-foreground">
        {photo.missing ? "无抓拍" : dateTime(photo.captured_at)}
      </span>

      <Dialog open={zoom} onOpenChange={setZoom}>
        <DialogContent className="max-w-[900px]">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold">
              {photo.label} · <span className="tnum font-normal text-muted-foreground">{dateTime(photo.captured_at)}</span>
            </span>
            {data && <img src={data.dataUrl} alt={photo.label} className="max-h-[70vh] w-full border object-contain" />}
            <span className="text-xs text-muted-foreground">
              画面含人像与车牌，属个人信息：仅本机留存、不外传，本次查看已记审计；按 attachment_keep_days 到期清理。
            </span>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
