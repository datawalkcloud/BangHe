/**
 * 对外大屏（F2）的原生窗口：独立于主窗口的第二扇窗，用来挂外屏给农户核对读数。
 *
 * 三条不能破的约定：
 *  - **总是另起窗口**：有没有第二块屏只决定它落在哪里，不决定它存不存在。单屏时开成浮动窗，
 *    操作员的主窗口照样露在外面能操作；
 *  - **焦点**：建窗 `focus: false`，按完 F2 键盘还留在主窗口，大屏窗不抢操作；
 *  - **落点**：多屏时先按**物理像素** `setPosition` 到外屏再 `setFullscreen`。建窗参数里的
 *    x/y 是逻辑像素，两屏缩放比不同会被按主屏 DPI 换算，可能开错屏。
 *
 * 读数走 Rust `app.emit` 的 `device://scale` 广播，两扇窗共用同一条串口流，
 * 大屏窗不重复 `scale_start`（那会停掉主窗口的读线程重开端口，见 `store/device.ts`）。
 */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { availableMonitors, PhysicalPosition, PhysicalSize, primaryMonitor, type Monitor } from "@tauri-apps/api/window";

export const DISPLAY_WINDOW_LABEL = "display";

/** 切换对外大屏窗：已开着就关掉，没开就按当前屏幕数选一种落点开起来。 */
export async function toggleDisplayWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(DISPLAY_WINDOW_LABEL).catch(() => null);
  if (existing) {
    await existing.close();
    return;
  }

  const target = await pickTarget();
  const display = new WebviewWindow(DISPLAY_WINDOW_LABEL, {
    url: new URL("/?display=1", window.location.origin).toString(),
    title: "磅禾对外大屏",
    focus: false,
    // 单屏时留标题栏：操作员要能把它拖开或点 X 关掉，全屏无边框就没这个把手了
    decorations: !target.external,
    resizable: true,
    // 先藏起来挪到位再显，否则会在操作员的主屏上闪一下
    visible: false,
  });

  // 构造函数只发出 create 命令，窗口注册要等 tauri://created；提前操作会拿到 window not found
  await new Promise<void>((resolve, reject) => {
    void display.once("tauri://created", () => resolve());
    void display.once("tauri://error", (event) => {
      console.error("对外大屏创建失败", event);
      reject(new Error(String(event.payload)));
    });
  });

  const { x, y } = target.monitor.position;
  const { width, height } = target.monitor.size;
  if (target.external) {
    await display.setPosition(new PhysicalPosition(x, y));
    await display.setFullscreen(true);
  } else {
    // 单屏：占屏右下方约六成，留出主窗口的操作面（给的都是物理像素，不涉及缩放比换算）
    await display.setSize(new PhysicalSize(Math.round(width * 0.62), Math.round(height * 0.72)));
    await display.setPosition(new PhysicalPosition(Math.round(x + width * 0.34), Math.round(y + height * 0.16)));
  }
  await display.show();
}

interface Target {
  monitor: Monitor;
  /** true = 这块屏不是操作员在用那块，大屏窗可以整屏盖住它 */
  external: boolean;
}

/** 有两块屏取非主屏并整屏展示；只有一块屏就在主屏上开浮动窗（仍是一扇独立窗口）。 */
async function pickTarget(): Promise<Target> {
  const [monitors, primary] = await Promise.all([availableMonitors(), primaryMonitor()]);
  if (!primary || monitors.length < 2) {
    const only = monitors[0] ?? primary;
    if (!only) throw new Error("枚举不到显示器");
    return { monitor: only, external: false };
  }
  const sameSpot = (m: Monitor) => m.position.x === primary.position.x && m.position.y === primary.position.y;
  const external = monitors.find((m) => !sameSpot(m));
  return { monitor: external ?? primary, external: !!external };
}
