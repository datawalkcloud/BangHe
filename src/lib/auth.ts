/**
 * 登录与会话的原生通道（02 §11 M10、05 §3 末尾）。
 *
 * 与 `src/lib/native.ts` 分开的理由：那份只管外设（打印、量表），身份与 SQL 走这里，
 * 两边互不牵制。共用的是同一条纪律——**没有 Tauri 通道就如实说**，绝不拿假数据
 * 伪装成"已登录的真实账号"。
 *
 * 浏览器里仍然可以演示（发给客户看的那份）：此时 `channel === "demo"`，
 * 密码不做任何校验。界面必须把它显式挂出来（横幅在 `AppShell` 顶部），不许静悄悄。
 *
 * 类型与 `src-tauri/src/auth.rs` 逐字段对齐（Rust 侧 `rename_all = "camelCase"`）。
 */
import { api } from "@/lib/api";
import { runningInTauri } from "@/lib/native";
import type { Role } from "@/lib/constants";

export interface AuthProfile {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  mustChangePwd: boolean;
}

export interface AuthSession {
  actor: AuthProfile;
  sessionId: string;
  issuedAt: string;
  lastSeenAt: string;
  /** 空闲多久锁屏（不是登出），由后端下发；界面提示"还剩几分钟"用它，不抄常量 */
  idleTtlSecs: number;
  /** 锁屏中：会话仍有效，但业务命令在 Rust 侧一律被拒，直到 unlock 验密 */
  locked: boolean;
}

export interface LoginOutcome {
  ok: boolean;
  error: string | null;
  session: AuthSession | null;
  needsPasswordSetup: boolean | null;
  attemptsLeft: number | null;
  lockedUntil: string | null;
}

export interface ActionOutcome {
  ok: boolean;
  error: string | null;
}

export type Channel = "native" | "demo";

export type AuthCall<T> = { channel: Channel; data?: T; error?: string };

const NO_CHANNEL = "当前是浏览器预览，没有原生登录通道";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<AuthCall<T>> {
  if (!runningInTauri()) return { channel: "demo", error: NO_CHANNEL };
  try {
    const { invoke: raw } = await import("@tauri-apps/api/core");
    return { channel: "native", data: await raw<T>(cmd, args) };
  } catch (e) {
    // 命令本身失败（库读不到、任务 panic）与"没有通道"要分得开，故 channel 不变
    return { channel: "native", error: e instanceof Error ? e.message : String(e) };
  }
}

/** 与 Rust 侧 `bootstrap_password()` 对齐的装机初始密码。
 *  前端只**展示**它出现在哪一步（首启设置密码界面的提示），不参与校验：
 *  真正的判定在 Rust，改这里不会让任何账号变得可登录。 */
export const BOOTSTRAP_HINT = "首次使用请先输入装机时交付的初始密码，再设一个本站自己的";

// ------------------------------------------------------------------- 演示模式

/** 浏览器演示：自动取一名在职站长，不校验任何账号或密码。 */
async function demoSignIn(): Promise<LoginOutcome> {
  const staff = await api.staff();
  const hit = staff.find((u) => u.is_active === 1 && u.role === "station_master") ?? staff.find((u) => u.is_active === 1);
  if (!hit) {
    return { ok: false, error: "账号或密码错误", session: null, needsPasswordSetup: null, attemptsLeft: null, lockedUntil: null };
  }
  return {
    ok: true,
    error: null,
    session: {
      actor: { id: hit.id, username: hit.username, displayName: hit.display_name, role: hit.role, mustChangePwd: false },
      sessionId: "demo",
      issuedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      // 演示模式没有服务端会话，自然也没有空闲锁屏
      idleTtlSecs: 0,
      locked: false,
    },
    needsPasswordSetup: false,
    attemptsLeft: null,
    lockedUntil: null,
  };
}

function demoUnsupported(): AuthCall<never> {
  return { channel: "demo", error: "浏览器演示模式没有真实密码，改密与授权均不可用" };
}

// ----------------------------------------------------------------------- 通道

/** WebView 刷新 / HMR 后 JS 状态全丢，用这条问后端"我还在登录态里吗" */
export async function restore(): Promise<AuthCall<AuthSession | null>> {
  if (!runningInTauri()) {
    const outcome = await demoSignIn();
    return { channel: "demo", data: outcome.session, error: outcome.error ?? undefined };
  }
  return invoke<AuthSession | null>("auth_session");
}

export async function signIn(username: string, password: string): Promise<AuthCall<LoginOutcome>> {
  if (!runningInTauri()) {
    return { channel: "demo", data: await demoSignIn() };
  }
  return invoke<LoginOutcome>("auth_login", { username, password });
}

export async function signOut(): Promise<AuthCall<ActionOutcome>> {
  if (!runningInTauri()) return { channel: "demo", data: { ok: true, error: null } };
  return invoke<ActionOutcome>("auth_logout");
}

/** 活动心跳。回 `data:false` 表示已锁屏（会话还在），前端弹锁屏浮层 */
export async function beat(): Promise<AuthCall<boolean>> {
  if (!runningInTauri()) return { channel: "demo", data: true };
  return invoke<boolean>("auth_touch");
}

/** 手动锁屏（左下角入口）：只置锁不登出，解锁同样走 unlock。演示模式没有服务端会话，就地锁 */
export async function lockNow(): Promise<AuthCall<ActionOutcome>> {
  if (!runningInTauri()) return { channel: "demo", data: { ok: true, error: null } };
  return invoke<ActionOutcome>("auth_lock");
}

/** 锁屏解锁：只输当前登录人的密码，会话本身不变（审计链不断）。回执同登录（连错计数、锁定倒计时） */
export async function unlock(password: string): Promise<AuthCall<LoginOutcome>> {
  if (!runningInTauri()) return { channel: "demo", error: NO_CHANNEL };
  return invoke<LoginOutcome>("auth_unlock", { password });
}

/** 首启设置密码与日常改密共用：`old` 在首启时就是装机初始密码 */
export async function setPassword(old: string, fresh: string): Promise<AuthCall<ActionOutcome>> {
  if (!runningInTauri()) return demoUnsupported();
  return invoke<ActionOutcome>("auth_change_password", { old, new: fresh });
}

export async function resetPassword(target: number): Promise<AuthCall<ActionOutcome>> {
  if (!runningInTauri()) return demoUnsupported();
  return invoke<ActionOutcome>("auth_reset_password", { target });
}

/** 破坏性操作的站长授权（作废 / 红冲 / 补打 / 皮重越权，05 §10-7） */
export async function verifySupervisor(username: string, password: string): Promise<AuthCall<ActionOutcome>> {
  if (!runningInTauri()) return demoUnsupported();
  return invoke<ActionOutcome>("auth_verify_supervisor", { username, password });
}
