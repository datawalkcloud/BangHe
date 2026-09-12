/** 外观设置：保留业务系统的分区布局，并提供主题生成器支持的配置。 */
import type { CSSProperties } from "react";
import { RotateCcwIcon } from "lucide-react";
import { ACCENT_COLOR_THEMES, BASE_COLOR_THEMES, MENU_STYLES, RADIUS_STYLES, THEME_STYLES, resolveAppearanceVars, resolveTokens, type ThemePalette } from "@/lib/theme";
import { useThemeConfig } from "@/hooks/useThemeConfig";
import { SectionTitle } from "@/components/business/layout";
import { ChoiceCard } from "@/components/business/ChoiceCard";
import { ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "cn";

function tokenVars(tokens: Record<string, string>): CSSProperties {
  return Object.fromEntries(Object.entries(tokens).map(([key, value]) => [`--${key}`, value])) as CSSProperties;
}

function SwatchCard({ name, preset, tokens, active, onSelect }: { name: string; preset: { key: string; zh: string; title: string }; tokens: Record<string, string>; active: boolean; onSelect: () => void }) {
  return (
    <label className="flex min-w-0 cursor-pointer flex-col gap-1 text-xs" title={`${preset.title} · ${preset.key}`}>
      <input type="radio" name={name} value={preset.key} checked={active} onChange={onSelect} className="sr-only" />
      <span className={cn("flex h-10 items-center gap-1.5 border p-1.5", active ? "border-primary ring-1 ring-primary" : "border-input")} style={tokenVars(tokens)}>
        <span className="size-6 shrink-0 rounded-full ring-1 ring-black/15" style={{ background: "var(--primary)" }} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="h-2.5 w-full" style={{ background: "var(--primary)" }} />
          <span className="flex gap-1">
            <span className="h-2 flex-1 border" style={{ background: "var(--secondary)", borderColor: "var(--border)" }} />
            <span className="h-2 w-3" style={{ background: "var(--ring)" }} />
          </span>
        </span>
      </span>
      <span className={cn("truncate", active ? "font-medium text-foreground" : "text-muted-foreground")}>{preset.zh}</span>
    </label>
  );
}

function ChartSwatchCard({ preset, tokens, active, onSelect }: { preset: { key: string; zh: string; title: string }; tokens: Record<string, string>; active: boolean; onSelect: () => void }) {
  const chartTokens = preset.key === "default" ? {} : Object.fromEntries([1, 2, 3, 4, 5].map((index) => [`chart-color-${index}`, tokens[`chart-${index}`]]));
  return (
    <label className="flex min-w-0 cursor-pointer flex-col gap-1 text-xs" title={`${preset.title} · ${preset.key}`}>
      <input type="radio" name="theme-chart" value={preset.key} checked={active} onChange={onSelect} className="sr-only" />
      <span className={cn("flex h-10 items-end gap-1 border p-1.5", active ? "border-primary ring-1 ring-primary" : "border-input")} style={{ ...tokenVars(tokens), ...tokenVars(chartTokens) }}>
        {[1, 2, 3, 4, 5].map((index) => <span key={index} className="min-w-0 flex-1" style={{ height: `${30 + index * 12}%`, background: `var(--chart-color-${index})` }} />)}
      </span>
      <span className={cn("truncate", active ? "font-medium text-foreground" : "text-muted-foreground")}>{preset.zh}</span>
    </label>
  );
}

function PreviewPair({ palette }: { palette: ThemePalette }) {
  const tokens = resolveTokens(palette);
  const appearance = resolveAppearanceVars(palette);
  const chartPalette = resolveTokens({ ...palette, accent: palette.chart });
  return (
    <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {(["light", "dark"] as const).map((mode) => {
        const chartTokens = palette.chart === "default" ? {} : Object.fromEntries([1, 2, 3, 4, 5].map((index) => [`chart-color-${index}`, chartPalette[mode][`chart-${index}`]]));
        return (
        <div key={mode} className={cn("flex min-w-0 w-full flex-col gap-2 border bg-background p-3 text-foreground", mode === "dark" && "dark")} style={{ ...tokenVars(tokens[mode]), ...tokenVars(appearance), ...tokenVars(chartTokens) }}>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">磅禾粮站 · 过磅单</span>
            <span className="text-xs text-muted-foreground">BD0001202609110007</span>
          </div>
          <div className="flex items-end justify-between gap-2">
            <span className="tnum text-2xl font-semibold">8,420.0 <span className="text-xs font-normal text-muted-foreground">kg</span></span>
            <ToneBadge tone="success">已结算</ToneBadge>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="xs">确认结算</Button>
            <Button size="xs" variant="outline">作废</Button>
            <Button size="xs" variant="ghost">更多</Button>
          </div>
          <Input className="h-7 text-xs" placeholder="磅单号 / 姓名 / 证号" aria-label={`${mode === "dark" ? "深色" : "浅色"}主题预览输入框`} />
          <div className="grid grid-cols-3 gap-1.5">
            <div className="border bg-muted/40 p-1.5"><p className="text-[10px] text-muted-foreground">毛重</p><p className="tnum text-xs font-medium">12,560 kg</p></div>
            <div className="border bg-muted/40 p-1.5"><p className="text-[10px] text-muted-foreground">皮重</p><p className="tnum text-xs font-medium">4,140 kg</p></div>
            <div className="border bg-primary/5 p-1.5"><p className="text-[10px] text-muted-foreground">净重</p><p className="tnum text-xs font-medium">8,420 kg</p></div>
          </div>
          <div className="overflow-hidden border">
            <div className="grid grid-cols-[1fr_auto_auto] gap-2 border-b bg-muted/50 px-2 py-1 text-[10px] text-muted-foreground"><span>品种 / 等级</span><span>单价</span><span>状态</span></div>
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 px-2 py-1.5 text-[11px]"><span>小麦 · 二等</span><span className="tnum">2.65</span><ToneBadge tone="success">合格</ToneBadge></div>
          </div>
          <div className="border p-2">
            <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground"><span>近 5 日收粮量</span><span>吨</span></div>
            <div className="flex h-10 items-end gap-1">
              {[52, 76, 44, 90, 66].map((height, index) => <span key={height} className="min-w-0 flex-1" style={{ height: `${height}%`, background: `var(--chart-color-${index + 1})` }} />)}
            </div>
          </div>
          <div className="flex flex-wrap gap-1"><ToneBadge tone="warning">水分偏高</ToneBadge><ToneBadge tone="info">待打印</ToneBadge><ToneBadge tone="neutral">已留档</ToneBadge></div>
          <p className="text-[11px] text-muted-foreground">{mode === "dark" ? "深色预览" : "浅色预览"}</p>
        </div>
        );
      })}
    </div>
  );
}

export function ThemeSettingsPanel() {
  const { base, accent, setBase, setAccent, style, setStyle, radius, setRadius, chart, setChart, menu, setMenu, reset, isDefault } = useThemeConfig();
  const palette: ThemePalette = { base, accent, style, radius, chart, menu };

  return (
    <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(26rem,0.8fr)]">
      <div className="flex min-w-0 flex-col gap-3">
      <section className="flex flex-col gap-2 border bg-card p-3">
        <SectionTitle>组件风格</SectionTitle>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {THEME_STYLES.map((item) => <ChoiceCard key={item.value} name="theme-style" value={item.value} label={item.label} hint="组件表面与描边" active={style === item.value} onSelect={() => setStyle(item.value)} />)}
        </div>
      </section>

      <section className="flex flex-col gap-2 border bg-card p-3">
        <SectionTitle extra={<span className="text-xs text-muted-foreground">决定灰阶与对比</span>}>基础色板</SectionTitle>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
          {BASE_COLOR_THEMES.map((preset) => <SwatchCard key={preset.key} name="theme-base" preset={preset} tokens={resolveTokens({ ...palette, base: preset.key, accent: "default" }).light} active={base === preset.key} onSelect={() => setBase(preset.key)} />)}
        </div>
      </section>

      <section className="flex flex-col gap-2 border bg-card p-3">
        <SectionTitle extra={<span className="text-xs text-muted-foreground">主色、次级面与侧栏主色</span>}>主题色</SectionTitle>
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-7 xl:grid-cols-9">
          {ACCENT_COLOR_THEMES.map((preset) => <SwatchCard key={preset.key} name="theme-accent" preset={preset} tokens={resolveTokens({ ...palette, accent: preset.key }).light} active={accent === preset.key} onSelect={() => setAccent(preset.key)} />)}
        </div>
      </section>

      <section className="flex flex-col gap-2 border bg-card p-3">
        <SectionTitle extra={<span className="text-xs text-muted-foreground">只影响图表，不改变状态语义</span>}>图表色</SectionTitle>
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-7 xl:grid-cols-9">
          {ACCENT_COLOR_THEMES.map((preset) => <ChartSwatchCard key={preset.key} preset={preset} tokens={resolveTokens({ ...palette, accent: preset.key }).light} active={chart === preset.key} onSelect={() => setChart(preset.key)} />)}
        </div>
      </section>

      <section className="grid gap-3 border bg-card p-3 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <SectionTitle>圆角</SectionTitle>
          <div className="grid grid-cols-5 gap-2">
            {RADIUS_STYLES.map((item) => <ChoiceCard key={item.value} name="theme-radius" value={item.value} label={item.label} hint="" active={radius === item.value} onSelect={() => setRadius(item.value)} />)}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <SectionTitle>菜单</SectionTitle>
          <div className="grid grid-cols-2 gap-2">
            {MENU_STYLES.map((item) => <ChoiceCard key={item.value} name="theme-menu" value={item.value} label={item.label} hint="侧栏选中项样式" active={menu === item.value} onSelect={() => setMenu(item.value)} />)}
          </div>
        </div>
      </section>

      </div>

      <aside className="sticky top-0 z-10 flex min-w-0 flex-col gap-3 xl:max-h-[calc(100svh-2rem)] xl:overflow-y-auto">
        <section className="flex flex-col gap-2 border bg-card p-3">
          <SectionTitle extra={<span className="text-xs text-muted-foreground">随设置即时更新</span>}>预览</SectionTitle>
          <PreviewPair palette={palette} />
        </section>
        <div className="flex flex-wrap items-center gap-2 bg-background/95 py-1 backdrop-blur-sm">
          <Button size="sm" variant="outline" onClick={reset} disabled={isDefault} title={isDefault ? "当前已是默认外观" : "恢复出厂默认外观"}>
            <RotateCcwIcon />
            恢复默认
          </Button>
          <span className="text-xs text-muted-foreground">{isDefault ? "当前已是默认外观。" : "恢复默认会还原全部外观设置。"}</span>
        </div>
      </aside>
    </div>
  );
}