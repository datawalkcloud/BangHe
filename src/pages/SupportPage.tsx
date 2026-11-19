/**
 * 技术支持（侧栏「服务 → 技术支持」）。
 *
 * ⚠️ 二次开发提示：AGPL-3.0 允许修改乃至移除本页，但前提是遵守许可证：对外分发
 * （含以网络服务形式提供）必须以同等条款开源并随附源码，保留许可证与版权声明；
 * 确需闭源分发，请先取得官方书面授权。「磅禾 / BANGHE」名称与商标不在授权范围内，
 * 衍生版本不得用原品牌对外背书，详见 README「开源协议」，违者必究。
 *
 * 这一项原先直接打开「关于」弹窗，两条联系方式缩在信息格子的最后一行——装机现场真要
 * 找人的时候，恰恰是最难扫到的一条。现在独立成页，自上而下：产品与更新（logo / 版本 /
 * 版权 / 官网 / 检查更新，与「关于」同源）→ 微信 / QQ 各占一张大卡片、号码旁就是复制钮
 * → 服务与合作范围 → 支持这个项目（Star、推荐给朋友、反馈与共建）→ 二次开发授权声明。
 * 支持类都是不花钱的方式，也避免把开源免费的产品做成只收钱的单向通道。
 *
 * 号码单源在 lib/support.ts；静态站读不到应用常量，site/index.html 的「技术支持」
 * 弹窗里还有一份副本，换号码时两处一起改。
 */
import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangleIcon, CircleDollarSignIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { SUPPORT_QQ, SUPPORT_WECHAT } from "@/lib/support";
import { runningInTauri, updateChannel, type UpdateChannel } from "@/lib/native";
import { CallOut, InfoGrid, PageHeader, SectionTitle } from "@/components/business/layout";
import { UpdatePanel } from "@/components/business/UpdatePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "cn";
import pkg from "../../package.json";
// 产品名 / 版权 / 一句话简介与「关于」弹窗同一单源，界面不抄第二份
import conf from "../../src-tauri/tauri.conf.json";

/** 微信 / QQ 的品牌图标：lucide 里没有这两家，path 与 site/index.html 的弹窗同一份画法 */
function WeChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-5">
      <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z" />
    </svg>
  );
}

function QqIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-5">
      <path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673" />
    </svg>
  );
}

/**
 * 一条通道一张大卡片：号码是这一屏的主角，复制钮跟在旁边。
 * 剪贴板不可用（非安全上下文、窗口没焦点等）不装成功——号码原样亮在提示里，人还能选中复制。
 */
function ChannelCard({
  icon,
  iconClass,
  label,
  id,
  what,
  note,
}: {
  icon: ReactNode;
  iconClass: string;
  label: string;
  id: string;
  what: string;
  note?: string;
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      toast.success(`${what}已复制：${id}`);
    } catch {
      toast.error(`没能复制，${what}：${id}`);
    }
  }

  return (
    <Card size="sm" className="gap-3 px-5">
      <div className="flex items-center gap-3">
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", iconClass)}>{icon}</span>
        <span className="text-base font-medium">{label}</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="tnum text-3xl font-semibold tracking-wide select-all">{id}</span>
        <Button size="sm" variant="outline" onClick={() => void copy()}>
          <CopyIcon />
          复制号码
        </Button>
      </div>
      {note && <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>}
    </Card>
  );
}

/** 官网与源码仓：Star / 推荐 / 反馈都指向它们，地址与应用里其他入口保持同一份 */
const SITE_URL = "https://bh.datawalk.cn";
const GITEE_REPO_URL = "https://gitee.com/datawalkcloud/BangHe";
const GITHUB_REPO_URL = pkg.repository.url;
const GITEE_ISSUES_URL = `${GITEE_REPO_URL}/issues`;
const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;
const BROCHURE_URL = `${SITE_URL}/brochure/`;

