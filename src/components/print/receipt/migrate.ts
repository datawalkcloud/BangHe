/**
 * 打印模板本地存储的结构迁移（v1 → v2）。
 *
 * v1 按场景存一份：`custom[scenario] = 模板`，纸型只是模板里的一个字段，改一次覆盖全部纸。
 * v2 按场景 × 纸型存：`custom[scenario][paper] = 模板`，换纸型是换一份各自可改的版式。
 *
 * 单独成一个纯模块而不是写在 store.ts 里，是为了让这条迁移能被
 * `scripts/receipt-code/check.ts` 直接 import 断言——store.ts 一加载就建 zustand store、
 * 还要 localStorage，无头自检里读不到它。
 */
import { defaultTemplate } from "./defaults";
import { isPaperKind } from "@/lib/constants";
import type { PaperKind } from "@/lib/constants";
import type { ReceiptScenario, ReceiptTemplate } from "./types";

/** v2 的存储形状：场景 → 纸型 → 用户存过的覆盖模板 */
export type TemplateBuckets = Partial<Record<ReceiptScenario, Partial<Record<PaperKind, ReceiptTemplate>>>>;

/** 一张模板认得出自己：有区块数组。v1 的整份模板与 v2 桶里的值都满足，v2 的桶本身不满足 */
function isTemplate(v: unknown): v is ReceiptTemplate {
  return !!v && typeof v === "object" && Array.isArray((v as ReceiptTemplate).sections);
}

/**
 * 把一整个 `custom` 摊成 v2 的桶。
 *
 * 三种输入都要接得住，因为用户可能停在任何一个版本上直接升到 v2：
 *  - **v1**（场景 → 模板）：模板自带的 `paper` 就是它当初那张纸，搬进对应纸型的桶里；
 *    `paper` 缺失/认不出来（手改脏、更早的版本没这个字段）时按该场景出厂纸型落位，
 *    宁可跟出厂默认同格、也不要凭空造一档没有入口的纸型——落在出厂那一格里，站长在顶部
 *    点开这张纸就能看到他自己的改动，落到别处等于这份模板永远读不出来。
 *  - **v2**（场景 → 桶）：逐个纸型校验后原样留下。
 *  - **脏值**（null、字符串、结构对不上）：丢掉。留着会在取用侧炸成"票面空白但看不出为什么"。
 */
export function migrateCustom(raw: unknown): TemplateBuckets {
  const next: TemplateBuckets = {};
  if (!raw || typeof raw !== "object") return next;
  for (const [scenario, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isTemplate(value)) {
      const paper = isPaperKind(value.paper) ? value.paper : defaultTemplate(scenario as ReceiptScenario).paper;
      next[scenario as ReceiptScenario] = { [paper]: value };
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const bucket: Partial<Record<PaperKind, ReceiptTemplate>> = {};
    for (const [p, t] of Object.entries(value as Record<string, unknown>)) {
      if (isPaperKind(p) && isTemplate(t)) bucket[p] = t;
    }
    if (Object.keys(bucket).length > 0) next[scenario as ReceiptScenario] = bucket;
  }
  return next;
}
