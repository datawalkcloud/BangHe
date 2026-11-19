/**
 * 启动骨架的收场。骨架本体在 index.html（那里写着为什么必须是 HTML 而不是组件），这里只管摘它。
 */

/** 与 index.html 里 #boot-splash 的 transition 时长是同一个数，改一边要改另一边 */
const FADE_MS = 260;

export function dismissBootSplash(): void {
  const el = document.getElementById("boot-splash");
  if (!el || el.classList.contains("boot-splash--gone")) return;
  el.classList.add("boot-splash--gone");
  // 不挂 transitionend：系统开了"减弱动态效果"时压根没有过渡，那个事件永远不来，
  // 覆盖层就会一直杵在最上面把整屏点击都吃掉。
  setTimeout(() => el.remove(), FADE_MS);
}

/** 页面真画出东西的判据：抬头标题、大白卡、骨架、表格，四者有其一。
 *  壳自己（侧栏/顶栏/设备条）一样都不带，所以命中即说明正文已经落地。 */
const isPainted = () => !!document.querySelector('h1, [data-slot="card"], [data-slot="skeleton"], table');

/**
 * 第一屏真渲染出来才摘骨架——不能挂在 React 挂载上，也不能挂在路由首帧上：
 * 页面是懒加载 chunk，`onRendered` 那一下正文还在 await 模块，而 React 对**新挂载**的
 * Suspense 边界还要压约 500ms 才肯画骨架，于是这段时间内容区是纯画布灰
 * （用户截图里"打开程序后第一次进页面，整块空灰"就是这一帧）。
 * 骨架多杵一会儿总比露出一个空壳强，所以这里等到画出东西为止，最多 3 秒。
 */
export function dismissBootSplashWhenPainted(): void {
  if (isPainted()) {
    dismissBootSplash();
    return;
  }
  const stop = new MutationObserver(() => {
    if (!isPainted()) return;
    stop.disconnect();
    dismissBootSplash();
  });
  stop.observe(document.body, { childList: true, subtree: true });
  // 兜底那条给"正文里四样都没有"的新页面留的：宁可骨架早摘，不能让它一直盖着点不动
  setTimeout(() => {
    stop.disconnect();
    dismissBootSplash();
  }, 3000);
}
