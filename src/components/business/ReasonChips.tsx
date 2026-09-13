/**
 * 事由/原因类字段的快捷选项（02 §F2.3 口径的通用版）。
 *
 * 摆在这儿的东西都不是空文本框，而是「文本框旁边那一排按钮」：文本框照旧可手改，
 * 但操作员不必敲——点一下填进去的是一句完整的人话，迎检看得懂，落库仍是自由文本。
 *
 * `value` 相等即高亮：一眼看出框里那句话是不是自己点出来的，还是已经改过了。
 */
import { Button } from "@/components/ui/button";
import { cn } from "cn";

export interface ReasonPreset {
  label: string;
  value: string;
}

export function ReasonChips({
  presets,
  value,
  onChange,
  className,
  "aria-label": ariaLabel,
}: {
  presets: readonly ReasonPreset[];
  value: string;
  onChange: (next: string) => void;
  className?: string;
  /** 一屏里出现两组同类按钮时用来区分（无障碍标签） */
  "aria-label"?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("flex flex-wrap gap-1", className)}>
      {presets.map((p) => (
        <Button
          key={p.label}
          type="button"
          size="xs"
          variant={value === p.value ? "secondary" : "outline"}
          onClick={() => onChange(p.value)}
        >
          {p.label}
        </Button>
      ))}
    </div>
  );
}
