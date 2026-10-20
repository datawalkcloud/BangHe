/**
 * 登录与首启设密码（02 §11 M10、05 §3 `/login`）。
 *
 * 一个页面三种态，切换只看数据、不看按钮名字：
 *   signin  输入登录名与密码
 *   setup   账号还是装机初始密码 / mustChangePwd → 先设自己的密码才能进业务页
 *   locked  连错到达阈值 → 给倒计时，不让人反复试
 *
 * 三条现场约束：
 *  1. 全程键盘可完成（05 §10-2）：进入即聚焦、回车提交、Caps Lock 有提示
 *  2. 不弹阻塞窗（05 §10-6）：所有失败提示就地显示在表单里
 *  3. 登录失败统一显示通用提示，不泄露账号是否存在
 */
import { FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertCircleIcon, KeyRoundIcon, LogInIcon } from "lucide-react";
import { api } from "@/lib/api";
import { BOOTSTRAP_HINT, type LoginOutcome } from "@/lib/auth";
import { useSession } from "@/store/session";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Kbd } from "@/components/business/layout";
import { LoginBackdrop } from "@/components/business/LoginBackdrop";

/** 密码最短位数与 Rust 侧同源约定（`auth::PWD_MIN_LEN`） */
const PWD_MIN_LEN = 6;

function useCountdown(iso: string | null): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!iso) {
      setLeft(0);
      return;
    }
    const tick = () => {
      const ms = new Date(iso).getTime() - Date.now();
      setLeft(ms > 0 ? Math.ceil(ms / 1000) : 0);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [iso]);
  return left;
}

/** 本机记住上一次登录成功的人：磅房里天天登的都是同一两个名字 */
const LAST_USER_KEY = "banghe.login.last-username";

/** 与 Rust `auth::ADMIN_USERNAME`（`src-tauri/src/auth.rs`）同步：种子 `0002_seed.sql` 写死的默认管理员登录名。 */
const ADMIN_USERNAME = "admin";

/** 首启要求装机人**亲手打一遍**默认管理员登录名——让他牢牢记住"下次登录用它"。
 *  与 Rust `auth::first_run_username_matches` 同一口径：trim + 大小写不敏感。 */
function firstRunUsernameMatches(input: string): boolean {
  return input.trim().toLowerCase() === ADMIN_USERNAME;
}

function lastLoginUsername(): string | null {
  try {
    return window.localStorage.getItem(LAST_USER_KEY);
  } catch {
    // 隐私模式/存储被禁：记不住就回到手输，不该把登录页弄崩
    return null;
  }
}

