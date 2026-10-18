/** 外观设置：保留业务系统的分区布局，并提供主题生成器支持的配置。 */
import type { CSSProperties } from "react";
import { RotateCcwIcon } from "lucide-react";
import { ACCENT_COLOR_THEMES, BASE_COLOR_THEMES, MENU_STYLES, RADIUS_STYLES, THEME_STYLES, resolveAppearanceVars, resolveTokens, type ThemePalette } from "@/lib/theme";
import { useThemeConfig } from "@/hooks/useThemeConfig";
import { ChoiceCard, ChoiceCardGroup } from "@/components/business/ChoiceCard";
import { ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "cn";

function tokenVars(tokens: Record<string, string>): CSSProperties {
  return Object.fromEntries(Object.entries(tokens).map(([key, value]) => [`--${key}`, value])) as CSSProperties;
}

function SwatchCard({ preset, tokens }: { preset: { key: string; zh: string; title: string }; tokens: Record<string, string> }) {
  return (
    <ToggleGroupItem
      value={preset.key}
      title={preset.zh}
      className="group/sw h-auto min-w-0 shrink basis-auto flex-col items-start gap-1 rounded-none border-0 bg-transparent p-0 text-left text-xs shadow-none hover:bg-transparent"
    >
      <span
        className="flex h-10 w-full items-center gap-1.5 border border-input p-1.5 group-data-[state=on]/sw:border-primary group-data-[state=on]/sw:ring-1 group-data-[state=on]/sw:ring-primary"
        style={tokenVars(tokens)}
      >
        <span className="size-6 shrink-0 rounded-full ring-1 ring-black/15" style={{ background: "var(--primary)" }} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="h-2.5 w-full" style={{ background: "var(--primary)" }} />
          <span className="flex gap-1">
            <span className="h-2 flex-1 border" style={{ background: "var(--secondary)", borderColor: "var(--border)" }} />
            <span className="h-2 w-3" style={{ background: "var(--ring)" }} />
          </span>
        </span>
      </span>
      <span className="truncate text-muted-foreground group-data-[state=on]/sw:font-medium group-data-[state=on]/sw:text-foreground">{preset.zh}</span>
    </ToggleGroupItem>
  );
}

function ChartSwatchCard({ preset, tokens }: { preset: { key: string; zh: string; title: string }; tokens: Record<string, string> }) {
  const chartTokens = preset.key === "default" ? {} : Object.fromEntries([1, 2, 3, 4, 5].map((index) => [`chart-color-${index}`, tokens[`chart-${index}`]]));
  return (
    <ToggleGroupItem
      value={preset.key}
      title={preset.zh}
      className="group/sw h-auto min-w-0 shrink basis-auto flex-col items-start gap-1 rounded-none border-0 bg-transparent p-0 text-left text-xs shadow-none hover:bg-transparent"
    >
      <span
        className="flex h-10 w-full items-end gap-1 border border-input p-1.5 group-data-[state=on]/sw:border-primary group-data-[state=on]/sw:ring-1 group-data-[state=on]/sw:ring-primary"
        style={{ ...tokenVars(tokens), ...tokenVars(chartTokens) }}
      >
        {[1, 2, 3, 4, 5].map((index) => <span key={index} className="min-w-0 flex-1" style={{ height: `${30 + index * 12}%`, background: `var(--chart-color-${index})` }} />)}
      </span>
      <span className="truncate text-muted-foreground group-data-[state=on]/sw:font-medium group-data-[state=on]/sw:text-foreground">{preset.zh}</span>
    </ToggleGroupItem>
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
            <div className="rounded-lg border bg-muted/40 p-1.5"><p className="text-[10px] text-muted-foreground">毛重</p><p className="tnum text-xs font-medium">12,560 kg</p></div>
            <div className="rounded-lg border bg-muted/40 p-1.5"><p className="text-[10px] text-muted-foreground">皮重</p><p className="tnum text-xs font-medium">4,140 kg</p></div>
            <div className="rounded-lg border bg-primary/5 p-1.5"><p className="text-[10px] text-muted-foreground">净重</p><p className="tnum text-xs font-medium">8,420 kg</p></div>
          </div>
          <div className="overflow-hidden rounded-lg border">
            <div className="grid grid-cols-[1fr_auto_auto] gap-2 border-b bg-muted/50 px-2 py-1 text-[10px] text-muted-foreground"><span>品种 / 等级</span><span>单价</span><span>状态</span></div>
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 px-2 py-1.5 text-[11px]"><span>小麦 · 二等</span><span className="tnum">2.65</span><ToneBadge tone="success">合格</ToneBadge></div>
          </div>
          <div className="rounded-lg border p-2">
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
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">组件风格</CardTitle>
        </CardHeader>
        <CardContent>
          <ChoiceCardGroup className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" value={style} onChange={(v) => setStyle(v as typeof style)}>
            {THEME_STYLES.map((item) => <ChoiceCard key={item.value} value={item.value} label={item.label} hint="组件表面与描边" />)}
          </ChoiceCardGroup>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">基础色板</CardTitle>
          <CardAction><span className="text-xs text-muted-foreground">决定灰阶与对比</span></CardAction>
        </CardHeader>
        <CardContent>
          <ChoiceCardGroup className="grid grid-cols-4 gap-2 sm:grid-cols-7" value={base} onChange={(v) => setBase(v as typeof base)}>
            {BASE_COLOR_THEMES.map((preset) => <SwatchCard key={preset.key} preset={preset} tokens={resolveTokens({ ...palette, base: preset.key, accent: "default" }).light} />)}
          </ChoiceCardGroup>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">主题色</CardTitle>
          <CardAction><span className="text-xs text-muted-foreground">主色、次级面与侧栏主色</span></CardAction>
        </CardHeader>
        <CardContent>
          <ChoiceCardGroup className="grid grid-cols-5 gap-2 sm:grid-cols-7 xl:grid-cols-9" value={accent} onChange={(v) => setAccent(v as typeof accent)}>
            {ACCENT_COLOR_THEMES.map((preset) => <SwatchCard key={preset.key} preset={preset} tokens={resolveTokens({ ...palette, accent: preset.key }).light} />)}
          </ChoiceCardGroup>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">图表色</CardTitle>
          <CardAction><span className="text-xs text-muted-foreground">只影响图表，不改变状态语义</span></CardAction>
        </CardHeader>
        <CardContent>
          <ChoiceCardGroup className="grid grid-cols-5 gap-2 sm:grid-cols-7 xl:grid-cols-9" value={chart} onChange={(v) => setChart(v as typeof chart)}>
            {ACCENT_COLOR_THEMES.map((preset) => <ChartSwatchCard key={preset.key} preset={preset} tokens={resolveTokens({ ...palette, accent: preset.key }).light} />)}
          </ChoiceCardGroup>
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">圆角</CardTitle>
          </CardHeader>
          <CardContent>
            <ChoiceCardGroup className="grid grid-cols-5 gap-2" value={radius} onChange={(v) => setRadius(v as typeof radius)}>
              {RADIUS_STYLES.map((item) => <ChoiceCard key={item.value} value={item.value} label={item.label} />)}
            </ChoiceCardGroup>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">菜单</CardTitle>
          </CardHeader>
          <CardContent>
            <ChoiceCardGroup className="grid grid-cols-2 gap-2" value={menu} onChange={(v) => setMenu(v as typeof menu)}>
              {MENU_STYLES.map((item) => <ChoiceCard key={item.value} value={item.value} label={item.label} hint="侧栏选中项样式" />)}
            </ChoiceCardGroup>
          </CardContent>
        </Card>
      </div>

      </div>

      <aside className="sticky top-0 z-10 flex min-w-0 flex-col gap-3 xl:max-h-[calc(100svh-2rem)] xl:overflow-y-auto">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">预览</CardTitle>
            <CardAction><span className="text-xs text-muted-foreground">即时更新</span></CardAction>
          </CardHeader>
          <CardContent>
            <PreviewPair palette={palette} />
          </CardContent>
        </Card>
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