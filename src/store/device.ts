/**
 * 设备实时状态（zustand）。
 *
 * 只放"高频、非服务端状态"——设备读数、判稳、抓拍中、桥接进程存活。
 * 业务数据一律走 react-query，不进这里（05 §8）。
 *
 * 读数流有两条路（04 §2、§4），由 `useScaleTick` 按运行环境自动选：
 *  - 桌面端：订阅 Rust 的 tauri event `device://scale`，切帧/取数/判稳全在 `scale.rs` 做完，
 *    这里只把可用的结论落成界面状态。**台账里没登记真磅就是"离线 + 一句原因"**，
 *    绝不拿模拟抖动顶上——过磅是要结算的，假读数比没读数危险得多。
 *  - 浏览器预览：没有串口通道，`tick()` 用随机抖动演示"不稳定 → 稳定 → 可捕获"，
 *    并把 `source` 标成 `"demo"`，界面据此说明这条读数是哪来的。
 *
 * 读卡器已经走真机：Rust `idcard.rs` 加载 64 位 Sdtapi.dll 直调精伦 iDR，一台机承担身份证
 * 与 IC（Mifare）两条介质通道（能读哪几条由 `lib/card-reader` 的登记表决定）。本 store 只把
 * `nativeIdcard` 的三个命令（status / read / ic_read）收成一份界面状态，让设备中心、工作台 F8、
 * 档案页读卡看到的是同一台读卡器、同一句失败原因。
 */
import { create } from "zustand";
import { useEffect } from "react";
import { api } from "@/lib/api";
import { nativeIdcard, runningInTauri } from "@/lib/native";
import { nativeScale, subscribeScale, type ScaleReading } from "@/lib/scale-native";
import type { DeviceStatus } from "@/lib/constants";
import { ACTIVE_PARTIES } from "@/mock/masters";

/** 判稳窗口与容差取自站点参数，默认 1500 ms / 5.0 kg（= 50 个 0.1kg） */
const WINDOW = 5;
const TOLERANCE = 50;
const DIVISION = 100; // 10 kg 分度

/** 读数出处：`live` = Rust 串口线程解析出的真帧，`demo` = 浏览器预览的模拟心跳 */
export type ScaleSource = "live" | "demo";

export interface ScaleState {
  connected: boolean;
  onScale: boolean;
  /** 当前读数，0.1kg 整数 */
  weight01kg: number;
  /** 车上"真值"，用于生成抖动 */
  setpoint01kg: number;
  samples: number[];
  stable: boolean;
  source: ScaleSource;
  /** 原帧的可读形式：`weigh_record.raw_frame` 落库用它（迎检要能对回原始报文）；模拟流没有，回 null */
  rawFrame: string | null;
  /** 最近一次失败原因的中文短句（台账没登记磅 / 串口打不开 / 帧解析失败），界面直接显示这一句 */
  error: string | null;
  /** 最近一帧的本地时刻，界面据此说明这条读数新不新 */
  at: string | null;
  /** 手动把车开上磅 / 开下磅（演示用） */
  driveOn: (kg: number) => void;
  driveOff: () => void;
  setConnected: (v: boolean) => void;
  tick: () => void;
}

/** 一次真机探测的结论，与 Rust `idcard::ReaderStatus` 对齐（设备中心状态灯的数据源） */
export interface ReaderProbe {
  status: DeviceStatus;
  connected: boolean;
  /** 安全模块 SAM 序列号：只有设备真被打开成功才有，是"在线"的凭据而非界面猜测 */
  samId: string | null;
  fingerprint: boolean;
  error: string | null;
  /** 本地探测时刻，界面据此说明这条结论是哪来的、还新不新 */
  at: string;
}

/**
 * 一次读卡的结果（身份证通道）。
 *
 * 明文只在内存，界面必须走 maskIdCard；`party_id` 是拿证号回查档案得到的，
 * 真机上"读到证号"和"系统里有这个人"是两件事，所以它可以是 null。
 */
export interface IdCardResult {
  party_id: number | null;
  name: string;
  id_card_no: string;
  address: string;
  /** 出生日期 CCYYMMDD（与卡片芯片一致） */
  born: string;
  sex: string;
  nation: string;
  agency: string;
  valid_from: string;
  valid_to: string;
  photo_path: string | null;
  /** false = 演示卡（浏览器预览或台账把这台机切了 Mock），不能当真机读数用 */
  real: boolean;
}