/** 推荐给朋友的一段话：官网、产品定位与断网可用的特点，复制出去就能直接发 */
const RECOMMEND_TEXT = `磅禾 · 粮站收粮计量结算系统：开源免费的粮站收粮管理系统，地磅、证卡、化验、结算、票据一台电脑全接，断网可用，数据由企业自己掌握。下载与介绍：${SITE_URL}/#download`;

/**
 * 标准支持之外能承接的合作面。按"服务人员常被问到什么"分组，
 * 不是功能清单：每一项都对应现场真会遇到的事，具体范围都要单独商定。
 */
const SCOPE_ITEMS = [
  { title: "安装与联调", desc: "上门装机、串口与仪表参数调试，打印 / 读卡 / 抓拍逐项联调。" },
  { title: "定制开发", desc: "报表与台账、票据版式、业务流程、字段与界面，按需调整。" },
  { title: "系统对接", desc: "与既有财务、仓储或监管系统的数据衔接，先评估再定方案。" },
  { title: "数据迁移", desc: "换电脑、历史数据整理与导入，沿用现有的备份与恢复流程。" },
  { title: "培训与运维", desc: "现场培训、操作手册、定期巡检与远程值守。" },
  { title: "硬件配套", desc: "地磅仪表、读卡器、摄像头、票据打印机的选型与配套。" },
  { title: "合作方式", desc: "按项目、按年服务或驻场，范围与费用单独商定。" },
];

/**
 * 站外链接：桌面端交给你 opener 插件的 https 白名单，浏览器预览退回新开标签。
 * 打不开不装成功——把地址原样亮在提示里，人还能选中复制。
 */
async function openExternal(url: string) {
  if (!runningInTauri()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    toast.error(`没能唤起浏览器，地址：${url}`);
  }
}

async function copyRecommendation() {
  try {
    await navigator.clipboard.writeText(RECOMMEND_TEXT);
    toast.success("推荐语已复制，粘贴发给朋友即可");
  } catch {
    toast.error(`没能复制，推荐语：${RECOMMEND_TEXT}`);
  }
}

/** 「支持这个项目」的一格：一句标题 + 动作钮 + 一句说明 */
function SupportTile({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border p-3">
      <span className="text-sm font-medium">{title}</span>
      {children}
    </div>
  );
}

