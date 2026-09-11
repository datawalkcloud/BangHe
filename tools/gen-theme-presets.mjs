/**
 * 生成 src/lib/theme-presets.ts —— 把 shadcn 官方主题令牌表落到本地仓库。
 *
 * 为什么要有这个脚本：磅房机没有外网（01 §部署约束），主题色板必须在构建期就进包；
 * 但色板值本身不属于我们，手抄一份 oklch 数字迟早会和上游分叉。所以数据只允许由本脚本
 * 从官方源生成，人在界面里只改中文标签，不改数值。
 *
 * 用法：
 *   node tools/gen-theme-presets.mjs                 # 联网取官方 themes.ts 后重写
 *   node tools/gen-theme-presets.mjs --from <file>   # 用已下载的 themes.ts 离线重跑
 *
 * 上游：shadcn-ui/ui 仓库 apps/v4/registry/themes.ts（registry:theme 条目）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/themes.ts";
/** 前 7 条是"基础色板"（决定灰阶表面），其余是叠加在基础色板上的"主题色" */
const BASE_ORDER = ["neutral", "stone", "zinc", "mauve", "olive", "mist", "taupe"];

/** 中文名只影响展示，不改上游数值；官方 title 一并保留，便于和 shadcn 文档对照 */
const LABELS = {
  neutral: "中性灰",
  stone: "石材灰",
  zinc: "锌灰",
  mauve: "藕紫灰",
  olive: "橄榄灰",
  mist: "雾灰",
  taupe: "驼褐灰",
  amber: "琥珀",
  blue: "湛蓝",
  cyan: "青",
  emerald: "祖母绿",
  fuchsia: "品红",
  green: "草绿",
  indigo: "靛蓝",
  lime: "青柠",
  orange: "橙",
  pink: "粉",
  purple: "紫",
  red: "正红",
  rose: "玫红",
  sky: "天蓝",
  teal: "蓝绿",
  violet: "紫罗兰",
  yellow: "明黄",
};

const outPath = fileURLToPath(new URL("../src/lib/theme-presets.ts", import.meta.url));

async function loadSource() {
  const fromIdx = process.argv.indexOf("--from");
  if (fromIdx >= 0) return readFileSync(process.argv[fromIdx + 1], "utf8");
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`拉取失败 ${res.status} ${SOURCE_URL}`);
  return res.text();
}

/** 逐条切出 { name, title, cssVars:{ light:{...}, dark:{...} } }，只依赖官方文件的缩进风格 */
function parse(text) {
  const themes = [];
  for (const block of text.split(/\n  \{\n/).slice(1)) {
    const name = /^\s*name: "([^"]+)"/m.exec(block)?.[1];
    const title = /^\s*title: "([^"]+)"/m.exec(block)?.[1];
    const vars = /cssVars: \{([\s\S]*?)\n {4}\}/m.exec(block)?.[1];
    if (!name || !vars) continue;
    const modes = {};
    for (const [, mode, body] of vars.matchAll(/(light|dark): \{([\s\S]*?)\n {6}\}/g)) {
      const tokens = {};
      // 官方表里只有含连字符的键带引号（"card-foreground"），单词键不带（background），
      // 引号写成可选，否则 background/primary/border 这些最关键的令牌会被整批丢掉
      for (const [, key, value] of body.matchAll(/"?([a-z0-9-]+)"?: "([^"]*)"/g)) tokens[key] = value;
      modes[mode] = tokens;
    }
    themes.push({ name, title: title ?? name, modes });
  }
  return themes;
}

function render(group, entries) {
  const lines = [];
  for (const t of entries) {
    const emit = (mode) =>
      Object.entries(t.modes[mode] ?? {})
        .map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
        .join("\n");
    lines.push(
      `  {\n    key: ${JSON.stringify(t.name)},\n    zh: ${JSON.stringify(LABELS[t.name] ?? t.title)},\n    title: ${JSON.stringify(t.title)},\n` +
        `    light: {\n${emit("light")}\n    },\n` +
        `    dark: {\n${emit("dark")}\n    },\n  },`,
    );
  }
  return `export const ${group}: ThemePreset[] = [\n${lines.join("\n")}\n];`;
}

const text = await loadSource();
const themes = parse(text);
if (themes.length < 20) throw new Error(`解析到的主题条数异常：${themes.length}`);
/**
 * 上游哪天改写法（比如令牌换成嵌套结构），正则就可能静默丢掉一半令牌，生成出一套
 * "背景色没定义"的残缺色板——那种错要到磅房屏幕上才看得见。宁可生成失败，不出半成品。
 */