/** 一个 Mifare 数据块的读取结论 */
export interface IcBlockResult {
  sector: number;
  block: number;
  ok: boolean;
  hex: string;
  error: string | null;
}

/** 一次 IC（Mifare）卡探测的结果；只在芯片应答成功时留下，失败原因走 error */
export interface IcCardResult {
  kind_code: number;
  kind_label: string;
  sn: string;
  blocks: IcBlockResult[];
  at: string;
}

/** 介质通道一：身份证（SAM 解密） */
export interface IdCardChannel {
  reading: boolean;
  /** watch 循环在跑：弹窗开着就一直监听，不是一次性点读 */
  watching: boolean;
  /** 监听期间最近一轮"没读到卡"的原因。只给弹窗当进度提示，不进页面级设备告警 */
  watchNote: string | null;
  last: IdCardResult | null;
  error: string | null;
  /** 读一次；命中返回脱敏后的卡片身份，没卡或设备故障返回 null */
  read: (opts?: { photo?: boolean }) => Promise<IdCardResult | null>;
  /**
   * 连续监听：一轮轮读到命中、或设备故障、或被 `stopWatch` 打断才返回。
   * 现场是一次排队放卡的动作，不该要农户跟着按钮的节奏重试。
   */
  watch: (opts?: { photo?: boolean }) => Promise<IdCardResult | null>;
  stopWatch: () => void;
  clear: () => void;
}

/** 介质通道二：IC（Mifare）卡，只读 */
export interface IcChannel {
  reading: boolean;
  last: IcCardResult | null;
  error: string | null;
  read: (opts?: { keyHex?: string; blocks?: [number, number][] }) => Promise<void>;
  clear: () => void;
}

/**
 * 一台读卡器的实时状态。
 *
 * 设备级字段（status / lastProbe）说明"这台机此刻在不在"，介质通道各自说明"这张卡读出来没有"：
 * 精伦 iDR 一台机同时承担身份证与 IC 两条通道，能读哪几条由 `lib/card-reader` 的登记表决定。
 */
export interface CardReaderState {
  status: DeviceStatus;
  probing: boolean;
  /** 最近一次真机探测的结论；null = 还没探过 */
  lastProbe: ReaderProbe | null;
  /** 台账里这台机处于 Mock 模式：身份证通道回演示卡，IC 通道不造假 */
  mocked: boolean;
  setMocked: (v: boolean) => void;
  /** 打开设备问一次 SAM，判断"这台机此刻在不在" */
  probe: () => Promise<ReaderProbe | null>;
  idcard: IdCardChannel;
  ic: IcChannel;
}

export interface DeviceHubState {
  scale: ScaleState;
  reader: CardReaderState;
  camera: { status: DeviceStatus; lastCaptureAt: string | null; busy: boolean };
  printer: { status: DeviceStatus; name: string; busy: boolean; lastError: string | null };
  /** Mock 总开关：关掉后所有外设不可用，用来验收"无外设也能完成闭环"（05 §10-1） */
  mockOff: boolean;
  setMockOff: (v: boolean) => void;
  setScale: (patch: Partial<ScaleState>) => void;
  /** Rust `device://scale` 的一帧落成界面状态（判稳已在后端做完，这里不再二次加工） */
  applyScaleFrame: (r: ScaleReading) => void;
  setCamera: (patch: Partial<DeviceHubState["camera"]>) => void;
  setPrinter: (patch: Partial<DeviceHubState["printer"]>) => void;
}

const initialScale: ScaleState = {
  connected: true,
  onScale: false,
  weight01kg: 0,
  setpoint01kg: 0,
  samples: [],
  stable: true,
  source: "demo",
  rawFrame: null,
  error: null,
  at: null,
  driveOn: () => {},
  driveOff: () => {},
  setConnected: () => {},
  tick: () => {},
};

/** 读卡用的模拟身份：直接取 mock 农户档案第一条，便于把“读卡 → 命中档案 → 带出默认值”串起来 */
const demoParty = ACTIVE_PARTIES.find((p) => p.party_type === "farmer") ?? ACTIVE_PARTIES[0];
const DEMO_CARD: IdCardResult = {
  party_id: demoParty.id,
  name: demoParty.name,
  id_card_no: demoParty.id_card_no,
  address: demoParty.address,
  born: demoParty.id_card_no.slice(6, 14),
  sex: Number(demoParty.id_card_no.slice(16, 17)) % 2 === 1 ? "男" : "女",
  nation: "汉",
  agency: "",
  valid_from: "",
  valid_to: "",
  photo_path: null,
  real: false,
};

