/**
 * ④ 化验区（05 §4 中栏下）。
 *
 * 关键边界（02 文档 F4.4：计价引擎首版不做）：
 *  指标只用来做"超基准提示"，前端绝不根据水分/杂质反算扣重；
 *  扣水、扣杂公斤数一律由化验员人工填写，写进化验单并留痕。
 *
 * 交互（0914 改版）：没有"保存"按钮——当前磅单存在即可编辑，录入停手后自动保存；
 * 未制单（或岗位无权）时整屏输入全部禁用。每次自动保存仍走 saveQc 的
 * "复检/更正"语义（新增一张有效单、旧单保留），所以只有内容真的变了、
 * 且过了必检项闸门才会发一次写请求，不会逐键打爆化验单链。
 *
 * **化验前必须先定品种**（新单在制单时就带着品种，这一行是给存量单 / 被清空的单兜底的）：
 * 化验的指标集与扣量基准全部来自品种档案（`variety.enabled_indicators` / `std_*`），
 * 没有品种的化验单连"超没超基准"都无从谈起。所以这一屏在品种为空时先给一个就地品种下拉
 * （走 `order_set_variety`），选定后指标集与基准自己回来；服务端 `qc_save` 同口径拦一道，
 * 前端只是让人少跑一步。
 *
 * **这一屏的数与计算单的关系要说清**（两屏都露着等级与扣水/扣杂，字面重复极易被当成同一格）：
 *  - 「化验定级」写的是 `qc_report.grade`——化验员按国标的判定，**永不改写**；
 *    "这一车按几等结钱"是计算单的「结算等级」（`weigh_order.grade`），两条线，别混。
 *  - 「扣水 / 扣杂」写的是 `qc_report.*_deduct_01kg`，库里注释就是"化验给出的**建议**"：
 *    结算真值落在磅单上（由计算单确认后 `settle` 写库），这里改完不会流过去，反之亦然。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { announce } from "@/lib/voice-prompt";
import type { GrainVariety, QcReport, WeighOrder } from "@/mock/types";
import type { Grade, IndicatorMeta, QcDecision, TestMethod } from "@/lib/constants";
import { GRADES, INDICATORS, QC_DECISION, REASON_MIN, TEST_METHOD } from "@/lib/constants";
import { density, fromPercent, percent, weight } from "@/lib/format";
import { actorId, useSession } from "@/store/session";
import { useQuickOptions, useVarieties } from "@/hooks/useLookups";
import { useHotkey } from "@/hooks/useHotkey";
import { Choose } from "@/components/business/Choose";
import { ComboBox } from "@/components/business/ComboBox";
import { QcDecisionBadge } from "@/components/business/badges";
import { NumField, WeightField } from "@/components/business/NumField";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "cn";

/** 指标输入缓冲：key = 指标 code，value = 屏幕上的十进制文本（% 或 g/L）或文本值 */
type Buffer = Record<string, string>;

/** 停手多久算"录完了这一格"：再短会把打字拆成两张化验单，再长显得没在存 */
const AUTO_SAVE_DELAY_MS = 1_000;

/** 与 api.saveQc 入参同形（去掉单号/化验员）；自动保存的"变没变"就按它序列化比对 */
interface QcPayload {
  indicators: {
    code: string;
    name: string;
    value_num: number | null;
    value_text: string | null;
    unit: "0.01pct" | "gL" | "text";
    std_value: number | null;
    over_std: 0 | 1;
  }[];
  grade: Grade | null;
  decision: QcDecision;
  test_method: TestMethod;
  moisture_deduct_01kg: number;
  impurity_deduct_01kg: number;
  reject_reason: string | null;
}

function bufferOf(list: QcReport["indicators"]): Buffer {
  const b: Buffer = {};
  for (const it of list) {
    if (it.unit === "text") b[it.code] = it.value_text ?? "";
    else if (it.unit === "gL") b[it.code] = it.value_num == null ? "" : String(it.value_num);
    else b[it.code] = it.value_num == null ? "" : (it.value_num / 100).toFixed(2);
  }
  return b;
}

