/**
 * 锁屏浮层（02 §11 M10 改、05 §3）。
 *
 * 登录后的会话**永久有效**：空闲超过站点参数 idle_lock_minutes（可为「从不」）不再踢回登录页，
 * 只在 AppShell 上盖一层锁屏；主动锁屏（侧栏左下角）走同一层。输入**当前登录人本人**
 * 的密码即原地解锁——页面不跳、正在录的单据状态都还在。
 * 真正的闸门在 Rust：`Session::locked` 期间所有业务命令一律被拒，这里只是界面。
 *
 * 与登录页同款的现场约束：进入即聚焦、回车提交、Caps Lock 有提示、失败就地显示不弹窗。
 */
import { FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircleIcon, LockKeyholeIcon, LogInIcon } from "lucide-react";
import { useSession } from "@/store/session";
import { ROLE } from "@/lib/constants";
import type { LoginOutcome } from "@/lib/auth";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Kbd } from "@/components/business/layout";

export function LockScreen() {
  const locked = useSession((s) => s.locked);
  const notice = useSession((s) => s.notice);
  const demo = useSession((s) => s.demo);
  const actor = useSession((s) => s.session?.actor ?? null);
  const unlock = useSession((s) => s.unlock);
  const signOut = useSession((s) => s.signOut);
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [capsOn, setCapsOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LoginOutcome | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (locked) {
      setPassword("");
      setResult(null);
      inputRef.current?.focus();
    }
  }, [locked]);

  if (!locked) return null;

  const lockedLeftMin = result?.lockedUntil ? Math.max(1, Math.ceil((new Date(result.lockedUntil).getTime() - Date.now()) / 60_000)) : 0;
  const accountLocked = lockedLeftMin > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setResult(null);
    const outcome = await unlock(password);
    setBusy(false);
    if (outcome.ok) setPassword("");
    else setResult(outcome);
  }

  async function switchAccount() {
    await signOut();
    void navigate({ to: "/login" });
  }

  return (
    <div data-lock-screen className="fixed inset-0 z-[200] flex items-center justify-center bg-background/95 p-6 backdrop-blur-sm">
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center text-center">
          <div className="mb-1 flex size-12 items-center justify-center rounded-full bg-muted">
            <LockKeyholeIcon className="size-6 text-muted-foreground" />
          </div>
          <CardTitle className="text-base">已锁屏</CardTitle>
          {/* 为什么锁的（超时 / 手动）由 store 的 notice 说清楚，这里不再自己抄一份时长 */}
          <CardDescription>{notice ?? "登录会话仍在，需验证身份后继续"}</CardDescription>
          {actor && (
            <p className="text-xs text-muted-foreground">
              请输入 <span className="font-medium text-foreground">{actor.displayName}</span>（{ROLE[actor.role]}）的登录密码
            </p>
          )}
        </CardHeader>

        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            {result && !result.ok && result.error && (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>无法解锁</AlertTitle>
                <AlertDescription>
                  {result.error}
                  {result.attemptsLeft != null && result.attemptsLeft > 0 && !accountLocked && (
                    <span className="tnum ml-1">（还可试 {result.attemptsLeft} 次）</span>
                  )}
                  {accountLocked && (
                    <span className="tnum ml-1">（约 {lockedLeftMin} 分钟后再试，或换账号登录）</span>
                  )}
                </AlertDescription>
              </Alert>
            )}

            <Label className="flex flex-col gap-1 text-xs text-muted-foreground">
              登录密码
              <Input
                ref={inputRef}
                type="password"
                className="text-base"
                value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
                onKeyUp={(e) => setCapsOn(e.getModifierState?.("CapsLock") ?? false)}
              />
            </Label>
            {capsOn && <p className="text-xs text-warning">大写锁定已开启，密码很可能输错了。</p>}
            <Button type="submit" disabled={busy || accountLocked || !password} className="mt-1 w-full">
              <LogInIcon data-slot="icon" />
              {busy ? "校验中…" : "解锁继续"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              {demo ? "演示模式不校验密码，输入任意内容即解锁" : <>回车即解锁 <Kbd>Enter</Kbd></>}
            </p>
          </form>
        </CardContent>

        <CardFooter className="justify-center">
          <Button type="button" variant="link" onClick={switchAccount} className="h-auto p-0 text-xs font-normal text-muted-foreground underline underline-offset-2 hover:text-foreground">
            换个账号登录（会退出当前会话）
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