const clock = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

/** 芯片字段可能带填充空格；证号一律去空格转大写，否则和档案里的 18 位比对会差一个 X */
const chip = (s: string) => s.trim();
const chipId = (s: string) => s.trim().toUpperCase();

/**
 * 监听轮次之间的停顿。`idcard_read` 内部已经重试 5×300ms，一轮就是两秒上下，
 * 这里再叠高频循环只会把读卡器（进程内单实例、非线程安全）占满，挤掉别的设备命令。
 */
const CARD_WATCH_GAP_MS = 350;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 监听循环的任期号：`stopWatch` 与每次新开监听都让它加一，循环每轮比对一次，
 * 过期就退。只靠 `watching` 挡不住 StrictMode 双跑与重复挂载——旧的先被 stop、
 * 新的再起，手里那条还在轮，真机上就是两条循环抢同一把设备锁。
 */
let cardWatchEpoch = 0;

/**
 * 证号 → 售粮人档案。
 *
 * 走 `api.listParties(证号)` 而不是拉全表比对：真库的证号列是 BLOB（将来密文化后
 * 只能由 Rust 侧解密匹配），档案量级下关键字检索就是最快的一条路。
 */
async function matchParty(idCardNo: string): Promise<number | null> {
  const rows = await api.listParties(idCardNo);
  return rows.find((p) => chipId(p.id_card_no) === idCardNo)?.id ?? null;
}