/** 屏幕文本 → 定点整数（0.01% / g/L），空串是"没录" */
function num01Of(buf: Buffer, code: string): number | null {
  const raw = buf[code];
  if (raw == null || raw.trim() === "") return null;
  const meta = INDICATORS[code];
  if (!meta) return null;
  if (meta.unit === "gL") return Number(raw) || 0;
  return fromPercent(raw);
}

function payloadOf(
  metas: IndicatorMeta[],
  buf: Buffer,
  grade: string,
  decision: QcDecision,
  method: TestMethod,
  moistureDeduct: number,
  impurityDeduct: number,
  rejectReason: string,
): QcPayload {
  return {
    indicators: metas.map((m) => {
      if (m.unit === "text") {
        const t = (buf[m.code] ?? "").trim();
        return { code: m.code, name: m.name, value_num: null, value_text: t || null, unit: m.unit, std_value: null, over_std: 0 as const };
      }
      const v = num01Of(buf, m.code);
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
    }),
    grade: (grade || null) as Grade | null,
    decision,
    test_method: method,
    moisture_deduct_01kg: moistureDeduct,
    impurity_deduct_01kg: impurityDeduct,
    reject_reason: decision === "reject" ? rejectReason.trim() : null,
  };
}

/**
 * 文本型化验指标（气味）。
 *
 * 常用结论（ODOR_PRESETS）收进可打字下拉：中栏很挤，气味只是其中一个格，
 * 平时就是一个文本框，聚焦/点箭头才浮出清单；照旧可直接手打补细节。
 */
