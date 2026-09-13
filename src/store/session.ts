/**
 * 当前登录会话（02 §11 M10 落地后的样子）。
 *
 * 这里只是 **Rust 会话的一份投影**：谁是当前操作员、他的岗位是什么、能不能做某事，
 * 真相在 `src-tauri/src/auth.rs` 里的那个 `Option<Session>`。前端这份丢了刷新一下
 * 就能用 `restore()` 拿回来（WebView 刷新、HMR 都不必重打密码）。
 *
 * 两条不能弯的：
 *  1. 未登录拿不到署名。`actorId()` 在没有会话时**抛错**而不是回 0——
 *     审计写成 0 号是"看着成功、事后查不到人"，比当场炸出来更难收拾。
 *     路由守卫保证正常操作到不了那一步，真抛错说明有绕过守卫的入口。
 *  2. `can()` 只管界面显隐（05 §5），命令层的权限校验在 Rust 侧做，两边不互相替代。
 */
import { create } from "zustand";
import type { Role } from "@/lib/constants";
import * as auth from "@/lib/auth";
import type { AuthProfile, AuthSession, LoginOutcome, ActionOutcome } from "@/lib/auth";

/** 岗位 → 能力集。前端用来隐藏按钮；后端命令层同样要校验（02 §11 RBAC） */
export const PERMISSIONS: Record<string, Role[]> = {
  "order.create": ["station_master", "registrar", "weigher"],
  "order.void": ["station_master", "registrar", "weigher"],
  "order.reverse": ["station_master"],
  /** 补录/改派入仓去向：值仓的活（02 §11），站长兜底 */
  "order.destination": ["station_master", "keeper"],
  /** 调整业务定级：化验员定级、出纳结算时改判，站长兜底（与 Rust GRADE_ROLES 同源） */
  "order.grade": ["station_master", "inspector", "cashier"],
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
  "backup.manage": ["station_master", "cashier"],
  "backup.restore": ["station_master"],
  "device.manage": ["station_master"],
};

type Phase =
  /** 还没问过 Rust，界面什么都不该画（避免闪一下登录页） */
  | "checking"
  /** 未登录 / 主动登出（空闲不再登出，只锁屏，见 `locked`） */
  | "out"
  /** 有会话，但可能仍被要求先设密码 */
  | "in";

interface SessionState {
  phase: Phase;
  /** 浏览器预览：密码不校验，界面必须显式挂横幅 */
  demo: boolean;
  session: AuthSession | null;
  /** 锁屏中：登录态永久有效，空闲 1 小时只是要一次密码确认人还没走 */
  locked: boolean;
  /** 上一次动作的回执文案（登录失败原因、锁定倒计时等），由登录页消费后清空 */
  notice: string | null;
  /** 组件内用法：`const canPrint = useSession((s) => s.can("print"))` */
  can: (permission: string) => boolean;
  boot: () => Promise<void>;
  signIn: (username: string, password: string) => Promise<LoginOutcome>;
  signOut: () => Promise<void>;
  /** 心跳：无操作超过后端给的 idleTtlSecs 即锁屏（不登出），返回 false 时调用方交给浮层 */
  beat: () => Promise<boolean>;
  /** 本地判定空闲超限（机器休眠、时钟跳变）：就地锁屏，Rust 的 last_seen 才是真相 */
  lock: (reason?: string) => void;
  /** 主动锁屏（左下角入口）：先让 Rust 置锁（业务命令随即被拒），再弹浮层 */
  lockScreen: () => Promise<void>;
  /** 锁屏解锁：只验本人密码，会话与审计链不变；失败回执带剩余次数 / 锁定时间 */
  unlock: (password: string) => Promise<LoginOutcome>;
  setPassword: (old: string, fresh: string) => Promise<ActionOutcome>;
  setNotice: (text: string | null) => void;
}

/** 岗位够不够做某件事。站长全量放行，其余查表（05 §5） */
function roleAllows(actor: AuthProfile | null | undefined, permission: string): boolean {
  if (!actor) return false;
  if (actor.role === "station_master") return true;
  return PERMISSIONS[permission]?.includes(actor.role) ?? false;
}

/** boot() 只真正跑一次，其余调用等同 await 第一次的结果 */
let booted: Promise<void> | null = null;

