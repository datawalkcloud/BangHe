/**
 * 打印通道：把预览里的那一段纸原样送进打印机。
 *
 * 为什么不用主文档的 `window.print()`（这也是从前"预览和打印差很远"的根源）：
 *
 *  1. `@page { size: <宽> auto }` 不是合法取值。CSS 分页规范里 `size` 只接受
 *     `auto | <长度>{1,2} | <纸型> [portrait|landscape]`，卷纸那种"宽度固定、高度随内容"的
 *     写法没有对应语法——整条声明被丢弃后浏览器退回打印机默认纸张（通常是 A4 / Letter），
 *     一张 58mm 的小票就印在了 A4 的左上角，右边全是白纸。
 *  2. 主文档里活着的是整个应用：弹窗 portal、固定顶栏、栅格布局、暗色主题。
 *     靠 `@media print { body * { visibility: hidden } }` 去"挖"出纸面，在复杂层叠上下文里
 *     既挖不干净（隐藏元素仍占版面 → 多出空白页），又要和主题色、overflow 容器一路打架。
 *
 * 现在的做法（也是当下 SP A 打印的主流做法）：
 *
 *  - 建一个**离屏 iframe**，把主文档的样式表原样复制进去，再把纸面那个节点克隆过去，
 *    对这个 iframe 调 `print()`。打印文档里除了纸没有别的东西，样式与预览同源，
 *    于是"预览什么样、纸上就什么样"是结构上保证的，而不是靠反复肉眼对齐。
 *  - 卷纸**先量后打**：等字体和首帧布局就绪后读纸面实测高度，再注入精确的
 *    `@page { size: Wmm Hmm }`。一张票正好一页，不会多拖一截白纸，也不会在边界上断行。
 *  - 定长纸（A4 / 241）反过来：页边距交给 `@page margin`，纸面自身不留白
 *    （`data-page-fixed`），这样第二页起也有一样的页边距。
 */
import type { MarginMm } from "./receipt/paper";
import { MM_TO_PX } from "./receipt/paper";

export interface PrintJob {
  /** 打印作业标题（部分驱动/另存 PDF 时当作文件名） */
  title: string;
  /** 纸宽（mm） */
  widthMm: number;
  /** 纸高（mm）；null = 卷纸，按内容实测 */
  heightMm: number | null;
  /** 纸面留白（mm） */
  marginMm: MarginMm;
  /** 纸面节点（id="print-root"），会被原样克隆进打印文档 */
  node: HTMLElement;
}

const pxToMm = (px: number) => (px * 25.4) / 96;

/** 卷纸：实测高度上留一点余量，避免打印机按整毫米取整后把最后一行甩到第二页 */
const SLACK_MM = 0.6;

/** 离屏 iframe 的初始高度：够长即可，body 实际高度不受视口高度限制 */
const ROLL_VIEWPORT_MM = 800;

const r2 = (n: number) => Math.round(n * 100) / 100;

function pageRule(widthMm: number, heightMm: number, marginMm: MarginMm | null): string {
  const margin = marginMm ? `${r2(marginMm.top)}mm ${r2(marginMm.right)}mm ${r2(marginMm.bottom)}mm ${r2(marginMm.left)}mm` : "0";
  return `@page { size: ${r2(widthMm)}mm ${r2(heightMm)}mm; margin: ${margin}; }`;
}

/**
 * 打印文档的基础样式。
 *
 * 关键一条是 `body * { visibility: visible }`：被复制进来的主样式表里带着"整页打印"那套隐藏
 * 规则，而这份文档里除了纸没有别的——不抵消掉，纸面会被自己人藏起来。
 */
const PRINT_BASE_CSS = `
html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; color: #000 !important; }
body * { visibility: visible !important; }
#print-root { position: static !important; margin: 0 !important; box-shadow: none !important; }
* { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
/* 模板编辑器的屏幕标记不是票面内容。放在基础样式而不是只放 @media print：
   这份文档在**量高度之前**就用上了它，占位行若不先藏掉，卷纸会按含占位行的高度多出一截空白。 */
.receipt-sec-active { outline: none !important; background: transparent !important; }
.receipt-sec-empty { display: none !important; }
`;

/** 定长纸：页边距由 @page 出，纸面自身不再留白 */
const FIXED_PAGE_CSS = `
#print-root { padding: 0 !important; width: auto !important; min-height: 0 !important; }
`;