export function LoginPage() {
  const navigate = useNavigate();
  const session = useSession();
  const [username, setUsername] = useState(() => lastLoginUsername() ?? "");
  const [password, setPassword] = useState("");
  const [fresh, setFresh] = useState("");
  const [again, setAgain] = useState("");
  const [capsOn, setCapsOn] = useState(false);
  const [busy, setBusy] = useState(false);
  /** setup 态需要知道"刚才是用哪条密码进来的"：首启时那就是装机初始密码 */
  const [oldPassword, setOldPassword] = useState("");
  const [result, setResult] = useState<LoginOutcome | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  const { data: station } = useQuery({ queryKey: ["station"], queryFn: () => api.station(), staleTime: Infinity });
  const lockedLeft = useCountdown(result?.lockedUntil ?? null);
  const passwordField = useRef<HTMLInputElement>(null);

  const mustSetup = !!session.session?.actor.mustChangePwd;
  const firstRun = session.firstRunNeedsSetup && !session.session;
  const mode: "signin" | "setup" | "firstrun" = firstRun ? "firstrun" : mustSetup || result?.needsPasswordSetup === true ? "setup" : "signin";

  // 进入页面 / 切换模式时聚焦第一个字段（05 §10-2）。绝不能把 password、username 放进依赖：
  // 那样每敲一个字都会重新 focus 回 firstField（登录名框），把光标从密码框抢走。
  useEffect(() => {
    firstField.current?.focus();
    if (username.trim()) {
      // 登录名已经预填（记住了上次的人）：直接把光标放到密码栏，今天只输一次密码
      window.setTimeout(() => passwordField.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const error = result?.error ?? session.notice;

  /**
   * 界面上那一栏此刻显示的就是要交上去的"旧密码"：`mustSetup` 决定它读哪份 state
   * （见下面输入框的 `value`）。只认这一份，别再去兜 `oldPassword || password`——
   * 那样会出现"框里是空的、提交上去的却是上一次登录遗留的密码"这种暗坑。
   */
  const current = mustSetup ? oldPassword : password;

  async function submitSignIn(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setResult(null);
    const outcome = await session.signIn(username.trim(), password);
    setResult(outcome);
    setBusy(false);
    if (outcome.ok) {
      try {
        window.localStorage.setItem(LAST_USER_KEY, username.trim());
      } catch {
        /* 记不住不影响登录本身 */
      }
    }
    if (outcome.ok && outcome.session?.actor.mustChangePwd) {
      // 后端对装机初始密码登录会直接建会话并置 mustChangePwd，于是切到"当前密码"这一支；
      // 刚在登录表单敲进去的就是当前密码，带过去免得再输一遍、也免得按钮因空字段而点不动
      setOldPassword(password);
      // 这条登录回执（"该账号尚未设置密码…"）只给 signin 态看，setup 态另有提示。就地清掉，
      // 否则改密成功那一刻 mustChangePwd 转 false、mode 会闪回 signin，把这条旧回执当错误红一下（一闪而过）
      session.setNotice(null);
    } else if (outcome.ok) {
      await navigate({ to: "/" });
    }
  }

  async function submitSetup(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    if (fresh !== again) {
      // 不一致不弹顶部红框：再输入那一格下面已经实时标了红字，这里只把提交掐掉
      return;
    }
    setBusy(true);
    setResult(null);

    /*
     * 改密这条命令只认 Rust 内存里那条会话，而 setup 态有两条来路、会话在不在两说：
     *  - 装机初始密码敲错：占位符账号即使命令失败也把界面停在设置步，此时后端压根没建会话；
     *  - 初始密码验过了：会话在，只是还欠一次改密。
     * 没会话硬去改密，只会回一句"登录已失效，请重新登录"——那既不是真正的原因（密码输错了），
     * 也没给操作员留退路（再点多少次都是这句）。所以先按来路把会话补上 / 验真，再谈改密。
     */
    if (!useSession.getState().session) {
      const login = await session.signIn(username.trim(), current);
      if (!login.ok || !login.session) {
        // 初始密码没过：退回登录态，让"用户名或密码不正确（还可试 N 次）"照 signin 那一支显示出来
        setResult({ ...login, needsPasswordSetup: null });
        setBusy(false);
        return;
      }
      // 验过了，mustSetup 即将转真、那一栏改读 oldPassword：把刚成功的这条带过去，
      // 免得下面万一改密失败（新密码不合规等），那栏看起来像是被清空了
      setOldPassword(current);
    } else if (!(await session.beat())) {
      // 表单在磅房机上挂过一夜：后端那条会话已转入锁屏。登录页在 AppShell 之外，
      // 锁屏浮层盖不到这里，就地登出退回登录表单，让人重新输账号密码进来。
      await session.signOut();
      setBusy(false);
      return;
    }

    const outcome = await session.setPassword(current, fresh);
    if (outcome.ok) {
      // 守卫读的是会话里的 mustChangePwd，store 已就地清掉，这里只需回到正常入口
      session.setNotice(null);
      await navigate({ to: "/" });
    } else {
      setResult({ ok: false, error: outcome.error ?? "设置密码未完成", session: null, needsPasswordSetup: true, attemptsLeft: null, lockedUntil: null });
    }
    setBusy(false);
  }

  /** 新密码够长、两次一致、且那一栏里确实有"要交上去的旧密码" */
  const setupReady = !busy && !!current && fresh.length >= PWD_MIN_LEN && fresh === again;

  /** 首启设密：装机人须亲手敲对默认管理员登录名，才让提交；成功后写 LAST_USER_KEY，下次进登录页就是预填的 */
  async function submitFirstRun(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    if (!firstRunUsernameMatches(username)) return;
    if (fresh !== again) return;
    setBusy(true);
    setResult(null);
    const outcome = await session.firstRunSetup(fresh);
    if (outcome.ok) {
      try {
        // 用规范化的 "admin" 写回，别把装机人可能打错的 "ADMIN" / " Admin " 带进 localStorage，
        // 否则下次登录页预填的还是错的
        window.localStorage.setItem(LAST_USER_KEY, ADMIN_USERNAME);
      } catch {
        /* 记不住不影响设密本身 */
      }
      session.setNotice(null);
      await navigate({ to: "/" });
    } else {
      setResult({ ok: false, error: outcome.error ?? "设置密码未完成", session: null, needsPasswordSetup: null, attemptsLeft: null, lockedUntil: null });
    }
    setBusy(false);
  }

  return (
    <div className="relative flex h-svh w-full items-center justify-center overflow-auto p-6">
      {/* 整页背景插画。fixed 而不是 absolute：这层不跟着卡片内容滚，窗口再矮也不会露出一截底色 */}
      <LoginBackdrop className="fixed inset-0 size-full" />
      {/* 压暗遮罩：插画自带深浅渐变，卡片是实心的，中间这一层保证两档主题下都拉得开对比 */}
      <div aria-hidden className="pointer-events-none fixed inset-0 bg-black/20 dark:bg-black/55" />
      <Card className="relative w-full max-w-sm border-t-2 border-t-warning shadow-lg">
        <CardHeader className="justify-items-center text-center">
          <img src="/logo.png" alt="磅禾" className="size-14 object-contain" />
          <CardTitle className="text-base">{station?.name ?? "磅禾粮站"}</CardTitle>
          <CardDescription>
            {mode === "firstrun"
              ? "首次使用 · 为本站管理员（admin）设置登录密码"
              : mode === "signin"
                ? "收粮计量结算系统 · 请登录后继续"
                : "首次使用请先设置本站登录密码"}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          {error && mode === "signin" && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>无法登录</AlertTitle>
              <AlertDescription>
                {error}
                {result?.attemptsLeft != null && result.attemptsLeft > 0 && (
                  <span className="tnum ml-1">（还可试 {result.attemptsLeft} 次）</span>
                )}
              </AlertDescription>
            </Alert>
          )}

          {lockedLeft > 0 && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>账号已临时锁定</AlertTitle>
              <AlertDescription>
                连错密码次数已达上限，请 <span className="tnum font-semibold">{Math.ceil(lockedLeft / 60)}</span> 分钟后再试。
                <span className="mt-1 block text-xs">也可找站长在「系统与审计 → 员工与岗位」里重置。</span>
              </AlertDescription>
            </Alert>
          )}

          {mode === "setup" && result && !result.ok && result.error && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>设置未完成</AlertTitle>
              <AlertDescription>{result.error}</AlertDescription>
            </Alert>
          )}

          {mode === "firstrun" ? (
            <form onSubmit={submitFirstRun} className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                这是首次启动。请先输入默认管理员登录名 <code className="font-mono">{ADMIN_USERNAME}</code>，再设一个密码——<b>下次登录就用这个名字和密码</b>。
              </p>
              {result && !result.ok && result.error && (
                <Alert variant="destructive">
                  <AlertCircleIcon />
                  <AlertTitle>设置未完成</AlertTitle>
                  <AlertDescription>{result.error}</AlertDescription>
                </Alert>
              )}
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                请在下方输入管理员用户名 {ADMIN_USERNAME}
                <Input
                  ref={firstField}
                  className="text-base font-mono"
                  value={username}
                  spellCheck={false}
                  autoComplete="username"
                  onChange={(e) => setUsername(e.target.value)}
                  aria-invalid={username !== "" && !firstRunUsernameMatches(username) ? true : undefined}
                />
                {username !== "" && !firstRunUsernameMatches(username) && (
                  <span className="text-destructive">默认管理员登录名是 {ADMIN_USERNAME}，请照它输入</span>
                )}
              </Label>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                新密码（至少 {PWD_MIN_LEN} 位）
                <Input
                  type="password"
                  className="text-base"
                  value={fresh}
                  aria-invalid={fresh.length > 0 && fresh.length < PWD_MIN_LEN ? true : undefined}
                  autoComplete="new-password"
                  onChange={(e) => setFresh(e.target.value)}
                  onKeyUp={(e) => setCapsOn(e.getModifierState?.("CapsLock") ?? false)}
                />
                {fresh.length > 0 && fresh.length < PWD_MIN_LEN && <span className="text-destructive">密码太短，至少 {PWD_MIN_LEN} 位</span>}
              </Label>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                再输入一次
                <Input
                  type="password"
                  className="text-base"
                  value={again}
                  aria-invalid={again !== "" && fresh !== again ? true : undefined}
                  autoComplete="new-password"
                  onChange={(e) => setAgain(e.target.value)}
                />
                {again !== "" && fresh !== again && <span className="text-destructive">两次输入的密码不一致</span>}
              </Label>
              {capsOn && <p className="text-xs text-warning">大写锁定已开启，密码很可能输错了。</p>}
              <Button
                type="submit"
                disabled={busy || !firstRunUsernameMatches(username) || fresh.length < PWD_MIN_LEN || fresh !== again}
                className="mt-1 w-full"
              >
                <KeyRoundIcon data-slot="icon" />
                {busy ? "保存中…" : "设置并进入"}
              </Button>
            </form>
          ) : mode === "signin" ? (
            <form onSubmit={submitSignIn} className="flex flex-col gap-3">
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                登录名
                <Input
                  ref={firstField}
                  className="text-base"
                  value={username}
                  autoComplete="username"
                  spellCheck={false}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder=""
                />
              </Label>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                密码
                <Input
                  ref={passwordField}
                  type="password"
                  className="text-base"
                  value={password}
                  autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyUp={(e) => setCapsOn(e.getModifierState?.("CapsLock") ?? false)}
                />
              </Label>
              {capsOn && <p className="text-xs text-warning">大写锁定已开启，密码很可能输错了。</p>}
              <Button type="submit" disabled={busy || lockedLeft > 0 || !username.trim()} className="mt-1 w-full">
                <LogInIcon data-slot="icon" />
                {busy ? "校验中…" : "登录"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                回车即登录 <Kbd>Enter</Kbd>
              </p>
            </form>
          ) : (
            <form onSubmit={submitSetup} className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                {mustSetup ? "需要先把密码改成自己的才能进入。" : BOOTSTRAP_HINT}
              </p>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {mustSetup ? "当前密码" : "装机初始密码"}
                <Input
                  ref={mustSetup ? undefined : firstField}
                  type="password"
                  className="text-base"
                  value={mustSetup ? oldPassword : password}
                  autoComplete="current-password"
                  onChange={(e) => (mustSetup ? setOldPassword(e.target.value) : setPassword(e.target.value))}
                  onKeyUp={(e) => setCapsOn(e.getModifierState?.("CapsLock") ?? false)}
                />
              </Label>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                新密码（至少 {PWD_MIN_LEN} 位）
                <Input
                  type="password"
                  className="text-base"
                  value={fresh}
                  aria-invalid={fresh.length > 0 && fresh.length < PWD_MIN_LEN ? true : undefined}
                  autoComplete="new-password"
                  onChange={(e) => setFresh(e.target.value)}
                />
                {fresh.length > 0 && fresh.length < PWD_MIN_LEN && (
                  <span className="text-destructive">密码太短，至少 {PWD_MIN_LEN} 位</span>
                )}
              </Label>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                再输入一次
                <Input
                  ref={mustSetup ? firstField : undefined}
                  type="password"
                  className="text-base"
                  value={again}
                  aria-invalid={again !== "" && fresh !== again ? true : undefined}
                  autoComplete="new-password"
                  onChange={(e) => setAgain(e.target.value)}
                />
                {again !== "" && fresh !== again && <span className="text-destructive">两次输入的密码不一致</span>}
              </Label>
              {capsOn && <p className="text-xs text-warning">大写锁定已开启，密码很可能输错了。</p>}
              <Button type="submit" disabled={!setupReady} className="mt-1 w-full">
                <KeyRoundIcon data-slot="icon" />
                {busy ? "保存中…" : "设置并进入"}
              </Button>
              {/* 还没验过密码的这一支留条退路：想换个人登录、或本来就知道自己的密码，不该被扣在这屏。
                  已登录待改密（mustSetup）不给退——密码没设，回去也只是再被守卫弹回来。 */}
              {!mustSetup && (
                <Button
                  type="button"
                  variant="link"
                  onClick={() => {
                    setResult(null);
                    session.setNotice(null);
                  }}
                  className="h-auto self-center p-0 text-xs font-normal text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  返回登录
                </Button>
              )}
            </form>
          )}
        </CardContent>

        {!session.demo && (
          <CardFooter className="justify-center text-xs text-muted-foreground">
            {!import.meta.env.DEV && <>连错 5 次锁定 15 分钟；</>}登录状态长期有效，无操作自动锁屏后输本人密码解锁
          </CardFooter>
        )}
      </Card>
    </div>
  );
}
