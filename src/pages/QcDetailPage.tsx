/**
 * 质检单详情（05 §3 `/qc/$reportNo`）。
 *
 * 复检单必须与首检单并排看：农户申诉"我的粮没那么湿"时，
 * 唯一能自证的说法就是"首检多少、复检多少、差多少、谁测的、用哪台方法"。
 * 所以这个页面在复检时强制渲染对比列，而不是藏在折叠里。
 */
import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, PrinterIcon } from "lucide-react";
import { api } from "@/lib/api";
import { GRADES, INDICATORS, TEST_METHOD } from "@/lib/constants";
import { dateTime, density, maskIdCard, orDash, percent, weight } from "@/lib/format";
import { useStaffNames, useStation } from "@/hooks/useLookups";
import { useSession } from "@/store/session";
import { DocTimeline } from "@/components/business/DocTimeline";
import { QcDecisionBadge, ToneBadge } from "@/components/business/badges";
import { CallOut, EmptyState, InfoGrid, PageHeader } from "@/components/business/layout";
import { useQuickDetail } from "@/components/business/QuickDetailSheet";
import { PrintPreview } from "@/components/print/PrintPreview";
import { QcReportSheet } from "@/components/print/sheets";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "cn";

export function QcDetailPage() {
  const { reportNo } = useParams({ from: "/qc/$reportNo" });
  const names = useStaffNames();
  const can = useSession((s) => s.can);
  const { data: station } = useStation();
  const [printOpen, setPrintOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["qc-report", reportNo],
    queryFn: () => api.getQc(reportNo),
  });
  const { data: order } = useQuery({
    queryKey: ["order", data?.report.order_no],
    queryFn: () => (data ? api.getOrder(data.report.order_no) : Promise.resolve(null)),
    enabled: !!data,
  });

  const openQuickDetail = useQuickDetail((s) => s.open);

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="质检单" description="加载中…" />
        <div className="grid gap-4 px-6 py-4 xl:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="质检单" />
        <EmptyState
          title={`找不到质检单 ${reportNo}`}
          description="单号可能来自另一台电脑的数据，或该化验尚未保存。"
          action={
            <Button size="sm" variant="outline" render={<Link to="/qc" />}>
              返回化验台账
            </Button>
          }
        />
      </div>
    );
  }

  const { report, first } = data;
  const isRecheck = report.is_recheck === 1 && !!first;
  const timeline = order?.timeline?.filter((t) => t.action.startsWith("qc") || t.label.includes("化验")) ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="tnum">{report.report_no}</span>
            <QcDecisionBadge decision={report.decision} />
            {report.is_recheck === 1 && <ToneBadge tone="info">复检</ToneBadge>}
            {report.is_effective === 0 && <ToneBadge tone="neutral">已被复检替换</ToneBadge>}
          </span>
        }
        description={`${report.party_name} · 样品 ${report.sample_no} · ${TEST_METHOD[report.test_method]} · ${dateTime(report.inspected_at)}`}
        actions={
          <>
            <Button size="sm" variant="outline" render={<Link to="/qc" />}>
              <ArrowLeftIcon />
              返回台账
            </Button>
            <Button size="sm" onClick={() => openQuickDetail("order", report.order_no)}>
              对应磅单
            </Button>
            <Button size="sm" variant="outline" disabled={!can("print") || !station} onClick={() => setPrintOpen(true)}>
              <PrinterIcon />
              打印质检单
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-col gap-4">
          {report.is_effective === 0 && (
            <CallOut tone="warning" title="本单不是当前有效质检单">
              复检完成后本单转为留档，计价以复检单为准。留档不可删除，用于追溯当时的判定依据。
            </CallOut>
          )}
          {report.decision === "reject" && (
            <CallOut tone="danger" title="本批判价为拒收">
              拒收原因：{orDash(report.reject_reason)}。拒收磅单不参与任何汇总统计（01 §F3.5）。
            </CallOut>
          )}

          <div className="grid items-start gap-4 xl:grid-cols-2">
            <section className="border bg-card">
              <header className="border-b px-3 py-2 text-sm font-semibold">检验信息</header>
              <div className="p-3">
                <InfoGrid
                  cols={2}
                  items={[
                    { label: "质检单号", value: <span className="tnum">{report.report_no}</span> },
                    { label: "样品号", value: <span className="tnum">{report.sample_no}</span> },
                    {
                      label: "对应磅单",
                      value: (
                        <Link to="/orders/$orderNo" params={{ orderNo: report.order_no }} className="tnum underline underline-offset-2">
                          {report.order_no}
                        </Link>
                      ),
                    },
                    { label: "售粮人", value: `${report.party_name}${order ? `（${maskIdCard(order.id_card_no)}）` : ""}` },
                    { label: "检测项目", value: TEST_METHOD[report.test_method] },
                    { label: "定级", value: orDash(report.grade) },
                    { label: "化验员", value: `${names(report.inspector_id)} · ${dateTime(report.inspected_at)}` },
                    {
                      label: "留样",
                      value: report.retention_no ? (
                        <span className="tnum">{`${report.retention_no}（保留至 ${report.retention_until}）`}</span>
                      ) : (
                        <span className="text-warning">未留样</span>
                      ),
                    },
                    { label: "扣水", value: <span className="tnum">{weight(report.moisture_deduct_01kg)}</span> },
                    { label: "扣杂", value: <span className="tnum">{weight(report.impurity_deduct_01kg)}</span> },
                    { label: "拒收原因", value: <span className="text-destructive">{orDash(report.reject_reason)}</span>, span: 2 },
                    { label: "备注", value: orDash(report.remark), span: 2 },
                  ]}
                />
                <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
                  扣水/扣杂为化验员人工录入值。水分增扣量、等级加减价的规则引擎首版不实现（02 §F4.4），
                  因此这里的扣重不会被任何公式自动改写。
                </p>
              </div>
            </section>

            <section className="border bg-card">
              <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <span className="text-sm font-semibold">
                  指标明细{isRecheck && <span className="ml-2 text-xs font-normal text-muted-foreground">与首检单 {first?.report_no} 对比</span>}
                </span>
                <ToneBadge tone="neutral">{GRADES.length} 档等级制</ToneBadge>
              </header>
              <div className="p-3">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="py-1.5 text-left font-normal">指标</th>
                      <th className="py-1.5 text-right font-normal">{isRecheck ? "复检" : "实测"}</th>
                      {isRecheck && <th className="py-1.5 text-right font-normal">首检</th>}
                      {isRecheck && <th className="py-1.5 text-right font-normal">差值</th>}
                      <th className="py-1.5 text-right font-normal">国标基准</th>
                      <th className="py-1.5 text-right font-normal">结论</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.indicators.map((it) => {
                      const meta = INDICATORS[it.code];
                      const fmt = (v: number | null, unit: string) =>
                        v == null ? "—" : unit === "gL" ? density(v) : unit === "text" ? "—" : percent(v);
                      const shown =
                        it.unit === "text"
                          ? orDash(it.value_text)
                          : it.unit === "gL"
                            ? density(it.value_num)
                            : percent(it.value_num);
                      const before = isRecheck ? first?.indicators.find((x) => x.code === it.code) : undefined;
                      const beforeShown = before
                        ? before.unit === "text"
                          ? orDash(before.value_text)
                          : fmt(before.value_num, before.unit)
                        : null;
                      const diff =
                        before && before.value_num != null && it.value_num != null ? it.value_num - before.value_num : null;
                      const std = meta?.std;
                      return (
                        <tr key={it.code} className={cn("border-b last:border-0", it.over_std === 1 && "bg-warning-bg")}>
                          <td className="py-1.5">{meta?.name ?? it.name}</td>
                          <td className={cn("tnum py-1.5 text-right", it.over_std === 1 && "font-medium text-warning")}>{shown}</td>
                          {isRecheck && <td className="tnum py-1.5 text-right text-muted-foreground">{beforeShown ?? "—"}</td>}
                          {isRecheck && (
                            <td className="tnum py-1.5 text-right text-xs">
                              {diff == null ? "—" : `${diff > 0 ? "+" : diff < 0 ? "−" : "±"}${
                                it.unit === "gL" ? `${Math.abs(diff)} g/L` : percent(Math.abs(diff), "")
                              }`}
                            </td>
                          )}
                          <td className="tnum py-1.5 text-right text-muted-foreground">
                            {meta?.unit === "text" ? "—" : std == null ? "—" : fmt(std, meta.unit)}
                          </td>
                          <td className="py-1.5 text-right text-xs">
                            {it.unit === "text" ? (
                              <span className="text-muted-foreground">描述项</span>
                            ) : it.over_std === 1 ? (
                              <ToneBadge tone="warning">超基准</ToneBadge>
                            ) : (
                              <span className="text-success">合格</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          {timeline.length > 0 && (
            <section className="border bg-card">
              <header className="border-b px-3 py-2 text-sm font-semibold">化验环节留痕</header>
              <div className="p-3">
                <DocTimeline events={timeline} />
              </div>
            </section>
          )}
        </div>
      </div>

      {station && (
        <PrintPreview open={printOpen} onOpenChange={setPrintOpen} docType="quality_report" docNo={report.report_no}>
          <QcReportSheet report={report} station={station} names={names} />
        </PrintPreview>
      )}
    </div>
  );
}
