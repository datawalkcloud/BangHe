/**
 * 流转卡卡池（06 篇 §8；§9.26 `card`）。
 *
 * 卡是循环资产：**在册才能用**；一次流转内被一张磅单独占，终态即释放回池。这页管三件事——
 * 批量登记入库、看空闲/占用/注销分布、注销丢失或磨损的卡。工作台上的"发卡"是靠后台监听读到一张
 * 空闲卡自动绑单（06 §4.1），不在这里手点；这里只维护"哪些卡在池子里可用"这本账。
 *
 * 未登记的外来卡**不必先跑到这一页来登**（前提：站点参数 `card_auto_register`「允许使用未登记的流转卡」
 * 开着，默认就是开）：工作台后台常听与「制单请放流转卡」读到陌生卡号时，当场走同一条
 * `card_pool_register` 入池留痕（06 §4.1 闸门 3），来源写在「来源 / 备注」列。把它关掉即退回
 * 硬闸门——新卡必须先在本页登记才能用。开着时本页也就从"不发卡的前置闸门"退成
 * **批量登记 + 事后纠错**：新卡贴签在这里补，误收进来的公交卡也在这里注销。
 *
 * 登记闭环在 `IcScanDialog` 里：点「读卡登记」开弹窗，连续监听读到卡号后再补一条贴签就
 * 直接入库，不再有"页面输入卡号、读卡、点登记"来回切两屏的老节奏。读不到或想绕过读卡
 * 仍可在弹窗里「手工录入」手输卡号。
 *
 * 空闲卡低于 `card_pool_warn_free` 时顶部黄条预警（C8）：当日在途多、池子快见底得先补登。
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScanLineIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { CardPoolRow } from "@/mock/types";
import { CARD_STATUS, type CardStatus, REASON_MIN } from "@/lib/constants";
import { dateTimeShort, orDash } from "@/lib/format";
import { useQuickOptions, useSetting } from "@/hooks/useLookups";
import { actorId, useSession } from "@/store/session";
import { DataTable, type Column } from "@/components/business/DataTable";
import { IcScanDialog } from "@/components/business/IcScanDialog";
import { ComboBox } from "@/components/business/ComboBox";
import { QuickDetailLink } from "@/components/business/quickDetail";
import { ToneBadge } from "@/components/business/badges";
import { CallOut, EmptyState, PageHeader } from "@/components/business/layout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function CardsPage() {
  const qc = useQueryClient();
  const can = useSession((s) => s.can);
  const warnFree = useSetting("card_pool_warn_free").num || 5;
  const { options: retireOptions } = useQuickOptions("card_retire");

  const [status, setStatus] = useState<CardStatus | "all">("all");
  const [keyword, setKeyword] = useState("");
  const [retire, setRetire] = useState<CardPoolRow | null>(null);
  const [retireReason, setRetireReason] = useState("");
  /**
   * 读卡登记弹窗：登记的整个节奏（监听 → 读卡 → 补贴签 → 入库）都在弹窗里完成。
   * 与售粮人档案的「读卡建档」同一套工作台物理读卡器，但介质是 IC 卡（Mifare）、
   * 命中后不展开完整档案编辑页，只需要一条贴签。
   */
  const [scanOpen, setScanOpen] = useState(false);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["cards", status, keyword],
    queryFn: () => api.cardPoolList({ status, keyword }),
  });
  const { data: all = [] } = useQuery({ queryKey: ["cards", "all", ""], queryFn: () => api.cardPoolList({}) });
  const freeCount = all.filter((c) => c.status === "in_pool").length;

  /** 弹窗里点「登记入库」时调一次；倒计时与设备故障的提示都在弹窗自己里，不外泄 */
  const register = useMutation({
    mutationFn: (input: { card_no: string; label: string }) =>
      api.cardPoolRegister({
        card_no: input.card_no,
        label: input.label.trim() || null,
        remark: null,
        operator_id: actorId() ?? 0,
      }),
  });

  const doRetire = useMutation({
    mutationFn: () => api.cardPoolRetire({ card_no: retire!.card_no, reason: retireReason.trim() }),
    onSuccess: () => {
      toast.success("已注销，该卡不再可发放");
      setRetire(null);
      setRetireReason("");
      qc.invalidateQueries({ queryKey: ["cards"] });
    },
    onError: (e: Error) => toast.error(`注销失败：${e.message}`),
  });

  const columns = useMemo<Column<CardPoolRow>[]>(
    () => [
      { key: "card_no", header: "卡号", cell: (r) => <span className="tnum font-medium">{r.card_no}</span> },
      { key: "label", header: "贴签", cell: (r) => orDash(r.label) },
      { key: "status", header: "状态", cell: (r) => <ToneBadge tone={CARD_STATUS[r.status].tone}>{CARD_STATUS[r.status].label}</ToneBadge> },
      {
        key: "order_no",
        header: "挂在单",
        cell: (r) =>
          r.order_no ? (
            <QuickDetailLink type="order" id={r.order_no} className="tnum font-medium text-primary">
              {r.order_no}
            </QuickDetailLink>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        key: "remark",
        header: "来源 / 备注",
        // 工作台刷到未登记的卡会当场自动入库并写明出处（06 §4.1 闸门 3）：这列就是"哪些卡不是批量登记的"
        cell: (r) => <span className="text-muted-foreground">{orDash(r.remark)}</span>,
      },
      { key: "issued_at", header: "发卡时间", cell: (r) => (r.issued_at ? dateTimeShort(r.issued_at) : "—") },
      { key: "issued_by", header: "领卡人", cell: (r) => orDash(r.issued_by_name) },
      {
        key: "action",
        header: "操作",
        cell: (r) =>
          can("device.manage") && r.status !== "retired" ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setRetire(r);
                setRetireReason("");
              }}
            >
              <Trash2Icon />
              注销
            </Button>
          ) : null,
      },
    ],
    [can],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="流转卡卡池"
        description="卡只认单不认人：工作台上刷到没登记的卡会当场自动入库（来源记在备注里），本页批量登记贴签、注销丢损，结算/作废自动回收。"
        actions={
          <>
            <Button size="sm" onClick={() => setScanOpen(true)} disabled={!can("order.create")}>
              <ScanLineIcon />
              读卡登记
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-2.5 py-2">
        {freeCount < warnFree && (
          <CallOut tone="warning" title={`空闲卡仅剩 ${freeCount} 张`}>
            低于预警阈值 {warnFree} 张：当日在途若多，请到本页继续登记入库，免得发到没卡可用。
          </CallOut>
        )}

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">筛选</span>
          {(["all", "in_pool", "in_use", "retired"] as const).map((s) => (
            <Button key={s} size="xs" variant={status === s ? "default" : "outline"} className="h-6 text-xs" onClick={() => setStatus(s)}>
              {s === "all" ? "全部" : CARD_STATUS[s].label}
            </Button>
          ))}
          <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="卡号 / 贴签 / 单号" className="h-7 w-52 text-xs" />
          <span className="ml-auto text-xs text-muted-foreground">新卡用右上「读卡登记」按钮</span>
        </div>

        <div className="min-h-0 flex-1">
          <DataTable<CardPoolRow>
            columns={columns}
            rows={rows}
            rowKey={(r) => r.card_no}
            loading={isLoading}
            dense
            empty={
              <EmptyState
                title="卡池里还没有卡"
                description="批量登记便于贴签辨认；不登也行——工作台上刷到没登记的卡会当场自动入库。"
                action={
                  <Button size="sm" onClick={() => setScanOpen(true)}>
                    <ScanLineIcon />
                    读卡登记第一张
                  </Button>
                }
              />
            }
          />
        </div>
      </div>

      <Dialog open={retire != null} onOpenChange={(v) => !v && setRetire(null)}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">注销流转卡 {retire?.card_no}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>注销原因（不少于 {REASON_MIN} 字，迎检可追溯）</span>
            <ComboBox
              aria-label="注销原因"
              presets={retireOptions}
              value={retireReason}
              onChange={setRetireReason}
              invalid={retireReason.trim().length > 0 && retireReason.trim().length < REASON_MIN}
              placeholder="选一条常用的，或写清楚这张卡为什么注销…"
              className="text-xs"
            />
            {retireReason.trim().length > 0 && retireReason.trim().length < REASON_MIN && (
              <span className="text-destructive">注销原因写全一点（不少于 {REASON_MIN} 字），这张卡为什么退场要留得明白</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">注销只影响卡池，不动任何磅单与金额；挂在途单上的卡需先退卡或走补发换卡。</p>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setRetire(null)}>
              取消
            </Button>
            <Button size="sm" variant="destructive" disabled={retireReason.trim().length < REASON_MIN || doRetire.isPending} onClick={() => doRetire.mutate()}>
              {doRetire.isPending ? "注销中…" : "确认注销"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <IcScanDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        validate={({ card_no }) =>
          !card_no.trim()
            ? { card_no: "未检测到 IC 卡号：请贴卡或手输后再提交" }
            : register.isError
              ? { card_no: register.error instanceof Error ? register.error.message : "登记失败，请稍后再试" }
              : {}
        }
        onRegister={async ({ card_no, label }) => {
          await register.mutateAsync({ card_no, label });
        }}
        onRegistered={() => {
          // 弹窗已关上后才 invalidate，避免点击瞬间把表里行闪一下又瞬移
          qc.invalidateQueries({ queryKey: ["cards"] });
        }}
      />
    </div>
  );
}