export const useSession = create<SessionState>((set, get) => ({
  phase: "checking",
  demo: false,
  session: null,
  locked: false,
  notice: null,
  can: (permission) => roleAllows(get().session?.actor, permission),

  boot: () => {
    if (!booted) {
      booted = (async () => {
        const r = await auth.restore();
        if (r.channel === "native" && r.error) {
          // 问不到会话就当没登录：宁可多要一次密码，也不猜一个身份出来
          set({ phase: "out", session: null, locked: false, demo: false, notice: r.error });
          return;
        }
        set({
          phase: r.data ? "in" : "out",
          session: r.data ?? null,
          locked: r.data?.locked ?? false,
          demo: r.channel === "demo",
        });
      })();
    }
    return booted;
  },

  signIn: async (username, password) => {
    const r = await auth.signIn(username, password);
    const outcome: LoginOutcome =
      r.data ??
      ({
        ok: false,
        error: r.error ?? "登录未完成",
        session: null,
        needsPasswordSetup: null,
        attemptsLeft: null,
        lockedUntil: null,
      } satisfies LoginOutcome);
    if (outcome.ok && outcome.session) {
      set({ phase: "in", session: outcome.session, locked: outcome.session.locked, demo: r.channel === "demo", notice: outcome.error });
    } else {
      set({ notice: outcome.error });
    }
    return outcome;
  },

  signOut: async () => {
    await auth.signOut();
    set({ phase: "out", session: null, locked: false, notice: null });
  },

  beat: async () => {
    const s = get();
    if (s.phase !== "in" || s.demo) return true;
    const r = await auth.beat();
    // 通道错误不等于锁屏：问不到就当还在，避免网络/进程抖动把磅员踢进锁屏
    if (r.channel === "native" && r.error) return true;
    if (r.data === false) {
      get().lock("无操作超时，已自动锁屏");
      return false;
    }
    return true;
  },

  lock: (reason) =>
    set((s) => ({
      locked: true,
      session: s.session ? { ...s.session, locked: true } : null,
      notice: reason ?? "已锁屏，需验证身份后继续",
    })),

  lockScreen: async () => {
    const s = get();
    if (s.phase !== "in" || s.locked) return;
    // 演示模式没有服务端会话，auth.lockNow 直接回 ok；桌面端先置锁再弹层，顺序反了会漏开放行窗口
    await auth.lockNow();
    get().lock("已在左下角手动锁屏");
  },

  unlock: async (password) => {
    if (get().demo) {
      // 演示模式密码本就不校验（顶部有横幅），锁屏也只当摆设：给个密码形状就放行
      set((s) => ({ locked: false, session: s.session ? { ...s.session, locked: false } : null, notice: null }));
      return { ok: true, error: null, session: null, needsPasswordSetup: null, attemptsLeft: null, lockedUntil: null };
    }
    const r = await auth.unlock(password);
    const outcome: LoginOutcome =
      r.data ??
      ({
        ok: false,
        error: r.error ?? "解锁未完成",
        session: null,
        needsPasswordSetup: null,
        attemptsLeft: null,
        lockedUntil: null,
      } satisfies LoginOutcome);
    if (outcome.ok) {
      set((s) => ({ locked: false, session: s.session ? { ...s.session, locked: false } : null, notice: null }));
    } else {
      set({ notice: outcome.error });
    }
    return outcome;
  },

  setPassword: async (old, fresh) => {
    const r = await auth.setPassword(old, fresh);
    const outcome: ActionOutcome = r.data ?? { ok: false, error: r.error ?? "设置密码未完成" };
    if (outcome.ok) {
      const s = get().session;
      if (s) set({ session: { ...s, actor: { ...s.actor, mustChangePwd: false } } });
    }
    return outcome;
  },

  setNotice: (text) => set({ notice: text }),
}));

export const useActor = (): AuthProfile | null => useSession((s) => s.session?.actor ?? null);

export const useMustChangePwd = (): boolean => useSession((s) => s.session?.actor.mustChangePwd ?? false);

/** 写操作署名。未登录时抛错，见文件头第 1 条 */
export function actorId(): number {
  const actor = useSession.getState().session?.actor;
  if (!actor) throw new Error("未登录：写操作没有署名，已阻止提交");
  return actor.id;
}

/** 需要"当前是谁"的界面用这个，别在组件里再写一遍 `?.` 兜底 */
export function requireActor(): AuthProfile {
  const actor = useSession.getState().session?.actor;
  if (!actor) throw new Error("未登录：没有可显示的署名");
  return actor;
}

/** 命令式权限判断（非组件环境，如菜单项禁用态计算） */
export function can(permission: string): boolean {
  return roleAllows(useSession.getState().session?.actor, permission);
}
