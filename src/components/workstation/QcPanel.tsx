/**
 * ④ 化验区（05 §4 中栏下）。
 *
 * 关键边界（02 文档 F4.4：计价引擎首版不做）：
 *  指标只用来做"超基准提示"，前端绝不根据水分/杂质反算扣重；
 *  扣水、扣杂公斤数一律由化验员人工填写，写进化验单并留痕。
 *
 * 已保存后再进来看，会回填原化验单，此时保存等于"复检/更正"，
 * mock 层会新增一张有效单并把旧单保留，符合"单据永不物理删除"。
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { announce } from "@/lib/voice-prompt";
import type { GrainVariety, QcReport, WeighOrder } from "@/mock/types";
import type { Grade, IndicatorMeta, QcDecision, TestMethod } from "@/lib/constants";
import { GRADES, INDICATORS, ODOR_PRESETS, QC_DECISION, REASON_MIN, REJECT_REASONS, TEST_METHOD } from "@/lib/constants";
import { density, fromPercent, percent, weight } from "@/lib/format";
import { actorId, useSession } from "@/store/session";
import { useHotkey } from "@/hooks/useHotkey";
import { Choose } from "@/components/business/Choose";
import { QcDecisionBadge } from "@/components/business/badges";
import { NumField, WeightField } from "@/components/business/NumField";
import { ReasonChips } from "@/components/business/ReasonChips";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "cn";

/** 指标输入缓冲：key = 指标 code，value = 屏幕上的十进制文本（% 或 g/L）或文本值 */
type Buffer = Record<string, string>;

function bufferOf(list: QcReport["indicators"]): Buffer {
  const b: Buffer = {};
  for (const it of list) {
    if (it.unit === "text") b[it.code] = it.value_text ?? "";
    else if (it.unit === "gL") b[it.code] = it.value_num == null ? "" : String(it.value_num);
    else b[it.code] = it.value_num == null ? "" : (it.value_num / 100).toFixed(2);
  }
  return b;
}

/** 超基准判定只用于提示色与箭头，不参与任何计算 */
function compare(meta: IndicatorMeta, num: number | null): { over: 0 | 1; text: string | null } {
  if (num == null || meta.std == null || meta.unit === "text") return { over: 0, text: null };
  const worse = meta.lowerBetter ? num > meta.std : num < meta.std;
  if (!worse) return { over: 0, text: null };
  const diff = Math.abs(num - meta.std);
  const txt = meta.unit === "gL" ? `${diff} g/L` : `${(diff / 100).toFixed(2)}%`;
  return { over: 1, text: `${meta.lowerBetter ? "↑ 超" : "↓ 低"}基准 ${txt}` };
}

