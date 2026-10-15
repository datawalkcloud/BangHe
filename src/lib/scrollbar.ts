/**
 * 全局滚动条的"正在滚动"状态跟踪，配合 App.css 里的自动隐藏滚动条样式。
 *
 * CSS 能表达"悬停才显示"，但拿不到"正在滚动"这个状态——滚动条该在动的时候才浮现、
 * 停手后淡掉（磅房工作台一屏布局，常驻滚动条既占宽又抢视线）。所以这里补上那半边：
 *
 * - `scroll` 事件不冒泡，但能在 document 上以**捕获阶段**收到任意容器的滚动；
 * - 给正在滚的那个容器挂 `.is-scrolling`，停手 IDLE_MS 后摘掉，CSS 随之把滑块透明化；
 * - 拖动滚动条、键盘翻页同样会连续触发 scroll，不需要额外监听。
 *
 * 只在应用入口调用一次 setupGlobalScrollbar()，两个窗口（主窗口与副屏）共用同一份逻辑。
 */

/** 停手多久后认为"没在滚了"，短到不打断连续慢滚，长到不至于读一行字就消失 */
const IDLE_MS = 800;

const SCROLLING_CLASS = "is-scrolling";

/** 每个容器一条独立的熄火计时：重排滚动条不该被别的容器的计时误伤 */
const idleTimers = new WeakMap<Element, number>();

function markScrolling(el: Element): void {
  el.classList.add(SCROLLING_CLASS);
  const prev = idleTimers.get(el);
  if (prev !== undefined) window.clearTimeout(prev);
  idleTimers.set(
    el,
    window.setTimeout(() => {
      el.classList.remove(SCROLLING_CLASS);
      idleTimers.delete(el);
    }, IDLE_MS),
  );
}

/** 整页滚动时事件 target 是 Document，真正带滚动条的元素是根元素 */
function scrollOwner(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Document) return target.scrollingElement ?? target.documentElement;
  return null;
}

export function setupGlobalScrollbar(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  document.addEventListener(
    "scroll",
    (e) => {
      const el = scrollOwner(e.target);
      if (el) markScrolling(el);
    },
    { capture: true, passive: true },
  );
}
