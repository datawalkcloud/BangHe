/**
 * 「点打印」的唯一入口封装（06 §2.2 硬规矩 2 / §8 打印编排）。
 *
 * 工作台（第二刷自动出码单、F9、结算框「凭票打印」）、磅单详情（页面与抽屉）的补打
 * 全部走这里，因此三者物理上是同一条路：
 *   1. 先让 `silent.ts` 判这台机器能不能不经人手直接出纸——只有 ESC/POS 直连的热敏小票机
 *      会当场出纸（出纸口由**设备中心台账**决定，默认打印机优先）；
 *   2. 其余一律回到预览框：A4 / 241 这类走打印队列的机器**默认就是先预览再打**（issue #4），
 *      直连小票机真打不出去时也从这里给磅员一次手动机会。
 *
 * 为什么非得抽出来：早先只有工作台走直打，磅单详情的「补打码单」直接开预览框，
 * 出纸交给 `window.print()`——配好的那台打印机在补打时形同虚设，票全跑去了系统默认队列。
 * 规矩只写一份，两处才不会再分叉；设备台账的解析也只该有一处实现。
 *
 * 用法：
 * ```tsx
 * const { print, preview } = useSilentReceiptPrint();
 * // 触发：await print({ scenario: "weigh_order", docNo, isReprint: true, context });
 * // 渲染：{preview}   // 预览框，没发起过打印时是 null
 * ```
 */
import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { printReceiptSilently } from "./silent";
import { ReceiptPrintPreview } from "./ReceiptPrintPreview";
import type { ReceiptContext, ReceiptScenario } from "./types";

export interface ReceiptPrintRequest {
  scenario: ReceiptScenario;
  context: ReceiptContext;
  docNo: string;
  isReprint?: boolean;
  /**
   * 出纸成功后要刷新哪条查询。缺省 `["order", docNo]`（磅单）。
   *
   * 之所以做成参数而不是让 hook 自己认场景：`prints`（已打几张）挂在各张单据自己的详情查询上，
   * 出库码单刷新的是 `["outbound"]`——写死磅单那一条的话，出库页打完一张「已打 N 张」不动，
   * 下一次点还是"首打"，补打角标就永远漏第一张。
   */
  invalidate?: readonly unknown[];
}

/**
 * 返回 `print`（触发出纸或预览）与 `preview`（预览框节点）。
 *
 * 成功出纸后刷新 `["order", docNo]`，让「已打几张 / 补打角标」立刻跟上——
 * 只有 print_log 里 result=success 的记录才算打过，不能由"框开合过"决定。
 */
export function useSilentReceiptPrint() {
  const qc = useQueryClient();
  // 出纸口从台账解析；与工作台/设备状态条共用同一个 query key，不重复拉
  const { data: devices = [] } = useQuery({
    queryKey: ["devices"],
    queryFn: () => api.listDevices(),
    staleTime: 60_000,
  });
  /** 最近一次打印请求：预览框要就地渲染，票面数据得留在手上 */
  const [req, setReq] = useState<ReceiptPrintRequest | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const print = useCallback(
    async (r: ReceiptPrintRequest) => {
      setReq(r);
      setPreviewOpen(false);
      const out = await printReceiptSilently({
        scenario: r.scenario,
        context: r.context,
        docNo: r.docNo,
        isReprint: r.isReprint,
        devices,
      });
      // 纸已经出去了就别弹窗挡路；只有没出纸（队列机、浏览器演示、设备不可用）才开框
      if (out === "preview") setPreviewOpen(true);
      else void qc.invalidateQueries({ queryKey: r.invalidate ?? ["order", r.docNo] });
      return out;
    },
    [devices, qc],
  );

  const preview = req ? (
    <ReceiptPrintPreview
      open={previewOpen}
      onOpenChange={(v) => setPreviewOpen(v)}
      scenario={req.scenario}
      context={req.context}
      isReprint={req.isReprint}
      docNo={req.docNo}
      devices={devices}
      onPrinted={() => void qc.invalidateQueries({ queryKey: req.invalidate ?? ["order", req.docNo] })}
    />
  ) : null;

  return { print, preview };
}
