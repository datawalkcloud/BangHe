/**
 * 关于本程序：帮助菜单「关于…」点开的这一张。
 *
 * 界面上每一行字都取自既有单源，这里不抄第二份：产品名 / 版权 / 一句话简介来自
 * src-tauri/tauri.conf.json；版本号由 AppTopbar——schema_contract::app_version_is_single_sourced
 * 点名的那份导入——以 prop 传入；GitHub 仓库地址取 package.json 的 repository 字段。
 * 外链一律走 ExtLink（opener 插件默认放行的 https 白名单），不经自开命令。
 *
 * 「检查更新」走 tauri-plugin-updater，更新源与验签公钥在 tauri.conf.json 的 plugins.updater。
 * 只做手动检查：磅房机大多不联网，开局自动检查只会先撞一次超时招人烦。
 * Windows 下安装器拉起后本程序即退出并自动重启（InstallOptions.restartAfterInstall 默认 true），
 * 所以「安装中」之后前端不用再调重启。浏览器预览没有原生通道，这一区如实换成一句说明。
 */
import { useRef, useState } from "react";
import { toast } from "sonner";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { InfoGrid } from "@/components/business/layout";
import { fileSize } from "@/lib/format";
import { runningInTauri } from "@/lib/native";
// 与 AppTopbar 引 package.json 同一个道理：配置在仓库里就一份，界面不改写它
import conf from "../../../src-tauri/tauri.conf.json";

type Phase = "idle" | "checking" | "available" | "downloading" | "installing";

/** 官网：产品介绍的入口 */
const SITE_URL = "https://bh.datawalk.cn";

/** 源码仓的国内镜像（GitHub 那份由 package.json 的 repository 单源提供） */
const GITEE_REPO_URL = "https://gitee.com/datawalkcloud/BangHe";

/** 命令层回的错误可能是裸字符串（Rust 侧约定），别把 `[object Object]` 弹给人 */
function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

/**
 * 可点开的对外链接：桌面端交给你 opener 插件的 https 白名单，浏览器预览退回新开标签。
 * 打不开（没装默认浏览器等）不装成功——把地址原样亮在提示里，人还能选中复制。
 */
function ExtLink({ url, text, what }: { url: string; text?: string; what: string }) {
  const desktop = runningInTauri();
  async function open() {
    if (!desktop) {
      window.open(url, "_blank", "noopener");
      return;
    }
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch {
      toast.error(`没能唤起浏览器，${what}：${url}`);
    }
  }
  return (
    <button
      type="button"
      onClick={() => void open()}
      className="break-all text-left font-mono text-xs underline underline-offset-2 hover:opacity-80"
      title="在浏览器打开"
    >
      {text ?? url}
    </button>
  );
}

export function AboutDialog({
  open,
  onOpenChange,
  version,
  repoUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** package.json 的 version，AppTopbar 传入——版本号守卫钉在那一处导入上 */
  version: string;
  /** package.json 的 repository.url，同上 */
  repoUrl: string;
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

  function handleOpenChange(next: boolean) {
    // 关框时把「发现了但没装」的更新放掉；下载/安装中的状态保留，重开还能看到进度
    if (!next && phase === "available") dismissUpdate();
    onOpenChange(next);
  }

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
      // 安装器已经离场，弹窗里的文字只是给"重启前的最后一屏"看的
      setPhase("installing");
    } catch (e) {
      toast.error(`下载或安装失败：${errText(e)}`);
      dismissUpdate();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <img src="/logo.png" alt={conf.productName} className="size-12 object-contain" />
            <span className="flex min-w-0 flex-col gap-1">
              <span>{conf.productName}</span>
              <span className="tnum text-xs font-normal text-muted-foreground">版本 {version}</span>
            </span>
          </DialogTitle>
          <DialogDescription>{conf.bundle.longDescription}</DialogDescription>
        </DialogHeader>
        <InfoGrid
          cols={2}
          items={[
            { label: "出品 / 版权", value: conf.bundle.copyright },
            { label: "官网", value: <ExtLink url={SITE_URL} text="bh.datawalk.cn" what="官网地址" /> },
            {
              label: "开源仓库",
              value: (
                <span className="inline-flex items-center gap-3">
                  <ExtLink url={GITEE_REPO_URL} text="Gitee 源码仓库" what="Gitee 仓库地址" />
                  <ExtLink url={repoUrl} text="GitHub 源码仓库" what="GitHub 仓库地址" />
                </span>
              ),
              span: 2,
            },
          ]}
        />

        {desktop ? (
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
        ) : (
          <p className="text-xs text-muted-foreground">检查更新只在桌面端可用。</p>
        )}

        <p className="text-xs text-muted-foreground">本项目开源免费，采用 Apache-2.0 协议。</p>
      </DialogContent>
    </Dialog>
  );
}
