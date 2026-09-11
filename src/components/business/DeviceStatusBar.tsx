/**
 * 底部设备状态条（05 §2）：常驻、不可隐藏。
 *
 * 设备故障是磅房现场最高频的问题，任何页面都必须一眼看到，
 * 因此它不随侧栏折叠、不随路由切换卸载，也不因离线弹模态（05 §6.5）。
 *
 * 状态同时用图形符号 + 中文文字表达，不依赖颜色（色弱、黑白打印、远程截图）。
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { KeyboardIcon, VolumeXIcon } from "lucide-react";
import { api } from "@/lib/api";
import { useDeviceStore } from "@/store/device";
import { useActor, useSession } from "@/store/session";
import { weight } from "@/lib/format";
import { DEVICE_STATUS } from "@/lib/constants";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dot } from "@/components/business/badges";
import { operatorLabel } from "@/components/business/OperatorSwitch";
import { cn } from "cn";
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

export function DeviceStatusBar() {
  const scale = useDeviceStore((s) => s.scale);
  const idcard = useDeviceStore((s) => s.idcard);
  const camera = useDeviceStore((s) => s.camera);
  const printer = useDeviceStore((s) => s.printer);
  const mockOff = useDeviceStore((s) => s.mockOff);
  const setMockOff = useDeviceStore((s) => s.setMockOff);
  const actor = useActor();
  // 底栏这个开关与设备中心页的总开关改的是同一个 mockOff，得用同一个权限门禁，
  // 否则只在一处设限制等于没设
  const canManage = useSession((s) => s.can("device.manage"));

  const { data: devices = [] } = useQuery({ queryKey: ["devices"], queryFn: () => api.listDevices() });
  const cfg = (code: string) => devices.find((d) => d.code === code);

  const scaleCfg = cfg("scale1");
  const camCfg = cfg("cam1");
  const prtCfg = devices.find((d) => d.kind === "printer" && d.is_default === 1) ?? cfg("prt1");

  const scaleDetail = scale.connected
    ? `${String(scaleCfg?.config.port ?? "COM3")} · ${weight(scale.weight01kg)} · ${scale.stable ? "稳" : "不稳"}`
    : `${String(scaleCfg?.config.port ?? "COM3")} 离线，可改手录`;

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
        <Separator orientation="vertical" className="h-4 shrink-0" />
        {/* 底栏给磅房操作员看，不摆驱动代码（bridge_exe 这类），只说能不能读卡、刚读了谁 */}
        <Chip
          title="证"
          status={idcard.status}
          detail={
            idcard.status === "online"
              ? `在线${idcard.last ? ` · 刚读 ${idcard.last.name}` : ""}`
              : "离线，可手工输入身份证号"
          }
          deviceCode="idcard1"
        />
        <Separator orientation="vertical" className="h-4 shrink-0" />
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
        <Separator orientation="vertical" className="h-4 shrink-0" />
        <Chip
          title="印"
          status={printer.status}
          detail={printer.status === "online" ? `${printer.name} 就绪` : (printer.lastError ?? "打印机不可用")}
          deviceCode={prtCfg?.code ?? "prt1"}
        />
      </div>

      <span className="ml-auto flex shrink-0 items-center gap-3">
        {mockOff && (
          <span className="inline-flex items-center gap-1 text-xs text-warning">
            <VolumeXIcon />
            外设已全部关闭，仅可手录作业
          </span>
        )}
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex items-center gap-1.5" />}>
            <Switch
              id="mock-off"
              size="sm"
              checked={mockOff}
              disabled={!canManage}
              onCheckedChange={(v) => setMockOff(v === true)}
              className="ml-1"
            />
            <label htmlFor="mock-off" className={cn("text-xs", canManage ? "cursor-pointer" : "cursor-not-allowed")}>
              Mock 关
            </label>
          </TooltipTrigger>
          <TooltipContent side="top">
            关掉后四类外设全部离线，用于验收"无外设也能手工完成一车闭环"（05 §10-1）
            {!canManage && <p className="text-muted-foreground">改动需 device.manage（仅站长）。当前账号不够，用左侧栏底部「换人」以站长密码重新登录</p>}
          </TooltipContent>
        </Tooltip>
        <Separator orientation="vertical" className="h-4" />
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <KeyboardIcon className="size-3.5 text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="font-medium">主要快捷键</p>
            <p className="text-muted-foreground">空格 捕获 · F7 下一单 · F8 读卡 · F5 化验 · F6 带价</p>
            <p className="text-muted-foreground">F10 结算打印 · F2 展示模式 · Ctrl+K 检索 · Ctrl+B 折叠侧栏</p>
          </TooltipContent>
        </Tooltip>
        <Separator orientation="vertical" className="h-4" />
        <span className="text-xs text-muted-foreground">
          当前操作员：
          <span className="text-foreground">{actor ? operatorLabel(actor) : "—"}</span>
        </span>
      </span>
    </footer>
  );
}
