/**
 * 售粮人档案的人像照片（02 §F3.1 选填项、03 §9.6 `party.photo_attachment_id`）。
 *
 * 三条口径收在这里，免得每个用到它的页面各判一遍：
 *  ① **没有照片是常态**——手工建档、读卡时没取到照片都会留空。所以缺图只给一格安静的
 *    占位，不画碎图标、不上警示色：那会让磅员以为档案坏了，而它只是"还没照片"。
 *  ② 像素只来自 `api.partyPhoto` 回的 `data:` URL，界面从头到尾不碰本机文件路径
 *    （04 §4.3：`attachment.file_path` 在库里唯一一处，不外泄）。
 *  ③ 读不出来（附件行还在、盘上文件丢了）把 Rust 那句人话原样显示，并给出路：
 *    重新上传或刷一次卡补一张。
 */
import { useQuery } from "@tanstack/react-query";
import { UserRoundIcon } from "lucide-react";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "cn";

/** 两档尺寸，比例都跟着身份证芯片照的 102×126 走，不另发明一种裁切 */
const BOX = {
  sm: "h-[52px] w-[42px]",
  md: "h-[118px] w-[96px]",
} as const;

export function PartyPortrait({
  partyId,
  hasPhoto = true,
  size = "md",
  className,
}: {
  /** 档案 id；为 null（还没建出来的新档案）时不查，直接给占位 */
  partyId: number | null;
  /**
   * 档案上到底挂没挂附件（`party.photo_attachment_id != null`）。
   * 没有照片就不发这一枪：档案列表一多，逐个空查就是纯空转，而且"没照片"这件事
   * 档案行本身已经说清了，不需要再问一次后端确认。
   */
  hasPhoto?: boolean;
  size?: keyof typeof BOX;
  className?: string;
}) {
  const { data, isPending, error } = useQuery({
    queryKey: ["party-photo", partyId],
    queryFn: () => api.partyPhoto(partyId as number),
    enabled: partyId != null && hasPhoto,
    // 人像不会自己变，一次会话里同一张档案不必反复解一遍 base64；换照片时由调用方失效这条缓存
    staleTime: 5 * 60_000,
  });

  const frame = cn(
    "shrink-0 overflow-hidden border bg-muted/30 grid place-items-center",
    BOX[size],
    className,
  );

  const empty = (title: string) => (
    <div className={cn(frame, "border-dashed text-muted-foreground")} title={title}>
      <UserRoundIcon className="size-4" aria-hidden />
      <span className="text-[10px]">无照片</span>
    </div>
  );

  if (partyId == null) return empty("这张档案还没有保存，人像照片保存后即可显示");
  if (!hasPhoto) return empty("这张档案还没有人像照片，可上传或刷身份证补一张");
  if (isPending) return <Skeleton className={frame} aria-label="正在读取档案人像" />;
  if (error) {
    const why = error instanceof Error ? error.message : "照片读不出来";
    return (
      <div className={cn(frame, "border-warning bg-warning-bg text-center leading-tight text-warning")} title={why}>
        <span className="px-1 text-[10px]">照片读不出来</span>
      </div>
    );
  }
  if (!data) return empty("这张档案还没有人像照片，可上传或刷身份证补一张");
  return (
    <img
      src={data.dataUrl}
      alt={`${partyId} 号档案人像`}
      title={`建档/更新照片于 ${data.capturedAt?.slice(0, 10) ?? ""}`}
      className={cn(frame, "object-cover")}
    />
  );
}