export const useDeviceStore = create<DeviceHubState>((set, get) => ({
  scale: {
    ...initialScale,
    driveOn: (kg: number) =>
      set((s) => ({
        scale: { ...s.scale, onScale: true, setpoint01kg: Math.round(kg * 10), stable: false },
      })),
    driveOff: () =>
      set((s) => ({ scale: { ...s.scale, onScale: false, setpoint01kg: 0, stable: false, samples: [] } })),
    setConnected: (v: boolean) => set((s) => ({ scale: { ...s.scale, connected: v, stable: v ? s.scale.stable : false } })),
    tick: () => {
      const s = get().scale;
      if (!s.connected) {
        set({ scale: { ...s, weight01kg: 0, stable: false, samples: [] } });
        return;
      }
      const base = s.onScale ? s.setpoint01kg : 0;
      // 上磅初期波动大，逐渐收敛到分度值的半格以内
      const spread = s.onScale ? Math.max(6, Math.round(s.setpoint01kg * 0.0012)) : 4;
      const jitter = Math.round((Math.random() - 0.5) * 2 * spread);
      const raw = Math.max(0, base + jitter);
      const samples = [...s.samples.slice(-(WINDOW - 1)), raw];
      const min = Math.min(...samples);
      const max = Math.max(...samples);
      const stable = samples.length >= WINDOW && max - min <= TOLERANCE;
      const aligned = Math.round(raw / DIVISION) * DIVISION;
      set({
        scale: {
          ...s,
          samples,
          // 显式标回 demo：一旦从真帧流切回模拟心跳，界面不能还挂着"live"说这是仪表读数
          source: "demo",
          weight01kg: stable ? aligned : raw,
          stable,
        },
      });
    },
  },
  reader: {
    status: "unknown",
    probing: false,
    lastProbe: null,
    mocked: false,
    setMocked: (v) => set((s) => ({ reader: { ...s.reader, mocked: v } })),
    probe: async () => {
      const patch = (p: Partial<CardReaderState>) => set((s) => ({ reader: { ...s.reader, ...p } }));
      if (get().mockOff) {
        const r: ReaderProbe = {
          status: "offline",
          connected: false,
          samId: null,
          fingerprint: false,
          error: "外设总开关已关闭，不做真机探测",
          at: clock(),
        };
        patch({ probing: false, status: r.status, lastProbe: r });
        return r;
      }
      if (get().reader.mocked || !runningInTauri()) {
        const r: ReaderProbe = {
          status: "unknown",
          connected: false,
          samId: null,
          fingerprint: false,
          error: get().reader.mocked
            ? "这台读卡器在台账里处于 Mock 模式：身份证通道回演示卡，IC 通道不造假"
            : "当前是浏览器预览，没有原生设备通道",
          at: clock(),
        };
        patch({ probing: false, status: r.status, lastProbe: r });
        return r;
      }
      patch({ probing: true });
      const res = await nativeIdcard.status();
      const at = clock();
      if (!res.available) {
        const r: ReaderProbe = { status: "unknown", connected: false, samId: null, fingerprint: false, error: res.error, at };
        patch({ probing: false, status: r.status, lastProbe: r });
        return r;
      }
      const d = res.data;
      const r: ReaderProbe = d
        ? {
            status: d.connected ? "online" : "offline",
            connected: d.connected,
            samId: d.samId,
            fingerprint: d.fingerprint,
            error: d.error,
            at,
          }
        : { status: "offline", connected: false, samId: null, fingerprint: false, error: res.error ?? "状态查询未返回结果", at };
      patch({ probing: false, status: r.status, lastProbe: r });
      return r;
    },

    /* -------------------------------------------- 通道一：身份证（SAM） */
    idcard: {
      reading: false,
      watching: false,
      watchNote: null,
      last: null,
      error: null,
      read: async (opts) => {
        const st = get();
        const patchCard = (p: Partial<IdCardChannel>) =>
          set((s) => ({ reader: { ...s.reader, idcard: { ...s.reader.idcard, ...p } } }));
        /** 监听中每轮"没卡"是常态：只报给弹窗，别举到页面上当设备告警 */
        const softFail = (reason: string) => {
          if (get().reader.idcard.watching) patchCard({ reading: false, watchNote: reason });
          else patchCard({ reading: false, last: null, error: reason });
        };
        if (st.mockOff) {
          patchCard({ reading: false, last: null, error: "外设已关闭，无法读卡；请改用「搜档案」或手工录入证号" });
          return null;
        }
        if (st.reader.mocked || !runningInTauri()) {
          // 演示通道：浏览器预览或台账把这台机切了 Mock，明确不碰真设备
          patchCard({ reading: true, error: null });
          await sleep(420);
          const demo = { ...DEMO_CARD };
          patchCard({ reading: false, watchNote: null, last: demo, error: null });
          return demo;
        }
        patchCard({ reading: true, error: null });
        const res = await nativeIdcard.read(opts?.photo === true);
        if (!res.available) {
          set((s) => ({
            reader: { ...s.reader, status: "unknown", idcard: { ...s.reader.idcard, reading: false, error: res.error } },
          }));
          return null;
        }
        const d = res.data;
        if (res.error || !d) {
          // 命令本身失败＝设备此刻打不开，状态灯必须跟着下去，不能一边报错一边挂着绿点
          const err = res.error ?? "读卡命令未返回结果";
          set((s) => ({
            reader: {
              ...s.reader,
              status: "offline",
              lastProbe: { status: "offline", connected: false, samId: null, fingerprint: false, error: err, at: clock() },
              idcard: { ...s.reader.idcard, reading: false, error: err },
            },
          }));
          return null;
        }
        if (!d.ok) {
          // 读卡失败不是设备故障（设备刚应答过才走到这里），状态灯维持原样，只把原因送界面
          softFail(d.error ?? "读卡失败，请重新放卡");
          return null;
        }
        const idCardNo = chipId(d.idNumber);
        let partyId: number | null = null;
        let matchError: string | null = null;
        try {
          partyId = await matchParty(idCardNo);
        } catch (e) {
          // 证号已经读到，只是回查档案失败——这句要和"系统里没有这个人"分清楚
          matchError = `证号 ${idCardNo} 已读到，但档案检索失败：${e instanceof Error ? e.message : String(e)}`;
        }
        const card: IdCardResult = {
          party_id: partyId,
          name: chip(d.name),
          id_card_no: idCardNo,
          address: chip(d.address),
          born: chip(d.birth),
          sex: chip(d.gender),
          nation: chip(d.nation),
          agency: chip(d.agency),
          valid_from: chip(d.validFrom),
          valid_to: chip(d.validTo),
          photo_path: d.photoPath,
          real: true,
        };
        set((s) => ({
          reader: {
            ...s.reader,
            status: "online",
            idcard: { ...s.reader.idcard, reading: false, watchNote: null, error: matchError, last: card },
          },
        }));
        return card;
      },
      watch: async (opts) => {
        const patchCard = (p: Partial<IdCardChannel>) =>
          set((s) => ({ reader: { ...s.reader, idcard: { ...s.reader.idcard, ...p } } }));
        // 读卡器只有一台，两个循环并行只会互相抢设备锁；后开的那个直接退让
        if (get().reader.idcard.watching) return null;
        const epoch = ++cardWatchEpoch;
        patchCard({ watching: true, watchNote: null, error: null });
        for (;;) {
          const hit = await get().reader.idcard.read(opts);
          // 关掉弹窗（或又开了新一轮）会换掉任期号：手里这条循环到此为止
          if (epoch !== cardWatchEpoch) return null;
          if (hit) {
            patchCard({ watching: false, watchNote: null });
            return hit;
          }
          // error 只剩设备级故障（"没卡"走 watchNote）——继续轮下去既没用也只会刷屏
          if (get().reader.idcard.error) {
            patchCard({ watching: false });
            return null;
          }
          await sleep(CARD_WATCH_GAP_MS);
          if (epoch !== cardWatchEpoch || !get().reader.idcard.watching) return null;
        }
      },
      stopWatch: () => {
        cardWatchEpoch += 1; // 让在飞的那条循环作废，不等下一轮 read 回来才收手
        set((s) => ({ reader: { ...s.reader, idcard: { ...s.reader.idcard, watching: false, watchNote: null } } }));
      },
      clear: () => set((s) => ({ reader: { ...s.reader, idcard: { ...s.reader.idcard, last: null, error: null } } })),
    },

    /* ---------------------------------------------- 通道二：IC（Mifare） */
    ic: {
      reading: false,
      last: null,
      error: null,
      read: async (opts) => {
        const st = get();
        const patchIc = (p: Partial<IcChannel>) =>
          set((s) => ({ reader: { ...s.reader, ic: { ...s.reader.ic, ...p } } }));
        if (st.mockOff) {
          patchIc({ reading: false, last: null, error: "外设总开关已关闭，IC 卡通道不可用" });
          return;
        }
        // IC 通道没有可演示的假卡：宁可不给结果，也不凭空编一个卡号和块数据出来
        if (st.reader.mocked || !runningInTauri()) {
          patchIc({
            reading: false,
            last: null,
            error: st.reader.mocked
              ? "这台读卡器在台账里是 Mock，IC 通道不给演示数据"
              : "当前是浏览器预览，没有原生设备通道；请用「npm run tauri dev」启动桌面端后重试",
          });
          return;
        }
        patchIc({ reading: true, error: null });
        const res = await nativeIdcard.icRead(opts);
        if (!res.available) {
          patchIc({ reading: false, last: null, error: res.error });
          return;
        }
        const d = res.data;
        if (res.error || !d) {
          // 与身份证通道同一口径：命令失败＝这台机此刻不通，状态灯跟着下去
          const err = res.error ?? "IC 卡读取未返回结果";
          set((s) => ({
            reader: {
              ...s.reader,
              status: "offline",
              lastProbe: { status: "offline", connected: false, samId: null, fingerprint: false, error: err, at: clock() },
              ic: { ...s.reader.ic, reading: false, last: null, error: err },
            },
          }));
          return;
        }
        if (!d.ok) {
          // 没寻到卡、密钥不对都不算设备故障（设备刚应答过），只送原因
          patchIc({ reading: false, last: null, error: d.error ?? "未找到 IC 卡，或扇区密钥不是出厂密钥" });
          return;
        }
        set((s) => ({
          reader: {
            ...s.reader,
            status: "online",
            ic: {
              ...s.reader.ic,
              reading: false,
              error: null,
              last: {
                kind_code: d.kindCode,
                kind_label: d.kindLabel,
                sn: d.sn,
                blocks: d.blocks.map((b) => ({ sector: b.sector, block: b.block, ok: b.ok, hex: b.hex, error: b.error })),
                at: clock(),
              },
            },
          },
        }));
      },
      clear: () => set((s) => ({ reader: { ...s.reader, ic: { ...s.reader.ic, last: null, error: null } } })),
    },
  },
  camera: { status: "online", lastCaptureAt: null, busy: false },
  printer: { status: "online", name: "HP LaserJet M403d", busy: false, lastError: null },
  mockOff: false,
  setMockOff: (v) =>
    set((s) => ({
      mockOff: v,
      scale: { ...s.scale, connected: !v, onScale: v ? false : s.scale.onScale, weight01kg: v ? 0 : s.scale.weight01kg, stable: v ? false : s.scale.stable },
      reader: { ...s.reader, status: v ? "offline" : "unknown", lastProbe: v ? s.reader.lastProbe : null },
      camera: { ...s.camera, status: v ? "offline" : "online" },
      printer: { ...s.printer, status: v ? "offline" : "online" },
    })),
  setScale: (patch) => set((s) => ({ scale: { ...s.scale, ...patch } })),
  applyScaleFrame: (r) => {
    // 关掉外设总开关时丢弃在途帧：读线程可能还挂在串口上，但"无外设闭环"的验收不该看到读数
    if (get().mockOff) return;
    // 只挑界面要用的字段：ScaleReading 还有分度值/均值/帧计数等诊断项，将来界面要用再显式加，
    // 不整体展开进 store——否则 Rust 加一个字段这边就静默多一个没人声明的状态。
    set((s) => ({
      scale: {
        ...s.scale,
        source: "live",
        connected: r.connected,
        onScale: r.onScale,
        weight01kg: r.weight01kg,
        samples: r.samples,
        stable: r.stable,
        rawFrame: r.rawFrame,
        error: r.error,
        at: r.at,
      },
    }));
  },
  setCamera: (patch) => set((s) => ({ camera: { ...s.camera, ...patch } })),
  setPrinter: (patch) => set((s) => ({ printer: { ...s.printer, ...patch } })),
}));

