/**
 * 页面级排版件：标题区 56 px、内容区左右 24 px（05 §7.3）。
 */
import type { ReactNode } from "react";
import type { Tone } from "@/lib/constants";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "cn";

export function PageHeader({
  title,
  description,
  actions,
  actionsRight,
  actionsBelow,
  tabs,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** 第二组控件，钉在标题栏最右端；给了它，`actions` 就退到左侧贴着标题。
   *  控件多到换行的页面用它，否则整排挤在右边谁也点不着（工作台是首个用户）。 */
  actionsRight?: ReactNode;
  /**
   * 控件群**固定排在标题行的下一行**，标题与描述仍占同一行。
   *
   * 挤在同一行时，中间那段可截断的描述会吸收所有剩余空间，于是控件群的位置取决于
   * 「另一群有多宽」：一个界面里有两种状态、按钮数量不一样时（工作台入库/出库），
   * 切一下整群左群就横着滑一百多像素。给了它，`actions` 恒从最左起、`actionsRight`
   * 恒钉最右，两边互不影响，换行落点也不再跟文案字数赌。
   */
  actionsBelow?: boolean;
  tabs?: ReactNode;
  /** 嵌进抽屉等待别的浮层时用它让开自带控件（如右上角关闭按钮） */
  className?: string;
}) {
  return (
    <div className={cn("flex shrink-0 flex-col gap-1 border-b bg-card px-3", className)}>
      {/* 用 min-h 而不是 h：窄窗口下标题与操作按钮会 flex-wrap 换行，固定高度会让溢出部分压到下方内容上 */}
      {/* 靠右一律用 ml-auto 而不是给这行加 justify-between：justify-between 是"把空白摊到成员之间"，
          控件多到换行时落单的第二行会被甩回左边，三群并存时还会把制单夹到标题栏正中。 */}
      <div className="flex min-h-10 flex-wrap items-center gap-2 py-1">
        {/* 标题与描述**同一行**：整块 `min-w-0`，描述 `truncate`。
            标题 `shrink-0`（配 `max-w-full` 兜底）：描述的基础宽是标题的十几倍，
            两者都可收缩时按比例挤下来先把标题截成「磅房…」——标题是这一行的锚，
            宁可说明一个字不剩，也不能让标题打省略号。 */}
        <div className={cn("flex min-w-0 flex-1 items-baseline gap-2", actionsBelow && "basis-full")}>
          <h1 className="max-w-full shrink-0 truncate text-base font-semibold">{title}</h1>
          {description && <p className="min-w-0 truncate text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className={cn("flex shrink-0 flex-wrap items-center gap-2", !actionsRight && "ml-auto")}>{actions}</div>}
        {actionsRight && <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actionsRight}</div>}
      </div>
      {tabs}
    </div>
  );
}

/**
 * 页面主体大白卡的公共皮（05 §7.5 去线留白的落地口径）：整站**一页一张卡**，
 * 卡贴满抬头以下的整个内容区（不留画布灰缝，侧栏/抬头与内容之间必须无缝）；
 * 页内的块与块靠留白分界，禁止再包第二层 Card。
 * 走 PageBody 的页面已经穿上；自带滚动容器的（列表/详情类）直接 `className={PAGE_CARD}`
 * 或 `cn(PAGE_CARD, …布局类)`。改这皮子只改这一处。
 * 末尾那个变量是给页内卡用的：卡在这张白卡里=白压白，靠 [--card-hairline] 给一条
 * 台账行线同档的淡边（判据在 App.css「页内卡的淡边」，画布上的卡不沾这个变量）。
 */
export const PAGE_CARD =
  "min-h-0 min-w-0 flex-1 overflow-y-auto bg-card px-4 py-3 [--card-hairline:var(--hairline-row)]";

/**
 * 页面主体 = **一张**大白卡（PAGE_CARD）。列表页自带的滚动容器用的是同一个常量。
 */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn(PAGE_CARD, "space-y-4", className)}>
      {children}
    </div>
  );
}

/**
 * 页面代码块还没到位时的占位皮。router.tsx 把 21 个页面切成了按导航现取的 chunk，
 * 首次进某一页会短暂 Suspense；壳（侧栏/顶栏/设备条）不动，只有内容区换成这个。
 * 形状照一页列表页捏，别让切页看起来像换了个界面。
 */
export function PagePending() {
  return (
    <div className={cn(PAGE_CARD, "space-y-3")}>
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-9 w-full max-w-md" />
      <div className="space-y-2 pt-2">
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <Skeleton key={row} className="h-9 w-full" />
        ))}
      </div>
    </div>
  );
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
