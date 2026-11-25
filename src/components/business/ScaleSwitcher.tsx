/**
 * 「切换当前地磅」（03 §9.12）。一站两磅的站点靠它切：切的是台账里 scale 类的「当前磅」，
 * 读数归属（`weigh_record.device_id`）与整量化跟着一起走，所以**必须**从这里切，而不是只把
 * 屏幕上的数换一台——两处各切一份就会出现"屏幕是 2 号磅、库里记 1 号磅"。
 *
 * 抽出来是因为它有三处同样的宿主：磅房工作台③称重区、出库称重区，以及出库模式
 * **还没选出库单**那一格——车开上哪台秤是磅员在看单之前就要定的事，切磅不该等到点中一张单。
 * 只有一台时整格不渲染，界面与从前逐字一致。
 */
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { DeviceConfig } from "@/mock/types";

export function ScaleSwitcher({
  scales,
  liveCode,
  onSelect,
  switching = false,
}: {
  /** 台账里启用的真磅（`kind='scale' && is_enabled=1 && is_mock=0`）；不足两台时不渲染 */
  scales: DeviceConfig[];
  /** 读数帧里的 code：读数此刻真正属于哪台磅，比台账的 default 更近事实；未取到帧时为 null */
  liveCode?: string | null;
  onSelect?: (code: string) => void;
  switching?: boolean;
}) {
  if (scales.length <= 1) return null;
  /**
   * 读数归属以帧里的 `code` 为准（"读数是从哪条串口来的"只有后端知道），还没收到帧时退回台账当前磅。
   * 下拉显示的是**真正的读数来源**，不是刚点过的那一项——切到一台打不开的磅时，这里仍是原来那台
   * 并且状态跟着变"离线"，而不是假装已经切过去了。
   */
  const current = scales.find((d) => d.code === liveCode) ?? scales.find((d) => d.is_default === 1) ?? null;
  return (
    <Select
      value={current?.code}
      items={scales.map((d) => ({ value: d.code, label: d.name }))}
      onValueChange={(v) => {
        if (v && v !== current?.code) onSelect?.(v);
      }}
      disabled={switching}
    >
      <SelectTrigger
        size="sm"
        className="h-6 w-auto gap-1 rounded-md border-dashed px-1.5 py-0 text-xs font-medium text-foreground"
        aria-label="切换当前地磅"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {scales.map((d) => (
          <SelectItem key={d.code} value={d.code}>
            {d.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
