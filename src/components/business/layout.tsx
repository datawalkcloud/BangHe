/**
 * 页面级排版件：标题区 56 px、内容区左右 24 px（05 §7.3）。
 */
import type { ReactNode } from "react";
import type { Tone } from "@/lib/constants";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { cn } from "cn";

export function PageHeader({
  title,
  description,
  actions,
  tabs,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  /** 嵌进抽屉等待别的浮层时用它让开自带控件（如右上角关闭按钮） */
  className?: string;
}) {
  return (
    <div className={cn("flex shrink-0 flex-col gap-1 border-b bg-background px-3", className)}>
      {/* 用 min-h 而不是 h：窄窗口下标题与操作按钮会 flex-wrap 换行，固定高度会让溢出部分压到下方内容上 */}
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 py-1">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{title}</h1>
          {description && <p className="truncate text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {tabs}
    </div>
  );
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-w-0 flex-1 space-y-4 px-6 py-4", className)}>{children}</div>;
}

export function SectionTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{children}</h2>
      {extra}
    </div>
  );
}

/**
 * 分区顶部的「一句说明 + 右侧动作」条。原先只在基础档案里用，
 * 员工与岗位搬到系统与审计后两页都要，于是提到公共排版件里，避免两份走样。
 */
export function SectionBar({ note, action }: { note: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="min-w-[16rem] flex-1 text-xs text-muted-foreground">{note}</p>
      {action}
    </div>
  );
}

/** 空状态必须给下一步动作，不留纯文案空页（05 §6.3）。组合自官方 Empty 件 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

export { Kbd } from "@/components/ui/kbd";

/** 键值对信息块，详情页通用 */
export function InfoGrid({ items, cols = 3 }: { items: { label: string; value: ReactNode; span?: number }[]; cols?: 2 | 3 | 4 }) {
  return (
    <dl
      className={cn(
        "grid gap-x-6 gap-y-3",
        cols === 2 && "grid-cols-2",
        cols === 3 && "grid-cols-2 md:grid-cols-3",
        cols === 4 && "grid-cols-2 md:grid-cols-4",
      )}
    >
      {items.map((it) => (
        <div key={it.label} className="min-w-0" style={it.span ? { gridColumn: `span ${it.span}` } : undefined}>
          <dt className="text-xs text-muted-foreground">{it.label}</dt>
          <dd className="truncate text-sm">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 页面内提示条。shadcn 的 Alert 只有 default / destructive 两档，
 * 但业务上 info / success / warning 都得用（挂账超期、设备离线、保存成功），
 * 所以这里按 Tone 补一层语义色，避开每个页面各自拼字符串。
 */
const ALERT_TONE: Record<Tone, string> = {
  neutral: "border-border bg-card text-foreground",
  info: "border-info/40 bg-info-bg text-info [&>svg]:text-info",
  success: "border-success/40 bg-success-bg text-success [&>svg]:text-success",
  warning: "border-warning/50 bg-warning-bg text-warning [&>svg]:text-warning",
  danger: "border-destructive/40 bg-destructive/10 text-destructive [&>svg]:text-destructive",
};

export function CallOut({
  tone = "warning",
  title,
  children,
  action,
  icon,
  className,
}: {
  tone?: Tone;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <Alert className={cn(ALERT_TONE[tone], className)}>
      {icon}
      <AlertTitle>{title}</AlertTitle>
      {children && <AlertDescription className="[&>a]:underline">{children}</AlertDescription>}
      {action && <AlertAction>{action}</AlertAction>}
    </Alert>
  );
}
