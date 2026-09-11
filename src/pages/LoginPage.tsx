/**
 * 登录与首启设口令（02 §11 M10、05 §3 `/login`）。
 *
 * 一个页面三种态，切换只看数据、不看按钮名字：
 *   signin  输入登录名与口令
 *   setup   账号还是装机初始口令 / mustChangePwd → 先设自己的口令才能进业务页
 *   locked  连错到达阈值 → 给倒计时，不让人反复试
 *
 * 三条现场约束：
 *  1. 全程键盘可完成（05 §10-2）：进入即聚焦、回车提交、Caps Lock 有提示
 *  2. 不弹阻塞窗（05 §10-6）：所有失败提示就地显示在表单里
 *  3. 演示模式必须自报身份（浏览器预览没有真实口令校验，见 `src/lib/auth.ts`）
 */
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertCircleIcon, KeyRoundIcon, LogInIcon } from "lucide-react";
import { api } from "@/lib/api";
import { BOOTSTRAP_HINT, type LoginOutcome } from "@/lib/auth";
import { ROLE } from "@/lib/constants";
import { useSession } from "@/store/session";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Kbd } from "@/components/business/layout";

/** 口令最短位数与 Rust 侧同源约定（`auth::PWD_MIN_LEN`） */
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

export function LoginPage() {
  const navigate = useNavigate();
  const session = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fresh, setFresh] = useState("");
  const [again, setAgain] = useState("");
  const [capsOn, setCapsOn] = useState(false);
  const [busy, setBusy] = useState(false);
  /** setup 态需要知道"刚才是用哪条口令进来的"：首启时那就是装机初始口令 */
  const [oldPassword, setOldPassword] = useState("");
  const [result, setResult] = useState<LoginOutcome | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  const { data: station } = useQuery({ queryKey: ["station"], queryFn: () => api.station(), staleTime: Infinity });
  const lockedLeft = useCountdown(result?.lockedUntil ?? null);

  const mustSetup = !!session.session?.actor.mustChangePwd;
  const mode: "signin" | "setup" = mustSetup || result?.needsPasswordSetup === true ? "setup" : "signin";

  // 演示模式给一份可点的名单，免得现场演示时谁都不知道该输什么
  const { data: staff = [] } = useQuery({
    queryKey: ["staff"],
    queryFn: () => api.staff(),
    enabled: session.demo,
    staleTime: Infinity,
  });

  useEffect(() => {
    firstField.current?.focus();
  }, [mode]);

  const error = result?.error ?? session.notice;

  async function submitSignIn(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setResult(null);
    const outcome = await session.signIn(username.trim(), password);
    setResult(outcome);
    setBusy(false);
    if (outcome.ok && !outcome.session?.actor.mustChangePwd) {
      await navigate({ to: "/" });
    }
  }

  async function submitSetup(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    if (fresh !== again) {
      setResult({ ok: false, error: "两次输入的口令不一致", session: null, needsPasswordSetup: true, attemptsLeft: null, lockedUntil: null });
      return;
    }
    setBusy(true);
    setResult(null);
    const outcome = await session.setPassword(oldPassword || password, fresh);
    if (outcome.ok) {
      // 守卫读的是会话里的 mustChangePwd，store 已就地清掉，这里只需回到正常入口
      session.setNotice(null);
      await navigate({ to: "/" });
    } else {
      setResult({ ok: false, error: outcome.error ?? "设置口令未完成", session: null, needsPasswordSetup: true, attemptsLeft: null, lockedUntil: null });
    }
    setBusy(false);
  }

  const hints = useMemo(
    () => (session.demo ? staff.filter((u) => u.is_active === 1).slice(0, 6) : []),
    [session.demo, staff],
  );

  /** 新口令够长、两次一致、且"要交上去的那条旧口令"已填 */
  const entering = mustSetup ? !!oldPassword : !!password;
  const setupReady = !busy && entering && fresh.length >= PWD_MIN_LEN && fresh === again;

  return (
    <div className="flex h-svh w-full items-center justify-center overflow-auto bg-muted/30 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-base">{station?.name ?? "邦禾粮站"}</CardTitle>
          <CardDescription>
            {mode === "signin" ? "收粮计量结算系统 · 请登录后继续" : "首次使用请先设置本站登录口令"}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          {session.demo && (
            <Alert>
              <AlertCircleIcon />
              <AlertTitle>浏览器演示模式</AlertTitle>
              <AlertDescription>
                这里没有原生通道，<b>口令不做任何校验</b>，只按在职名单认登录名。真实登录请用桌面版启动。
              </AlertDescription>
            </Alert>
          )}

          {error && mode === "signin" && !session.demo && (
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
                连错口令次数已达上限，请 <span className="tnum font-semibold">{Math.ceil(lockedLeft / 60)}</span> 分钟后再试。
                <span className="mt-1 block text-xs">找站长在「基础档案 → 员工与岗位」里重置口令也可以。</span>
              </AlertDescription>
            </Alert>
          )}

          {mode === "signin" ? (
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
                  placeholder="如 admin"
                />
              </Label>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                口令
                <Input
                  type="password"
                  className="text-base"
                  value={password}
                  autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyUp={(e) => setCapsOn(e.getModifierState?.("CapsLock") ?? false)}
                />
              </Label>
              {capsOn && <p className="text-xs text-warning">大写锁定已开启，口令很可能输错了。</p>}
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
                {mustSetup ? "为安全起见需要改一次口令。" : BOOTSTRAP_HINT}
              </p>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {mustSetup ? "当前口令" : "装机初始口令"}
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
                新口令（至少 {PWD_MIN_LEN} 位）
                <Input
                  type="password"
                  className="text-base"
                  value={fresh}
                  autoComplete="new-password"
                  onChange={(e) => setFresh(e.target.value)}
                />
              </Label>
              <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
                再输入一次
                <Input
                  ref={mustSetup ? firstField : undefined}
                  type="password"
                  className="text-base"
                  value={again}
                  autoComplete="new-password"
                  onChange={(e) => setAgain(e.target.value)}
                />
              </Label>
              {capsOn && <p className="text-xs text-warning">大写锁定已开启，口令很可能输错了。</p>}
              <Button type="submit" disabled={!setupReady} className="mt-1 w-full">
                <KeyRoundIcon data-slot="icon" />
                {busy ? "保存中…" : "设置并进入"}
              </Button>
            </form>
          )}

          {hints.length > 0 && (
            <>
              <Separator />
              <div className="flex flex-wrap gap-1.5">
                {hints.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => {
                      setUsername(u.username);
                      setPassword("demo");
                    }}
                    className="border bg-card px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
                  >
                    {u.display_name}
                    <span className="ml-1 opacity-70">{ROLE[u.role]}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </CardContent>

        <CardFooter className="justify-center text-xs text-muted-foreground">
          连错 5 次锁定 15 分钟；无操作 1 小时后需重新登录
        </CardFooter>
      </Card>
    </div>
  );
}
