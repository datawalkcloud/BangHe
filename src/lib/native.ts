/**
 * 桌面原生通道（Tauri）的唯一出口。
 *
 * 为什么要单独一层：小票机、读卡桥接这类设备访问只在桌面端存在，而项目还要能在
 * 纯浏览器里跑演示与冒烟测试。这里的约定是**永远不抛异常、也永远不返回假数据**：
 * 没有原生通道时回 `available: false` 加一句原因，界面据此把按钮置灰并解释，
 * 而不是拿一组假设备号骗出"设备在线"。
 */

/** 与 Rust `ticket_core::model::Paper` 对齐（serde 小写） */
export type NativePaper = "p80" | "p58";

/** 与 Rust `device::DeviceInfo` 对齐（camelCase 序列化） */
export interface NativePrinterDevice {
  devicePath: string;
  vendorId: number | null;
  productId: number | null;
  label: string;
}

/** 与 Rust `device::DeviceStatus` 对齐 */
export interface NativePrinterStatus {
  responding: boolean;
  online: boolean;
  paperAdequate: boolean;
  /** escpos = DLE EOT 有应答；ioctl = 只拿到类驱动状态字；none = 都没应答 */
  source: "escpos" | "ioctl" | "none" | string;
  rawByte: number | null;
  ioctl: number | null;
  note: string;
}

/**
 * 与 Rust `printer::WindowsPrinter` 对齐（camelCase）。
 *
 * 一条本机已安装的 Windows 打印队列（A4 / 针式这类走假脱机的打印机），与
 * {@link NativePrinterDevice}（usbprint 直连小票机、按 VID/PID 寻址）互补：
 * 这条靠 `name` 认机器，`port`/`isDefault` 帮现场把队列名对上桌上那台。
 */
export interface NativeWindowsPrinter {
  name: string;
  driver: string;
  port: string;
  share: string;
  isDefault: boolean;
  network: boolean;
}

/**
 * 与 Rust `camera::LocalCamera` 对齐（camelCase）。本机接的一个视频输入设备
 * （内置 / USB 摄像头），由 Media Foundation 枚举而来；`deviceId` 是稳定符号链接，
 * 与网络摄像机按 IP 寻址是两套。
 */
export interface NativeLocalCamera {
  name: string;
  deviceId: string;
}

/** 与 Rust `printer::PrintOutcome` 对齐 */
export interface NativePrintOutcome {
  ok: boolean;
  device: string;
  status: NativePrinterStatus;
  elapsedMs: number;
  error: string | null;
}

/** 与 Rust `ticket_core::model::WeighTicket` 对齐（字段保持 snake_case） */
export interface ReceiptTicket {
  station_name: string;
  station_code: string;
  doc_no: string;
  biz_date: string;
  print_time: string;
  scale_no: string;
  farmer_name: string;
  id_card_masked: string;
  plate_no: string;
  grain_name: string;
  grade_name: string;
  gross_kg: number;
  tare_kg: number;
  net_kg: number;
  moisture: number | null;
  impurity: number | null;
  deduct_kg: number;
  settle_net_kg: number;
  unit_price: number;
  amount: number;
  amount_upper: string;
  weigher: string;
  qc_by: string;
  cashier: string;
  copy_note: string;
  is_reprint: boolean;
  qr_text: string;
  footer_note: string;
  paper: NativePaper;
  copies: number;
  open_drawer: boolean;
}

/**
 * 一条通用小票行，与 Rust `ticket_core::model::PrintLine` 对齐。
 *
 * 这是**自定义模板的打印出口**：票面由前端按用户当前模板排好交过来，Rust 只把每行
 * 翻成 ESC/POS 指令，不再认任何一种写死的票面结构。字段名一律单词、与 Rust 同形——
 * 大小写约定只在一处（`#[serde(tag = "kind", rename_all = "camelCase")]`）。
 */
/**
 * 码的横向落点（点，从打印头左端起算）。
 *
 * 为什么由前端算而不是让机器居中：`ESC a 1` 按**打印机自己认的可打宽度**居中，而那个数
 * 只跟机身有关、与这卷纸无关。80 机装 58 卷时机身仍按 72mm 居中，48mm 宽的条码就落在
 * 12~60mm，而纸只有 58mm——右端连停止符一起被切在纸外。落点只能自己算，
 * 算法与依据见 `src/components/print/receipt/code-size.ts::codeOffsetDots`。
 *
 * 缺省 0 = 贴着纸左端起排（定长纸走打印队列时用不上它，那一侧的可打区是驱动给的，
 * 见 `queue_print.rs`）。
 */
type PadLeft = {
  /** 码左侧的空点（203dpi）。热敏直打才有；预览 / A4 队列为 0 */
  padLeft?: number;
};

