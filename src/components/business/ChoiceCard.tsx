/**
 * 卡片式单选（主题面板、窗口行为与软键盘面板共用）。
 *
 * 官方 ToggleGroup 的组合件：multiple=false 时就是单选组，方向键切换与
 * aria-pressed 语义都是现成的；整张卡即按钮本体，点标题、点说明都算选中。
 */
import type { ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "cn";

export function ChoiceCardGroup({
  value,
  onChange,
  className,
  disabled,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <ToggleGroup
      value={[value]}
      disabled={disabled}
      onValueChange={(v) => {
        // 再点已选项 Base UI 会取消按压（v 为空），单选语义下保持原值
        if (v.length) onChange(v[v.length - 1]);
      }}
      className={cn("w-full", className)}
    >
      {children}
    </ToggleGroup>
  );
}

export function ChoiceCard({
  value,
  label,
  hint,
  disabled,
  className,
}: {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <ToggleGroupItem
      value={value}
      disabled={disabled}
      className={cn(
        "group/cc relative h-auto min-w-0 shrink basis-auto flex-col items-start gap-1 rounded-none border border-input p-2.5 text-left text-sm transition-colors",
        "aria-pressed:border-primary aria-pressed:bg-primary/5 not-aria-pressed:hover:bg-accent",
        className,
      )}
    >
      <span className="flex items-center gap-1.5 font-medium pr-7">{label}</span>
      <CheckIcon
        strokeWidth={2.5}
        className="absolute right-2 top-2 hidden size-6 shrink-0 text-primary group-aria-pressed/cc:block"
      />
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </ToggleGroupItem>
  );
}
