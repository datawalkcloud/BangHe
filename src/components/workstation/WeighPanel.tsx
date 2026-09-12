/**
 * ③ 称重区（05 §4 中栏上）。
 *
 * 三条现场规则写死在这里：
 *  1. 读数不稳定不允许捕获——按钮禁用并说明原因（05 §5 要求禁用必须带文字）
 *  2. 仪表离线时必须能改手录，但手录会永久标记在磅单上，迎检必查
 *  3. 皮重与历史偏差超容差 → **不拦下这次捕获**：数据照常有效，只给一句警告，
 *     并在磅单上留醒目提醒（本面板醒目条、详情页、码单票面「皮重警示」栏、审计）
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PenLineIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { announce } from "@/lib/voice-prompt";
import type { WeighOrder } from "@/mock/types";
import { dateTime, fromKg, nowLocalISO, toKg, weight } from "@/lib/format";
import { useDeviceStore } from "@/store/device";
import { actorId, useSession } from "@/store/session";
import { useHotkey } from "@/hooks/useHotkey";
import { WeightDisplay } from "@/components/business/WeightDisplay";
import { NumField } from "@/components/business/NumField";
import { ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "cn";

interface Pending {
  weight_01kg: number;
  source: "scale" | "manual";
}

export function WeighPanel({
  order,
  mean01kg,
  tolerancePct,
  scalePort,
  scaleDivision01kg,
  cameraOnline,
}: {
  order: WeighOrder | null;
  mean01kg: number | null;
  tolerancePct: number;
  scalePort: string;
  scaleDivision01kg: number;
  cameraOnline: boolean;
}) {
  const scale = useDeviceStore((s) => s.scale);
  const setCamera = useDeviceStore((s) => s.setCamera);
  const can = useSession((s) => s.can);
  const qc = useQueryClient();

  const [manual, setManual] = useState(false);
  const [manualTare, setManualTare] = useState<number | null>(null);
  const [manualGross, setManualGross] = useState<number | null>(null);
  const [flash, setFlash] = useState<"gross" | "tare" | null>(null);

  /** 待捕项：缺哪项就优先提示哪项，两项都有则为复称 */
  const next: "gross" | "tare" | null = !order
    ? null
    : order.gross_weight_01kg == null
      ? "gross"
      : order.tare_weight_01kg == null
        ? "tare"
        : null;

  const capture = useMutation({
    mutationFn: (args: Pending & { weigh_type: "gross" | "tare"; warning?: string | null }) =>
      api.capture({
        order_no: order!.order_no,
        weigh_type: args.weigh_type,
        weight_01kg: args.weight_01kg,
        source: args.source,
        operator_id: actorId(),
        raw_frame:
          args.source === "scale"
            ? // 真机流的原帧是迎检时唯一能对回仪表报文的证据；只有模拟流才用合成句占位
              (scale.rawFrame ?? `=W${(args.weight_01kg / 10).toFixed(1)}kg ST`)
            : undefined,
        has_photo: cameraOnline,
        tare_warning: args.warning ?? null,
      }),
    onSuccess: (o, args) => {
      if (!o) {
        toast.error("捕获失败：磅单不存在或已被他人修改");
        announce("捕获失败，这张单可能已经被改过", `ic-capture:${order?.order_no ?? "-"}`);
        return;
      }
      // 抓拍时间给下游用 dateTime 按字面切分展示，存 UTC 串会让时标少 8 小时
      if (cameraOnline) setCamera({ lastCaptureAt: nowLocalISO() });
      setFlash(args.weigh_type);
      window.setTimeout(() => setFlash(null), 700);
      const manualTag = args.source === "manual" ? "（手录）" : "";
      // 超容差不拦这次捕获：以服务端复核结果为准给警告，警示文案同时已记在磅单上（醒目条/票面/审计）。
      // 只判皮重那一捕——毛重/复称时单上可能挂着更早留下的警示，别拿旧文案冒充这次的结论
      if (args.weigh_type === "tare" && o.tare_override_reason) {
        toast.warning(`皮重 ${weight(args.weight_01kg)} 已捕获${manualTag}：偏差超出容差，已在磅单醒目提醒`, {
          description: o.tare_override_reason,
        });
        announce("皮重偏差超出容差，请核对车上有没有留人", `ic-tare-tol:${o.order_no}`);
      } else {
        toast.success(`${args.weigh_type === "gross" ? "毛重" : "皮重"} ${weight(args.weight_01kg)} 已捕获${manualTag}`);
        // 去重键与后台刷卡那条路共用一套（useIcWorkflow 里同名单号），同一笔重量只念一次
        announce(
          args.weigh_type === "gross" ? "毛重已捕获，请卸货后再来一次" : "皮重已捕获，可以下磅了",
          `ic-weight:${o.order_no}:${args.weigh_type}`,
        );
      }
      qc.invalidateQueries({ queryKey: ["order", o.order_no] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["open-orders"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["party", o.party_id] });
    },
    // Rust 闸门回的是人话（"本单当前为 settled，不能再称重"），吞掉就没法排障了
    onError: (e: Error) => {
      toast.error(`捕获失败：${e.message || "请重试；读数未丢，仪表仍在推送"}`);
      // 服务端原因带状态码与单号，念出来没人听得懂，只念结论与下一步
      announce("捕获失败，读数没有丢，再捕一次", `ic-catch:${order?.order_no ?? "-"}`);
    },
  });

  function submit(type: "gross" | "tare", value01kg: number, source: "scale" | "manual") {
    if (!order) {
      toast.error("尚未制单，无法捕获读数");
      announce("还没有制单，先点制单再称重", "w-noorder");
      return;
    }
    if (!can("weigh.capture")) {
      toast.error("当前岗位无权捕获读数，需磅员或站长");
      announce("当前岗位不能称重，请换磅员或站长登录", "w-noperm");
      return;
    }
    if (source === "manual" && !can("weigh.manual")) {
      toast.error("手录重量需磅员或站长岗位");
      announce("手录重量需要磅员或站长岗位", "w-nomanual");
      return;
    }
    if (value01kg <= 0) {
      toast.error("读数必须大于 0");
      announce("读数是零，这一笔不记账", `ic-zero:${order.order_no}`);
      return;
    }
    // 皮重容差（05 §4 ②）：超差只附上警示文案照常捕获，不再拦下要授权；判定以服务端复算为准
    if (type === "tare" && mean01kg != null && tolerancePct > 0) {
      const tol = Math.round((mean01kg * tolerancePct) / 100);
      const diff = value01kg - mean01kg;
      if (Math.abs(diff) > tol) {
        capture.mutate({
          weigh_type: type,
          weight_01kg: value01kg,
          source,
          warning: `偏差 ${diff > 0 ? "+" : "-"}${weight(Math.abs(diff), false)} kg（容差 ±${tolerancePct}%）`,
        });
        return;
      }
    }
    capture.mutate({ weigh_type: type, weight_01kg: value01kg, source });
  }

  function captureLive(type: "gross" | "tare") {
    if (!scale.connected) {
      toast.error(scale.error ? `仪表离线：${scale.error}` : "仪表离线，请改用手工录入");
      announce("仪表离线，这一笔没记上，请改手录", `ic-scale:${order?.order_no ?? "-"}`);
      return;
    }
    if (!scale.stable) {
      toast.warning("读数未稳定，请等车辆停稳后再捕获");
      announce("读数还没稳定，等车停稳再捕", `ic-scale:${order?.order_no ?? "-"}`);
      return;
    }
    submit(type, scale.weight01kg, "scale");
  }

  // 空格捕当前待捕项；P 捕皮重（05 §5）
  useHotkey(" ", () => captureLive(next ?? "gross"), { enabled: !!order });
  useHotkey("p", () => captureLive("tare"), { enabled: !!order });

  const records = order?.records ?? [];
  const lastRecord = records[records.length - 1];

  return (
    <Card size="sm" className="min-w-0 py-0 gap-0">
      <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center border-b px-2.5">
        <CardTitle className="text-xs font-semibold">称重区</CardTitle>
        <CardAction className="flex items-center gap-1.5 self-center text-xs text-muted-foreground">
          分度 {weight(scaleDivision01kg, false)} · {scalePort}
          {!cameraOnline && <ToneBadge tone="danger">无抓拍</ToneBadge>}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 p-2">
        <div
          className={cn(
            "flex flex-col sm:flex-row items-stretch justify-between gap-2 border bg-muted/20 p-2 transition-colors",
            flash && "border-success bg-success-bg",
            !scale.connected && "bg-muted/50",
          )}
        >
          {/* 左侧：地磅实时读数 */}
          <div className="flex min-w-0 flex-1 flex-col justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">地磅实时读数</span>
            <WeightDisplay
              value01kg={scale.connected ? scale.weight01kg : null}
              stable={scale.stable}
              connected={scale.connected}
              size="lg"
            />
          </div>

          {/* 右侧：本单已取重量明细 + 捕获操作（填掉读数右边的空白） */}
          <div className="flex shrink-0 min-w-[220px] flex-col justify-center gap-1.5 border-t sm:border-l sm:border-t-0 pt-1.5 sm:pt-0 sm:pl-2.5">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground border-b pb-0.5">本单实测重量</span>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">毛重</span>
                <span className="tnum font-semibold text-foreground">
                  {order?.gross_weight_01kg != null ? weight(order.gross_weight_01kg) : "待捕获"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">皮重</span>
                <span className="tnum font-semibold text-foreground">
                  {order?.tare_weight_01kg != null ? weight(order.tare_weight_01kg) : "待捕获"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs border-t pt-0.5">
                <span className="font-semibold text-foreground">净重</span>
                <span className="tnum font-bold text-primary text-sm">
                  {order?.net_weight_01kg != null ? weight(order.net_weight_01kg) : "—"}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                size="default"
                variant={next === "gross" ? "default" : "outline"}
                onClick={() => captureLive("gross")}
                disabled={!order || !scale.connected || !scale.stable || capture.isPending}
                className="h-8 text-xs"
              >
                捕获毛重
                <kbd className="ml-1 text-[10px] opacity-70">空格</kbd>
              </Button>
              <Button
                size="default"
                variant={next === "tare" ? "default" : "outline"}
                onClick={() => captureLive("tare")}
                disabled={!order || !scale.connected || !scale.stable || capture.isPending}
                className="h-8 text-xs"
              >
                捕获皮重
                <kbd className="ml-1 text-[10px] opacity-70">P</kbd>
              </Button>
            </div>
          </div>
        </div>
        {!order && <p className="text-xs text-warning">尚未制单，取号后才能捕获重量。</p>}
        {order && !scale.connected && (
          <p className="text-xs text-destructive">
            仪表离线{scale.error ? `：${scale.error}` : ""}。可打开下方手工录入继续作业，本单将永久标记为「手录」。
          </p>
        )}
        {order && scale.connected && !scale.stable && (
          <p className="text-xs text-warning">读数未稳定（窗口内波动超容差），捕获按钮已锁定。</p>
        )}

        <div className="flex flex-col gap-1.5">
          <Label className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5">
              <PenLineIcon className="size-3.5" />
              手工录入读数（仪表故障应急）
            </span>
            <Switch checked={manual} onCheckedChange={(v) => setManual(v === true)} size="sm" />
          </Label>
          {manual && (
            <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-1.5 border bg-muted/20 p-2">
              <NumField label="毛重" text={manualGross == null ? "" : String(toKg(manualGross))} onText={(t) => setManualGross(t.trim() === "" ? null : fromKg(t))} unit="kg" decimals={1} />
              <NumField label="皮重" text={manualTare == null ? "" : String(toKg(manualTare))} onText={(t) => setManualTare(t.trim() === "" ? null : fromKg(t))} unit="kg" decimals={1} />
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={manualGross == null || !order}
                  onClick={() => manualGross != null && submit("gross", manualGross, "manual")}
                >
                  录毛重
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={manualTare == null || !order}
                  onClick={() => manualTare != null && submit("tare", manualTare, "manual")}
                >
                  录皮重
                </Button>
              </div>
              <p className="col-span-3 text-[11px] text-warning">
                手录必须有原因并在磅单上永久标记，事后由站长在审计日志里逐条核对。
              </p>
            </div>
          )}
        </div>

        {records.length > 0 && (
          <p className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground">
            <span>
              称重轨迹 {records.length} 次
              {records.some((r) => r.source === "manual") && <span className="text-warning">（含手录）</span>}
            </span>
            <span className="tnum">
              最近 {lastRecord.weigh_type === "gross" ? "毛重" : "皮重"} {weight(lastRecord.weight_01kg)} ·{" "}
              {dateTime(lastRecord.captured_at).slice(5)}
              {lastRecord.source === "scale" ? " 地磅" : " 手录"}
            </span>
          </p>
        )}

        {order?.tare_override_reason && (
          <div className="border border-warning bg-warning-bg p-1.5 text-xs">
            <ToneBadge tone="warning">皮重偏差超容差</ToneBadge>
            <p className="mt-0.5">
              本单已按现场读数捕获（数据有效）：{order.tare_override_reason}。请核对车辆与读数，如需更正走红冲重录；提醒已记入磅单、补打票面与审计。
            </p>
          </div>
        )}

      </CardContent>
    </Card>
  );
}