function TextIndicatorField({
  code,
  name,
  value,
  onChange,
  disabled,
}: {
  code: string;
  name: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const { options } = useQuickOptions("odor");
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      <Label htmlFor={`qc-ind-${code}`} className="text-xs text-muted-foreground">
        {name}
      </Label>
      <ComboBox
        id={`qc-ind-${code}`}
        aria-label={`${name}常用结论`}
        presets={options}
        value={value}
        onChange={onChange}
        disabled={disabled}
        placeholder="选常用结论，或直接填写"
        className="h-8 text-xs"
      />
    </div>
  );
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
  const { options: rejectOptions } = useQuickOptions("reject");
  const { data: allVarieties = [] } = useVarieties();

  /**
   * 就地给本单补定品种（制单可以不带，见文件头）。选完即回读：`variety` 由页面查询跟着变，
   * 指标集与国标基准自己长回来，化验员不用离开这一屏去别处设置。
   * 事由留空即可——这不是改判（同一张单换品种在制单后属补录），真要留痕的改判在结算框那一路。
   */
  const setVariety = useMutation({
    mutationFn: (variety_id: number) =>
      api.setOrderVariety({ order_no: order!.order_no, variety_id, reason: "", operator_id: actorId() }),
    onSuccess: (o) => {
      if (!o) {
        toast.error("这张单已经不在系统里了，请刷新后再录化验");
        return;
      }
      qc.invalidateQueries({ queryKey: ["order", o.order_no] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["open-orders"] });
      announce("品种已选定，请按项目录入化验", `qc-variety:${o.order_no}`);
    },
    onError: (e: Error) => toast.error(`品种没选定：${e.message || "请重试"}`),
  });

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

  /** 化验员在这张单上动过几次手：回填只补"没动过手"的屏，不覆盖正在录的 */
  const editSeqRef = useRef(0);
  /** 最后一次成功落库（或回填自原单）的内容签名；签名没变就不该再发写请求 */
  const savedSigRef = useRef<string | null>(null);
  /** 本次请求携带的签名与发出时的改动序号，成功后转正，防在飞期间又改了字被误判"已保存" */
  const submitSigRef = useRef<string | null>(null);
  const submitSeqRef = useRef(-1);
  const markTouched = () => {
    editSeqRef.current += 1;
  };

  const sig = useMemo(
    () => JSON.stringify(payloadOf(metas, buf, grade, decision, method, moistureDeduct, impurityDeduct, rejectReason)),
    [metas, buf, grade, decision, method, moistureDeduct, impurityDeduct, rejectReason],
  );

  // 换单先清屏：否则上一张单的残留会被自动保存到这一张头上
  const orderNo = order?.order_no ?? null;
  useEffect(() => {
    setBuf({});
    setGrade("");
    setDecision("accept");
    setMethod("nir");
    setMoistureDeduct(0);
    setImpurityDeduct(0);
    setRejectReason("");
    editSeqRef.current = 0;
    savedSigRef.current = null;
    submitSigRef.current = null;
  }, [orderNo]);

  // 拿到原化验单时回填（复检/更正就地续改），内容与原单一致时签名先对齐、不触发自动保存
  useEffect(() => {
    if (!orderNo || !existing || editSeqRef.current > 0) return;
    const reportSig = JSON.stringify(
      payloadOf(
        metas,
        bufferOf(existing.indicators),
        existing.grade ?? "",
        existing.decision,
        existing.test_method,
        existing.moisture_deduct_01kg,
        existing.impurity_deduct_01kg,
        existing.reject_reason ?? "",
      ),
    );
    if (savedSigRef.current === reportSig) return; // 已回填过/刚保存完，别在重渲染里反复 setBuf
    setBuf(bufferOf(existing.indicators));
    setGrade(existing.grade ?? "");
    setDecision(existing.decision);
    setMethod(existing.test_method);
    setMoistureDeduct(existing.moisture_deduct_01kg);
    setImpurityDeduct(existing.impurity_deduct_01kg);
    setRejectReason(existing.reject_reason ?? "");
    savedSigRef.current = reportSig;
  }, [orderNo, existing, sig, metas]);

  // 闸门缺哪一项，自动保存就等在哪一项（缺项期间不发请求，避免一次打字一串报错）。
  // 不属于任何表单项的原因（未制单/无权限）走底部状态行；品种/拒收原因这些字段级缺项
  // 直接红框+红字长在对应控件上，状态行不再重复（F5 手动保存时仍会把整句原因 toast 出来）。
  const needVariety = !!order && variety == null;
  const needReason = decision === "reject" && rejectReason.trim().length < REASON_MIN;
  const statusGate = !order
    ? "尚未制单，无法录入化验"
    : !can("qc.save")
      ? "当前岗位无权录入化验，需化验员或站长"
      : null;
  const gateMiss = statusGate
    ?? (needVariety
      ? "本单还没有定收购品种，选定品种后才会保存化验"
      : needReason
        ? `拒收需填写原因（不少于 ${REASON_MIN} 字），填好后自动保存`
        : null);
  const editable = !!order && can("qc.save");
  const dirty = sig !== savedSigRef.current;

  const save = useMutation({
    mutationFn: () => {
      const payload = payloadOf(metas, buf, grade, decision, method, moistureDeduct, impurityDeduct, rejectReason);
      submitSigRef.current = JSON.stringify(payload);
      submitSeqRef.current = editSeqRef.current;
      return api.saveQc({
        order_no: order!.order_no,
        inspector_id: actorId(),
        ...payload,
      });
    },
    onSuccess: (r) => {
      if (!r) {
        // 没写进去：签名不转正，改一个字还会再试；F5 也能立刻重试
        toast.error("保存失败：磅单不存在");
        announce("化验保存失败，这张单不存在", `qc:${order?.order_no ?? "-"}`);
        return;
      }
      savedSigRef.current = submitSigRef.current;
      // 在飞期间又改了字：保持"动过手"状态，让回填让位、改完自动再存一版
      if (editSeqRef.current === submitSeqRef.current) editSeqRef.current = 0;
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
    // 拒收理由、重复录入等闸门原因要原样送到化验员眼前；改一个字会自动再试
    onError: (e: Error) => {
      toast.error(`保存化验失败：${e.message || "可重试；已录入内容不会丢"}`);
      announce("化验保存失败，填的内容没有丢，可以再存一次", "qc-fail");
    },
  });

  // 编辑后自动保存：停手 1 秒、且内容相对最后落库签名真的变了才发一次；
  // 没动过手就不许发（选中即空单的场景也不能凭空存出一张零值化验单）
  useEffect(() => {
    if (!editable || gateMiss || !dirty || save.isPending) return;
    if (editSeqRef.current === 0) return;
    const t = setTimeout(() => save.mutate(), AUTO_SAVE_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, gateMiss, dirty, sig, save.isPending]);

  // F5 保留为"立即保存"：不点按钮的肌肉记忆，也覆盖"不想等那一秒"的场景
  useHotkey("f5", () => {
    if (!editable || gateMiss) {
      toast.error(gateMiss ?? "无法保存化验");
      // 这些原因本身就是一句人话（不带单号与数字），照整句话去重：原因换了就该重念一句
      announce(gateMiss ?? "无法保存化验");
      return;
    }
    if (!dirty) {
      toast.info("化验内容没有改动");
      return;
    }
    save.mutate();
  });

  /** 品种的国标基准可以是"尚未核定"（真库种子留空），此时不能渲染成一串破折号 */
  const standards =
    variety == null
      ? "未选品种"
      : variety.std_moisture_001pct == null && variety.std_impurity_001pct == null
        ? `${variety.name} · 尚未核定国标基准（基础档案 › 品种与指标）`
        : `${variety.name} · 基准 水分 ${percent(variety.std_moisture_001pct, "")}／杂质 ${percent(variety.std_impurity_001pct, "")}`;

  const status = !editable
    ? { text: statusGate ?? "", tone: "text-warning" as const }
    : statusGate
      ? { text: statusGate, tone: "text-warning" as const }
      : save.isPending
        ? { text: "保存中…", tone: "text-muted-foreground" as const }
        : dirty
          ? { text: "有改动，即将自动保存", tone: "text-muted-foreground" as const }
          : { text: "改动会自动保存（F5 立即保存）", tone: "text-muted-foreground" as const };

  return (
    <Card size="sm" className="min-w-0 py-0 gap-0">
      <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center px-2.5">
        <CardTitle className="text-xs font-semibold">化验区</CardTitle>
        <CardAction className="self-center text-xs text-muted-foreground">{standards}</CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 p-2">
        {/* 没定品种就没有指标集与基准（现在露的是"水分/杂质"这个兜底组合），
            所以这一行挡在最上面：选完指标格与基准立刻按新品种重排 */}
        {needVariety && order && (
          <Label className="flex items-center gap-1.5 border bg-muted/30 p-1.5 text-xs text-muted-foreground">
            <span className="shrink-0 text-destructive">请先选择收购品种：</span>
            <Choose
              aria-label="收购品种"
              size="sm"
              invalid
              className="min-w-0 flex-1 text-xs"
              value=""
              disabled={setVariety.isPending}
              onChange={(v) => v && setVariety.mutate(Number(v))}
              options={[
                { value: "", label: "请选择品种…" },
                ...allVarieties.filter((v) => v.is_active !== 0).map((v) => ({ value: String(v.id), label: v.name })),
              ]}
            />
          </Label>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {metas.map((m) => {
            const cmp = m.unit === "text" ? { over: 0 as const, text: null } : compare(m, num01Of(buf, m.code));
            if (m.unit === "text") {
              return (
                <TextIndicatorField
                  key={m.code}
                  code={m.code}
                  name={m.name}
                  value={buf[m.code] ?? ""}
                  onChange={(v) => {
                    markTouched();
                    setBuf((b) => ({ ...b, [m.code]: v }));
                  }}
                  disabled={!editable}
                />
              );
            }
            return (
              <NumField
                key={m.code}
                keypad
                label={`${m.name}${m.std != null ? `(${m.unit === "gL" ? density(m.std) : percent(m.std, "")})` : ""}`}
                text={buf[m.code] ?? ""}
                onText={(t) => {
                  markTouched();
                  setBuf((b) => ({ ...b, [m.code]: t }));
                }}
                unit={m.unit === "gL" ? "g/L" : "%"}
                decimals={m.unit === "gL" ? 0 : 2}
                invalid={cmp.over === 1}
                // `cmp` 是「文本指标占位」与 `compare` 结果的联合，占位那支的 text 是 null；
                // `hint` 只认 string | undefined，这一下是把 null 收成 undefined
                hint={cmp.text ?? undefined}
                disabled={!editable}
                className={cn(cmp.over === 1 && "bg-warning-bg")}
              />
            );
          })}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
          <Label
            className="flex flex-col gap-0.5 text-xs text-muted-foreground"
            title="化验定级按国标判定，复检另立新单；这一车按几等结钱在计算单的「结算等级」里定。"
          >
            化验定级
            <Choose
              aria-label="化验定级"
              value={grade}
              disabled={!editable}
              onChange={(v) => {
                markTouched();
                setGrade(v);
              }}
              options={[{ value: "", label: "未定级" }, ...GRADES.map((g) => ({ value: g, label: g }))]}
            />
          </Label>
          <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            判定
            <Choose
              aria-label="判定"
              value={decision}
              disabled={!editable}
              onChange={(v) => {
                markTouched();
                setDecision(v);
              }}
              options={(Object.keys(QC_DECISION) as QcDecision[]).map((k) => ({ value: k, label: QC_DECISION[k].label }))}
            />
          </Label>
          <Label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            检测方法
            <Choose
              aria-label="检测方法"
              value={method}
              disabled={!editable}
              onChange={(v) => {
                markTouched();
                setMethod(v);
              }}
              options={(Object.keys(TEST_METHOD) as TestMethod[]).map((k) => ({ value: k, label: TEST_METHOD[k] }))}
            />
          </Label>
          <WeightField
            label="扣水"
            keypad
            value01kg={moistureDeduct || null}
            disabled={!editable}
            onChange={(v) => {
              markTouched();
              setMoistureDeduct(v ?? 0);
            }}
          />
          <WeightField
            label="扣杂"
            keypad
            value01kg={impurityDeduct || null}
            disabled={!editable}
            onChange={(v) => {
              markTouched();
              setImpurityDeduct(v ?? 0);
            }}
          />
        </div>

        {/* 这一句是本屏唯一能挡住"同一件事填两遍"的地方：扣水/扣杂在计算单里还会再出现一次
            （那才是进结算、进票面的真值）。不点明"这里是建议"，化验员与出纳就会各录一遍，
            事后也说不清哪份算数。 */}
        <p className="text-[11px] text-muted-foreground">
          扣水 / 扣杂 是化验给出的<span className="text-foreground">建议值</span>：结算与票面按计算单里确认的那份算。
        </p>

        {decision === "reject" && (
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>拒收原因（必填，不少于 {REASON_MIN} 字）</span>
            <ComboBox
              multiline
              rows={2}
              aria-label="拒收原因"
              presets={rejectOptions}
              value={rejectReason}
              disabled={!editable}
              invalid={editable && needReason}
              onChange={(v) => {
                markTouched();
                setRejectReason(v);
              }}
              placeholder="选一条常用的，或写清楚为什么退粮…"
              className="min-h-0 text-sm"
            />
            {editable && needReason && (
              <span className="text-destructive">拒收需填写原因，不少于 {REASON_MIN} 字</span>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 border-t pt-1.5">
          <span className={cn("text-xs", status.tone)}>{status.text}</span>
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
