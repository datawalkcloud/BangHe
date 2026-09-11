/**
 * 外观与主题面板（/system/appearance）。
 *
 * 布局照 shadcn 官方主题编辑器：显示模式 → 基础色板 → 主题色 → 双模式预览 → 复制 CSS / 重置。
 * 关键约定（05 §7.4）：主题是**本机显示偏好**，即时生效、存 localStorage，
 * 不写 app_setting、不留审计、不需要站长权限——所以这里没有"保存"按钮，也没有只弹 toast 的假动作。
 */
import type { CSSProperties } from "react";
import { CheckIcon, CopyIcon, MonitorIcon, MoonIcon, RotateCcwIcon, SunIcon } from "lucide-react";
import { toast } from "sonner";
import {
  ACCENT_COLOR_THEMES,
  BASE_COLOR_THEMES,
  findAccent,
  findBase,
  paletteToClipboardCss,
  resolveTokens,
  THEME_MODE_KEY,
  THEME_MODES,
  THEME_PALETTE_KEY,
  type ThemeMode,
  type ThemePalette,
} from "@/lib/theme";
import { useThemeConfig } from "@/hooks/useThemeConfig";
import { Choose } from "@/components/business/Choose";
import { ToneBadge } from "@/components/business/badges";
import { CallOut, InfoGrid, SectionTitle } from "@/components/business/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "cn";

/** 把一套令牌钉在元素上：预览块因此能各显示各的模式，不必切换全局 .dark */
function tokenVars(tokens: Record<string, string>): CSSProperties {
  return Object.fromEntries(Object.entries(tokens).map(([k, v]) => [`--${k}`, v])) as CSSProperties;
}

const MODE_ICON: Record<ThemeMode, typeof SunIcon> = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
};

function ModeCard({ value, label, hint, active, onSelect }: { value: ThemeMode; label: string; hint: string; active: boolean; onSelect: () => void }) {
  const Icon = MODE_ICON[value];
  return (
    <Label
      className={cn(
        "flex min-w-40 flex-1 cursor-pointer flex-col items-start gap-1 border p-2.5 text-sm font-normal transition-colors",
        active ? "border-primary bg-primary/5" : "border-input hover:bg-accent",
      )}
    >
      <span className="flex items-center gap-1.5">
        <input type="radio" name="theme-mode" className="sr-only" value={value} checked={active} onChange={onSelect} />
        <Icon className="size-3.5" />
        <span className="font-medium">{label}</span>
        {active && <CheckIcon className="size-3.5 text-primary" />}
      </span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </Label>
  );
}

function SwatchCard({
  name,
  preset,
  tokens,
  active,
  onSelect,
}: {
  name: string;
  preset: { key: string; zh: string; title: string };
  tokens: Record<string, string>;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <Label className="flex min-w-0 cursor-pointer flex-col gap-1 text-xs font-normal" title={`${preset.title} · ${preset.key}`}>
      <input type="radio" name={name} className="sr-only" value={preset.key} checked={active} onChange={onSelect} />
      <span
        className={cn("flex h-9 items-end gap-px border p-px", active ? "border-primary ring-1 ring-primary" : "border-input")}
        style={tokenVars(tokens)}
      >
        <span className="h-full flex-1" style={{ background: "var(--muted)" }} />
        <span className="h-4 w-3" style={{ background: "var(--secondary)", border: "1px solid var(--border)" }} />
        <span className="h-4 flex-1" style={{ background: "var(--primary)" }} />
        <span className="h-full w-3" style={{ background: "var(--ring)" }} />
      </span>
      <span className={cn("truncate", active ? "font-medium text-foreground" : "text-muted-foreground")}>{preset.zh}</span>
    </Label>
  );
}

/**
 * 双模式预览：同一套色板并排画两张微型磅单，不用切全局模式就能比较强光与夜班的观感。
 * 令牌写在容器 style 上，所以两张卡各自成立；内部组件的少数 dark: 悬停态按外层模式渲染，
 * 这点差异只在 hover 时可见，不影响选色判断。
 */