function raf(win: Window): Promise<void> {
  // 离屏窗口的 rAF 不一定按时到达，加一个定时器兜底，两者谁先到算谁
  return new Promise((resolve) => {
    win.requestAnimationFrame(() => resolve());
    window.setTimeout(resolve, 120);
  });
}

/** 把主文档的样式表搬进打印文档（Tailwind 工具类、组件样式、@font-face 都在里面） */
function copyStylesheets(doc: Document): void {
  for (const el of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) {
    const copy = doc.importNode(el, true) as HTMLElement;
    if (copy.tagName === "LINK") {
      const href = copy.getAttribute("href");
      if (href) copy.setAttribute("href", new URL(href, location.href).href);
    }
    doc.head.appendChild(copy);
  }
}

/**
 * 打印一个 DOM 节点（离屏 iframe 通道）。
 *
 * 返回 false = 这条通道不可用（没有 iframe / 没有 print / 文档写不进去），调用方应退回整页打印。
 */
export async function printElement(job: PrintJob): Promise<boolean> {
  const fixed = job.node.dataset.pageFixed === "1";
  const m = job.marginMm;
  // 定长纸：iframe 视口宽度要等于"页面减去页边距"后的内容区，否则量出来的换行位置和纸上不一致
  const viewportMm = fixed ? job.widthMm - m.left - m.right : job.widthMm;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.title = job.title;
  // 移到屏幕外而不是 display:none —— 被隐藏的 iframe 在部分内核里不进打印树
  iframe.style.cssText = `position:fixed;left:-20000px;top:0;width:${Math.ceil(viewportMm * MM_TO_PX)}px;height:${Math.ceil((job.heightMm ?? ROLL_VIEWPORT_MM) * MM_TO_PX)}px;border:0;`;

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    iframe.remove();
  };

  document.body.appendChild(iframe);
  try {
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (!win || !doc || typeof win.print !== "function") {
      cleanup();
      return false;
    }

    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    doc.close();
    doc.title = job.title;

    copyStylesheets(doc);

    const pageStyle = doc.createElement("style");
    // 放在复制来的样式表之后，才能压过其中的 @media print 规则
    pageStyle.textContent = PRINT_BASE_CSS + (fixed ? FIXED_PAGE_CSS : "");
    doc.head.appendChild(pageStyle);

    doc.body.appendChild(doc.importNode(job.node, true));

    // 不等字体和首帧就量高度，量到的是"字体还没到"的高度——卷纸会短一截
    await Promise.resolve(doc.fonts?.ready).catch(() => undefined);
    await raf(win);

    const measured = doc.body.firstElementChild?.getBoundingClientRect().height ?? 0;
    const heightMm = job.heightMm ?? Math.max(job.widthMm, pxToMm(measured) + SLACK_MM);
    pageStyle.textContent += pageRule(job.widthMm, heightMm, fixed ? m : null);

    await raf(win);
    win.focus();
    win.print();

    // print() 是异步的：同步移除 iframe 会把刚弹出的对话框一起带走
    win.addEventListener("afterprint", cleanup, { once: true });
    window.setTimeout(cleanup, 120_000);
    return true;
  } catch {
    cleanup();
    return false;
  }
}

/**
 * 兜底：离屏 iframe 通道用不了时退回整页打印。
 *
 * 临时往主文档注入 @page（打完即摘），配合 App.css 里的 `@media print` 只保留 #print-root。
 * 卷纸的高度在这里只能量主文档里的纸面——它在缩放容器里，但 offsetHeight 是排版高度，
 * 不受祖先 transform 影响，所以量到的仍是真实毫米。
 */
export function printFallback(job: PrintJob): void {
  const fixed = job.node.dataset.pageFixed === "1";
  const heightMm = job.heightMm ?? Math.max(job.widthMm, pxToMm(job.node.offsetHeight) + SLACK_MM);

  const style = document.createElement("style");
  style.textContent = pageRule(job.widthMm, heightMm, fixed ? job.marginMm : null);
  document.head.appendChild(style);
  const drop = () => style.remove();
  window.addEventListener("afterprint", drop, { once: true });
  window.setTimeout(drop, 120_000);

  window.print();
}

/** 一次完整的出纸：先走离屏通道，走不通退回整页打印 */
export async function printJob(job: PrintJob): Promise<void> {
  const ok = await printElement(job);
  if (!ok) printFallback(job);
}