export function QcPanel({ order, variety }: { order: WeighOrder | null; variety: GrainVariety | null }) {
  const can = useSession((s) => s.can);
  const qc = useQueryClient();

  const { data: reports = [] } = useQuery({
    queryKey: ["qc-of-order", order?.order_no],
    queryFn: () => (order ? api.listQc({ keyword: order.order_no }) : Promise.resolve([])),
    enabled: !!order,
  });
  const existing = useMemo(
    () => (order?.qc_report_id != null ? (reports.find((r) => r.id === order.qc_report_id) ?? null) : null),
    [reports, order?.qc_report_id],
  );

  const codes = variety?.enabled_indicators?.length ? variety.enabled_indicators : ["moisture", "impurity"];
  const metas = codes.map((c) => INDICATORS[c]).filter((m): m is IndicatorMeta => !!m);

  const [buf, setBuf] = useState<Buffer>({});
  const [grade, setGrade] = useState<string>("");
  const [decision, setDecision] = useState<QcDecision>("accept");
  const [method, setMethod] = useState<TestMethod>("nir");
  const [moistureDeduct, setMoistureDeduct] = useState<number>(0);
  const [impurityDeduct, setImpurityDeduct] = useState<number>(0);
  const [rejectReason, setRejectReason] = useState("");

  // 换单或拿到原化验单时回填，避免在磅员已输入后覆盖
  useEffect(() => {
    if (!order) {
      setBuf({});
      setGrade("");
      setDecision("accept");
      setMoistureDeduct(0);
      setImpurityDeduct(0);
      setRejectReason("");
      return;
    }
    if (!existing) return;
    setBuf(bufferOf(existing.indicators));
    setGrade(existing.grade ?? "");
    setDecision(existing.decision);
    setMethod(existing.test_method);
    setMoistureDeduct(existing.moisture_deduct_01kg);
    setImpurityDeduct(existing.impurity_deduct_01kg);
    setRejectReason(existing.reject_reason ?? "");
  }, [order?.order_no, existing]);

  function num01(code: string): number | null {
    const raw = buf[code];
    if (raw == null || raw.trim() === "") return null;
    const meta = INDICATORS[code];
    if (!meta) return null;
    if (meta.unit === "gL") return Number(raw) || 0;
    return fromPercent(raw);
  }

  const save = useMutation({
    mutationFn: () => {
      const indicators = metas.map((m) => {
        if (m.unit === "text") {
          const t = (buf[m.code] ?? "").trim();
          return { code: m.code, name: m.name, value_num: null, value_text: t || null, unit: m.unit, std_value: null, over_std: 0 as const };
        }
        const v = num01(m.code);
        const cmp = compare(m, v);
        return {
          code: m.code,
          name: m.name,
          value_num: v,
          value_text: null,
          unit: m.unit,
          std_value: m.std ?? null,
          over_std: cmp.over,
        };
      });
      return api.saveQc({
        order_no: order!.order_no,
        grade: (grade || null) as Grade | null,
        decision,
        test_method: method,
        indicators,
        moisture_deduct_01kg: moistureDeduct,
        impurity_deduct_01kg: impurityDeduct,
        inspector_id: actorId(),
        reject_reason: decision === "reject" ? rejectReason.trim() : null,
      });
    },
    onSuccess: (r) => {
      if (!r) {
        toast.error("保存失败：磅单不存在");
        announce("化验保存失败，这张单不存在", `qc:${order?.order_no ?? "-"}`);
        return;
      }
      toast.success(`化验单 ${r.report_no} 已保存（留样 ${r.retention_no ?? "—"}）`);
      // 结论念出来是这一屏最有用的一声：拒收与否决定司机要不要卸货，化验员常常背对着屏幕在扦样
      announce(
        decision === "reject" ? "化验已保存，判定拒收" : "化验已保存",
        `qc-done:${order?.order_no ?? "-"}`,
      );
      qc.invalidateQueries({ queryKey: ["order", order?.order_no] });
      qc.invalidateQueries({ queryKey: ["qc-of-order", order?.order_no] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["open-orders"] });
      qc.invalidateQueries({ queryKey: ["qc-list"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    // 拒收理由、重复录入等闸门原因要原样送到化验员眼前
    onError: (e: Error) => {
      toast.error(`保存化验失败：${e.message || "可重试；已录入内容不会丢"}`);
      announce("化验保存失败，填的内容没有丢，可以再存一次", "qc-fail");
    },
  });

  const blocked = !order
    ? "尚未制单，无法录入化验"
    : !can("qc.save")
      ? "当前岗位无权保存化验，需化验员或站长"
      : metas.some((m) => m.code === "moisture" && num01("moisture") == null)
        ? "水分为必检项，不能留空"
        : decision === "reject" && rejectReason.trim().length < REASON_MIN
          ? `拒收必须填写原因（不少于 ${REASON_MIN} 字）`
          : null;

  useHotkey("f5", () => {
    if (!blocked) save.mutate();
    else {
      toast.error(blocked);
      // 这些原因本身就是一句人话（不带单号与数字），照整句话去重：原因换了就该重念一句
      announce(blocked);
    }
  });

  /** 品种的国标基准可以是"尚未核定"（真库种子留空），此时不能渲染成一串破折号 */
  const standards =
    variety == null
      ? "未选品种"
      : variety.std_moisture_001pct == null && variety.std_impurity_001pct == null
        ? `${variety.name} · 尚未核定国标基准（基础档案 › 品种与指标）`
        : `${variety.name} · 基准 水分 ${percent(variety.std_moisture_001pct, "")}／杂质 ${percent(variety.std_impurity_001pct, "")}`;

  return (
    <Card size="sm" className="min-w-0 py-0 gap-0">
      <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center border-b px-2.5">
        <CardTitle className="text-xs font-semibold">化验区</CardTitle>
        <CardAction className="self-center text-xs text-muted-foreground">{standards}</CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 p-2">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {metas.map((m) => {
            const cmp = m.unit === "text" ? { over: 0 as const, text: null } : compare(m, num01(m.code));
            if (m.unit === "text") {
              return (
                <div key={m.code} className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  <Label htmlFor={`qc-ind-${m.code}`} className="text-xs text-muted-foreground">
                    {m.name}
                  </Label>
                  <Input
                    id={`qc-ind-${m.code}`}
                    value={buf[m.code] ?? ""}
                    onChange={(e) => setBuf((b) => ({ ...b, [m.code]: e.target.value }))}
                    placeholder="点下面的常用结论"
                    className="h-8 text-xs"
                  />
                  <ReasonChips
                    aria-label={`${m.name}常用结论`}
                    presets={ODOR_PRESETS}
                    value={buf[m.code] ?? ""}
                    onChange={(v) => setBuf((b) => ({ ...b, [m.code]: v }))}
                  />
                </div>
              );
            }
            return (
              <NumField
                key={m.code}
                keypad
                label={`${m.name}${m.std != null ? `(${m.unit === "gL" ? density(m.std) : percent(m.std, "")})` : ""}`}
                text={buf[m.code] ?? ""}
                onText={(t) => setBuf((b) => ({ ...b, [m.code]: t }))}
                unit={m.unit === "gL" ? "g/L" : "%"}
                decimals={m.unit === "gL" ? 0 : 2}
                invalid={cmp.over === 1}
                hint={cmp.text ?? undefined}
                className={cn(cmp.over === 1 && "bg-warning-bg")}
              />
            );
          })}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
          <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            等级
            <Choose
              aria-label="等级"
              value={grade}
              onChange={setGrade}
              options={[{ value: "", label: "未定级" }, ...GRADES.map((g) => ({ value: g, label: g }))]}
            />
          </Label>
          <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            判定
            <Choose
              aria-label="判定"
              value={decision}
              onChange={(v) => setDecision(v)}
              options={(Object.keys(QC_DECISION) as QcDecision[]).map((k) => ({ value: k, label: QC_DECISION[k].label }))}
            />
          </Label>
          <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            检测方法
            <Choose
              aria-label="检测方法"
              value={method}
              onChange={(v) => setMethod(v)}
              options={(Object.keys(TEST_METHOD) as TestMethod[]).map((k) => ({ value: k, label: TEST_METHOD[k] }))}
            />
          </Label>
          <WeightField
            label="扣水"
            keypad
            value01kg={moistureDeduct || null}
            onChange={(v) => setMoistureDeduct(v ?? 0)}
          />
          <WeightField
            label="扣杂"
            keypad
            value01kg={impurityDeduct || null}
            onChange={(v) => setImpurityDeduct(v ?? 0)}
          />
        </div>

        {decision === "reject" && (
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>拒收原因（必填，不少于 {REASON_MIN} 字）</span>
            <Textarea
              rows={1.5}
              aria-label="拒收原因"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="点一条常用的，或写清楚为什么退粮…"
              className="min-h-0 text-sm"
            />
            <ReasonChips aria-label="常用拒收原因" presets={REJECT_REASONS} value={rejectReason} onChange={setRejectReason} />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 border-t pt-1.5">
          <Button size="sm" onClick={() => save.mutate()} disabled={!!blocked || save.isPending} className="h-8">
            保存化验（F5）
          </Button>
          {blocked && <span className="text-xs text-warning">{blocked}</span>}
          {existing && (
            <span className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
              已有化验单 {existing.report_no}
              <QcDecisionBadge decision={existing.decision} />
              <span className="tnum">扣水 {weight(existing.moisture_deduct_01kg)}</span>
              <span className="tnum">扣杂 {weight(existing.impurity_deduct_01kg)}</span>
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
