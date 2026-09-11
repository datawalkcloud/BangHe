/**
 * 首页看板（05 §3，站长每天早上第一眼看的页面）。
 *
 * 排序按"今天要处理什么"而不是"数据好不好看"：
 * 告警 → 待办数字 → 在途作业 → 趋势，快捷入口放右上角给磅员用。
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, ArrowRightIcon, CircleCheckIcon } from "lucide-react";
import { api } from "@/lib/api";
import { durationText, money, ton, weight, dateTimeShort, nowLocalISO, ratioText, todayISO } from "@/lib/format";
import { VARIETY_COLOR } from "@/lib/constants";
import { ORDER_STATUS, PARTY_TYPE } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OrderStatusBadge, ToneBadge } from "@/components/business/badges";
import { BarList, MiniBars, SplitBar, StatCard } from "@/components/business/StatCard";
import { EmptyState, PageBody, PageHeader, SectionTitle } from "@/components/business/layout";
import { cn } from "cn";

export function DashboardPage() {
  const { data, isPending } = useQuery({ queryKey: ["dashboard"], queryFn: () => api.dashboard() });
  // 设备面板随看板一起取（桌面端 = 真库 device_config，与下方离线告警同源），
  // 不再单独 query mock 的 listDevices。
  const devices = data?.devices ?? [];

  const offline = devices.filter((d) => d.is_enabled === 1 && d.last_status !== "online");

  return (
    <>
      <PageHeader
        title="首页看板"
        description={isPending ? "加载中…" : `今日为 ${todayISO()}（业务日期口径，跨零点单归前一日）`}
        actions={
          <>
            <Button size="sm" render={<Link to="/workstation" />}>
              去磅房工作台
            </Button>
            <Button size="sm" variant="outline" render={<Link to="/orders" />}>
              磅单中心
            </Button>
          </>
        }
      />
      <PageBody className="overflow-y-auto">
        {/* 告警优先：进站第一眼要看到"今天有什么不对" */}
        {(data?.alerts.length ?? 0) > 0 && (
          <section className="grid gap-2 lg:grid-cols-2">
            {data!.alerts.map((a) => (
              <Link
                key={a.title + a.href}
                to={a.href as never}
                className={cn(
                  "flex items-start gap-2 border p-3 text-sm hover:border-ring",
                  a.level === "danger" && "border-destructive/40 bg-destructive/5",
                  a.level === "warning" && "border-warning/40 bg-warning-bg/50",
                )}
              >
                {a.level === "success" ? (
                  <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <AlertTriangleIcon
                    className={cn("mt-0.5 size-4 shrink-0", a.level === "danger" ? "text-destructive" : "text-warning")}
                  />
                )}
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{a.title}</span>
                  <span className="text-xs text-muted-foreground">{a.detail}</span>
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  {a.action}
                  <ArrowRightIcon className="size-3" />
                </span>
              </Link>
            ))}
          </section>
        )}

        {/* 今日待办数字 */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
          <StatCard label="今日车次" value={data?.today.orders ?? "—"} unit="车" hint={isPending ? "" : "含在途与已归档"} />
          <StatCard label="今日净重" value={ton(data?.today.net_01kg ?? 0)} hint={`结算重 ${ton(data?.today.settle_01kg ?? 0)}`} />
          <StatCard label="今日货款" value={money(data?.today.goods_fen ?? 0)} tone="info" />
          <StatCard
            label="今日应付"
            value={money(data?.today.payable_fen ?? 0)}
            hint={`已付 ${money(data?.today.paid_fen ?? 0)}`}
          />
          <StatCard
            label="挂账未付"
            value={money(data?.today.credit_fen ?? 0)}
            tone={(data?.today.credit_fen ?? 0) > 0 ? "warning" : "neutral"}
            hint="超时效天数的进下方告警"
          />
          <StatCard
            label="手录车次"
            value={data?.today.manualCount ?? 0}
            unit="车"
            tone={(data?.today.manualCount ?? 0) > 0 ? "warning" : "neutral"}
            hint={`拒收 ${data?.today.rejectCount ?? 0} 车`}
          />
        </section>

        <div className="grid min-w-0 gap-4 xl:grid-cols-3">
          {/* 在途作业 */}
          <Card className="xl:col-span-2">
            <CardHeader className="py-2.5">
              <CardTitle className="flex items-center gap-2 text-sm">
                在途作业
                <span className="font-normal text-muted-foreground">
                  共 {data?.openOrders.length ?? 0} 车，停留超阈值标"超"
                </span>
                <Button size="xs" variant="ghost" className="ml-auto" render={<Link to="/workstation" />}>
                  处理
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {(data?.openOrders.length ?? 0) === 0 ? (
                <EmptyState
                  title="当前没有在途车辆"
                  description="磅房空闲，可直接新建过磅单开始今天的作业。"
                  action={
                    <Button size="sm" render={<Link to="/workstation" />}>
                      新建过磅单
                    </Button>
                  }
                />
              ) : (
                <ul className="divide-y">
                  {data!.openOrders.map((o) => (
                    <li key={o.order_no}>
                      <Link
                        to="/workstation"
                        search={{ orderNo: o.order_no } as never}
                        className="flex min-w-0 items-center gap-3 px-4 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
                      >
                        {/* 不锁定宽度：磅单号有 16 字，写死 w-32 会溢出压到下一列上出现叠字 */}
                        <span className="tnum shrink-0 whitespace-nowrap">{o.order_no}</span>
                        <span className="min-w-0 flex-1 truncate">{o.party_name}</span>
                        <span className="w-16 shrink-0 truncate text-muted-foreground">{o.variety_name}</span>
                        <OrderStatusBadge status={o.status} />
                        <span
                          className={cn(
                            "tnum ml-auto shrink-0 text-xs",
                            o.overdue ? "text-warning" : "text-muted-foreground",
                          )}
                        >
                          {o.overdue && <AlertTriangleIcon className="mr-1 inline size-3" />}
                          停留 {durationText(o.since_minutes)}{o.overdue ? " 超" : ""}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* 设备离线 */}
          <Card>
            <CardHeader className="py-2.5">
              <CardTitle className="flex items-center gap-2 text-sm">
                设备状态
                <Button size="xs" variant="ghost" className="ml-auto" render={<Link to="/devices" />}>
                  设备中心
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 p-0">
              {devices
                .filter((d) => d.is_enabled === 1)
                .slice(0, 8)
                .map((d) => (
                  <div key={d.code} className="flex items-center gap-2 px-4 text-sm">
                    <span className="min-w-0 flex-1 truncate">{d.name}</span>
                    <ToneBadge
                      tone={d.last_status === "online" ? "success" : d.last_status === "unknown" ? "neutral" : "danger"}
                    >
                      {d.last_status === "online" ? "在线" : d.last_status === "unknown" ? "未检测" : d.last_status === "error" ? "故障" : "离线"}
                    </ToneBadge>
                  </div>
                ))}
              {offline.length === 0 ? (
                <p className="px-4 pb-2 text-xs text-success">全部启用设备在线，可直接作业</p>
              ) : (
                <p className="px-4 pb-2 text-xs text-warning">
                  {offline.length} 台异常，相关录入将回退到手录，底栏可定位具体设备
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid min-w-0 gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader className="py-2.5">
              <CardTitle className="text-sm">近 7 日车次</CardTitle>
            </CardHeader>
            <CardContent className="p-0 pr-2">
              <MiniBars
                items={(data?.trend ?? []).slice(-7).map((t) => ({ label: t.date.slice(5), value: t.orders }))}
                formatter={(v) => String(v)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-2.5">
              <CardTitle className="text-sm">品种净重占比（今日）</CardTitle>
            </CardHeader>
            <CardContent>
              <BarList
                items={(data?.byVariety ?? []).map((v) => ({
                  label: v.variety_name,
                  value: v.net_01kg,
                  colorClass: VARIETY_COLOR[v.variety_code] ?? "bg-chart-5",
                }))}
                formatter={(v) => weight(v)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-2.5">
              <CardTitle className="text-sm">售粮人构成</CardTitle>
            </CardHeader>
            <CardContent>
              <SplitBar
                segments={(data?.byPartyType ?? []).map((p, i) => ({
                  label: PARTY_TYPE[p.type] ?? p.label,
                  value: p.orders,
                  colorClass: `bg-chart-${(i % 5) + 1}`,
                }))}
                formatter={(v) => `${v} 车`}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                大户与经纪人贡献 {ratioText(ratioOf(data?.byPartyType))} 的车次，皮重历史更稳定，可放宽容差。
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="py-2.5">
            <CardTitle className="text-sm">今日状态分布与时间线</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <SectionTitle extra={<span className="text-xs text-muted-foreground">按磅单状态</span>}>
              在途与完成
            </SectionTitle>
            <div className="flex flex-wrap gap-2">
              {Object.entries(ORDER_STATUS).map(([k, v]) => {
                const n = (data?.openOrders ?? []).filter((o) => o.status === k).length;
                if (n === 0) return null;
                return (
                  <ToneBadge key={k} tone={v.tone}>
                    {v.label} {n}
                  </ToneBadge>
                );
              })}
              {(data?.openOrders.length ?? 0) === 0 && (
                <span className="text-sm text-muted-foreground">当前无在途车，今日已完成 {data?.today.orders ?? 0} 车</span>
              )}
            </div>
            <SectionTitle>时段分布</SectionTitle>
            <MiniBars
              height={72}
              items={(data?.hourCurve ?? []).map((h) => ({ label: `${h.hour}`, value: h.orders }))}
              formatter={(v) => (v > 0 ? `${v}` : "")}
              labelEvery={2}
              colorClass="bg-chart-2"
            />
            <p className="text-xs text-muted-foreground">
              数据最后刷新：{data ? dateTimeShort(nowLocalISO()) : "—"}（点击页面内任意查询会自动重取）
            </p>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}

function ratioOf(list: { type: string; orders: number }[] | undefined): number {
  if (!list || list.length === 0) return 0;
  const total = list.reduce((s, x) => s + x.orders, 0);
  const big = list.filter((x) => x.type !== "farmer").reduce((s, x) => s + x.orders, 0);
  return total === 0 ? 0 : big / total;
}