const REQUIRED_TOKENS = ["background", "foreground", "card", "primary", "primary-foreground", "border", "ring", "sidebar"];
for (const t of themes) {
  if (!BASE_ORDER.includes(t.name)) continue;
  const miss = REQUIRED_TOKENS.filter((k) => !t.modes.light?.[k]);
  if (miss.length) throw new Error(`基础色板 ${t.name} 缺令牌：${miss.join(", ")}（大概率是上游格式变了，需要改正则）`);
}
const bases = BASE_ORDER.map((n) => themes.find((t) => t.name === n) ?? (() => { throw new Error(`官方表里找不到基础色 ${n}`); })());
const accents = themes.filter((t) => !BASE_ORDER.includes(t.name));
const missing = Object.keys(LABELS).filter((k) => !themes.some((t) => t.name === k));
if (missing.length) console.warn("提示：以下中文名没有对应官方主题，已忽略：", missing.join(", "));

writeFileSync(
  outPath,
  `/**\n` +
    ` * shadcn 官方主题令牌表（vendored）。\n` +
    ` *\n` +
    ` * 由 tools/gen-theme-presets.mjs 生成，来源 ${SOURCE_URL}\n` +
    ` * ——数值请勿手改，要换配色就重跑脚本；中文 zh 是本工程自己的叫法。\n` +
    ` *\n` +
    ` * 结构与 shadcn 官方主题编辑器一致：基础色板给出全套灰阶令牌，主题色只是叠加层\n` +
    ` * （覆盖 primary / secondary / chart / sidebar-primary 等少数令牌）。\n` +
    ` * radius 一并照抄为完整镜像，但应用阶段由 src/lib/theme.ts 忽略：本工程 --radius 固定 0（05 §7.2）。\n` +
    ` */\n\n` +
    `export interface ThemeTokens {\n  [token: string]: string;\n}\n\n` +
    `export interface ThemePreset {\n` +
    `  /** 官方主题标识，与 shadcn 文档对照用，也是存进 localStorage 的值 */\n  key: string;\n` +
    `  /** 官方英文名 */\n  title: string;\n` +
    `  /** 界面展示名（中文） */\n  zh: string;\n` +
    `  light: ThemeTokens;\n  dark: ThemeTokens;\n}\n\n` +
    `${render("BASE_THEMES", bases)}\n\n${render("ACCENT_THEMES", accents)}\n`,
  "utf8",
);
console.log(`已写入 ${outPath}\n基础色板 ${bases.length} 套 / 主题色 ${accents.length} 套`);

/**
 * 守卫：内置默认（neutral）必须与 src/App.css 的 :root / .dark 逐令牌相等。
 * 一旦上游把这些值改了而我们的 App.css 没跟着改，"重置默认主题"就会把界面换成另一副样子，
 * 而这种差别只有肉眼能发现——所以放在生成阶段直接拦下。radius 不参与比对（应用阶段被忽略）。
 */
const cssPath = fileURLToPath(new URL("../src/App.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");
const readBlock = (re, what) => {
  const m = css.match(re);
  if (!m) throw new Error(`App.css 结构变了（找不到${what}），需要同步改这个校验`);
  return Object.fromEntries([...m[1].matchAll(/--([a-z0-9-]+): ([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
};
const cssBlocks = [
  ["light", readBlock(/\n:root \{([\s\S]*?)\n\}/, ":root 块")],
  ["dark", readBlock(/\n\.dark \{([\s\S]*?)\n\}/, ".dark 块")],
];
const drift = [];
for (const [mode, actual] of cssBlocks) {
  const want = bases[0].modes[mode];
  for (const [token, v] of Object.entries(actual)) {
    if (token === "radius") continue;
    if (want[token] !== v) drift.push(`${mode} --${token}：App.css=${v}，官方表=${want[token] ?? "（无此令牌）"}`);
  }
  for (const token of Object.keys(want)) {
    if (token === "radius") continue;
    if (!(token in actual)) drift.push(`${mode} --${token}：官方表有、App.css 没有`);
  }
}
if (drift.length) throw new Error(`默认主题漂移，重置后界面会变样：\n${drift.join("\n")}`);
console.log("默认主题校验：neutral 与 src/App.css 逐令牌一致 ✓");
