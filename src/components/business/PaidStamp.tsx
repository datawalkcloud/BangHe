/**
 * 结清印记（压在卡片右下角的"盖上去的章"）。
 *
 * 钱付清之后，页面上最该被一眼看见的事实是"这单付完了"——原先只有页头那枚小徽章
 * 与金额明细里一行 0，出纳站在两米外看不出这张单和别的有什么不同，客户伸手问
 * "我这钱结清没有"时得凑到屏前读数字。所以做成一枚盖上去的印子：大字、边框、轻微倾斜。
 *
 * 结算单详情（全额付清）与磅单详情（已付清）共用这一枚，只在文案上分流：
 * 徽章词表里两处的终态词不一样，章上的字必须与本页徽章同源，不能各写一份。
 *
 * 印在纸上的老规矩是"章要压在内容上"，但这里是屏幕：绝对定位压住的是内容末行，
 * 所以父卡片在盖印时要把内容容器的下内边距放大（`pb-20`），给印子腾出不重叠的地方。
 *
 * `aria-hidden`：纯视觉强调，语义已由页头徽章与「已付 / 未付」两行承载，
 * 读屏再念一遍只是噪音；金额与付款时间仍实名印上，便于人工核对。
 */
import { dateTime, money } from "@/lib/format";

export function PaidStamp({ label, paidFen, paidAt }: { label: string; paidFen: number; paidAt: string | null }) {
  return (
    <div className="pointer-events-none absolute right-3 bottom-3 select-none text-success" aria-hidden>
      <div className="-rotate-6 border-2 border-current px-3 py-1 text-center opacity-80">
        {/* 字间距会在末字后留出同样的空隙，补一个等量左内边距才真正居中 */}
        <p className="pl-[0.2em] text-xl font-bold tracking-[0.2em]">{label}</p>
        <p className="tnum mt-0.5 text-[10px]">
          已付 {money(paidFen)}
          {paidAt ? ` · ${dateTime(paidAt)}` : ""}
        </p>
      </div>
    </div>
  );
}
