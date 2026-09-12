/**
 * 卡片式单选（主题面板与窗口行为面板共用）。
 *
 * 为什么**不**用 shadcn 的 `RadioGroup`（与 `business/Choose.tsx` 不用 `Select` 是同一类理由）：
 * 这里要的是"整张卡可点"——`<label>` 包住全部内容，点标题、点说明都算选中。
 * `RadioGroup` 的 item 本身是 Base UI 的 button，塞进 `<label>` 后失去原生 label 激活，
 * 而 `sr-only` 的 `position:absolute` 又会和 item 自带的 `relative` 打架，换过去是净损失。
 * 于是保留一个 `sr-only` 的原生 radio：无障碍语义与键盘操作都在，视觉上则完全由外层卡片承担。
 */
import type { ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import { cn } from "cn";

export function ChoiceCard({
  name,
  value,
  label,
  hint,
  active,
  disabled,
  onSelect,
}: {
  /** 同组单选共用的 name，键盘方向键切换靠它 */
  name: string;
  value: string;
  label: ReactNode;
  hint?: ReactNode;
  active: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "flex min-w-0 flex-col gap-1 border p-2.5 text-sm transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        active ? "border-primary bg-primary/5" : "border-input",
        !disabled && !active && "hover:bg-accent",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={active}
        disabled={disabled}
        onChange={onSelect}
        className="sr-only"
      />
      <span className="flex items-center gap-1.5 font-medium">
        {label}
        {active && <CheckIcon className="size-3.5 text-primary" />}
      </span>
      {hint != null && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
