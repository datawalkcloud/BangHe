/**
 * 作废原因输入框 + 常用事由快捷选项（02 §F2.3）。
 *
 * 为什么给快捷选项而不是只摆一个空文本框：磅房现场一只手扶卡一只手敲字，
 * 废单来去就那么几句，让磅员每次现敲十几个字，结果就是"手滑""不要了"这种
 * 迎检看不懂的理由。点一下填的是一句完整的人话，填完仍可手改补细节。
 *
 * 服务端只认自由文本（事由 ≥6 字，见 `orders.rs::void_order`），下拉候选是站长在
 * 「基础档案 › 常用语/快捷选项」里维护的一份可选话术而不是枚举码——作废不需要授权，
 * 事由就是唯一的留痕，不能被按钮锁死。
 */
import { Label } from "@/components/ui/label";
import { ComboBox } from "@/components/business/ComboBox";
import { useQuickOptions } from "@/hooks/useLookups";
import { VOID_REASON_MIN } from "@/lib/constants";

export function VoidReasonField({
  value,
  onChange,
  id,
  invalid,
  error,
}: {
  value: string;
  onChange: (next: string) => void;
  /** 弹窗里有两个同类字段时用来区分（无障碍标签） */
  id?: string;
  /** 校验不通过：文本框红框（错误文案由调用方给，直接挂在字段上） */
  invalid?: boolean;
  error?: string;
}) {
  const { options } = useQuickOptions("void");
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        作废原因（必填，不少于 {VOID_REASON_MIN} 字）
      </Label>
      <ComboBox
        multiline
        id={id}
        rows={3}
        aria-label="作废原因"
        presets={options}
        value={value}
        onChange={onChange}
        invalid={invalid}
        placeholder="选一条常用的，或直接写清楚为什么废…"
      />
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
