/**
 * 设备实时状态（zustand）。
 *
 * 只放"高频、非服务端状态"——设备读数、判稳、抓拍中、桥接进程存活。
 * 业务数据一律走 react-query，不进这里（05 §8）。
 *
 * 读数流只有一条路（04 §2、§4）：桌面端订阅 Rust 的 tauri event `device://scale`，切帧/取数/判稳
 * 全在 `scale.rs` 做完，这里只把可用的结论落成界面状态。**台账里没有启用的真磅就是"离线 + 一句
 * 原因"**，绝不拿模拟抖动顶上——过磅是要结算的，假读数比没读数危险得多。浏览器预览没有原生通道，
 * 界面就停在未连接并说明原因。
 *
 * 读卡器已经走真机：Rust `idcard.rs` 加载 64 位 Sdtapi.dll 直调精伦 iDR，一台机承担身份证
 * 与 IC（Mifare）两条介质通道（能读哪几条由 `lib/card-reader` 的登记表决定）。本 store 只把
 * `nativeIdcard` 的三个命令（status / read / ic_read）收成一份界面状态，让设备中心、工作台 F8、
 * 档案页读卡看到的是同一台读卡器、同一句失败原因。
 *
 * **开真机的前提与地磅同一口径：台账里得有一行「启用」的证卡阅读器**（`registered`，由
 * 底栏从 `["devices"]` 查询算出并同步）。USB 上插着读卡器 ≠ 本站登记了它——读卡带出的是
 * 真实公民 PII，没建档进台账的设备绝不能悄悄可用；未启用时三条通道一律给"请到设备中心
 * 登记并启用"这句原因。设备中心登记表单里的「本机设备自检」不走这条闸门（入台账前本来就
 * 要能测得到），它直接调 `nativeIdcard.status`。
 */
import { create } from "zustand";
import { useEffect } from "react";
import { api } from "@/lib/api";
import { nativeIdcard, runningInTauri } from "@/lib/native";
import { nativeScale, subscribeScale, type ScaleReading } from "@/lib/scale-native";
import type { DeviceStatus } from "@/lib/constants";
import { ACTIVE_PARTIES } from "@/mock/masters";

/** 读数出处：`live` = Rust 串口线程解析出的真帧，`demo` = 还没收到过任何真帧（浏览器预览 / 未连上仪表） */
export type ScaleSource = "live" | "demo";

export interface ScaleState {
  connected: boolean;
  onScale: boolean;
  /** 当前读数，0.1kg 整数 */
  weight01kg: number;
  samples: number[];
  stable: boolean;
  source: ScaleSource;
  /** 原帧的可读形式：`weigh_record.raw_frame` 落库用它（迎检要能对回原始报文）；模拟流没有，回 null */
  rawFrame: string | null;
  /** 最近一次失败原因的中文短句（台账没登记磅 / 串口打不开 / 帧解析失败），界面直接显示这一句 */
  error: string | null;
  /** 最近一帧的本地时刻，界面据此说明这条读数新不新 */
  at: string | null;
  /**
   * 这一帧来自台账里的**哪台磅**（`device_config.code`）。读数流是全局单槽（一次只开一条串口），
   * 而设备中心可以选中任意一行磅来开面板：没有这个归属，面板就会把别的磅的在线结论回写到
   * 当前选中行的状态灯上——绿灯挂错设备比不绿更糟。演示/浏览器预览里是 null。
   */
  code: string | null;
  /** 这帧是从哪个串口来的（打不开/掉线时要说清是哪条链路） */
  port: string | null;
  /* ---- 判稳依据快照：界面说的数就是后端判的那几条，不再各写一份默认值 ---- */
  /** 窗口内均值（0.1 kg） */
  mean01kg: number;
  /** 分度（0.1 kg） */
  division01kg: number;
  /** 窗口极差（0.1 kg） */
  spread01kg: number;
  /** 窗口首尾帧实际时长（ms） */
  windowMs: number;
  /** 判稳所需帧数下限（`stability.window_frames`） */
  windowFrames: number;
  /** 容差（0.1 kg）= `max_spread_divisions × division_01kg` */
  tolerance01kg: number;
  /** 窗口需持续多久（ms，`stability.stable_ms`） */
  stableMs: number;
  /** 累计解析成功的帧数 */
  frameCount: number;
  /** 累计校验/解析失败帧数 */
  errCount: number;
  setConnected: (v: boolean) => void;
}

