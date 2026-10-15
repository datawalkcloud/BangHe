/**
 * 底部设备状态条（05 §2）：常驻、不可隐藏，右侧带本机系统时钟。
 *
 * 设备故障是磅房现场最高频的问题，任何页面都必须一眼看到，
 * 因此它不随侧栏折叠、不随路由切换卸载，也不因离线弹模态（05 §6.5）。
 * 工作台的「全屏专注」是一层 `fixed inset-0` 覆盖层，会把挂在 AppShell 里的这条盖掉，
 * 所以拆成两层：`useDeviceStatusGate`（台账判据 + 探一次真机，全局只该跑一份）与
 * `DeviceStatusStrip`（纯展示）。专注态在覆盖层底部再挂一份 `DeviceStatusStrip`，
 * 盖在下面的那一份仍在跑闸门与探测，不会出现两个实例抢读卡器。
 *
 * 状态同时用图形符号 + 中文文字表达，不依赖颜色（色弱、黑白打印、远程截图）。
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ClockIcon, KeyboardIcon } from "lucide-react";
import { api } from "@/lib/api";
import { useDeviceStore } from "@/store/device";
import { useActor } from "@/store/session";
import { weight } from "@/lib/format";
import { DEVICE_STATUS } from "@/lib/constants";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Dot } from "@/components/business/badges";
import { operatorLabel } from "@/components/business/OperatorSwitch";
import { ShortcutHelpDialog } from "@/components/business/ShortcutHelpDialog";
import { cn } from "cn";
import type { DeviceConfig } from "@/mock/types";
import type { DeviceStatus } from "@/lib/constants";

function toneOf(s: DeviceStatus) {
  return s === "online" ? "success" : s === "unknown" ? "neutral" : s === "error" ? "warning" : "danger";
}

function Chip({
  title,
  status,
  detail,
  deviceCode,
}: {
  title: string;
  status: DeviceStatus;
  detail: string;
  deviceCode?: string;
}) {
  const tone = toneOf(status);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link to="/devices" className="flex min-w-0 outline-none" />
        }
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <Dot tone={tone} />
          <span className="shrink-0 font-medium">{title}</span>
          <span className={cn("min-w-0 truncate", tone === "success" ? "text-foreground" : "text-muted-foreground")}>
            {detail}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>{title}：{DEVICE_STATUS[status].label}</p>
        <p className="text-muted-foreground">{detail}</p>
        <p className="text-muted-foreground">设备码 {deviceCode ?? "—"}，点击进入设备中心自检</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 读卡器的台账判据按「kind + 启用态」整体算，不写死设备码：登记新设备的编码是自动生成的，
 * 认死 idcard1 会让"根本没登记"与"登记成别的码"两种情况都静默走真机——那正是这次的漏洞。
 * 判据：有真机用真机；只剩 Mock 才算 mocked；一台没有 = 闸门关。
 */
function readerGateOf(devices: DeviceConfig[]) {
  const readers = devices.filter((d) => d.kind === "idcard" && d.is_enabled === 1);
  const realReaders = readers.filter((d) => d.is_mock === 0);
  return {
    readerRegistered: readers.length > 0,
    readerMocked: readers.length > 0 && realReaders.length === 0,
    // 底栏提示的"生效设备码"与通道路由同一判据：有真机时报真机那台，别在混装台账下指错行
    readerDev:
      (realReaders.find((d) => d.is_default === 1) ?? realReaders[0]) ??
      (readers.find((d) => d.is_default === 1) ?? readers[0]) ??
      null,
  };
}

/**
 * 闸门与探测：台账的 Mock 标记与"有没有启用的读卡器"决定读卡走真机、演示卡还是拒开设备，
 * 由底栏这一份把结论同步进 store，工作台和档案页不必各判一遍。
 * 只允许全局跑一份（AppShell 那条常驻底栏），专注态补挂的展示条不碰它，免得两个实例抢读卡器。
 */
