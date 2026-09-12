/**
 * 作废原因输入框 + 常用事由快捷选项（02 §F2.3）。
 *
 * 为什么给快捷选项而不是只摆一个空文本框：磅房现场一只手扶卡一只手敲字，
 * 废单来去就那么几句，让磅员每次现敲十几个字，结果就是"手滑""不要了"这种
 * 迎检看不懂的理由。点一下填的是一句完整的人话，填完仍可手改补细节。
 *
 * 服务端只认自由文本（事由 ≥6 字，见 `orders.rs::void_order`），快捷选项是
 * 常量表而不是枚举码——作废不需要授权，事由就是唯一的留痕，不能被按钮锁死。
 */
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { VOID_REASON_MIN, VOID_REASONS } from "@/lib/constants";

export function VoidReasonField({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  /** 弹窗里有两个同类字段时用来区分（无障碍标签） */
  id?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        作废原因（必填，不少于 {VOID_REASON_MIN} 字）
      </Label>
      <Textarea
        id={id}
        aria-label="作废原因"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="选一条常用的，或直接写清楚为什么废…"
        rows={3}
      />
      <div className="flex flex-wrap gap-1">
        {VOID_REASONS.map((p) => (
          <Button
            key={p.label}
            type="button"
            size="xs"
            variant={value === p.reason ? "secondary" : "outline"}
            onClick={() => onChange(p.reason)}
          >
            {p.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