function PreviewPair({ palette }: { palette: ThemePalette }) {
  const tokens = resolveTokens(palette);
  return (
    <div className="grid min-w-0 gap-2 sm:grid-cols-2">
      {(["light", "dark"] as const).map((m) => {
        const t = tokens[m];
        return (
          <div key={m} className={cn("flex min-w-0 flex-col gap-2 border p-3", m === "dark" && "dark")} style={tokenVars(t)}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">磅禾粮站 · 过磅单</span>
              <span className="tnum shrink-0 text-xs text-muted-foreground">BD0001202609110007</span>
            </div>
            <div className="flex items-end justify-between gap-2">
              <span className="tnum text-2xl leading-none font-semibold">
                8,420.0<span className="ml-1 text-xs font-normal text-muted-foreground">kg</span>
              </span>
              <ToneBadge tone="success">已结算</ToneBadge>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="xs">确认结算并打印</Button>
              <Button size="xs" variant="outline">
                作废
              </Button>
            </div>
            <Input className="h-7 text-xs" placeholder="磅单号 / 姓名 / 证号" aria-label={`预览输入框（${m}）`} />
            <div className="flex flex-wrap gap-1">
              <ToneBadge tone="warning">皮重越差</ToneBadge>
              <ToneBadge tone="danger">拒收退粮</ToneBadge>
              <ToneBadge tone="neutral">灰阶面</ToneBadge>
            </div>
            <p className="text-[11px] text-muted-foreground">{m === "dark" ? "深色 · 夜班 / 遮阳棚内" : "浅色 · 白天强光（出厂默认）"}</p>
          </div>
        );
      })}
    </div>
  );
}