function useDeviceStatusGate() {
  const probeReader = useDeviceStore((s) => s.reader.probe);
  const setReaderMocked = useDeviceStore((s) => s.reader.setMocked);
  const setReaderRegistered = useDeviceStore((s) => s.reader.setRegistered);
  const { data: devices = [] } = useQuery({ queryKey: ["devices"], queryFn: () => api.listDevices() });
  const { readerRegistered, readerMocked } = readerGateOf(devices);

  useEffect(() => {
    setReaderMocked(readerMocked);
  }, [readerMocked, setReaderMocked]);
  useEffect(() => {
    setReaderRegistered(readerRegistered);
  }, [readerRegistered, setReaderRegistered]);

  // 启动时探一次，底栏那颗灯才有真机依据；探测只开设备问 SAM，不占读卡时序。
  // 台账查清后闸门翻真会自动重探，未登记的灰灯不必等用户点读卡才见到原因
  useEffect(() => {
    void probeReader();
  }, [probeReader, readerRegistered, readerMocked]);
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * 本机系统时钟：磅房里操作员手上是票据、眼睛在车上，抬头看一眼时间比点开任何页面都快。
 * 取的是操作系统本地时间（与 `nowLocalISO()` 同源，不做时区换算），
 * 定时器对齐到整秒边界，避免出现"14:32:05 停一秒半才跳"或同一秒念两遍。
 */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    const tick = () => {
      setNow(new Date());
      timer = window.setTimeout(tick, 1000 - (Date.now() % 1000) || 1000);
    };
    timer = window.setTimeout(tick, 1000 - (Date.now() % 1000) || 1000);
    return () => window.clearTimeout(timer);
  }, []);
  const pad = (n: number) => String(n).padStart(2, "0");
  const text = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${WEEKDAYS[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <span className="tnum flex items-center gap-1.5 text-xs text-muted-foreground">
          <ClockIcon className="size-3.5" />
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="font-medium">本机系统时间</p>
        <p className="text-muted-foreground">{`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${WEEKDAYS[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/** 纯展示的那一条：不跑闸门与探测，专注模式覆盖层底部复用的就是它 */
export function DeviceStatusStrip() {
  const scale = useDeviceStore((s) => s.scale);
  const reader = useDeviceStore((s) => s.reader);
  const camera = useDeviceStore((s) => s.camera);
  const printer = useDeviceStore((s) => s.printer);
  const actor = useActor();

  const { data: devices = [] } = useQuery({ queryKey: ["devices"], queryFn: () => api.listDevices() });
  const cfg = (code: string) => devices.find((d) => d.code === code);

  const scaleCfg = cfg("scale1");
  const camCfg = cfg("cam1");
  const prtCfg = devices.find((d) => d.kind === "printer" && d.is_default === 1) ?? cfg("prt1");
  const { readerDev } = readerGateOf(devices);

  /** 底栏键盘图标开的就是顶栏「帮助 → 快捷键一览」那一张，键位表同一份（F1 也是它） */
  const [helpOpen, setHelpOpen] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);

  const scaleDetail = scale.connected
    ? `${String(scaleCfg?.config.port ?? "COM3")} · ${weight(scale.weight01kg)} · ${scale.stable ? "稳" : "不稳"}`
    : `${String(scaleCfg?.config.port ?? "COM3")} 离线，可改手录`;

  // 两条通道各自刚读了谁／哪张卡，底栏只放得下一句，按最近一次成功的那条说
  const readerDetail =
    reader.status === "online"
      ? reader.idcard.watching
        ? "在线 · 正在监听身份证"
        : reader.ic.watching
          ? "在线 · 正在监听 IC 卡"
          : reader.idcard.last
            ? `在线 · 刚读 ${reader.idcard.last.name}`
            : reader.ic.last
              ? `在线 · 刚读 IC ${reader.ic.last.sn}`
              : "在线"
      : reader.status === "unknown"
        ? // 闸门/ Mock 的探测都带回一句原因（"台账里没有启用的证卡阅读器…"），亮灯更要说出来
          (reader.lastProbe?.error ?? "未检测，读卡时自动探测")
        : (reader.lastProbe?.error ?? "离线，可手工输入身份证号");

  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border-t bg-muted/40 px-3 select-none">
      {/* 左侧设备区必须整体可收缩（flex-1 + min-w-0），否则窗口变窄时会挤压右侧操作员文案，把它挤成逐字竖排 */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Chip
          title="磅"
          status={scale.connected ? "online" : "offline"}
          detail={scaleDetail}
          deviceCode="scale1"
        />
        <Separator orientation="vertical" className="my-auto h-4 shrink-0" />
        {/* 底栏给磅房操作员看，不摆驱动代码（routon_sdtapi 这类），只说能不能读卡、刚读了谁 */}
        <Chip title="卡" status={reader.status} detail={readerDetail} deviceCode={readerDev?.code} />
        <Separator orientation="vertical" className="my-auto h-4 shrink-0" />
        <Chip
          title="像"
          status={camera.status}
          detail={
            camera.status === "online"
              ? `${String(camCfg?.config.host ?? "192.168.1.64")} 在线`
              : "离线，磅单将标「无抓拍」"
          }
          deviceCode="cam1"
        />
        <Separator orientation="vertical" className="my-auto h-4 shrink-0" />
        <Chip
          title="印"
          status={printer.status}
          detail={printer.status === "online" ? `${printer.name} 就绪` : (printer.lastError ?? "打印机不可用")}
          deviceCode={prtCfg?.code ?? "prt1"}
        />
      </div>

      <span className="ml-auto flex shrink-0 items-center gap-3">
        <Clock />
        <Separator orientation="vertical" className="my-auto h-4" />
        {/* 键盘图标原先只挂悬停提示：触屏机上没有 hover，点了没反应，等于一颗死图标
            （旁边的「磅/卡/像/印」都能点进设备中心，更容易让人以为它也能点）。
            现在点它开「快捷键一览」，与顶栏菜单、F1 是同一张弹窗、同一份键位表。 */}
        <Tooltip open={hintOpen && !helpOpen} onOpenChange={setHintOpen}>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground"
                aria-label="快捷键一览（F1）"
                onClick={() => setHelpOpen(true)}
              />
            }
          >
            <KeyboardIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="font-medium">主要快捷键</p>
            <p className="text-muted-foreground">空格 捕获 · F7 下一单 · F8 读卡 · F5 化验 · F6 带价</p>
            <p className="text-muted-foreground">F9 打码单 · F10 提交结算 · F2 对外大屏 · Ctrl+K 检索 · Ctrl+B 折叠侧栏</p>
            <p className="text-muted-foreground">点击查看全部（F1）</p>
          </TooltipContent>
        </Tooltip>
        <ShortcutHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
        <Separator orientation="vertical" className="my-auto h-4" />
        <span className="text-xs text-muted-foreground">
          当前操作员：
          <span className="text-foreground">{actor ? operatorLabel(actor) : "—"}</span>
        </span>
      </span>
    </footer>
  );
}

/** AppShell 常驻的那一条：闸门 effect 全局只跑这份，展示部分交给 `DeviceStatusStrip` */
export function DeviceStatusBar() {
  useDeviceStatusGate();
  return <DeviceStatusStrip />;
}
