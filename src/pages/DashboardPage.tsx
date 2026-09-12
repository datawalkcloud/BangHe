/**
 * 首页看板（05 §3，站长每天早上第一眼看的页面）。
 *
 * 排序按"要处理什么 / 这段时间干得怎么样"而不是"数据好不好看"：
 * 告警 → 区间汇总数字 → 在途作业 → 趋势与分组，快捷入口放右上角给磅员用。
 *
 * 顶部的时间选择器只重算"历史类"数字（汇总卡、趋势、品种/人群占比、时段分布），
 * 口径是一整段 business_date 闭区间；在途作业、告警、设备状态永远是"此刻"的事实，
 * 不随区间变化（今天的在途车不会因为切到"本月"就变成 30 天的存量）。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, ArrowRightIcon, CircleCheckIcon } from "lucide-react";
import { api } from "@/lib/api";
import { durationText, money, ton, weight, dateTimeShort, nowLocalISO, ratioText } from "@/lib/format";
import { resolveRange, rangeLabel } from "@/lib/date-range";
import { VARIETY_COLOR } from "@/lib/constants";
import { ORDER_STATUS, PARTY_TYPE } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OrderStatusBadge, ToneBadge } from "@/components/business/badges";
import { BarList, MiniBars, SplitBar, StatCard } from "@/components/business/StatCard";
import { EmptyState, PageBody, PageHeader, SectionTitle } from "@/components/business/layout";
import { cn } from "cn";

export function DashboardPage() {
  const [range, setRange] = useState(() => resolveRange("today"));
  const { data, isPending } = useQuery({
    queryKey: ["dashboard", range.from, range.to],
    queryFn: () => api.dashboard(range.from, range.to),
  });
  // 设备面板随看板一起取（桌面端 = 真库 device_config，与下方离线告警同源），
  // 不再单独 query mock 的 listDevices。
  const devices = data?.devices ?? [];

  const offline = devices.filter((d) => d.is_enabled === 1 && d.last_status !== "online");
  // 汇总卡标签前缀用所选区间文案（近 30 天 / 本月 / 昨天…），避免切了区间还写死"今日"。
  const p = range.label;

  return (
    <>
      <PageHeader
        title="首页看板"
        description={isPending ? "加载中…" : `统计区间 ${range.from} ~ ${range.to}（${p}；业务日期口径，跨零点单归前一日）`}
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
        {/* 时间区间选择器：单个 range 日期控件，快捷预设内置在下拉里（与报表同一份口径 date-range.ts） */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">统计范围</span>
          <DateRangePicker
            value={{ from: range.from, to: range.to }}
            onChange={(f, t) => setRange({ from: f, to: t, label: rangeLabel(f, t) })}
            className="w-64"
          />
        </div>

        {/* 告警优先：进站第一眼要看到"有什么不对"（实时，不受区间影响） */}
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

        {/* 区间待办数字 */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
          <StatCard label={`${p}车次`} value={data?.summary.orders ?? "—"} unit="车" hint={isPending ? "" : "含在途与已归档"} />
          <StatCard label={`${p}净重`} value={ton(data?.summary.net_01kg ?? 0)} hint={`结算重 ${ton(data?.summary.settle_01kg ?? 0)}`} />
          <StatCard label={`${p}货款`} value={money(data?.summary.goods_fen ?? 0)} tone="info" />
          <StatCard
            label={`${p}应付`}
            value={money(data?.summary.payable_fen ?? 0)}
            hint={`已付 ${money(data?.summary.paid_fen ?? 0)}`}
          />
          <StatCard
            label="挂账未付"
            value={money(data?.summary.credit_fen ?? 0)}
            tone={(data?.summary.credit_fen ?? 0) > 0 ? "warning" : "neutral"}
            hint="超时效天数的进下方告警"
          />
          <StatCard
            label="手录车次"
            value={data?.summary.manualCount ?? 0}
            unit="车"
            tone={(data?.summary.manualCount ?? 0) > 0 ? "warning" : "neutral"}
            hint={`拒收 ${data?.summary.rejectCount ?? 0} 车`}
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
              <CardTitle className="text-sm">{p}车次趋势</CardTitle>
            </CardHeader>
            <CardContent className="p-0 pr-2">
              <MiniBars
                items={(data?.trend ?? []).map((t) => ({ label: t.date.slice(5), value: t.orders }))}
                labelEvery={(data?.trend.length ?? 0) > 15 ? 5 : (data?.trend.length ?? 0) > 7 ? 3 : 1}
                formatter={(v) => String(v)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-2.5">
              <CardTitle className="text-sm">品种净重占比（{p}）</CardTitle>
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
            <CardTitle className="text-sm">在途状态与作业节奏</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <SectionTitle extra={<span className="text-xs text-muted-foreground">实时在途，按磅单状态</span>}>
              当前在途
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
                <span className="text-sm text-muted-foreground">当前无在途车，{p}共 {data?.summary.orders ?? 0} 车</span>
              )}
            </div>
            <SectionTitle extra={<span className="text-xs text-muted-foreground">{p}</span>}>
              时段分布
            </SectionTitle>
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
