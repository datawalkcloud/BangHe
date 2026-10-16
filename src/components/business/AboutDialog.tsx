/**
 * 关于本程序：帮助菜单「关于磅禾粮站收粮系统…」点开的这一张。
 *
 * 界面上每一行字都取自既有单源，这里不抄第二份：
 * - 产品名 / 版权 / 应用标识 / 一句话简介：src-tauri/tauri.conf.json——装机包、
 *   主窗口标题、AppData 目录名吃的就是这份配置，界面上这行字与它们天然一致；
 * - 版本号：package.json 的 version（四处单源，schema_contract::app_version_is_single_sourced
 *   钉着），由 AppTopbar——守卫点名的那份导入——以 prop 传入；
 * - 仓库地址：package.json 的 repository 字段（npm 标准位）；官网 bh.datawalk.cn。
 *   两条外链都走 ExtLink：点开经 opener 插件默认放行的 https 白名单，不经自开命令。
 *
 * 「检查更新」走 tauri-plugin-updater：更新源与验签公钥在 tauri.conf.json 的
 * plugins.updater——清单与安装包直接挂**本仓 datawalkcloud/BangHe 的 GitHub Release**，
 * gh-proxy 镜像优先。
 * 流程是 opt-in 的手动检查——不开自动检查，磅房机大多不联网，开局先撞一次超时
 * 只会招人烦。Windows 下安装器拉起后本程序会退出、装完自动重启
 * （InstallOptions.restartAfterInstall 默认 true），所以「安装中」这一态出现后
 * 不需要前端再调重启；走完前关掉弹窗也不影响后台继续装。
 * 浏览器预览没有原生通道，这一区如实替换成一句说明，不演按钮。
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

/** 官网：现场支持与产品介绍的入口（安装包在本仓 GitHub Release / 国内 Gitee 镜像） */
const SITE_URL = "https://bh.datawalk.cn";

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
  const [updateMeta, setUpdateMeta] = useState<{ version: string; date: string | null; body: string | null } | null>(null);
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
      setUpdateMeta({ version: found.version, date: found.date ?? null, body: found.body ?? null });
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
            { label: "运行环境", value: desktop ? "桌面端（Tauri）" : "浏览器预览（演示模式）" },
            { label: "官网", value: <ExtLink url={SITE_URL} text="bh.datawalk.cn" what="官网地址" /> },
            { label: "应用标识", value: <span className="font-mono text-xs">{conf.identifier}</span> },
            { label: "源码仓库", value: <ExtLink url={repoUrl} what="仓库地址" />, span: 2 },
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
                连一次更新源，有比当前版新的安装包就当场下载、静默安装，装完程序自动以新版本重启；
                完全离线的机器用装机包覆盖安装同样能升级。
              </p>
            )}

            {phase === "available" && updateMeta && (
              <div className="flex flex-col gap-2">
                <p className="text-sm">
                  发现新版本 <span className="tnum font-medium">{updateMeta.version}</span>
                  {updateMeta.date && (
                    <span className="ml-2 text-xs text-muted-foreground">发布于 {updateMeta.date.slice(0, 10)}</span>
                  )}
                  <span className="ml-2 text-xs text-muted-foreground">当前 {version}</span>
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
                  ，下载完自动安装并重启。
                </p>
              </div>
            )}

            {phase === "installing" && (
              <p className="text-xs">安装包已就绪，正在启动安装——程序马上会自动退出并以新版本重启。</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">检查更新只在桌面端可用；浏览器预览是演示模式，没有更新通道。</p>
        )}

        <p className="text-xs text-muted-foreground">
          本项目以 Apache-2.0 协议开源；安装包与在线更新清单直接挂在本仓库的 GitHub
          <span className="font-mono"> Release </span>
          页，机房上不了网时把那个地址抄给能上网的人下载装机包即可。
        </p>
      </DialogContent>
    </Dialog>
  );
}
