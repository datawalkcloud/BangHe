/**
 * 所有后端调用的唯一出口（05 §8：组件里不允许出现字符串命令名）。
 *
 * 现在是"逐块换真库"的过渡态，所以按模块覆盖而不是整体替换：
 * 基础档案（`mastersApi`）、首页看板（`dashboardApi`）、工作台录单链路
 * （`ordersApi`：档案/磅单/化验/结算/打印）、磅单中心补口（`ordersCenterApi`：
 * 作废、本单所属结算单）、报表与挂账的读（`reportsApi`：日报、未付清清单）、
 * 系统与审计（`systemApi`：审计留痕、备份/校验/体检/恢复）、结算台账
 * （`settlementsApi`：详情/待结算池/挂账账龄/补录收款，列表走 `reportsApi`）
 * 已经打到 SQLite，其余仍指向 mock。`mastersApi` 还捎带了站点参数（`settings` /
 * `saveSetting`）：库里的键值由 `lib/settings-catalog.ts` 那份目录贴上标签与单位。
 * 台账报表页（05 §3 `/reports/$kind`）由两个通道拼齐：日报走 `reportsApi`，
 * 另外四个 tab（收购明细台账 / 质量分析 / 农户排行 / 作业量与异常）走 `ledgerApi`
 * （`src-tauri/src/ledger.rs`），两者共用 `STAT_WHERE` 同一条汇总口径。
 * 覆盖是安全的——原生层与 mock 同名函数返回同一份字段，页面与
 * `hooks/useLookups.ts` 一行都不用改；下一块（红冲、设备中心）照这个形状继续叠。
 *
 * 全部换完后本文件收成 `import { invoke } from "@tauri-apps/api/core"` 的薄壳。
 */
import { api as mockApi } from "@/mock/api";
import { mastersApi } from "@/lib/masters-native";
import { dashboardApi } from "@/lib/dashboard-native";
import { ordersApi } from "@/lib/orders-native";
import { ordersCenterApi } from "@/lib/orders-center-native";
import { reportsApi } from "@/lib/reports-native";
import { systemApi } from "@/lib/system-native";
import { settlementsApi } from "@/lib/settlements-native";
import { ledgerApi } from "@/lib/ledger-native";
import { prefsApi } from "@/lib/prefs-native";

export const api = { ...mockApi, ...mastersApi, ...dashboardApi, ...ordersApi, ...ordersCenterApi, ...reportsApi, ...systemApi, ...settlementsApi, ...ledgerApi, ...prefsApi };

export type Api = typeof api;
export type { OrderRow, PartyDetail } from "@/mock/api";
