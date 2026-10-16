/**
 * 读卡器能力登记表。
 *
 * 「一台读卡器能读几种卡」是硬件属性，不该散在页面的 if 分支里：精伦 iDR 一台机既读
 * 身份证（SAM 安全模块解芯片）也读 IC（Mifare）卡，所以台账里只有一行 device_config，
 * 面板却要按介质分节。这里就是那份唯一的答案——谁能读什么、在线凭据是什么、登记表单
 * 该露哪几项。以后换/加一台只读身份证的机型，只改这张表，面板和台账自动跟着变。
 *
 * 台账的 kind 仍是数据库 CHECK 约束里的 'idcard'（改枚举要重建 device_config 表，
 * 属另一轮），所以这里只抽象「能力」，不动 kind。
 */

/** 一种卡介质＝读卡器上的一个通道 */
export type CardMedium = "idcard" | "ic";

/** 登记/配置表单里的一项参数（结构与 DevicesPage 的 FieldSpec 兼容） */
export interface ReaderField {
  key: string;
  label: string;
  placeholder?: string;
  options?: string[];
}

export interface MediumSpec {
  medium: CardMedium;
  /** 面板小节标题 */
  label: string;
  /** 小节右侧的一句话限定 */
  qualifier: string;
  /** 按钮文案（空闲 / 进行中） */
  action: string;
  pending: string;
  /** 小节底部说明 */
  note: string;
}

export interface ReaderSpec {
  /** 与 device_config.driver 对齐 */
  driver: string;
  /** 面板副标题：说清接入方式，现场排障第一眼要看到 */
  label: string;
  /** 这台机能读哪些介质，面板按这个顺序分节 */
  media: readonly CardMedium[];
  /** 在线凭据：sam＝问到 SAM 序列号才算在线；none＝无从校验，只能停在未检测 */
  onlineProof: "sam" | "none";
  /** 读身份证能否同时取照片 */
  photo: boolean;
  /** 登记/配置表单暴露的关键参数 */
  fields: ReaderField[];
}

export const MEDIUM: Record<CardMedium, MediumSpec> = {
  idcard: {
    medium: "idcard",
    label: "身份证（芯片）",
    qualifier: "脱敏显示",
    action: "读身份证",
    pending: "正在读卡…",
    note: "读到的内容只存在内存里，界面一律脱敏显示。",
  },
  ic: {
    medium: "ic",
    label: "IC 卡",
    qualifier: "只读，不写任何块",
    action: "读 IC 卡",
    pending: "正在寻卡…",
    note: "只读卡号，不往卡里写。读不出来通常是这张卡的密钥被改过，不代表设备坏了。",
  },
};

export const READER_DRIVERS: Record<string, ReaderSpec> = {
  routon_sdtapi: {
    driver: "routon_sdtapi",
    label: "精伦 Sdtapi 直调 · 64 位进程内",
    media: ["idcard", "ic"],
    onlineProof: "sam",
    photo: true,
    fields: [
      { key: "dll", label: "Sdtapi.dll", placeholder: "留空＝用随包的 resources/sdtapi/Sdtapi.dll" },
      { key: "photo", label: "读卡同时取照片", options: ["false", "true"] },
      { key: "icKey", label: "IC 出厂密钥", placeholder: "FFFFFFFFFFFF" },
    ],
  },
  mock: {
    driver: "mock",
    label: "Mock 读卡器（只出演示卡）",
    media: ["idcard", "ic"],
    onlineProof: "none",
    photo: true,
    fields: [],
  },
};

/** 未在表里的驱动：保守认为只能读身份证，且必须问 SAM，别凭空给绿点 */
const UNREGISTERED: ReaderSpec = {
  driver: "",
  label: "未登记的读卡驱动",
  media: ["idcard"],
  onlineProof: "sam",
  photo: false,
  fields: [],
};

export const READER_DRIVER_IDS = Object.keys(READER_DRIVERS);

export function readerSpec(driver: string): ReaderSpec {
  return READER_DRIVERS[driver] ?? { ...UNREGISTERED, driver };
}

/** 登记表单里这台驱动值得现场填的参数；未登记的至少留一项，别让人什么都填不了 */
export function readerFields(driver: string): ReaderField[] {
  const spec = READER_DRIVERS[driver];
  return spec ? spec.fields : [{ key: "dll", label: "动态库/地址", placeholder: "驱动未登记，先按厂商资料填" }];
}
