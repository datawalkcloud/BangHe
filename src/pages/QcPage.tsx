/**
 * 化验台账（05 §3 `/qc`）。
 *
 * 两块内容放在同一页，因为化验员的一天就是这两件事：
 *   「待检队列」= 已经登记还没出结果的车，等着扦样化验；
 *   「质检单」= 已经出的所有结果，包含复检与作废留档。
 *
 * 复检单与首检单同时保留、只有 `is_effective` 那张参与计价（01 §F3.4），
 * 所以列表必须能看出"这张是不是当前有效单"。
 */
import { useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { FlaskConicalIcon, ScanSearchIcon } from "lucide-react";
import { api } from "@/lib/api";
import type { QcReport, WeighOrder } from "@/mock/types";
import type { QcDecision } from "@/lib/constants";
import { QC_DECISION, TEST_METHOD } from "@/lib/constants";
import { dateTime, orDash, percent, sinceMinutes, sinceText, weight, varietyLabel } from "@/lib/format";
import { searchKeyword } from "@/lib/ticket-code";
import { useStaffNames, useVarieties } from "@/hooks/useLookups";
import { Choose } from "@/components/business/Choose";
import { DataTable, type Column } from "@/components/ui/data-table";
import { QcDecisionBadge, ToneBadge } from "@/components/business/badges";
import { EmptyState, Kbd, PageHeader } from "@/components/business/layout";
import { detailColumn, QuickDetailLink } from "@/components/business/quickDetail";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "cn";

/** 从指标数组里取某个指标的原生值（0.01% 或 g/L），取不到给 null */
function indOf(q: QcReport, code: string): number | null {
  const it = q.indicators.find((x) => x.code === code);
  return it?.value_num ?? null;
}

export function QcPage() {
  const navigate = useNavigate();
  const names = useStaffNames();
  const { data: varieties = [] } = useVarieties();

  const [tab, setTab] = useState<string>("reports");
  const [kw, setKw] = useState("");
  const [applied, setApplied] = useState("");

  /**
   * 提交关键字：手上的**老纸**上载荷比号多两位（`11` 磅单 / `12` 质检单 + 单号；本版只有
   * 磅单带码，且码就是单号本体，02 §F1.4），库里的号不带那两位，带着就一条查不到。
   * 剥完把框里的字一起换成真正去查的那一串；拿收购码单来查它的化验单也走得通——
   * 那一轨剥完是磅单号，`listQc` 本来就按磅单号匹配。
   */
  const applyKeyword = () => {
    const k = searchKeyword(kw);
    setKw(k);
    setApplied(k);
  };
  const [decision, setDecision] = useState<QcDecision | "all">("all");
  const [onlyRecheck, setOnlyRecheck] = useState(false);

  const { data: reports = [], isPending } = useQuery({
    queryKey: ["qc-reports", applied],
    queryFn: () => api.listQc({ keyword: applied }),
  });
  const { data: queue = [], isPending: queuePending } = useQuery({
    queryKey: ["qc-queue"],
    queryFn: () => api.qcQueue(),
    refetchInterval: 20_000,
  });

  const filtered = useMemo(
    () =>
      reports.filter(
        (q) => (decision === "all" || q.decision === decision) && (!onlyRecheck || q.is_recheck === 1),
      ),
    [reports, decision, onlyRecheck],
  );

  const rejectCount = filtered.filter((q) => q.decision === "reject").length;

  const columns = useMemo<Column<QcReport>[]>(
    () => [
      {
        key: "report_no",
        header: "质检单号",
        cell: (q) => <span className="tnum font-medium">{q.report_no}</span>,
        sortValue: (q) => q.report_no,
      },
      {
        key: "order_no",
        header: "磅单号",
        cell: (q) => (
          <QuickDetailLink type="order" id={q.order_no} className="tnum font-medium text-primary">
            {q.order_no}
          </QuickDetailLink>
        ),
      },
      { key: "sample_no", header: "样品号", cell: (q) => <span className="tnum text-xs">{q.sample_no}</span> },
      { key: "party", header: "售粮人", cell: (q) => q.party_name, sortValue: (q) => q.party_name },
      {
        key: "variety",
        header: "品种/等级",
        cell: (q) => {
          const v = varieties.find((x) => x.id === q.variety_id);
          return `${v?.name ?? `#${q.variety_id}`}${q.grade ? ` ${q.grade}` : ""}`;
        },
      },
      {
        key: "moisture",
        header: "水分",
        align: "right",
        cell: (q) => {
          const over = q.indicators.find((x) => x.code === "moisture")?.over_std === 1;
          return <span className={cn("tnum", over && "font-medium text-warning")}>{percent(indOf(q, "moisture"))}</span>;
        },
        sortValue: (q) => indOf(q, "moisture"),
      },
      {
        key: "impurity",
        header: "杂质",
        align: "right",
        cell: (q) => {
          const over = q.indicators.find((x) => x.code === "impurity")?.over_std === 1;
          return <span className={cn("tnum", over && "font-medium text-warning")}>{percent(indOf(q, "impurity"))}</span>;
        },
        sortValue: (q) => indOf(q, "impurity"),
      },
      {
        key: "deduct",
        header: "扣水/扣杂",
        align: "right",
        cell: (q) => (
          <span className="tnum text-xs">
            {weight(q.moisture_deduct_01kg, false)} / {weight(q.impurity_deduct_01kg, false)} kg
          </span>
        ),
      },
      { key: "decision", header: "判定", cell: (q) => <QcDecisionBadge decision={q.decision} />, sortValue: (q) => q.decision },
      { key: "method", header: "方法", cell: (q) => <span className="text-xs">{TEST_METHOD[q.test_method]}</span> },
      {
        key: "recheck",
        header: "性质",
        cell: (q) =>
          q.is_recheck === 1 ? (
            <ToneBadge tone={q.is_effective === 1 ? "info" : "neutral"}>{q.is_effective === 1 ? "复检（有效）" : "复检（已失效）"}</ToneBadge>
          ) : (
            <span className="text-xs text-muted-foreground">首检</span>
          ),
      },
      { key: "inspector", header: "化验员", cell: (q) => <span className="text-xs">{names(q.inspector_id)}</span> },
      { key: "at", header: "化验时间", cell: (q) => <span className="tnum text-xs">{dateTime(q.inspected_at)}</span>, sortValue: (q) => q.inspected_at },
      detailColumn("qc", (q) => q.report_no),
    ],
    [names, varieties],
  );

  const queueCols = useMemo<Column<WeighOrder>[]>(
    () => [
      { key: "order_no", header: "磅单号", cell: (o) => <span className="tnum font-medium">{o.order_no}</span> },
      { key: "party", header: "售粮人", cell: (o) => o.party_name },
      { key: "variety", header: "品种", cell: (o) => `${varietyLabel(o.variety_name)}${o.grade ? ` ${o.grade}` : ""}` },
      { key: "vehicle", header: "车牌", cell: (o) => <span className="tnum">{orDash(o.vehicle_no)}</span> },
      { key: "at", header: "登记时间", cell: (o) => <span className="tnum text-xs">{dateTime(o.registered_at)}</span> },
      {
        key: "waiting",
        header: "已等待",
        align: "right",
        cell: (o) => {
          const m = sinceMinutes(o.registered_at);
          return (
            <span className={cn("tnum text-xs", m > 60 && "font-medium text-warning")}>{sinceText(o.registered_at)}</span>
          );
        },
        sortValue: (o) => sinceMinutes(o.registered_at),
      },
      {
        key: "op",
        header: "操作",
        cell: (o) => (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              void navigate({ to: "/workstation", search: { orderNo: o.order_no } });
            }}
          >
            去化验
          </Button>
        ),
      },
    ],
    [navigate],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="化验台账"
        description={`质检单 ${reports.length} 张（当前筛选 ${filtered.length}）· 拒收 ${rejectCount} · 待检 ${queue.length} 车`}
        actions={
          <>
            <Button size="sm" variant="outline" render={<Link to="/reports/$kind" params={{ kind: "quality" }} />}>
              <ScanSearchIcon />
              质量分析报表
            </Button>
          </>
        }
        tabs={
          <Tabs value={tab} onValueChange={setTab} className="gap-0">
            <TabsList className="mb-1 h-auto max-w-full flex-wrap justify-start">
              <TabsTrigger value="reports" className="text-sm">
                <FlaskConicalIcon />
                质检单
              </TabsTrigger>
              <TabsTrigger value="queue" className="text-sm">
                待检队列
                {queue.length > 0 && <span className="tnum text-warning">（{queue.length}）</span>}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {tab === "reports" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-2">
              <Label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
                关键字
                <Input
                  value={kw}
                  onChange={(e) => setKw(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyKeyword();
                  }}
                  placeholder="质检单号 / 磅单号 / 样品号 / 姓名，回车查询"
                  className="h-8 text-sm"
                />
              </Label>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                判定
                <Choose
                  aria-label="判定"
                  className="w-28"
                  value={decision}
                  onChange={(v) => setDecision(v as QcDecision | "all")}
                  options={[
                    { value: "all", label: "全部" },
                    ...(Object.keys(QC_DECISION) as QcDecision[]).map((k) => ({ value: k, label: QC_DECISION[k].label })),
                  ]}
                />
              </Label>
              <Label className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
                <Checkbox checked={onlyRecheck} onCheckedChange={(v) => setOnlyRecheck(v === true)} aria-label="只看复检" />
                只看复检
              </Label>
              <Button size="sm" onClick={applyKeyword}>
                查询
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setKw("");
                  setApplied("");
                  setDecision("all");
                  setOnlyRecheck(false);
                }}
              >
                重置
              </Button>
            </div>

            <DataTable
              columns={columns}
              rows={filtered}
              rowKey={(q) => q.report_no}
              loading={isPending}
              rowHref={(q) => `/qc/${q.report_no}`}
              rowClassName={(q) => (q.is_effective === 0 ? "text-muted-foreground" : undefined)}
              empty={
                <EmptyState
                  title="没有符合条件的质检单"
                  description="换个关键字或把判定条件放开试试。"
                />
              }
              toolbar={
                <span className="text-xs text-muted-foreground">
                  末列「详情」在本页右侧弹出完整质检单。灰色行是被复检替换掉的旧单，仅作留档，不参与计价。水分/杂质超基准只标色提示。
                </span>
              }
            />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <DataTable
              columns={queueCols}
              rows={queue}
              rowKey={(o) => o.order_no}
              loading={queuePending}
              empty={
                <EmptyState
                  title="待检队列是空的"
                  description="新车登记后会立刻出现在这里。"
                />
              }
              toolbar={
                <span className="text-xs text-muted-foreground">
                  待检 = 已登记但还没有有效化验单的磅单；停留超 60 分钟标黄。
                </span>
              }
            />
            <p className="text-xs text-muted-foreground">
              选中待检磅单后，在工作台按 <Kbd>F5</Kbd> 就地化验并保存。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
