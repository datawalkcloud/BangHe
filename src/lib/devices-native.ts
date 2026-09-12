/**
 * 设备台账的原生通道（02 §M9、03 §9.20 `device_config`；页面 `src/pages/DevicesPage.tsx`）。
 *
 * 后端在 `src-tauri/src/devices.rs`：这一轮把
 * 台账读、启用/停用、Mock 切换、配置写入、联机探测回写、登记新设备七件事全部换成
 * SQLite，`device_config` 表从 0001 建好到现在第一次有人读写它。
 *
 * 三条与 `settlements-native.ts` 同样的纪律：
 *  1. 桌面端发 `device_*` 命令，浏览器预览回落 mock——演示机不断线。
 *  2. **把 invoke reject 出来的字符串包成 Error**：Rust 侧业务失败回的是人话短句
 *     （"联机测试未通过，配置未保存：设备未应答状态查询"），而页面一律写
 *     `onError: (e) => e.message`，不包这一层提示就成了"失败：undefined"。
 *  3. 入参原样透传，Rust 的 `*Input` 与 mock 同名函数逐字段同名；`operator_id` 会被
 *     serde 收下再忽略——操作人以会话为准，不信前端。
 *
 * 返回值的引用问题这里不存在：mock 是在内存数组上原地改字段的，所以它的 `listDevices`
 * 特意逐项浅拷贝，好让 react-query 比得出变化；真库每次查库都是新构造的 DTO，
 * 天然没有"同一批对象引用"这回事，不用再拷一遍。
 *
 * 与 mock 的有意差异（详见 Rust 模块头注）：`testDevice` 只探本机真有通道的三类
 * （ESC/POS 小票机、精伦读卡器、地磅的那条串口读数流——正在收数即在线，没开流时
 * `scale::probe_once` 临时开端口读三帧），探不到就回"该驱动（xxx）暂未接入本机探测通道"，
 * 耗时是实测；地磅的结论由设备中心当场 `reportDeviceProbe` 回写成状态灯。
 * 台账里没有的编码，两个开关也会回"设备不存在"而不是静默成功。
 */
import { runningInTauri } from "@/lib/native";
import { api as mock } from "@/mock/api";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : `${cmd} 调用失败`);
  }
}

type DeviceRow = Awaited<ReturnType<typeof mock.listDevices>>[number];
type DeviceList = Awaited<ReturnType<typeof mock.setDeviceEnabled>>;
type DeviceTestResult = Awaited<ReturnType<typeof mock.testDevice>>;
type UpdateDeviceConfigInput = Parameters<typeof mock.updateDeviceConfig>[0];
type ProbeReport = Parameters<typeof mock.reportDeviceProbe>[1];
type CreateDeviceInput = Parameters<typeof mock.createDevice>[0];
type UpdateDeviceInput = Parameters<typeof mock.updateDevice>[0];

export const devicesApi = {
  listDevices: (): Promise<DeviceRow[]> => (runningInTauri() ? call("device_list") : mock.listDevices()),

  /** 一次真自检：读台账 → 派发到本机通道 → 实测耗时；探不到的一律 ok:false，不当绿标 */
  testDevice: (code: string): Promise<DeviceTestResult> =>
    runningInTauri() ? call("device_test", { code }) : mock.testDevice(code),

  setDeviceMock: (code: string, mockOn: boolean): Promise<DeviceList> =>
    runningInTauri() ? call("device_mock", { code, mock: mockOn }) : mock.setDeviceMock(code, mockOn),

  setDeviceEnabled: (code: string, enabled: boolean): Promise<DeviceList> =>
    runningInTauri() ? call("device_enabled", { code, enabled }) : mock.setDeviceEnabled(code, enabled),

  /** 02 §M9 的门禁在服务端也判一次：`verify.mode === "device"` 而没通过就拒绝保存 */
  updateDeviceConfig: (input: UpdateDeviceConfigInput): Promise<DeviceRow> =>
    runningInTauri() ? call("device_config_update", { input }) : mock.updateDeviceConfig(input),

  reportDeviceProbe: (code: string, res: ProbeReport): Promise<DeviceRow> =>
    runningInTauri() ? call("device_probe_report", { code, res }) : mock.reportDeviceProbe(code, res),

  createDevice: (input: CreateDeviceInput): Promise<DeviceRow> =>
    runningInTauri() ? call("device_create", { input }) : mock.createDevice(input),

  /** 修改已登记设备（名称 / 驱动 / 关键参数 / 默认标记）；编码与类型不可改 */
  updateDevice: (input: UpdateDeviceInput): Promise<DeviceRow> =>
    runningInTauri() ? call("device_update", { input }) : mock.updateDevice(input),

  /** 删除设备（错录清理）；有业务历史（被称重记录或抓拍引用）的真实命令会拒删 */
  deleteDevice: (code: string, operatorId: number): Promise<DeviceList> =>
    runningInTauri() ? call("device_delete", { code }) : mock.deleteDevice(code, operatorId),
};
