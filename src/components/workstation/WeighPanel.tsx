/**
 * ③ 称重区（05 §4 中栏上）。
 *
 * 三条现场规则写死在这里：
 *  1. 读数不稳定不允许捕获——按钮禁用并说明原因（05 §5 要求禁用必须带文字）
 *  2. 仪表离线时必须能改手录，但手录会永久标记在磅单上，迎检必查
 *  3. 皮重与历史均值偏差超容差 → 拦下来弹授权框，授权人必须是站长，事由必填
 *
 * 底部那组"模拟载重 / 开上磅 / 开下磅"是 mock 专用的演示开关：
 * 真实环境里这三件事由车辆与仪表完成，界面上不会出现。
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CarFrontIcon, CarIcon, KeyboardIcon, PenLineIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { UserAccount, WeighOrder } from "@/mock/types";
import { dateTime, fromKg, nowLocalISO, toKg, weight } from "@/lib/format";
import { useDeviceStore } from "@/store/device";
import { actorId, useSession } from "@/store/session";
import { useHotkey } from "@/hooks/useHotkey";
import { WeightDisplay } from "@/components/business/WeightDisplay";
import { NumField } from "@/components/business/NumField";
import { ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Choose } from "@/components/business/Choose";
import { cn } from "cn";

interface Pending {
  weight_01kg: number;
  source: "scale" | "manual";
}

export function WeighPanel({
  order,
  mean01kg,
  tolerancePct,
  staff,
  scalePort,
  scaleDivision01kg,
  cameraOnline,
}: {
  order: WeighOrder | null;
  mean01kg: number | null;
  tolerancePct: number;
  staff: UserAccount[];
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
  const [simKg, setSimKg] = useState("32000");
  const [flash, setFlash] = useState<"gross" | "tare" | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [authorizerId, setAuthorizerId] = useState("");

  /** 待捕项：缺哪项就优先提示哪项，两项都有则为复称 */
  const next: "gross" | "tare" | null = !order
    ? null
    : order.gross_weight_01kg == null
      ? "gross"
      : order.tare_weight_01kg == null
        ? "tare"
        : null;

  const capture = useMutation({
    mutationFn: (args: Pending & { weigh_type: "gross" | "tare"; override?: { by: number; reason: string } | null }) =>
      api.capture({
        order_no: order!.order_no,
        weigh_type: args.weigh_type,
        weight_01kg: args.weight_01kg,
        source: args.source,
        operator_id: actorId(),
        raw_frame: args.source === "scale" ? `=W${(args.weight_01kg / 10).toFixed(1)}kg ST` : undefined,
        has_photo: cameraOnline,
        tare_override: args.override ?? null,
      }),
    onSuccess: (o, args) => {
      if (!o) {
        toast.error("捕获失败：磅单不存在或已被他人修改");
        return;
      }
      // 抓拍时间给下游用 dateTime 按字面切分展示，存 UTC 串会让时标少 8 小时
      if (cameraOnline) setCamera({ lastCaptureAt: nowLocalISO() });
      setFlash(args.weigh_type);
      window.setTimeout(() => setFlash(null), 700);
      toast.success(
        `${args.weigh_type === "gross" ? "毛重" : "皮重"} ${weight(args.weight_01kg)} 已捕获${args.source === "manual" ? "（手录）" : ""}`,
      );
      qc.invalidateQueries({ queryKey: ["order", o.order_no] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["open-orders"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["party", o.party_id] });
    },
    // Rust 闸门回的是人话（"本单当前为 settled，不能再称重"），吞掉就没法排障了
    onError: (e: Error) => toast.error(`捕获失败：${e.message || "请重试；读数未丢，仪表仍在推送"}`),
  });

  function submit(type: "gross" | "tare", value01kg: number, source: "scale" | "manual") {
    if (!order) {
      toast.error("尚未制单，无法捕获读数");
      return;
    }
    if (!can("weigh.capture")) {
      toast.error("当前岗位无权捕获读数，需磅员或站长");
      return;
    }
    if (source === "manual" && !can("weigh.manual")) {
      toast.error("手录重量需磅员或站长岗位");
      return;
    }
    if (value01kg <= 0) {
      toast.error("读数必须大于 0");
      return;
    }
    // 皮重容差校验（05 §4 ②）：只有拿到历史均值才有比较基准
    if (type === "tare" && mean01kg != null && tolerancePct > 0) {
      const tol = Math.round((mean01kg * tolerancePct) / 100);
      if (Math.abs(value01kg - mean01kg) > tol) {
        setPending({ weight_01kg: value01kg, source });
        setOverrideReason("");
        setAuthorizerId("");
        return;
      }
    }
    capture.mutate({ weigh_type: type, weight_01kg: value01kg, source });
  }

  function captureLive(type: "gross" | "tare") {
    if (!scale.connected) {
      toast.error("仪表离线，请改用手工录入");
      return;
    }
    if (!scale.stable) {
      toast.warning("读数未稳定，请等车辆停稳后再捕获");
      return;
    }
    submit(type, scale.weight01kg, "scale");
  }

  // 空格捕当前待捕项；P 捕皮重（05 §5）
  useHotkey(" ", () => captureLive(next ?? "gross"), { enabled: !!order });
  useHotkey("p", () => captureLive("tare"), { enabled: !!order });

  const authorizers = staff.filter((u) => u.role === "station_master" && u.is_active === 1);
  const tolerance01kg = mean01kg == null ? null : Math.round((mean01kg * tolerancePct) / 100);
  const liveDiff = pending && mean01kg != null ? pending.weight_01kg - mean01kg : null;
  const records = order?.records ?? [];
  const lastRecord = records[records.length - 1];

  return (
    <Card size="sm" className="min-w-0 py-0 gap-0">
      <CardHeader className="grid-cols-[1fr_auto] items-center border-b py-1 px-2.5">
        <CardTitle className="text-xs font-semibold">③ 称重区</CardTitle>
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
              size="xl"
            />
          </div>

          {/* 右侧：本单已取重量明细 */}
          <div className="flex shrink-0 min-w-[130px] flex-col justify-center gap-1 border-t sm:border-l sm:border-t-0 pt-1.5 sm:pt-0 sm:pl-2.5">
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
        {!order && <p className="text-xs text-warning">尚未制单，取号后才能捕获重量。</p>}
        {order && !scale.connected && (
          <p className="text-xs text-destructive">仪表离线：可打开下方手工录入继续作业，本单将永久标记为「手录」。</p>
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

        {order?.tare_override_by != null && (
          <div className="border border-warning bg-warning-bg p-1.5 text-xs">
            <ToneBadge tone="warning">皮重超容差放行</ToneBadge>
            <p className="mt-0.5">
              授权人 {staff.find((u) => u.id === order.tare_override_by)?.display_name ?? `#${order.tare_override_by}`} ·
              事由：{order.tare_override_reason ?? "—"}
            </p>
          </div>
        )}

        {/* mock 专用：没有真车，用这组按钮把"上磅/下磅"演出来 */}
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-1.5 text-[11px]">
          <span className="flex items-center gap-1 text-muted-foreground">
            <KeyboardIcon className="size-3" />
            演示
          </span>
          <Input
            aria-label="模拟载重"
            value={simKg}
            onChange={(e) => setSimKg(e.target.value)}
            className="tnum h-7 w-20 text-xs px-1.5"
          />
          <span className="text-muted-foreground">kg</span>
          <Button size="xs" variant="outline" onClick={() => scale.driveOn(Number(simKg) || 0)} className="h-7 text-xs">
            <CarFrontIcon />
            上磅
          </Button>
          <Button size="xs" variant="outline" onClick={() => scale.driveOff()} className="h-7 text-xs">
            <CarIcon />
            下磅
          </Button>
        </div>
      </CardContent>

      <AlertDialog
        open={pending != null}
        onOpenChange={(v) => {
          if (!v) setPending(null);
        }}
      >
        <AlertDialogContent className="max-w-[520px]">
          <AlertDialogHeader>
            <AlertDialogTitle>皮重与历史偏差过大，需站长授权</AlertDialogTitle>
            <AlertDialogDescription className="flex flex-col gap-1.5">
              <span>
                历史均值 {weight(mean01kg)}，容差 ±{tolerancePct}%（±{tolerance01kg == null ? "—" : weight(tolerance01kg, false)}
                {liveDiff != null && tolerance01kg != null ? `）；本次偏差 ${liveDiff > 0 ? "+" : ""}${weight(liveDiff, false)}` : "）"}
              </span>
              <span className="text-muted-foreground">
                常见原因：车厢加装配件、油箱加满、带回货物。确认属实后再放行，事由会写进审计日志。
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2">
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              授权人（站长）
              <Choose
                aria-label="授权人"
                value={authorizerId}
                onChange={setAuthorizerId}
                options={[
                  { value: "", label: "请选择…" },
                  ...authorizers.map((u) => ({ value: String(u.id), label: `${u.display_name}（站长）` })),
                ]}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              偏差事由
              <Textarea
                rows={2}
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="如：油箱加满约 200 kg，已现场核对"
                className="min-h-0 text-sm"
              />
            </Label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>取消，重新过磅</AlertDialogCancel>
            <AlertDialogAction
              disabled={!authorizerId || overrideReason.trim().length < 4}
              onClick={() => {
                if (!pending) return;
                capture.mutate({
                  weigh_type: "tare",
                  weight_01kg: pending.weight_01kg,
                  source: pending.source,
                  override: { by: Number(authorizerId), reason: overrideReason.trim() },
                });
                setPending(null);
              }}
            >
              确认放行
            </AlertDialogAction>
          </AlertDialogFooter>
          {(!authorizerId || overrideReason.trim().length < 4) && (
            <p className="pb-1 text-xs text-warning">必须选定站长授权并填写不少于 4 字的事由，才能放行。</p>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
