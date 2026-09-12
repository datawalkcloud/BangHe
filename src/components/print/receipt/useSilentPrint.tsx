/**
 * 「点打印 = 出纸」的**唯一**入口封装（06 §2.2 硬规矩 2 / §8 打印编排）。
 *
 * 工作台（第二刷自动出码单、F9、结算框「凭票打印」）、磅单详情（页面与抽屉）的补打
 * 全部走这里，因此三者物理上是同一条路：
 *   1. 先调 `silent.ts` 无预览直打——出纸口由**设备中心台账**决定（默认打印机优先，
 *      热敏走 ESC/POS 直写、A4/针式走 Windows 打印队列），纸张随打印机自身配置；
 *   2. 只有真打不出去（无原生通道、设备离线、队列报错）才回退预览框，给磅员一次手动机会。
 *
 * 为什么非得抽出来：早先只有工作台走直打，磅单详情的「补打码单」直接开预览框，
 * 出纸交给 `window.print()`——配好的那台打印机在补打时形同虚设，票全跑去了系统默认队列。
 * 规矩只写一份，两处才不会再分叉；设备台账的解析也只该有一处实现。
 *
 * 用法：
 * ```tsx
 * const { print, preview } = useSilentReceiptPrint();
 * // 触发：await print({ scenario: "weigh_order", docNo, isReprint: true, context });
 * // 渲染：{preview}   // 兜底预览框，没发起过打印时是 null
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
   * 兜底预览框被关闭时的回调。
   * 只有"出票后还要收尾"的页面才用得上（扫码结算窗口靠它把焦点交回扫码口、清掉 URL 上的单号）；
   * 多数页面打印完就完事，不必传。
   */
  onFallbackClose?: () => void;
}

/**
 * 返回 `print`（触发直打）与 `preview`（兜底预览框节点）。
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
  /** 最近一次打印请求：直打失败要就地弹出预览框，票面数据得留在手上 */
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
      // 直打没成（浏览器演示 / 设备不可用）才交给预览框，成功就不该再弹窗挡路
      if (out === "preview") setPreviewOpen(true);
      else void qc.invalidateQueries({ queryKey: ["order", r.docNo] });
      return out;
    },
    [devices, qc],
  );

  const preview = req ? (
    <ReceiptPrintPreview
      open={previewOpen}
      onOpenChange={(v) => {
        setPreviewOpen(v);
        if (!v) req.onFallbackClose?.();
      }}
      scenario={req.scenario}
      context={req.context}
      isReprint={req.isReprint}
      docNo={req.docNo}
      onPrinted={() => void qc.invalidateQueries({ queryKey: ["order", req.docNo] })}
    />
  ) : null;

  return { print, preview };
}
