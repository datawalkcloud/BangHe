/**
 * 当前操作员身份。
 *
 * P0 未上登录，用"选择操作员"轻量切换（05 §3 末尾的务实做法）：
 * 所有写操作携带该 id 作为署名，P1 换成口令登录后 actor_id 机制完全不变。
 */
import { create } from "zustand";
import type { UserAccount } from "@/mock/types";
import type { Role } from "@/lib/constants";

export const PERMISSIONS: Record<string, Role[]> = {
  "order.create": ["station_master", "registrar", "weigher"],
  "order.void": ["station_master", "registrar", "weigher"],
  "order.reverse": ["station_master"],
  "tare.override": ["station_master"],
  "price.edit": ["station_master"],
  "price.override": ["station_master"],
  "qc.save": ["station_master", "inspector"],
  "weigh.capture": ["station_master", "weigher"],
  "weigh.manual": ["station_master", "weigher"],
  "settle.create": ["station_master", "cashier"],
  "settle.revoke": ["station_master"],
  "pay.record": ["station_master", "cashier"],
  "print": ["station_master", "registrar", "weigher", "inspector", "keeper", "cashier"],
  "reprint": ["station_master"],
  "setting.write": ["station_master"],
  "data.export": ["station_master", "cashier", "viewer", "keeper"],
  "device.manage": ["station_master"],
};

interface SessionState {
  operator: UserAccount | null;
  setOperator: (u: UserAccount | null) => void;
  can: (permission: string) => boolean;
}

export const useSession = create<SessionState>((set, get) => ({
  operator: null,
  setOperator: (u) => set({ operator: u }),
  can: (permission) => {
    const op = get().operator;
    if (!op) return false;
    if (op.role === "station_master") return true;
    const allowed = PERMISSIONS[permission];
    return allowed ? allowed.includes(op.role) : false;
  },
}));