export type NativePrintLine =
  | {
      kind: "text";
      text: string;
      align?: "left" | "center" | "right";
      bold?: boolean;
      underline?: boolean;
      reverse?: boolean;
      /** 字宽倍数，1 = 常规 */
      wide?: number;
      /** 字高倍数 */
      tall?: number;
    }
  | { kind: "kv"; label: string; value: string }
  | { kind: "pair"; l1: string; v1: string; l2: string; v2: string }
  | { kind: "rule" }
  | { kind: "feed"; n: number }
  | ({
      kind: "qr";
      text: string;
      /**
       * 一个模块占几个点（203dpi，1 点 = 0.125mm）。缺省 = 机器出厂的 4 点。
       *
       * 从前这条行不带尺寸，热敏纸上的码恒为固件默认的 4 点——站长在编辑器里把尺寸
       * 从「中」调到「超大」，A4 与预览变了、小票机纹丝不动。
       */
      size?: number;
    } & PadLeft)
  | ({
      /**
       * 一维条码（CODE128）。
       *
       * 这里发的不是文本而是一条**已算好的条空几何**：ESC/POS 功能 A 只支持
       * UPC / EAN / CODE39 / ITF / CODABAR，没有 CODE128（凭票载荷里的 `:` 连 CODE39
       * 的字符表都进不去）；走功能 B 要赌固件版本，而固件自己压缩码制会让纸比预览窄。
       * 所以条空宽度由前端一次算出（`src/components/print/receipt/code128.ts` 的
       * `measureCode128`，与屏幕预览同一份），Rust 只照着排点。
       */
      kind: "barcode";
      /** 条 / 空宽度交替序列（单位：模块），第一个元素是条 */
      runs: number[];
      /**
       * 条身的**总点宽**（203dpi，1 点 = 0.125mm，不含静区）。
       *
       * 发的不是"一个模块几点"而是整条的总宽：纸窄到放不下时前端按**实数**压模块宽度
       * （见 `fitModuleDots`），而 `GS v 0` 栅格只能按整数点排——所以小数那一份在前端
       * 一次折好，Rust 照着总宽把每段分到点上即可，两边不会再各自乘出一个不同的宽度。
       * 纸宽放不下时前端已经压过这个数。
       */
      width: number;
      /** 条高（点） */
      height: number;
    } & PadLeft);

export type NativeResult<T> =
  | { available: true; data?: T; error?: string }
  | { available: false; error: string };

/** 只有桌面端才有 `__TAURI_INTERNALS__`；用惰性判断，模块在浏览器里加载也不能报错 */
export function runningInTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 纸型（站点参数里的 PaperKind）→ ESC/POS 纸宽。只在这里做一次映射：
 * 各处再写一遍 `=== "thermal58" ? ...` 迟早和 constants 分叉。
 */
export function toNativePaper(paper: string | null | undefined): NativePaper {
  return paper === "thermal58" ? "p58" : "p80";
}

const NO_CHANNEL = "当前是浏览器预览，没有原生设备通道；请用「npm run tauri dev」启动桌面端后重试";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<NativeResult<T>> {
  if (!runningInTauri()) return { available: false, error: NO_CHANNEL };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return { available: true, data: await invoke<T>(cmd, args) };
  } catch (e) {
    // 命令本身失败（打不开设备、写失败）与"没有通道"要能区分开，故 available 仍为 true
    return { available: true, error: e instanceof Error ? e.message : String(e) };
  }
}

