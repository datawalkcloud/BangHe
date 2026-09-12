/**
 * 所有后端调用的唯一出口（05 §8：组件里不允许出现字符串命令名）。
 *
 * 覆盖状态（2026-09-12 起）：`src/mock/api.ts` 的**每一个**方法都能在下面这条展开链里找到
 * 同名的真库实现——浏览器预览照旧跑 mock，装成桌面端就是 SQLite，不存在"这一个按钮还是假的"。
 * 这条不变量由 `src-tauri/tests/mock_coverage_contract.rs` 把守：新增一个没接后端的 mock 方法会红，
 * 写了原生模块却忘了展开进本文件、或者两个模块抢同一个键，同样会红。
 *
 * 按模块的落点：
 *  - `mastersApi` 基础档案 + 站点参数（键值由 `lib/settings-catalog.ts` 贴标签与单位）、
 *    `dashboardApi` 首页看板
 *  - `ordersApi` 工作台录单全链路（档案/磅单/化验/结算/打印）、`ordersCenterApi` 磅单中心补口
 *    （作废、本单所属结算单）、`qcApi` 化验队列与单项
 *  - `reportsApi` 日报 + 未付清 + 结算列表、`ledgerApi` 另外四张台账报表，两条共用
 *    `STAT_WHERE` 同一条汇总口径；`settlementsApi` 结算详情/待结算池/挂账账龄/补录收款、
 *    `paymentsApi` 收款流水与口径分布
 *  - `systemApi` 审计留痕与备份/校验/体检/恢复、`prefsApi` 工作台布局偏好、
 *    `devicesApi` 设备台账、`searchApi` 全局搜索
 *
 * 两类**故意不进这条链**的旁路：本机外设命令（`lib/native.ts` 的读卡器与打印机，回参是
 * `{ available, data, error }` 而不是裸数据，因为"没有通道"是常态）和高频读数流
 * （`lib/scale-native.ts` 走 tauri event `device://scale` 推流，不是请求/响应）。
 * 它们与页面之间隔着一层 store，所以名字对不上时由 `tests/command_wiring_contract.rs` 兜底。
 *
 * 覆盖是安全的——原生层与 mock 同名函数返回同一份字段，页面与 `hooks/useLookups.ts` 一行都不用改。
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
import { qcApi } from "@/lib/qc-native";
import { devicesApi } from "@/lib/devices-native";
import { paymentsApi } from "@/lib/payments-native";
import { searchApi } from "@/lib/search-native";
import { cardsApi } from "@/lib/cards-native";

export const api = { ...mockApi, ...mastersApi, ...dashboardApi, ...ordersApi, ...ordersCenterApi, ...reportsApi, ...systemApi, ...settlementsApi, ...ledgerApi, ...prefsApi, ...qcApi, ...devicesApi, ...paymentsApi, ...searchApi, ...cardsApi };

export type Api = typeof api;
export type { OrderRow, PartyDetail } from "@/mock/api";
