// 临时脚本：单独验证本次新增的 Tailwind 变体是否真能编译出规则（验证完即删）
import { compile } from "tailwindcss";
import fs from "node:fs";
import path from "node:path";

const root = "G:/Github/BangHe";
const twIndex = path.join(root, "node_modules/tailwindcss/index.css");

// 把项目 App.css 里的 @theme inline 关键令牌带上，否则 bg-sidebar-border 这类
// 项目自定义颜色的工具类根本不会生成（原版 rail 里就用了同名类）
const source = `
@import "tailwindcss";
@theme inline {
  --color-sidebar-border: var(--sidebar-border);
}
`;

const compiler = await compile(source, {
  base: root,
  loadStylesheet: async (id) => {
    if (id === "tailwindcss") {
      return { path: twIndex, base: root, content: fs.readFileSync(twIndex, "utf8") };
    }
    throw new Error("unexpected import: " + id);
  },
});

const candidates = [
  "transition-[width]",
  "group-data-[resizing=true]/sidebar-wrapper:transition-none!",
  "hover:after:bg-sidebar-border",
  "group-data-[resizing=true]/sidebar-wrapper:after:bg-sidebar-border",
  "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
  "in-data-[side=left]:cursor-w-resize",
  "touch-none",
];

const css = compiler.build(candidates);
// 按输出顺序抽出每条规则的选择器与声明，看谁压得住谁
const rules = css
  .split("}")
  .map((s) => s.trim())
  .filter((s) => s.includes("border") || s.includes("transition") || s.includes("cursor"));

fs.writeFileSync(
  path.join(root, "tw-verify.txt"),
  "候选类逐个检查：\n" +
    candidates
      .map((c) => {
        const key = c.replace(/[!]/g, "\\!");
        return `${css.includes(key.replace(/[[\]()/=\-]/g, (m) => "\\" + m)) ? "OK  " : "MISS"} ${c}`;
      })
      .join("\n") +
    "\n\n实际生成的规则（按输出顺序，后者覆盖前者）：\n" +
    rules.join("}\n") +
    "\n}\n"
);
