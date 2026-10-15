/**
 * 出库单的「地磅称重」（02 §M11 F11.6、03 §9.12/§9.28，迁移 0029）。
 *
 * 这是磅房工作台③称重区（`workstation/WeighPanel`）的出库侧对应物：**同一块读数的样子、
 * 同一套现场纪律**，因为磅员在两个页面上干的是同一件事——车在磅上、手在键盘上。
 * 所以这里刻意照抄三条，不因"这是出库页"而走样：
 *  1. **读数未稳定不允许捕获**：按钮置灰并写出为什么灰（05 §5「禁用必须带文字」）。
 *  2. **毛重 / 皮重那一格本身就是手录入口**（2026-10-09 与③称重区同批改版，那块「手工录入读数」
 *     开关连同下面两个框一起撤了）：没捕过的格子直接是录入框，捕过的要改点数值右边的「修改」。
 *     仪表离线时不必先拨开关再点按钮——现场没道理为一台坏掉的串口卡住一车货。手录会标在单据的
 *     「重量来源」上（`weight_source`），迎检逐条核对就看这一格；出库侧这一格**看证据不粘滞**
 *     （`outbound.rs`：由"当前采用的那一捕是不是手录"决定，仪表恢复后重捕一次即改回「地磅」），
 *     与磅单那条"手录过就永久是手录"不同，别把两边的话术抄串。
 *  3. **毛皮齐备则净重必须为正**：判据在服务端（`outbound::capture`），这里只负责把那句中文
 *     原因原样透传——面板不自己编"保存失败"，现场要知道到底哪儿不对。
 *
 * 与③称重区的三处不同，是出库本身没有的东西，不是偷懒：
 *  - **没有价闸**（02 §F1.4）：出库单价随时可改，完成出库那一刻才复算货款；
 *  - **没有皮重容差**：`party.last_tare_01kg` 是售粮人反复送粮攒的历史皮，出库领出方没有；
 *  - **不推进状态机、不出票、不去结算**：出库链只有 `draft → done`，称重只是草稿期填数，
 *    出码单是波 3（票面码 `BH2`）的事。
 *
 * 读数流是全局那一条（`store/device.ts`，由 `AppShell` 挂载）：不需要在本页"先连磅"，
 * 磅房工作台上看到的读数，在这里同样看得到——台账里没启用的真磅时两边一起是"离线 + 同一句原因"。
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PencilIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { OUTBOUND_STATUS } from "@/lib/constants";
import { dateTime, fromKg, toKg, weight } from "@/lib/format";
import { useDeviceStore } from "@/store/device";
import { actorId, useSession } from "@/store/session";
import { WeightDisplay } from "@/components/business/WeightDisplay";
import { InlineNumField } from "@/components/business/NumField";
import { ToneBadge, WeightSourceBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "cn";
import type { OutboundDetail } from "@/mock/types";

type WeighType = "gross" | "tare";

const LABEL: Record<WeighType, string> = { gross: "毛重", tare: "皮重" };

export function OutboundWeighPanel({ order }: { order: OutboundDetail }) {
  const scale = useDeviceStore((s) => s.scale);
  const can = useSession((s) => s.can);
  const qc = useQueryClient();

  /**
   * 毛重 / 皮重那一格里正在敲的文本（公斤，**不预先换算**）。存字符串而不是 0.1kg 整数：
   * `"42."` 折成 420 再回填就把小数点吞了。换算留到提交那一步（`draftOf`）。
   */
  const [draft, setDraft] = useState<Record<WeighType, string>>({ gross: "", tare: "" });
  /** 已捕获的那一格被人点「修改」开了口（没捕过的格子本来就是框，不需要这个标记） */
  const [editing, setEditing] = useState<Record<WeighType, boolean>>({ gross: false, tare: false });
  const [flash, setFlash] = useState<WeighType | null>(null);
  const grossRef = useRef<HTMLInputElement>(null);
  const tareRef = useRef<HTMLInputElement>(null);

  const editable = order.status === "draft" && can("outbound.create");
  const scaleDown = !scale.connected;

  /** 这一项此刻库里采用的读数（`null`＝还没捕过） */
  function adopted01(type: WeighType): number | null {
    return (type === "gross" ? order.gross_weight_01kg : order.tare_weight_01kg) ?? null;
  }

  /** 这一格该不该是录入框：没捕过天然是框；捕过了要本人点「修改」。过账后整块是死的 */
  function cellIsOpen(type: WeighType): boolean {
    return editable && (adopted01(type) == null || editing[type]);
  }

  /**
   * 主按钮这一捕按什么提交：`true`＝提交这一格里敲的数（手录），`false`＝捕地磅读数。
   * 框里有人敲了数就听人的；仪表离线且这一格还空着时，这一格是唯一的路。
   */
  function submitsManual(type: WeighType): boolean {
    return draft[type].trim() !== "" || (scaleDown && adopted01(type) == null);
  }

  /** 按钮上的动词跟着这一格的实际走法变：捕读数 / 录一个新数 / 改一个已捕获的数 */
  function cellActionLabel(type: WeighType): string {
    if (!submitsManual(type)) return `捕获${LABEL[type]}`;
    return adopted01(type) == null ? `录入${LABEL[type]}` : `保存${LABEL[type]}`;
  }

  /**
   * 待捕项：缺哪项优先提示哪项，两项都有则为复称。
   * 与③称重区同一个判法——出库也没有「必须先称毛重」的强制顺序（03 §9.28）。
   */
  const next: WeighType | null =
    order.gross_weight_01kg == null ? "gross" : order.tare_weight_01kg == null ? "tare" : null;

  const capture = useMutation({
    mutationFn: (a: { weigh_type: WeighType; weight_01kg: number; source: "scale" | "manual" }) =>
      api.captureOutbound({
        order_no: order.order_no,
        weigh_type: a.weigh_type,
        weight_01kg: a.weight_01kg,
        source: a.source,
        // 真机流的原帧是迎检时唯一能对回仪表报文的证据；只有演示流才合成个样子
        raw_frame: a.source === "scale" ? (scale.rawFrame ?? `=W${(a.weight_01kg / 10).toFixed(1)}kg ST`) : null,
        operator_id: actorId(),
      }),
    onSuccess: (o, a) => {
      setFlash(a.weigh_type);
      window.setTimeout(() => setFlash(null), 700);
      const tag = a.source === "manual" ? "（手录）" : "";
      toast.success(`${LABEL[a.weigh_type]} ${weight(a.weight_01kg)} 已捕获${tag}`);
      // 手录落库成功即收掉这一格的录入框：留着残值，下一单点一下就把上一单的数记进来了
      setDraft((v) => ({ ...v, [a.weigh_type]: "" }));
      setEditing((v) => ({ ...v, [a.weigh_type]: false }));
      // 出库单详情与列表是同一条 query 前缀（["outbound", 单号] / ["outbound", filters]）
      qc.invalidateQueries({ queryKey: ["outbound"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      if (o && o.gross_weight_01kg != null && o.tare_weight_01kg != null) {
        toast.info(`净重 ${weight(o.gross_weight_01kg - o.tare_weight_01kg)}，核对无误后点「完成出库」扣减库存`);
      }
    },
    // Rust 回的是人话（"毛重不高于皮重…"），原样透传，不吞原因
    onError: (e: Error) => toast.error(`捕获失败：${e.message}`),
  });

  function submit(type: WeighType, value01kg: number, source: "scale" | "manual") {
    if (!editable) {
      toast.error("只有草稿单能称重；本单已过账或当前岗位无权操作");
      return;
    }
    if (value01kg <= 0) {
      toast.error("读数必须大于 0；空车没上磅就先别记这一笔");
      return;
    }
    capture.mutate({ weigh_type: type, weight_01kg: value01kg, source });
  }

  /** 框里那个文本 → 0.1kg 整数。空串 / 只剩一个负号＝**还没录**（`null`），不当 0 处理 */
  function draftOf(type: WeighType): number | null {
    const t = draft[type].trim();
    if (t === "" || t === "-") return null;
    return fromKg(t);
  }

  /**
   * 提交这一格里敲的数（手录）。格子里按回车、点主按钮「录入… / 保存…」走的都是这里。
   * 框里空着就提示 + 送光标，**绝不退回去捕地磅读数**——人已经在框里按了回车，框就是他的意图。
   */
  function commitCell(type: WeighType) {
    const v = draftOf(type);
    if (v == null) {
      toast.warning(`请先录入${LABEL[type]}读数`);
      (type === "gross" ? grossRef : tareRef).current?.focus();
      return;
    }
    submit(type, v, "manual");
  }

  /** 点「修改」：把已捕获的读数原样填进框里整段选中。光标等框真渲染出来再送，当场 focus 是空操作 */
  function startEditCell(type: WeighType) {
    const v = adopted01(type);
    setEditing((s) => ({ ...s, [type]: true }));
    setDraft((s) => ({ ...s, [type]: v == null ? "" : String(toKg(v)) }));
    const input = type === "gross" ? grossRef : tareRef;
    requestAnimationFrame(() => input.current?.select());
  }

  /** 取消修改 / 按 Esc：退回只读，框里那个数一个字都不落库 */
  function cancelEditCell(type: WeighType) {
    setEditing((s) => ({ ...s, [type]: false }));
    setDraft((s) => ({ ...s, [type]: "" }));
  }

  function captureLive(type: WeighType) {
    if (submitsManual(type)) {
      commitCell(type);
      return;
    }
    if (!scale.connected) {
      toast.error(scale.error ? `仪表离线：${scale.error}` : "仪表离线，请在毛重 / 皮重那一格手工录入");
      return;
    }
    if (!scale.stable) {
      toast.warning("读数未稳定，请等车辆停稳后再捕获");
      return;
    }
    submit(type, scale.weight01kg, "scale");
  }

  // 换单即清空整组录入框与「修改」态：残值留在框里是串单的头号来源
  useEffect(() => {
    setDraft({ gross: "", tare: "" });
    setEditing({ gross: false, tare: false });
  }, [order.order_no]);

  const records = order.records ?? [];
  const weighed = order.gross_weight_01kg != null || order.tare_weight_01kg != null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">地磅称重</CardTitle>
        <CardAction className="flex items-center gap-2 text-xs text-muted-foreground">
          {/* 读数归属说清是哪台磅：一站两磅时"这条读数是哪个坑称的"是要问得出来的 */}
          {scale.code ? `${scale.code}${scale.port ? ` · ${scale.port}` : ""}` : "未取到设备读数"}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div
          className={cn(
            "flex flex-col sm:flex-row items-stretch justify-between gap-3 border bg-muted/20 p-3 transition-colors",
            flash && "border-success bg-success-bg",
            !scale.connected && "bg-muted/50",
          )}
        >
          <div className="flex min-w-0 flex-1 flex-col justify-between gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">地磅实时读数</span>
            <WeightDisplay
              value01kg={scale.connected ? scale.weight01kg : null}
              stable={scale.stable}
              connected={scale.connected}
              size="lg"
            />
            <span className="text-[11px] text-muted-foreground">
              {scale.connected
                ? scale.stable
                  ? "读数稳定，可以捕获"
                  : "读数变动中，等车辆停稳"
                : (scale.error ?? "仪表离线")}
            </span>
          </div>

          <div className="flex shrink-0 min-w-[240px] flex-col justify-between gap-2 border-t sm:border-l sm:border-t-0 pt-2 sm:pt-0 sm:pl-3">
            <div className="flex flex-col gap-1">
              <span className="border-b pb-0.5 text-[11px] font-medium text-muted-foreground">本单实测重量</span>
              {/*
                毛重 / 皮重这两行**本身就是手录的入口**，与③称重区同一副样子（05 §4 ③）：
                没捕过的格子直接是录入框，捕过的退回只读、数值右边一只「修改」。
                过账之后 `editable` 为假，两行一律只读——那时要更正只能红冲另开一张。
              */}
              {(["gross", "tare"] as WeighType[]).map((t) => {
                const v01 = adopted01(t);
                const captured = v01 != null;
                return (
                  <div key={t} className="flex items-center justify-between gap-2 text-xs">
                    <span className="shrink-0 text-muted-foreground">{LABEL[t]}</span>
                    {cellIsOpen(t) ? (
                      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
                        <InlineNumField
                          id={`ob-cell-${t}`}
                          inputRef={t === "gross" ? grossRef : tareRef}
                          text={draft[t]}
                          onText={(v) => setDraft((s) => ({ ...s, [t]: v }))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitCell(t);
                            else if (e.key === "Escape" && captured) cancelEditCell(t);
                          }}
                          placeholder={captured ? "" : "待捕获"}
                          unit="kg"
                          size="sm"
                          className="w-[104px] shrink-0"
                        />
                        {captured && (
                          <Button
                            size="xs"
                            variant="ghost"
                            className="h-6 shrink-0 px-1 text-muted-foreground"
                            disabled={capture.isPending}
                            onClick={() => cancelEditCell(t)}
                          >
                            取消
                          </Button>
                        )}
                      </div>
                    ) : (
                      <span className="flex min-w-0 items-center justify-end gap-1">
                        <span className="tnum font-semibold text-foreground">{captured ? weight(v01) : "待捕获"}</span>
                        {captured && editable && (
                          <Button
                            size="xs"
                            variant="ghost"
                            className="h-5 shrink-0 gap-0.5 px-1 text-[11px] text-muted-foreground hover:text-foreground"
                            title={`修改${LABEL[t]}：改完按回车或点下面的「保存${LABEL[t]}」落库`}
                            disabled={capture.isPending}
                            onClick={() => startEditCell(t)}
                          >
                            <PencilIcon className="size-3" />
                            修改
                          </Button>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
              <div className="flex items-center justify-between gap-2 border-t pt-0.5 text-xs">
                <span className="font-semibold text-foreground">净重（毛 − 皮）</span>
                <span className="tnum text-sm font-bold text-primary">
                  {order.net_weight_01kg != null ? weight(order.net_weight_01kg) : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">重量来源</span>
                <WeightSourceBadge source={order.weight_source} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(["gross", "tare"] as WeighType[]).map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={next === t ? "default" : "outline"}
                  disabled={
                    !editable ||
                    capture.isPending ||
                    (!submitsManual(t) && (!scale.connected || !scale.stable))
                  }
                  onClick={() => captureLive(t)}
                  className="text-xs"
                >
                  {cellActionLabel(t)}
                </Button>
              ))}
            </div>
          </div>
        </div>

        {!editable ? (
          <p className="text-xs text-muted-foreground">
            {order.status === "draft"
              ? "当前岗位不能做出库称重；这一格需要值仓 / 站长 / 磅员 / 登记员。"
              : `本单已「${OUTBOUND_STATUS[order.status].label}」，重量已进库存账，不能再称重；要更正只能走红冲后另开一张。`}
          </p>
        ) : null}

        {editable && scaleDown && (
          <p className="text-xs text-destructive">
            仪表离线{scale.error ? `：${scale.error}` : ""}。上面「毛重 / 皮重」两格本身就是录入框：照仪表小票上的数敲进去、按回车即可（两个按钮也已切成「录入…」）。
          </p>
        )}
        {/*
          手录的后果**只在框里真有数的时候说**：没捕过的那一格本来就是框，空着的时候说这句是噪音。
          出库侧与磅单不同——`outbound.rs` 判 `weight_source` **看证据不粘滞**（当前采用的那一捕
          是不是手录），所以这里可以写明"仪表恢复后重捕一次即改回地磅"；那句话在③称重区是假的。
        */}
        {editable && (draft.gross.trim() !== "" || draft.tare.trim() !== "") && (
          <p className="text-[11px] text-warning">
            框里这个数按「手录」落库并标在本单的「重量来源」上，事后由站长在审计日志里逐条核对；仪表恢复后重新捕获一次即可改回「地磅」（旧那一捕留在轨迹里，不删）。
          </p>
        )}

        {records.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-medium text-muted-foreground">
              称重轨迹 {records.length} 次
              {records.some((r) => r.source === "manual") && <span className="text-warning">（含手录）</span>}
              <span className="ml-1 font-normal">——复称不删行，只把「采用」标记挪到新那一捕</span>
            </p>
            <ul className="flex flex-col gap-0.5 text-[11px]">
              {records.map((r) => (
                <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
                  <span className={cn("tnum", r.is_adopted ? "font-semibold text-foreground" : "line-through")}>
                    {LABEL[r.weigh_type]} {weight(r.weight_01kg)}
                  </span>
                  <span className="tnum">{dateTime(r.captured_at).slice(5)}</span>
                  <span>{r.source === "scale" ? r.device_code : "手录"}</span>
                  {!!r.is_adopted && <ToneBadge tone="success">采用</ToneBadge>}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {weighed
              ? "本单已记录毛重 / 皮重，但轨迹行读不出来——请让站长核查数据。"
              : "还没上过磅：这一单的净重目前是手填的那一格。上过磅之后，改重量只走这一块（表单里那一格会锁住，免得两份数字互相盖）。"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
