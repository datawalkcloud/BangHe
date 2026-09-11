/**
 * 设备实时状态（zustand）。
 *
 * 只放"高频、非服务端状态"——设备读数、判稳、抓拍中、桥接进程存活。
 * 业务数据一律走 react-query，不进这里（05 §8）。
 *
 * 当前为模拟流：真实实现由 Rust 侧 `DeviceHub` 以 tauri event `device://scale`
 * 推送解析后的通用帧（04 文档 §4），前端只做订阅，判稳逻辑留在 Rust。
 * 这里把判稳放前端是为了在没有 Rust 的情况下也能演示"不稳定 → 稳定 → 可捕获"。
 */
import { create } from "zustand";
import { useEffect } from "react";
import type { DeviceStatus } from "@/lib/constants";
import { ACTIVE_PARTIES } from "@/mock/masters";

/** 判稳窗口与容差取自站点参数，默认 1500 ms / 5.0 kg（= 50 个 0.1kg） */
const WINDOW = 5;
const TOLERANCE = 50;
const DIVISION = 100; // 10 kg 分度

export interface ScaleState {
  connected: boolean;
  onScale: boolean;
  /** 当前读数，0.1kg 整数 */
  weight01kg: number;
  /** 车上"真值"，用于生成抖动 */
  setpoint01kg: number;
  samples: number[];
  stable: boolean;
  /** 手动把车开上磅 / 开下磅（演示用） */
  driveOn: (kg: number) => void;
  driveOff: () => void;
  setConnected: (v: boolean) => void;
  tick: () => void;
}

export interface IdCardState {
  status: DeviceStatus;
  reading: boolean;
  /** 读卡结果，明文只在内存，界面必须走 maskIdCard */
  last: { party_id: number; name: string; id_card_no: string; address: string; born: string; sex: string } | null;
  error: string | null;
  read: () => Promise<void>;
  clear: () => void;
}

export interface DeviceHubState {
  scale: ScaleState;
  idcard: IdCardState;
  camera: { status: DeviceStatus; lastCaptureAt: string | null; busy: boolean };
  printer: { status: DeviceStatus; name: string; busy: boolean; lastError: string | null };
  /** Mock 总开关：关掉后所有外设不可用，用来验收"无外设也能完成闭环"（05 §10-1） */
  mockOff: boolean;
  setMockOff: (v: boolean) => void;
  setScale: (patch: Partial<ScaleState>) => void;
  setIdCard: (patch: Partial<IdCardState>) => void;
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
  driveOn: () => {},
  driveOff: () => {},
  setConnected: () => {},
  tick: () => {},
};

/** 读卡用的模拟身份：直接取 mock 农户档案第一条，便于把“读卡 → 命中档案 → 带出默认值”串起来 */
const demoParty = ACTIVE_PARTIES.find((p) => p.party_type === "farmer") ?? ACTIVE_PARTIES[0];
const DEMO_CARD = {
  party_id: demoParty.id,
  name: demoParty.name,
  id_card_no: demoParty.id_card_no,
  address: demoParty.address,
  born: demoParty.id_card_no.slice(6, 14),
  sex: Number(demoParty.id_card_no.slice(16, 17)) % 2 === 1 ? "男" : "女",
};

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
          weight01kg: stable ? aligned : raw,
          stable,
        },
      });
    },
  },
  idcard: {
    status: "online",
    reading: false,
    last: null,
    error: null,
    read: async () => {
      const st = get();
      if (st.mockOff || st.idcard.status !== "online") {
        set({ idcard: { ...st.idcard, error: st.mockOff ? "Mock 已关闭，无法读卡；请改用手工录入" : "桥接进程未启动", last: null } });
        return;
      }
      set({ idcard: { ...st.idcard, reading: true, error: null } });
      // 32 位 SDK 需 x86 桥接子进程，冷启动实测 300–1500 ms（04 文档 §5）
      await new Promise((r) => setTimeout(r, 420));
      set((s) => ({ idcard: { ...s.idcard, reading: false, last: { ...DEMO_CARD }, error: null } }));
    },
    clear: () => set((s) => ({ idcard: { ...s.idcard, last: null, error: null } })),
  },
  camera: { status: "online", lastCaptureAt: null, busy: false },
  printer: { status: "online", name: "HP LaserJet M403d", busy: false, lastError: null },
  mockOff: false,
  setMockOff: (v) =>
    set((s) => ({
      mockOff: v,
      scale: { ...s.scale, connected: !v, onScale: v ? false : s.scale.onScale, weight01kg: v ? 0 : s.scale.weight01kg, stable: v ? false : s.scale.stable },
      idcard: { ...s.idcard, status: v ? "offline" : "online" },
      camera: { ...s.camera, status: v ? "offline" : "online" },
      printer: { ...s.printer, status: v ? "offline" : "online" },
    })),
  setScale: (patch) => set((s) => ({ scale: { ...s.scale, ...patch } })),
  setIdCard: (patch) => set((s) => ({ idcard: { ...s.idcard, ...patch } })),
  setCamera: (patch) => set((s) => ({ camera: { ...s.camera, ...patch } })),
  setPrinter: (patch) => set((s) => ({ printer: { ...s.printer, ...patch } })),
}));

/** 订阅地磅读数流；真实实现里换成 listen("device://scale") 推事件，不再轮询 */
export function useScaleTick(intervalMs = 220): void {
  useEffect(() => {
    const id = window.setInterval(() => useDeviceStore.getState().scale.tick(), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
}