export const nativePrinter = {
  /** 可直连的小票机列表（设备中心下拉的数据源） */
  list: () => call<NativePrinterDevice[]>("printer_list"),

  /** 本机已安装的 Windows 打印队列（A4 / 针式按打印机名挑机），与 list 的 usbprint 直连互补 */
  listQueues: () => call<NativeWindowsPrinter[]>("printer_list_queues"),

  /** 问一次实时状态，不出纸 */
  status: (dev?: { vid?: number; pid?: number }) =>
    call<{ device: NativePrinterDevice; status: NativePrinterStatus }>("printer_status", {
      vid: dev?.vid ?? null,
      pid: dev?.pid ?? null,
    }),

  /** 打自检票：一次判读通道 / 中文字库 / 栅格列数 / 切刀 */
  selfTest: (dev?: { vid?: number; pid?: number; paper?: NativePaper }) =>
    call<NativePrintOutcome>("printer_self_test", {
      vid: dev?.vid ?? null,
      pid: dev?.pid ?? null,
      paper: dev?.paper ?? null,
    }),

  /** 打过磅码单（票面内容由调用方快照好交过来） */
  weighTicket: (ticket: ReceiptTicket) =>
    call<NativePrintOutcome>("print_weigh_ticket", { ticket }),

  /**
   * 打「前端按用户模板排好版」的通用小票。
   *
   * 与 {@link weighTicket} 的分工：那张票的版式写死在 Rust（热敏码单标准版），
   * 这里的票面完全由前端当前模板决定——新增票据、勾掉字段都不必改 Rust。
   * 只吃 58 / 80 热敏纸：A4 与针式要走系统打印队列，不是同一台机器。
   *
   * `cols` 是现场实测列数（汉字占 2 列），传了就覆盖纸宽标称。票面折行几乎都是
   * "标称列数比实机大"，实测入口在「小票模板 → 小票机列数」，值由自检票上的标尺读出。
   */
  receipt: (
    lines: NativePrintLine[],
    opts?: { paper?: NativePaper; vid?: number; pid?: number; copies?: number; openDrawer?: boolean; cols?: number },
  ) =>
    call<NativePrintOutcome>("print_receipt", {
      input: {
        lines,
        paper: opts?.paper ?? null,
        cols: opts?.cols ?? null,
        vid: opts?.vid ?? null,
        pid: opts?.pid ?? null,
        copies: opts?.copies ?? null,
        openDrawer: opts?.openDrawer ?? false,
      },
    }),

  /**
   * 队列直打（A4 激光 / 241 针式，无预览）：同一份行序列交过来，Rust 用 GDI 画进
   * Windows 打印队列。**没有 paper 参数是刻意的**——纸型、托盘、方向全随打印机自身配置，
   * 程序不越权替现场选纸。
   *
   * `printer` 缺省 = 系统默认打印机；传台账里登记的队列名（设备中心「本机打印机队列」
   * 回填的 `rawQueue`）则指哪台打哪台。ok=true 只代表"任务已进队列"，不代表纸已出。
   */
  receiptToQueue: (
    lines: NativePrintLine[],
    opts?: { printer?: string | null; copies?: number },
  ) =>
    call<NativePrintOutcome>("print_receipt_queue", {
      input: {
        lines,
        printer: opts?.printer ?? null,
        copies: opts?.copies ?? null,
      },
    }),
};

/* ------------------------------------------------------------------ *
 * 身份证 / IC 卡读卡器（精伦 Routon iDR，走 routon-idr 封装）
 * 与 Rust `idcard::{ReaderStatus, IdCardInfo, IcCardInfo, IcBlock}` 对齐（camelCase）。
 * ------------------------------------------------------------------ */

/** 读卡器连接状态 */
export interface NativeReaderStatus {
  connected: boolean;
  samId: string | null;
  fingerprint: boolean;
  error: string | null;
}

/** 一张身份证的结构化信息（含可选照片绝对路径） */
export interface NativeIdCardInfo {
  ok: boolean;
  name: string;
  gender: string;
  nation: string;
  birth: string;
  idNumber: string;
  address: string;
  agency: string;
  validFrom: string;
  validTo: string;
  photoPath: string | null;
  error: string | null;
}

/** 一个 Mifare 数据块 */
export interface NativeIcBlock {
  sector: number;
  block: number;
  ok: boolean;
  hex: string;
  error: string | null;
}

/** IC（Mifare）卡读取结果 */
export interface NativeIcCardInfo {
  ok: boolean;
  kindCode: number;
  kindLabel: string;
  sn: string;
  blocks: NativeIcBlock[];
  error: string | null;
}

export const nativeIdcard = {
  /** 读卡器是否在线 + SAM 号（设备中心状态灯） */
  status: () => call<NativeReaderStatus>("idcard_status"),

  /** 读身份证；withPhoto=true 时把照片写到应用缓存目录并回传绝对路径 */
  read: (withPhoto = false) =>
    call<NativeIdCardInfo>("idcard_read", { withPhoto }),

  /** 读 Mifare IC 卡：卡号 + 指定块。keyHex 为 12 位十六进制，默认出厂 FFFFFFFFFFFF */
  icRead: (opts?: { keyHex?: string; blocks?: [number, number][] }) =>
    call<NativeIcCardInfo>("ic_read", {
      keyHex: opts?.keyHex ?? null,
      blocks: opts?.blocks ?? null,
    }),
};

/* ------------------------------------------------------------------ *
 * 摄像机。网络摄像机（海康 ISAPI / 大华 CGI）走台账 host，不在此枚举；
 * 这里只补「本机连接的 USB / 内置摄像头」的发现（Media Foundation）。
 * ------------------------------------------------------------------ */

export const nativeCamera = {
  /** 本机接的摄像头列表（添加设备表单「扫描本机摄像头」的数据源） */
  listLocal: () => call<NativeLocalCamera[]>("camera_list_local"),
};

/* ------------------------------------------------------------------ *
 * 串口（地磅、钱箱等 RS-232 设备）。按名称选端口，避免手填 COM 号出错。
 * ------------------------------------------------------------------ */

export const nativeSerial = {
  /** 本机串口列表（添加设备表单「串口」下拉的数据源） */
  list: () => call<string[]>("serial_list"),
};
