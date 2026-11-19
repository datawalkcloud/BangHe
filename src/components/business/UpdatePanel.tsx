/**
 * 程序更新面板：「关于」弹窗与「服务 → 技术支持」页共用同一份更新逻辑与文案。
 *
 * 通道读数由调用方问 native.ts 的 updateChannel() 后以 prop 传入（「关于」那一处
 * 被 schema_contract::store_build_updater_channel_is_single_switch 钉着必须自己问），
 * 这里只负责按通道渲染：商店版说明 / GitHub 版检查-下载-安装 / 浏览器预览说明。
 *
 * 「检查更新」走 tauri-plugin-updater，更新源与验签公钥在 tauri.conf.json 的 plugins.updater。
 * 只做手动检查：磅房机大多不联网，开局自动检查只会先撞一次超时招人烦。
 * Windows 下安装器拉起后本程序即退出并自动重启（InstallOptions.restartAfterInstall 默认 true），
 * 所以「安装中」之后前端不用再调重启。
 *
 * active 供弹窗用：关框时把「发现了但没装」的更新放掉；下载/安装中的状态保留，重开还能看到进度。
 * 页面常驻传 true（默认）。
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { fileSize } from "@/lib/format";
import { runningInTauri, type UpdateChannel } from "@/lib/native";

type Phase = "idle" | "checking" | "available" | "downloading" | "installing";

/** 命令层回的错误可能是裸字符串（Rust 侧约定），别把 `[object Object]` 弹给人 */
function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

export function UpdatePanel({
  version,
  channel,
  active = true,
}: {
  /** package.json 的 version，调用方单源传入 */
  version: string;
  /** null = 还没问到手；问到手之前不渲染，免得商店版先闪出不该有的「检查更新」 */
  channel: UpdateChannel | null;
  active?: boolean;
}) {
  const desktop = runningInTauri();
  const [phase, setPhase] = useState<Phase>("idle");
  const [updateMeta, setUpdateMeta] = useState<{ version: string; body: string | null } | null>(null);
  const [progress, setProgress] = useState<{ received: number; total: number | null } | null>(null);
  // Update 在 Rust 侧持有资源（清单与已下载字节），不装就得 close，别攥着不放手
  const updateRef = useRef<Update | null>(null);

  /** 放弃这次更新机会：释放资源、回到初始态 */
  function dismissUpdate() {
    void updateRef.current?.close();
    updateRef.current = null;
    setUpdateMeta(null);
    setProgress(null);
    setPhase("idle");
  }

  useEffect(() => {
    if (!active && phase === "available") dismissUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, phase]);

  async function checkUpdate() {
    setPhase("checking");
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const found = await check({ timeout: 15_000 });
      if (!found) {
        setPhase("idle");
        toast.success(`已是最新版本（当前 ${version}）`);
        return;
      }
      updateRef.current = found;
      setUpdateMeta({ version: found.version, body: found.body ?? null });
      setPhase("available");
    } catch (e) {
      setPhase("idle");
      toast.error(`检查更新失败：${errText(e)}（可能没连上网，或更新源暂时不可用）`);
    }
  }

  async function installUpdate() {
    const u = updateRef.current;
    if (!u) return;
    setPhase("downloading");
    setProgress({ received: 0, total: null });
    try {
      await u.downloadAndInstall(
        (event: DownloadEvent) => {
          if (event.event === "Started") {
            setProgress({ received: 0, total: event.data.contentLength ?? null });
          } else if (event.event === "Progress") {
            setProgress((p) => ({ received: (p?.received ?? 0) + event.data.chunkLength, total: p?.total ?? null }));
          } else if (event.event === "Finished") {
            setPhase("installing");
          }
        },
        { timeout: 300_000 },
      );
      // Windows 下安装器拉起后本程序即退出、装完自动重启；能执行到这句说明
      // 安装器已经离场，面板里的文字只是给"重启前的最后一屏"看的
      setPhase("installing");
    } catch (e) {
      toast.error(`下载或安装失败：${errText(e)}`);
      dismissUpdate();
    }
  }

  if (desktop && channel === "store") {
    return (
      <div className="flex flex-col gap-2.5 rounded-xl border bg-muted/20 p-3">
        <span className="text-sm font-medium">程序更新</span>
        <p className="text-xs text-muted-foreground">
          本版本经 Microsoft Store 分发，新版本由商店自动推送安装；要立即检查，请在商店「下载和更新」里查看。应用内不提供更新检查。
        </p>
      </div>
    );
  }

  if (desktop && channel === "github") {
    return (
      <div className="flex flex-col gap-2.5 rounded-xl border bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">程序更新</span>
          <Button
            size="xs"
            variant="outline"
            disabled={phase === "checking" || phase === "downloading" || phase === "installing"}
            onClick={() => void checkUpdate()}
          >
            {phase === "checking" ? "检查中…" : "检查更新"}
          </Button>
        </div>

        {phase === "idle" && (
          <p className="text-xs text-muted-foreground">
            发现新版点「下载并安装」，装完自动重启到新版；离线电脑用装机包覆盖安装同样能升级。
          </p>
        )}

        {phase === "available" && updateMeta && (
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              发现新版本 <span className="tnum font-medium">{updateMeta.version}</span>
            </p>
            {updateMeta.body && <p className="whitespace-pre-line text-xs text-muted-foreground">{updateMeta.body}</p>}
            <div className="flex items-center gap-2">
              <Button size="xs" onClick={() => void installUpdate()}>
                下载并安装
              </Button>
              <Button size="xs" variant="ghost" onClick={dismissUpdate}>
                暂不更新
              </Button>
            </div>
          </div>
        )}

        {phase === "downloading" && progress && (
          <div className="flex flex-col gap-1.5">
            {progress.total != null && (
              <Progress value={Math.min(100, Math.round((progress.received / progress.total) * 100))} />
            )}
            <p className="text-xs text-muted-foreground">
              下载中 {fileSize(progress.received)}
              {progress.total != null ? ` / ${fileSize(progress.total)}` : ""}
            </p>
          </div>
        )}

        {phase === "installing" && <p className="text-xs">正在安装，程序会自动退出并重启。</p>}
      </div>
    );
  }

  if (!desktop) {
    return <p className="text-xs text-muted-foreground">检查更新只在桌面端可用。</p>;
  }

  return null;
}