/**
 * 地磅读数心跳：桌面端订 Rust 的 `device://scale` 真帧，浏览器预览跑前端模拟。
 *
 * 三点约定：
 *  - `AppShell`、副屏、设备中心三处共用本 hook，所以串口只开一次（反复 start/stop 会丢帧）；
 *    读线程的归宿是 `RunEvent::Exit`，组件卸载只掉订阅、不关端口。
 *  - 台账里没登记可用的真磅 → 状态灯灰着并说明原因，**不退化成模拟流**。
 *  - `mockOff` 走 selector 进依赖：一关开关就掉订阅，剩下的在途帧也被 `applyScaleFrame` 丢弃。
 */
export function useScaleTick(intervalMs = 220): void {
  const live = runningInTauri() && !useDeviceStore((s) => s.mockOff);
  useEffect(() => {
    if (!live) {
      const id = window.setInterval(() => useDeviceStore.getState().scale.tick(), intervalMs);
      return () => window.clearInterval(id);
    }
    const unsubscribe = subscribeScale(
      (r) => useDeviceStore.getState().applyScaleFrame(r),
      // 事件注册不上（例如事件名两边对不上）也要留一句话，否则界面就只剩"一直没读数"这个谜
      (message) =>
        useDeviceStore.getState().setScale({ source: "live", connected: false, stable: false, error: message }),
    );
    void openRealScale();
    return unsubscribe;
  }, [live, intervalMs]);
}