export function ThemeSettingsPanel() {
  const { mode, resolvedMode, setMode, base, accent, setBase, setAccent, reset, isDefault } = useThemeConfig();
  const palette: ThemePalette = { base, accent };
  const basePreset = findBase(base);
  const accentPreset = findAccent(accent);

  async function copyCss() {
    const css = paletteToClipboardCss(palette);
    try {
      await navigator.clipboard.writeText(css);
      toast.success("已复制主题 CSS 变量", { description: "粘进 src/App.css 可固化为出厂默认（radius 与图表语义色不在其中）" });
    } catch (e) {
      // 剪贴板被 WebView 权限挡掉时给出可选文本，不让人对着"复制失败"猜结果去哪了
      toast.error("剪贴板不可用，已改为弹出可复制文本", { description: String((e as Error).message ?? e) });
      window.prompt("以下内容可手动复制", css);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-2 border bg-card p-3">
        <SectionTitle extra={<span className="text-xs text-muted-foreground">05 §7.4：出厂默认浅色，强光下对比更稳</span>}>显示模式</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {THEME_MODES.map((m) => (
            <ModeCard key={m.value} value={m.value} label={m.label} hint={m.hint} active={mode === m.value} onSelect={() => setMode(m.value)} />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          当前实际生效 <span className="text-foreground">{resolvedMode === "dark" ? "深色" : "浅色"}</span>
          {mode === "system" ? "（跟随 Windows 的应用模式，系统改了这里立刻跟着改）" : ""}。
        </p>
      </section>

      <section className="flex flex-col gap-2 border bg-card p-3">
        <SectionTitle extra={<span className="text-xs text-muted-foreground">{BASE_COLOR_THEMES.length} 套 · 决定灰阶与对比</span>}>基础色板</SectionTitle>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
          {BASE_COLOR_THEMES.map((p) => (
            <SwatchCard
              key={p.key}
              name="theme-base"
              preset={p}
              tokens={resolveTokens({ base: p.key, accent: "default" }).light}
              active={base === p.key}
              onSelect={() => setBase(p.key)}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          基础色板换的是背景、文字、边框、卡片这一整套灰阶。磅房表格行密，灰阶选错最先糊掉的是列边界与合计行。
        </p>
      </section>

      <section className="flex flex-col gap-2 border bg-card p-3">
        <SectionTitle extra={<span className="text-xs text-muted-foreground">{ACCENT_COLOR_THEMES.length - 1} 套 · 只覆盖主色、次级面与侧栏主色</span>}>主题色</SectionTitle>
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-7 xl:grid-cols-9">
          {ACCENT_COLOR_THEMES.map((p) => (
            <SwatchCard
              key={p.key}
              name="theme-accent"
              preset={p}
              tokens={resolveTokens({ base, accent: p.key }).light}
              active={accent === p.key}
              onSelect={() => setAccent(p.key)}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Label className="flex min-w-56 flex-col gap-1 text-xs text-muted-foreground">
            同一个选项的键盘入口
            <Choose
              aria-label="主题色"
              size="sm"
              value={accent}
              onChange={setAccent}
              options={ACCENT_COLOR_THEMES.map((p) => ({ value: p.key, label: p.key === "default" ? p.zh : `${p.zh}（${p.title}）` }))}
            />
          </Label>
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            色板用眼睛挑，下拉给不用鼠标的场景（05 §10-2）；两者读写的是同一个值。
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-2 border bg-card p-3">
        <SectionTitle extra={<span className="text-xs text-muted-foreground">同一套色板并排两种模式</span>}>预览</SectionTitle>
        <PreviewPair palette={palette} />
      </section>

      <InfoGrid
        cols={4}
        items={[
          { label: "显示模式", value: THEME_MODES.find((m) => m.value === mode)?.label ?? "—" },
          { label: "基础色板", value: `${basePreset.zh}（${basePreset.title}）` },
          { label: "主题色", value: accent === "default" ? "跟随基础色板" : `${accentPreset.zh}（${accentPreset.title}）` },
          { label: "状态", value: isDefault ? <ToneBadge tone="neutral">默认主题</ToneBadge> : <ToneBadge tone="info">已自定义</ToneBadge> },
          { label: "生效范围", value: "仅本机，不写站点参数、不留审计" },
          { label: "出纸颜色", value: "强制浅色（屏幕深色不会带上纸面）" },
          {
            label: "存储键",
            value: (
              <span className="font-mono text-xs">
                {THEME_MODE_KEY} · {THEME_PALETTE_KEY}
              </span>
            ),
          },
          { label: "色板来源", value: <span className="font-mono text-xs">shadcn registry v4（脚本生成）</span> },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={reset}
          disabled={isDefault}
          title={isDefault ? "当前已是默认主题" : "回到内置默认：浅色 · Neutral · 不叠加主题色"}
        >
          <RotateCcwIcon />
          重置默认主题
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copyCss()}>
          <CopyIcon />
          复制 CSS 变量
        </Button>
        <span className="text-xs text-muted-foreground">
          {isDefault ? "未覆盖任何令牌，外观完全由 src/App.css 决定。" : "覆盖写在注入的 <style id=\"banghe-theme\">，重置即整块移除。"}
        </span>
      </div>

      <CallOut tone="info" title="三处刻意的取舍">
        <ul className="list-disc space-y-0.5 pl-4">
          <li>
            不提供圆角调节：本工程是 base-maia 直角体系，<span className="font-mono">--radius: 0</span> 固定（05 §7.2）。
          </li>
          <li>
            主题色不改图表配色：<span className="font-mono">--chart-color-1..5</span>
            是品种与等级的业务语义色，换肤不该让同一张日报表在两台机器上颜色不同。
          </li>
          <li>
            出纸强制浅色：列表页与审计页直接 Ctrl+P 会带上屏幕配色，因此打印前临时摘掉
            <span className="font-mono">.dark</span>、打完还原——纸面上永远是这套色板的浅色版。
          </li>
        </ul>
      </CallOut>
    </div>
  );
}