/**
 * 台账闸门的统一说法（与 openRealScale 的"没有启用的真机地磅"同一段式）：
 * 三条通道（probe / 读身份证 / 读 IC）在未登记时都回这一句，界面不必各编各的。
 */
const READER_NOT_REGISTERED =
  "设备台账里没有启用的证卡阅读器：请到设备中心登记并启用后再读卡；制单可继续用「搜档案」或手工录入证号";

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
  /** watch 循环在跑：工作台默认常听，弹窗要读身份证时挂起 */
  watching: boolean;
  /** 监听期间最近一轮"没寻到卡/密钥不对"的原因，只给编排器当进度提示，不进设备告警 */
  watchNote: string | null;
  last: IcCardResult | null;
  error: string | null;
  read: (opts?: { keyHex?: string; blocks?: [number, number][] }) => Promise<IcCardResult | null>;
  /**
   * 连续监听：**新的一刷**（换了一张卡，或天线空过一次之后再放上）才返回那张卡；
   * 设备故障、或被 `stopWatch` 打断返回 null。卡压在感应区不动不算第二刷（见 `icPresentSn`）。
   */
  watch: () => Promise<IcCardResult | null>;
  stopWatch: () => void;
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
  /**
   * 台账里有没有**启用**的证卡阅读器（`kind='idcard' && is_enabled=1` 的行存在）。
   * 真机三条通道开设备前都先过这道闸；与 mocked 同由底栏从 `["devices"]` 算出并同步，
   * 默认 false——查清台账前宁可先不给开真机，也不会有人拿没登记的读卡器悄悄读证。
   */
  registered: boolean;
  setRegistered: (v: boolean) => void;
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
  /**
   * 制单/登记弹窗正占用身份证通道（06 §1.2 设备互斥）：IC 常听循环据此让出读卡器。
   * 原先「弹窗让位」由各父页面各自 pause；顶部工具条也能开这张弹窗后，标记收进弹窗自己维护，
   * 父页面不必再各自记得。
   */
  regHolding: boolean;
  setRegHolding: (v: boolean) => void;
  setScale: (patch: Partial<ScaleState>) => void;
  /** Rust `device://scale` 的一帧落成界面状态（判稳已在后端做完，这里不再二次加工） */
  applyScaleFrame: (r: ScaleReading) => void;
  setCamera: (patch: Partial<DeviceHubState["camera"]>) => void;
  setPrinter: (patch: Partial<DeviceHubState["printer"]>) => void;
}

