/**
 * 下拉选择的统一入口。
 *
 * 刻意用 NativeSelect（原生 select）而不是 shadcn Select：
 * 磅房要求"不用鼠标也能开单"，原生下拉可被键盘/小键盘直接录入，
 * 且不会在 Tauri WebView 里产生浮层焦点逃逸问题。
 */
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select";

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
  "aria-label"?: string;
  id?: string;
}) {
  return (
    <NativeSelect
      id={id}
      size={size}
      aria-label={ariaLabel}
      className={className}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options?.map((o) => (
        <NativeSelectOption key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </NativeSelectOption>
      ))}
      {groups?.map((g) => (
        <NativeSelectOptGroup key={g.label} label={g.label}>
          {g.options.map((o) => (
            <NativeSelectOption key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
      ))}
    </NativeSelect>
  );
}

/** 状态类下拉的常用值 */
export const ALL = "__all__";