/** 已发起过开口的标记：三处挂载共用一条流，失败时放开以便下一次挂载重试（配置改对不必重启） */
let scaleOpening = false;

async function openRealScale(): Promise<void> {
  if (scaleOpening) return;
  scaleOpening = true;
  const set = (patch: Partial<ScaleState>) => useDeviceStore.getState().setScale(patch);
  // 先把 connected 压成 false：真帧到位前捕获按钮就该是灰的，不会把 0 当成空磅重量
  set({ source: "live", connected: false, stable: false, error: "正在打开地磅串口…" });
  let failure: string | null = null;
  try {
    const scales = (await api.listDevices()).filter((d) => d.kind === "scale" && d.is_enabled === 1 && d.is_mock === 0);
    const dev = scales.find((d) => d.is_default === 1) ?? scales[0];
    if (dev) {
      // 主窗口与展示窗各有一个 JS 上下文，两边的 scaleOpening 挡不住彼此；
      // 而 scale_start 是"停旧线程 + 重开端口"，展示窗再开一次就是操作员那边凭空丢一帧。
      const live = await nativeScale.status();
      const snap = live.available ? live.data : undefined;
      if (snap?.running && snap.code === dev.code) {
        set({ connected: snap.connected, stable: false, error: snap.error ?? null });
        return;
      }
      const res = await nativeScale.start(dev.code);
      failure = res.error ?? null;
    } else {
      failure = "设备台账里没有启用的真机地磅：请到设备中心登记并启用，工作台可用手工录入继续过磅";
    }
  } catch (e) {
    // 台账通道是会抛的那一类，这里兜住：读数流起不来不该把整页崩掉
    failure = e instanceof Error ? e.message : String(e);
  }
  // 失败才放开标记，下一次挂载（切页回来即可）能重试，配置改对了不必重启应用
  if (failure) scaleOpening = false;
  set({ error: failure });
}
