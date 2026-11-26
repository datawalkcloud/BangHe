/**
 * 「当前这份草稿是哪套预设」的判定：按版式内容比，不按对象身份比。
 *
 * 打印模板编辑器顶部那个「载入版式预设」下拉要显示选中的那一份，而载入这个动作只是把预设
 * 覆盖进草稿——草稿之后还会被继续编辑。用"上次点了什么"当选中值会出两个错：点完控件立刻
 * 看不出选了谁（现场只当没点上），以及改过一笔之后控件还挂着那个预设名，而纸上已经不是它了。
 *
 * 所以这里给内容算一个指纹，谁撞上算谁。单独成模块是为了让自检脚本能直接断言它
 * （`scripts/receipt-code/check.ts` 的 S 段），不必把编辑器整棵 React 树拖进 node。
 */
import type { ReceiptTemplate } from "./types";

/** 「是不是同一套版式」不参与比较的键：随机区块 id、存盘时刻、模板名 */
const SKIP = new Set(["id", "updatedAt", "name"]);

/**
 * 版式指纹：递归排掉 `SKIP` 里的键。
 *
 * 预设每次都是现生成的（区块 id 走 `uid()`），草稿里那份同理，整份 JSON 一比永远不等。
 * 名字也不比：载入「收购磅单（系统单据）」后草稿的名字跟着变成它，但接着改名，版式还是那一套——
 * 名字是标签，不是版式。
 */
export function fingerprint(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(fingerprint).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !SKIP.has(k))
      .map(([k, x]) => `${k}:${fingerprint(x)}`)
      .join(",")}}`;
  }
  return v === undefined ? "∅" : JSON.stringify(v);
}

/** 草稿撞上第几份预设；谁都不撞（= 用户自己调过）返回 -1 */
export function matchPreset(draft: ReceiptTemplate, presets: ReceiptTemplate[]): number {
  const cur = fingerprint(draft);
  return presets.findIndex((p) => fingerprint(p) === cur);
}