const initialScale: ScaleState = {
  connected: false,
  onScale: false,
  weight01kg: 0,
  samples: [],
  stable: true,
  source: "demo",
  rawFrame: null,
  error: null,
  at: null,
  code: null,
  port: null,
  /** 全 0 = 还没收到过真帧；这些数只由后端那一帧带来，界面不自己抄一份默认值 */
  mean01kg: 0,
  division01kg: 0,
  spread01kg: 0,
  windowMs: 0,
  windowFrames: 0,
  tolerance01kg: 0,
  stableMs: 0,
  frameCount: 0,
  errCount: 0,
  setConnected: () => {},
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
  // 演示通道也给一张"卡面照片"：浏览器预览要能跑通「读卡 → 自动带出人像 → 保存进档案」
  // 这条链（mock 侧只判路径空不空，不会真去读文件），否则演示里这条新功能永远看不见。
  photo_path: "演示：身份证照片.bmp",
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
/** IC 通道的监听任期号，与身份证通道各一条：两条通道共用一台读卡器，靠调用方（编排器/弹窗）
 *  先 stopWatch 一条再起另一条来互斥，epoch 只负责让"手里那条"在被打断后干净退出。 */
let icWatchEpoch = 0;

/**
 * IC 监听"此刻天线上压着的那张卡"——边沿触发的依据（06 §4.2 防连击）。
 *
 * 真机上卡往感应区一放就不动，循环会一轮轮读到**同一个 sn**：不去重就是每张外来卡
 * 一个红框刷屏，而只按时间窗口去重又挡不住"毛重捕完 1.5 s 后同一张没挪窝的卡把皮重也捕了"
 * （净重 0，直接算错钱）。所以一刷的判据用物理边沿：**换卡**或**天线空过一次后再放上**才算新命中。
 * 复位只靠空读，`stopWatch` 不清——弹窗让位再回来时，压在下面的同一张卡不该再算一刷。
 */
let icPresentSn: string | null = null;

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
    setConnected: (v: boolean) => set((s) => ({ scale: { ...s.scale, connected: v, stable: v ? s.scale.stable : false } })),
  },
  reader: {
    status: "unknown",
    probing: false,
    lastProbe: null,
    mocked: false,
    setMocked: (v) => set((s) => ({ reader: { ...s.reader, mocked: v } })),
    registered: false,
    setRegistered: (v) => set((s) => ({ reader: { ...s.reader, registered: v } })),
    probe: async () => {
      const patch = (p: Partial<CardReaderState>) => set((s) => ({ reader: { ...s.reader, ...p } }));
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
      // 台账闸门：没登记/没启用就压根不开这台 USB 设备——机器插着读卡器不代表本站要读卡
      if (!get().reader.registered) {
        const r: ReaderProbe = {
          status: "unknown",
          connected: false,
          samId: null,
          fingerprint: false,
          error: READER_NOT_REGISTERED,
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
        if (st.reader.mocked || !runningInTauri()) {
          // 演示通道：浏览器预览或台账把这台机切了 Mock，明确不碰真设备
          patchCard({ reading: true, error: null });
          await sleep(420);
          const demo = { ...DEMO_CARD };
          patchCard({ reading: false, watchNote: null, last: demo, error: null });
          return demo;
        }
        // 台账闸门（文件头约定）：写 error 而不是 watchNote，监听循环据此停下——未登记是配置态，轮下去没有意义
        if (!st.reader.registered) {
          patchCard({ reading: false, last: null, error: READER_NOT_REGISTERED });
          return null;
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
      watching: false,
      watchNote: null,
      last: null,
      error: null,
      read: async (opts) => {
        const st = get();
        const patchIc = (p: Partial<IcChannel>) =>
          set((s) => ({ reader: { ...s.reader, ic: { ...s.reader.ic, ...p } } }));
        /** 监听中每轮"没寻到卡/密钥不对"是常态：只报进度，别举到设备告警，好让 watch 继续轮 */
        const softFail = (reason: string) => {
          if (get().reader.ic.watching) patchIc({ reading: false, watchNote: reason });
          else patchIc({ reading: false, last: null, error: reason });
        };
        // IC 通道没有可演示的假卡：宁可不给结果，也不凭空编一个卡号和块数据出来
        if (st.reader.mocked || !runningInTauri()) {
          patchIc({
            reading: false,
            last: null,
            error: st.reader.mocked
              ? "这台读卡器在台账里是 Mock，IC 通道不给演示数据"
              : "当前是浏览器预览，没有原生设备通道；请用「npm run tauri dev」启动桌面端后重试",
          });
          return null;
        }
        // 台账闸门：与身份证通道同一条，未登记不开设备
        if (!st.reader.registered) {
          patchIc({ reading: false, last: null, error: READER_NOT_REGISTERED });
          return null;
        }
        patchIc({ reading: true, error: null });
        const res = await nativeIdcard.icRead(opts);
        if (!res.available) {
          patchIc({ reading: false, last: null, error: res.error });
          return null;
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
          return null;
        }
        if (!d.ok) {
          // 没寻到卡、密钥不对都不算设备故障（设备刚应答过），只送原因
          softFail(d.error ?? "未找到 IC 卡，或扇区密钥不是出厂密钥");
          return null;
        }
        const result: IcCardResult = {
          kind_code: d.kindCode,
          kind_label: d.kindLabel,
          sn: d.sn,
          blocks: d.blocks.map((b) => ({ sector: b.sector, block: b.block, ok: b.ok, hex: b.hex, error: b.error })),
          at: clock(),
        };
        set((s) => ({
          reader: {
            ...s.reader,
            status: "online",
            ic: { ...s.reader.ic, reading: false, error: null, watchNote: null, last: result },
          },
        }));
        return result;
      },
      watch: async () => {
        const patchIc = (p: Partial<IcChannel>) =>
          set((s) => ({ reader: { ...s.reader, ic: { ...s.reader.ic, ...p } } }));
        // 一台读卡器同一时刻只跑一条循环；已在监听就退让，避免重复挂载互相抢设备锁
        if (get().reader.ic.watching) return null;
        const epoch = ++icWatchEpoch;
        patchIc({ watching: true, watchNote: null, error: null });
        for (;;) {
          // 发卡/定位只需卡号，传空 blocks 跳过密钥认证读块（06 §6.1）
          const hit = await get().reader.ic.read({ blocks: [] });
          if (epoch !== icWatchEpoch) return null;
          if (hit) {
            // 芯片串可能带填充空格，比对用归一后的串，否则同一张卡会被当成两张、又开始刷屏
            const sn = hit.sn.trim().toUpperCase();
            // 还是天线上那张卡＝同一次压卡，不算新一刷：继续轮，等它挪开或换卡（06 §4.2）
            if (sn === icPresentSn) {
              await sleep(CARD_WATCH_GAP_MS);
              if (epoch !== icWatchEpoch || !get().reader.ic.watching) return null;
              continue;
            }
            icPresentSn = sn;
            patchIc({ watching: false, watchNote: null });
            return hit;
          }
          // 空读＝天线上当前的卡已经拿走：边沿复位，下一次放卡才算新的一刷
          icPresentSn = null;
          // error 只剩设备级故障（"没卡"走 watchNote）——继续轮没意义也只会刷屏
          if (get().reader.ic.error) {
            patchIc({ watching: false });
            return null;
          }
          await sleep(CARD_WATCH_GAP_MS);
          if (epoch !== icWatchEpoch || !get().reader.ic.watching) return null;
        }
      },
      stopWatch: () => {
        icWatchEpoch += 1; // 让在飞那条循环作废，不等下一轮 read 回来才收手
        set((s) => ({ reader: { ...s.reader, ic: { ...s.reader.ic, watching: false, watchNote: null } } }));
      },
      clear: () => set((s) => ({ reader: { ...s.reader, ic: { ...s.reader.ic, last: null, error: null, watchNote: null } } })),
    },
  },
  camera: { status: "online", lastCaptureAt: null, busy: false },
  printer: { status: "online", name: "HP LaserJet M403d", busy: false, lastError: null },
  regHolding: false,
  setRegHolding: (v) => set({ regHolding: v }),
  setScale: (patch) => set((s) => ({ scale: { ...s.scale, ...patch } })),
  applyScaleFrame: (r) => {
    // 仍然逐字段挑，不整体展开：界面要的是读数 + 判稳依据 + 这帧属于哪台磅；
    // Rust 侧新增的诊断字段（`deviceId`、`errorKind`）没界面用就先不落 store，
    // 否则加一个字段这边就静默多一个没人声明的状态。
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
        code: r.code,
        port: r.port,
        mean01kg: r.mean01kg,
        division01kg: r.division01kg,
        spread01kg: r.spread01kg,
        windowMs: r.windowMs,
        windowFrames: r.windowFrames,
        tolerance01kg: r.tolerance01kg,
        stableMs: r.stableMs,
        frameCount: r.frameCount,
        errCount: r.errCount,
      },
    }));
  },
  setCamera: (patch) => set((s) => ({ camera: { ...s.camera, ...patch } })),
  setPrinter: (patch) => set((s) => ({ printer: { ...s.printer, ...patch } })),
}));

