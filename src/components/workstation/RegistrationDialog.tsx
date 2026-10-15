/**
 * 「制单」弹窗（05 §4.0 / 06 §3）。
 *
 * 身份与制单不再常驻工作台——来新人点「制单」（或 F7）弹这个框：框内读身份证认人 /
 * 搜档案 / 手录证号建档 → 选品种车牌 → 取号制单 → 关框。表单体直接复用 `IdentityPanel`
 * （`order` 恒为 null 即"制单草稿态"，读卡回填 / 去向折叠 / 权限闸门全在那份里），
 * 草稿状态收在弹窗本地，不污染工作台。
 *
 * 设备互斥（06 §1.2）：弹窗开着就自己把 `regHolding` 置真，让工作台的 IC 常听让出读卡器——
 * 顶部工具条的「新建过磅单」也复用本弹窗，互斥不能再依赖父页面各自记得 pause。
 *
 * 另一个入口不是按钮而是刷卡：后台常听听到的空闲卡若没有在途单可发，会带卡号打开本框
 * （06 §4.1），卡号经 `presetCardNo` 进 `IdentityPanel`，取号那一刻与单一起绑上。
 */
import { useEffect, useState } from "react";
import type { GrainVariety, Party, StorageSlot, Warehouse } from "@/mock/types";
import { useDeviceStore } from "@/store/device";
import { IdentityPanel, emptyDraft, type OrderDraft } from "@/components/workstation/IdentityPanel";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function RegistrationDialog({
  open,
  onOpenChange,
  parties,
  varieties,
  warehouses,
  slots,
  lastVarietyId,
  cardNo = null,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  parties: Party[];
  varieties: GrainVariety[];
  warehouses: Warehouse[];
  slots: StorageSlot[];
  /** 沿用上张单的品种做默认值（磅房最省手，05 §4 ①） */
  lastVarietyId: number | null;
  /**
   * 已经贴在感应区上的那张卡：后台刷卡编排器发现"没有等发卡的在途单"时把它交下来，
   * 随本单一起绑上——人不用把卡收走再刷一次。没刷卡开窗时为 null，框内照常按需刷。
   */
  cardNo?: string | null;
  onCreated: (orderNo: string) => void;
}) {
  const [draft, setDraft] = useState<OrderDraft>(() => emptyDraft(lastVarietyId));
  const patch = (p: Partial<OrderDraft>) => setDraft((d) => ({ ...d, ...p }));
  const setRegHolding = useDeviceStore((s) => s.setRegHolding);

  // 关框即重置草稿，避免"这张单制完忘了清、下一张带着上一张的品种/车牌"
  const close = () => {
    setRegHolding(false);
    setDraft(emptyDraft(lastVarietyId));
    onOpenChange(false);
  };

  // 兜底：父页面直接把 open 置真（不经过 onOpenChange）时也占住设备；卸载/关框时归还
  useEffect(() => {
    if (open) setRegHolding(true);
    return () => setRegHolding(false);
  }, [open, setRegHolding]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          close();
          return;
        }
        // 同步置位互斥标记，不等 effect 跑完才让出设备
        setRegHolding(true);
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[88vh] max-w-[560px] gap-0 overflow-y-auto p-0">
        <DialogHeader className="border-b px-4 py-2.5">
          <DialogTitle className="text-sm font-semibold">制单 · 身份与登记</DialogTitle>
        </DialogHeader>
        <div className="p-3">
          <IdentityPanel
            order={null}
            draft={draft}
            onDraft={patch}
            presetCardNo={cardNo}
            parties={parties}
            varieties={varieties}
            warehouses={warehouses}
            slots={slots}
            onCreated={(no) => {
              onCreated(no);
              close();
            }}
            onNewOrder={() => setDraft(emptyDraft(lastVarietyId))}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
