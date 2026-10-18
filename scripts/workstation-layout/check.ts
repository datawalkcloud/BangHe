/**
 * 磅房工作台布局的无头自检（05 §4.1「脏值」「后加面板」两行）。
 *
 * 为什么单独留这一份：`parseDoc` / `stringifyDoc` 是纯函数，但它管的是"别人排好的界面会不会被
 * 我们悄悄重排"。这类回归在界面上当场看不出来，只在下一次开机时爆——用户拖了半天的布局被打回三栏。
 * 前端没有测试运行器，也不必为此装一套：用 vite 自带的 esbuild 打成 node 能跑的脚本即可。
 *
 *   npx esbuild scripts/workstation-layout/check.ts --bundle --platform=node --format=esm ^
 *     --alias:@/lib/api=./scripts/workstation-layout/stub.js ^
 *     --alias:@/store/session=./scripts/workstation-layout/stub.js ^
 *     --alias:react-grid-layout=./scripts/workstation-layout/stub.js ^
 *     --alias:@tanstack/react-query=./scripts/workstation-layout/stub.js ^
 *     --alias:sonner=./scripts/workstation-layout/stub.js ^
 *     --outfile=.tmp-check.mjs && node .tmp-check.mjs
 *
 * `stub.js` 只顶掉那几个"一 import 就要碰 Tauri / DOM"的模块，被检的函数本身不依赖它们。
 * 唯一被简化的是 react-grid-layout 的 `verticalCompactor`（落库前那道挤开逻辑）：真实网格在屏幕上跑，
 * 这里只断言"读回来的几何不该动"，所以拿不到它的挤开结果也不影响结论。
 */
import { PANELS, defaultDoc, parseDoc, stringifyDoc } from "../../src/components/workstation/layout";

let fails = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`PASS ${name}`);
  else {
    fails++;
    console.log(`FAIL ${name}`, extra === undefined ? "" : JSON.stringify(extra));
  }
}
function geom(doc: { items: { i: string; x: number; y: number; w: number; h: number }[] }, id: string) {
  const it = doc.items.find((x) => x.i === id);
  return it ? `${it.x},${it.y},${it.w},${it.h}` : "missing";
}
const visible = (doc: ReturnType<typeof parseDoc>) => doc.items.filter((i) => !doc.hidden.includes(i.i as never)).map((i) => i.i).sort();

/* A. 老版本写好的满格排布（12×24 全占） */
const oldFull = JSON.stringify({
  version: 1,
  items: [
    { i: "tare", x: 0, y: 0, w: 3, h: 24 },
    { i: "camera", x: 3, y: 0, w: 6, h: 7 },
    { i: "weigh", x: 3, y: 7, w: 6, h: 11 },
    { i: "qc", x: 3, y: 18, w: 6, h: 6 },
  ],
  hidden: [],
});
const a = parseDoc(oldFull);
ok(
  "A 老排布四格几何原样（一格都没动）",
  geom(a, "tare") === "0,0,3,24" && geom(a, "camera") === "3,0,6,7" && geom(a, "weigh") === "3,7,6,11" && geom(a, "qc") === "3,18,6,6" && a.items.length === 5,
  a.items,
);
ok("A 新面板对老用户默认收起", a.hidden.includes("identity") && visible(a).join() === "camera,qc,tare,weigh", a.hidden);

/* B. 老用户把右栏自己用掉了（camera 拉宽到 9 列） */
const oldWide = JSON.stringify({
  version: 1,
  items: [
    { i: "tare", x: 0, y: 0, w: 3, h: 24 },
    { i: "camera", x: 3, y: 0, w: 9, h: 10 },
    { i: "weigh", x: 3, y: 10, w: 9, h: 8 },
    { i: "qc", x: 3, y: 18, w: 9, h: 6 },
  ],
  hidden: [],
});
const b = parseDoc(oldWide);
ok("B 右栏被占用时也不挤动他的格子", geom(b, "camera") === "3,0,9,10" && geom(b, "weigh") === "3,10,9,8" && geom(b, "qc") === "3,18,9,6", b.items);
ok("B 新面板仍是收起", b.hidden.includes("identity"));

/* C. 落库往返稳定：写进去再读回来不该变样 */
const c1 = parseDoc(stringifyDoc(b));
const c2 = parseDoc(stringifyDoc(c1));
ok("C 二次往返逐字稳定", JSON.stringify(c1) === JSON.stringify(c2) && c1.hidden.includes("identity"), { c1, c2 });

/* D. 新账号（库里没值）走默认排布，新面板一进来就在位 */
const d = parseDoc(null);
ok("D 默认排布含五格且身份与制单可见", d.items.length === 5 && !d.hidden.includes("identity") && geom(d, "identity") === "0,0,3,14", d);
ok("D 默认排布五块互不压字（面板注册表与默认格位自洽）", PANELS.length === 5 && JSON.stringify(defaultDoc().hidden) === "[]");

/* E. 脏值（互相压字）仍整份退回默认——旧闸门不该被新逻辑绕过 */
const dirty = JSON.stringify({
  version: 1,
  items: [
    { i: "tare", x: 0, y: 0, w: 6, h: 24 },
    { i: "camera", x: 0, y: 0, w: 6, h: 7 },
    { i: "weigh", x: 3, y: 7, w: 6, h: 11 },
    { i: "qc", x: 3, y: 18, w: 6, h: 6 },
  ],
  hidden: [],
});
ok("E 压字脏值退回默认排布", JSON.stringify(parseDoc(dirty)) === JSON.stringify(defaultDoc()));

/* F. 本人已把新面板放出来并挪了位置：不该再被悄悄收回去 */
const shown = JSON.stringify({
  version: 1,
  items: [
    { i: "tare", x: 0, y: 0, w: 3, h: 24 },
    { i: "camera", x: 3, y: 0, w: 6, h: 7 },
    { i: "weigh", x: 3, y: 7, w: 6, h: 11 },
    { i: "qc", x: 3, y: 18, w: 6, h: 6 },
    { i: "identity", x: 9, y: 0, w: 3, h: 12 },
  ],
  hidden: [],
});
const f = parseDoc(shown);
ok("F 已放出的新面板保持可见且位置不动", !f.hidden.includes("identity") && geom(f, "identity") === "9,0,3,12", f);

/* G. 撤掉的面板键（settle）留在库里也只是静默丢弃，不报错、不连带重排 */
const withSettle = JSON.stringify({
  version: 1,
  items: [
    { i: "tare", x: 0, y: 0, w: 3, h: 24 },
    { i: "camera", x: 3, y: 0, w: 6, h: 7 },
    { i: "weigh", x: 3, y: 7, w: 6, h: 11 },
    { i: "qc", x: 3, y: 18, w: 6, h: 6 },
    { i: "settle", x: 9, y: 0, w: 3, h: 24 },
  ],
  hidden: [],
});
ok("G 认不出的 settle 被丢弃且四格原样", geom(parseDoc(withSettle), "weigh") === "3,7,6,11" && !parseDoc(withSettle).items.some((i) => i.i === "settle"));

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
