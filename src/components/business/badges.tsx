/**
 * 状态徽章：颜色 + 中文文字双表达（05 §6.2）。
 * 黑白打印、色弱、远程截图沟通都必须仅凭文字就能判读，因此禁止只用颜色。
 */
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "cn";
import { CircleDashedIcon, CircleCheckIcon, AlertTriangleIcon, CircleIcon } from "lucide-react";
import type {
  DeviceStatus,
  OrderStatus,
  PaymentStatus,
  QcDecision,
  Tone,
  WeightSource,
} from "@/lib/constants";
import {
  DEVICE_STATUS,
  ORDER_STATUS,
  PAYMENT_STATUS,
  QC_DECISION,
  TONE_BADGE,
  TONE_DOT,
  WEIGHT_SOURCE,
} from "@/lib/constants";

export function ToneBadge({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return <Badge className={cn("border ring-1 ring-inset", TONE_BADGE[tone], className)}>{children}</Badge>;
}

export function OrderStatusBadge({ status, className }: { status: OrderStatus; className?: string }) {
  const s = ORDER_STATUS[status];
  return (
    <ToneBadge tone={s.tone} className={className}>
      <Dot tone={s.tone} />
      {s.label}
    </ToneBadge>
  );
}

export function OrderStatusText({ status }: { status: OrderStatus }) {
  return <span className="text-sm">{ORDER_STATUS[status].label}</span>;
}

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const s = PAYMENT_STATUS[status];
  return (
    <ToneBadge tone={s.tone}>
      <Dot tone={s.tone} />
      {s.label}
    </ToneBadge>
  );
}

export function QcDecisionBadge({ decision }: { decision: QcDecision }) {
  const s = QC_DECISION[decision];
  return (
    <ToneBadge tone={s.tone}>
      <Dot tone={s.tone} />
      {s.label}
    </ToneBadge>
  );
}

export function WeightSourceBadge({ source }: { source: WeightSource }) {
  const s = WEIGHT_SOURCE[source];
  if (source === "scale") return <span className="text-xs text-muted-foreground">{s.label}</span>;
  // 手录是迎检必查项，必须显眼
  return (
    <ToneBadge tone={s.tone}>
      <AlertTriangleIcon />
      {s.label}
    </ToneBadge>
  );
}

/** 状态点：形状本身也承载信息（实心=正常，空心=未知，三角=警告） */
export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  const Icon = tone === "warning" ? AlertTriangleIcon : tone === "neutral" ? CircleIcon : tone === "success" ? CircleCheckIcon : CircleDashedIcon;
  return <Icon className={cn("size-3 shrink-0", TONE_DOT[tone], className)} aria-hidden />;
}

export function DeviceStatusLight({ status, label }: { status: DeviceStatus; label?: string }) {
  const s = DEVICE_STATUS[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span
        className={cn(
          "size-2 rounded-full",
          status === "online" && "bg-success",
          status === "offline" && "bg-destructive ring-2 ring-destructive/25",
          status === "error" && "bg-destructive",
          status === "unknown" && "border border-muted-foreground bg-transparent",
        )}
        aria-hidden
      />
      <span className={cn(status === "online" ? "text-foreground" : "text-muted-foreground")}>{label ?? s.label}</span>
    </span>
  );
}

export function ToneText({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        tone === "success" && "text-success",
        tone === "info" && "text-info",
        tone === "warning" && "text-warning",
        tone === "danger" && "text-destructive",
        tone === "neutral" && "text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
