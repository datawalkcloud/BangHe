/**
 * 关于本程序：帮助菜单「关于…」点开的这一张。
 *
 * 界面上每一行字都取自既有单源，这里不抄第二份：产品名 / 版权 / 一句话简介来自
 * src-tauri/tauri.conf.json；版本号由 AppTopbar——schema_contract::app_version_is_single_sourced
 * 点名的那份导入——以 prop 传入；GitHub 仓库地址取 package.json 的 repository 字段。
 * 技术支持的微信 / QQ 取 lib/support.ts（与「服务 → 技术支持」页共用；站内另有一份）。
 * 外链一律走 ExtLink（opener 插件默认放行的 https 白名单），不经自开命令。
 *
 * 更新面板与「服务 → 技术支持」页共用 UpdatePanel（检查 / 下载 / 安装 / 商店版说明都在那里）。
 * 通道读数只问 native.ts 的 updateChannel()（单源即 cargo feature `store-build`），
 * 这里不设第二个开关——schema_contract::store_build_updater_channel_is_single_switch
 * 钉着本文件必须自己问一次。
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { InfoGrid } from "@/components/business/layout";
import { UpdatePanel } from "@/components/business/UpdatePanel";
import { runningInTauri, updateChannel, type UpdateChannel } from "@/lib/native";
import { SUPPORT_QQ, SUPPORT_WECHAT } from "@/lib/support";
// 与 AppTopbar 引 package.json 同一个道理：配置在仓库里就一份，界面不改写它
import conf from "../../../src-tauri/tauri.conf.json";

/** 官网：产品介绍的入口 */
const SITE_URL = "https://bh.datawalk.cn";

/** 源码仓的国内镜像（GitHub 那份由 package.json 的 repository 单源提供） */
const GITEE_REPO_URL = "https://gitee.com/datawalkcloud/BangHe";

/**
 * 一行联系方式 + 一颗复制钮：磅房机上徒手敲一串 QQ 号不现实。
 * 剪贴板不可用（非安全上下文、窗口没焦点等）不装成功——把号码原样亮在提示里，人还能选中复制。
 */
function SupportLine({ id, what }: { id: string; what: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      toast.success(`${what}已复制：${id}`);
    } catch {
      toast.error(`没能复制，${what}：${id}`);
    }
  }
  return (
    <span className="inline-flex items-center gap-1">
      <span className="tnum">{id}</span>
      <Button type="button" size="xs" variant="ghost" onClick={() => void copy()}>
        复制
      </Button>
    </span>
  );
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
  // 分发通道读数：null = 还没问到手（桌面端首发一次，走的是本进程的原生命令，毫秒级；
  // 问到手之前不渲染那一区，免得商店版先闪出一个不该有的「检查更新」按钮）
  const [channel, setChannel] = useState<UpdateChannel | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    void updateChannel().then((c) => {
      if (alive) setChannel(c);
    });
    return () => {
      alive = false;
    };
  }, [desktop]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
            { label: "技术支持 · 微信", value: <SupportLine id={SUPPORT_WECHAT} what="微信号" /> },
            { label: "技术支持 · QQ", value: <SupportLine id={SUPPORT_QQ} what="QQ 号" /> },
          ]}
        />
        <p className="text-xs text-muted-foreground">装机、外设对接、定制开发与日常使用中的需求，都可通过以上方式联系服务人员。</p>

        <UpdatePanel version={version} channel={channel} active={open} />

        <p className="text-xs text-muted-foreground">本项目以 AGPL-3.0 协议开源，免费使用与商用；再分发须以同协议开源。</p>
      </DialogContent>
    </Dialog>
  );
}