export function SupportPage() {
  const desktop = runningInTauri();
  // 分发通道读数：与「关于」弹窗同一问法（native.ts 单源），问到手前不渲染更新面板
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
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="技术支持" description="安装部署、外设对接、定制开发与日常使用中的需求，可通过以下方式联系服务人员。" />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
        <Card size="sm" className="gap-3 px-5">
          <SectionTitle>产品与更新</SectionTitle>
          <div className="flex items-start gap-3">
            <img src="/logo.png" alt={conf.productName} className="size-12 shrink-0 object-contain" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-medium">{conf.productName}</span>
                <Badge variant="secondary" className="tnum font-normal">
                  版本 {pkg.version}
                </Badge>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{conf.bundle.longDescription}</p>
            </div>
          </div>
          <InfoGrid
            cols={2}
            items={[
              { label: "出品 / 版权", value: conf.bundle.copyright },
              {
                label: "官网",
                value: (
                  <button
                    type="button"
                    onClick={() => void openExternal(SITE_URL)}
                    className="break-all text-left font-mono text-xs underline underline-offset-2 hover:opacity-80"
                    title="在浏览器打开"
                  >
                    bh.datawalk.cn
                  </button>
                ),
              },
            ]}
          />
          <UpdatePanel version={pkg.version} channel={channel} />
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <ChannelCard
            icon={<WeChatIcon />}
            iconClass="bg-[#07c160]/12 text-[#07c160]"
            label="技术支持 · 微信"
            id={SUPPORT_WECHAT}
            what="微信号"
            note="添加时请备注粮站名称与具体需求，便于尽快对接。"
          />
          <ChannelCard
            icon={<QqIcon />}
            iconClass="bg-[#12b7f5]/12 text-[#12b7f5]"
            label="技术支持 · QQ"
            id={SUPPORT_QQ}
            what="QQ 号"
          />
        </div>

        <Card size="sm" className="gap-3 px-5">
          <SectionTitle>服务与合作范围</SectionTitle>
          <CallOut
            tone="warning"
            icon={<CircleDollarSignIcon className="size-4" />}
            title="以下均为收费服务项目"
          >
            软件本体开源免费（AGPL-3.0），上门安装、定制开发、系统对接、数据迁移、培训运维与硬件配套按项目单独报价。
          </CallOut>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
            {SCOPE_ITEMS.map((s) => (
              <div key={s.title} className="min-w-0">
                <p className="text-sm font-medium">{s.title}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{s.desc}</p>
              </div>
            ))}
          </div>
          <InfoGrid
            cols={2}
            items={[
              { label: "服务时间", value: "随装机约定" },
              { label: "软件授权", value: "AGPL-3.0 开源免费，商用可用" },
            ]}
          />
          <p className="text-xs text-muted-foreground">具体内容、周期与费用按项目单独商定。</p>
        </Card>

        <Card size="sm" className="gap-3 px-5">
          <SectionTitle>支持这个项目</SectionTitle>
          <p className="text-xs text-muted-foreground">软件开源免费，下面几件事不花钱，但能让更多粮站用上、也帮我们把产品做得更稳。</p>
          <div className="grid gap-3 md:grid-cols-3">
            <SupportTile title="给项目点个 Star">
              <div className="flex flex-wrap gap-2">
                <Button size="xs" onClick={() => void openExternal(GITEE_REPO_URL)}>
                  Gitee 仓库
                </Button>
                <Button size="xs" variant="outline" onClick={() => void openExternal(GITHUB_REPO_URL)}>
                  GitHub 仓库
                </Button>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                国内优先 Gitee，打不开再走 GitHub。
              </p>
            </SupportTile>

            <SupportTile title="推荐给朋友">
              <div className="flex flex-wrap gap-2">
                <Button size="xs" onClick={() => void copyRecommendation()}>
                  <CopyIcon />
                  复制推荐语
                </Button>
                <Button size="xs" variant="outline" onClick={() => void openExternal(BROCHURE_URL)}>
                  产品画册
                </Button>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                一段介绍加下载地址，发给朋友；给客户演示时，可直接把产品画册发过去。
              </p>
            </SupportTile>

            <SupportTile title="反馈与共建">
              <div className="flex flex-wrap gap-2">
                <Button size="xs" variant="outline" onClick={() => void openExternal(GITEE_ISSUES_URL)}>
                  Gitee Issues
                </Button>
                <Button size="xs" variant="outline" onClick={() => void openExternal(GITHUB_ISSUES_URL)}>
                  GitHub Issues
                </Button>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                问题、需求、文档修正和代码贡献都欢迎；不方便上仓库，直接找上方的微信 / QQ。
              </p>
            </SupportTile>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            还有两件小事同样有用：把现场的仪表、打印机型号告诉我们，帮助补齐适配清单；新版本愿意先试用并反馈问题。
          </p>
        </Card>

        <CallOut
          tone="warning"
          icon={<AlertTriangleIcon className="size-4" />}
          title="二次开发与分发授权声明"
        >
          AGPL-3.0 允许修改乃至移除本页，但前提是遵守许可证：对外分发（含以网络服务形式
          提供）必须以同等条款开源并随附源码，保留许可证与版权声明；确需闭源分发，请先
          取得官方书面授权。「磅禾 / BANGHE」名称与商标不在授权范围内，衍生版本不得用原
          品牌对外背书，详见 README「开源协议」，违者必究。
        </CallOut>
      </div>
    </div>
  );
}
