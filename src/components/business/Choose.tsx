/**
 * 下拉选择的统一入口：官方 shadcn Select（Base UI）的组合件。
 */
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "cn";

export interface Option<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export function Choose<T extends string>({
  value,
  onChange,
  options,
  groups,
  className,
  size = "default",
  disabled,
  invalid,
  "aria-label": ariaLabel,
  id,
}: {
  value: T;
  onChange: (v: T) => void;
  options?: readonly Option<T>[];
  groups?: readonly { label: string; options: readonly Option<T>[] }[];
  className?: string;
  size?: "sm" | "default";
  disabled?: boolean;
  /** 校验不通过：红框标在触发器上（SelectTrigger 自带 aria-invalid 样式） */
  invalid?: boolean;
  "aria-label"?: string;
  id?: string;
}) {
  const items = [...(options ?? []), ...(groups?.flatMap((g) => g.options) ?? [])].map((o) => ({
    value: o.value as string,
    label: o.label,
  }));
  return (
    <Select
      value={value}
      items={items}
      disabled={disabled}
      onValueChange={(v) => {
        if (v != null) onChange(v as T);
      }}
    >
      <SelectTrigger
        id={id}
        size={size}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        className={cn("w-full", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options?.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
        {groups?.map((g) => (
          <SelectGroup key={g.label}>
            <SelectLabel>{g.label}</SelectLabel>
            {g.options.map((o) => (
              <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 状态类下拉的常用值 */
export const ALL = "__all__";