/**
 * 地磅读数流挂载：桌面端订 Rust 的 `device://scale` 真帧。
 *
 * 三条约定：
 *  - `AppShell`、副屏、设备中心三处共用本 hook，所以串口只开一次（反复 start/stop 会丢帧）；
 *    读线程的归宿是 `RunEvent::Exit`，组件卸载只掉订阅、不关端口。
 *  - 台账里没有启用的真磅（含只登记成 Mock 的）→ 状态灯说明原因，**不退化成模拟流**
 *    （过磅要结算，凭空抖动比没读数危险）。
 *  - 浏览器预览没有原生通道：不去开一个不存在的串口，界面停在未连接并说明原因。
 */
export function useScaleTick(): void {
  useEffect(() => {
    if (!runningInTauri()) {
      useDeviceStore.getState().setScale({
        connected: false,
        stable: false,
        error: "当前是浏览器预览，没有原生设备通道：请用「npm run tauri dev」启动桌面端后重试",
      });
      return;
    }
    const unsubscribe = subscribeScale(
      (r) => useDeviceStore.getState().applyScaleFrame(r),
      // 事件注册不上（例如事件名两边对不上）也要留一句话，否则界面就只剩"一直没读数"这个谜
      (message) =>
        useDeviceStore.getState().setScale({ source: "live", connected: false, stable: false, error: message }),
    );
    void openRealScale();
    return unsubscribe;
  }, []);
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
