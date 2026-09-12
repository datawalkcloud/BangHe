/**
 * Mock API：与未来 `src/lib/api.ts`（invoke 出口）同签名的异步函数集。
 *
 * 换成真实实现时：把本文件整体删除，`src/lib/api.ts` 改为
 *   import { invoke } from "@tauri-apps/api/core"
 *   export const api = { orders: (f) => invoke<PageResult<WeighOrder>>("order_list", { f }) , ... }
 * 页面与组件一行不改（05 §8）。
 */
import type {
  AppSetting,
  AuditLog,
  DailyReport,
  Dashboard,
  DeviceConfig,
  GrainVariety,
  LedgerRow,
  OrderFilters,
  PageResult,
  Party,
  PaymentRecord,
  PrintLog,
  PriceList,
  QualityReport,
  QcReport,
  Settlement,
  StaffLoadRow,
  Station,
  PartyRankRow,
  UserAccount,
  Warehouse,
  WeighOrder,
} from "./types";
import type { DeviceStatus, OrderStatus, PaperKind, PaymentMethod, PrintChannel } from "@/lib/constants";
import { stamp, type PrintVerify } from "@/lib/print-guard";
import {
  ALL_SLOTS,
  parties,
  priceLists,
  settings,
  station,
  users,
  varieties,
  warehouses,
  devices,
  previewOrderNo,
} from "./masters";
import {
  auditLogs,
  buildTimeline,
  orderById,
  orderOf,
  orders,
  payments,
  photosOf,
  printLogs,
  printsOf,
  qcOf,
  qcReports,
  settlements,
  settlementOfOrder,
} from "./orders";
import {
  buildDaily,
  buildDashboard,
  buildLedger,
  buildPartyRank,
  buildQuality,
  buildStaffLoad,
  creditRows,
  paymentMethodDist,
  todayKey,
} from "./analytics";
import { amountFen, dateKey } from "./rng";

const LATENCY = 90;
function sleep(ms = LATENCY): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function statableForSummary(o: WeighOrder): boolean {
  return o.settlement_weight_01kg != null && o.status !== "voided" && o.status !== "rejected";
}

function paginateOrders(rows: WeighOrder[], page = 1, pageSize = 50): PageResult<OrderRow> {
  const start = (page - 1) * pageSize;
  const stat = rows.filter(statableForSummary);
  return {
    rows: rows.slice(start, start + pageSize).map(toRow),
    total: rows.length,
    summary: {
      count: stat.length,
      net_01kg: stat.reduce((s, o) => s + (o.net_weight_01kg ?? 0), 0),
      settle_01kg: stat.reduce((s, o) => s + (o.settlement_weight_01kg ?? 0), 0),
      goods_fen: stat.reduce((s, o) => s + (o.goods_amount_fen ?? 0), 0),
      payable_fen: stat.reduce((s, o) => s + (o.payable_amount_fen ?? 0), 0),
    },
  };
}

/** 列表不返回明细聚合，模拟"按需取" */
export type OrderRow = Omit<WeighOrder, "records" | "photos" | "prints" | "timeline">;

function toRow(o: WeighOrder): OrderRow {
  const { records: _r, photos: _p, prints: _pr, timeline: _t, ...rest } = o;
  return rest;
}

export interface PartyDetail extends Party {
  recent: OrderRow[];
  tareHistory: { date: string; tare_01kg: number; source: string }[];
  credit_fen: number;
  total_net_01kg: number;
}

export const api = {
  /* ------------------------------------------------------------ 元信息 */
  async station(): Promise<Station> {
    await sleep(0);
    return station;
  },

  async staff(): Promise<UserAccount[]> {
    await sleep(0);
    return users;
  },

  async dashboard(): Promise<Dashboard> {
    await sleep();
    return buildDashboard();
  },

  /* ----------------------------------------------------------- 磅单 */
  async listOrders(f: OrderFilters): Promise<PageResult<OrderRow>> {
    await sleep();
    const page = f.page ?? 1;
    const pageSize = f.pageSize ?? 50;
    const kw = (f.keyword ?? "").trim().toLowerCase();
    let rows = orders.filter((o) => {
      if (f.dateFrom && o.business_date < f.dateFrom) return false;
      if (f.dateTo && o.business_date > f.dateTo) return false;
      if (f.status && f.status !== "all" && o.status !== f.status) return false;
      if (f.varietyId && f.varietyId !== "all" && o.variety_id !== f.varietyId) return false;
      if (f.paymentStatus && f.paymentStatus !== "all" && o.payment_status !== f.paymentStatus) return false;
      if (f.weightSource && f.weightSource !== "all" && o.weight_source !== f.weightSource) return false;
      if (f.partyId && f.partyId !== "all" && o.party_id !== f.partyId) return false;
      if (kw) {
        const hay = `${o.order_no} ${o.party_name} ${o.id_card_no.slice(-4)} ${o.vehicle_no ?? ""}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
    const key = f.sort ?? "registered_at";
    const dir = f.order === "asc" ? 1 : -1;
    rows = rows.slice().sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[key];
      const bv = (b as unknown as Record<string, unknown>)[key];
      if (av == null) return 1;
      if (bv == null) return -1;
      return av > bv ? dir : av < bv ? -dir : 0;
    });
    return paginateOrders(rows, page, pageSize);
  },

  async getOrder(no: string): Promise<WeighOrder | null> {
    await sleep();
    const o = orderOf(no);
    if (!o) return null;
    return {
      ...o,
      records: o.records ?? [],
      photos: photosOf(o),
      prints: printsOf(no),
      timeline: buildTimeline(o),
    };
  },

  async openOrders(): Promise<WeighOrder[]> {
    await sleep(0);
    const OPEN: OrderStatus[] = ["draft", "registered", "qc_done", "gross_weighed", "tare_weighed", "reweigh", "to_settle"];
    return orders.filter((o) => OPEN.includes(o.status));
  },

  /* ---------------------------------------------------------- 售粮人 */
  async listParties(keyword = "", type?: Party["party_type"] | "all"): Promise<Party[]> {
    await sleep();
    const kw = keyword.trim().toLowerCase();
    return parties.filter((p) => {
      if (type && type !== "all" && p.party_type !== type) return false;
      if (!kw) return true;
      return `${p.name} ${p.code} ${p.id_card_no} ${p.phone} ${p.default_vehicle_no ?? ""}`.toLowerCase().includes(kw);
    });
  },

  async getParty(id: number): Promise<PartyDetail | null> {
    await sleep();
    const p = parties.find((x) => x.id === id);
    if (!p) return null;
    const mine = orders.filter((o) => o.party_id === id);
    return {
      ...p,
      recent: mine.slice(0, 8).map(toRow),
      tareHistory: mine
        .filter((o) => o.tare_weight_01kg != null)
        .slice(0, 12)
        .map((o) => ({ date: o.business_date, tare_01kg: o.tare_weight_01kg!, source: o.weight_source })),
      credit_fen: settlements.filter((s) => s.party_id === id && s.status === "normal").reduce((s, x) => s + (x.payable_fen - x.paid_fen), 0),
      total_net_01kg: mine.filter(statableForSummary).reduce((s, o) => s + (o.net_weight_01kg ?? 0), 0),
    };
  },

  /* ---------------------------------------------------------- 化验 */
  async listQc(opts: { onlyPending?: boolean; keyword?: string } = {}): Promise<QcReport[]> {
    await sleep();
    const kw = (opts.keyword ?? "").trim().toLowerCase();
    return qcReports.filter((q) => {
      if (opts.onlyPending) return false;
      if (kw && !`${q.report_no} ${q.order_no} ${q.party_name} ${q.sample_no}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  },

  async getQc(reportNo: string): Promise<{ report: QcReport; first?: QcReport } | null> {
    await sleep();
    const r = qcReports.find((x) => x.report_no === reportNo);
    if (!r) return null;
    const first = r.first_report_id ? qcReports.find((x) => x.id === r.first_report_id) : undefined;
    return { report: r, first };
  },

  /** 待检队列：已登记但还没有有效化验单的磅单 */
  async qcQueue(): Promise<WeighOrder[]> {
    await sleep();
    return orders.filter((o) => (o.status === "registered" || o.status === "draft") && qcOf(o.qc_report_id) == null);
  },

  /* -------------------------------------------------------- 结算/付款 */
  async listSettlements(filter: { paymentStatus?: Settlement["payment_status"] | "all"; keyword?: string } = {}): Promise<Settlement[]> {
    await sleep();
    const kw = (filter.keyword ?? "").trim().toLowerCase();
    return settlements.filter((s) => {
      if (filter.paymentStatus && filter.paymentStatus !== "all" && s.payment_status !== filter.paymentStatus) return false;
      if (kw && !`${s.settle_no} ${s.party_name}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  },

  /** 待结算池：已到 to_settle 的磅单，按售粮人分组 */
  async pendingSettlements(): Promise<{ party: Party; rows: WeighOrder[] }[]> {
    await sleep();
    const pool = orders.filter((o) => o.status === "to_settle" || o.status === "reweigh");
    const map = new Map<number, WeighOrder[]>();
    for (const o of pool) {
      const arr = map.get(o.party_id) ?? [];
      arr.push(o);
      map.set(o.party_id, arr);
    }
    return Array.from(map.entries())
      .map(([pid, rows]) => ({ party: parties.find((p) => p.id === pid)!, rows }))
      .sort((a, b) => b.rows.length - a.rows.length);
  },

  async listPayments(from: string, to: string): Promise<PaymentRecord[]> {
    await sleep();
    return payments.filter((p) => {
      const d = p.paid_at.slice(0, 10);
      return d >= from && d <= to;
    });
  },

  async credits() {
    await sleep();
    return creditRows();
  },

  async paymentMethodDist(from: string, to: string) {
    await sleep(0);
    return paymentMethodDist(from, to);
  },

  /* ---------------------------------------------------------- 主数据 */
  async varieties(): Promise<GrainVariety[]> {
    await sleep(0);
    return varieties;
  },

  async warehouses(): Promise<Warehouse[]> {
    await sleep(0);
    return warehouses;
  },

  async prices(): Promise<PriceList[]> {
    await sleep(0);
    return priceLists;
  },

  async settings(): Promise<AppSetting[]> {
    await sleep(0);
    return settings;
  },

  async slots() {
    await sleep(0);
    return ALL_SLOTS;
  },

  /* ------------------------------------------------------ 档案写入 */
  /**
   * 档案类写操作只在内存里生效，重启回到种子数据。
   * 现在就把接口给全，是因为界面必须把「新增 / 修改 / 启停」的表单流跑完；
   * 换 invoke 时函数名与入参可原样平移，Rust 侧把数组操作换成 UPSERT 即可。
   * 每一次写入都进 audit_log，与工作台的关键动作同表（01 §F7.2）。
   */
  async saveParty(
    input: Partial<Party> & {
      name: string;
      id_card_no: string;
      party_type: Party["party_type"];
      operator_id: number;
      id?: number | null;
    },
  ): Promise<Party> {
    await sleep(120);
    const idx = input.id != null ? parties.findIndex((p) => p.id === input.id) : -1;
    if (idx >= 0) {
      const next: Party = { ...parties[idx], ...input, id: parties[idx].id };
      parties[idx] = next;
      auditMaster("party.update", "party", next.code, input.operator_id);
      return next;
    }
    const created: Party = {
      id: parties.reduce((m, p) => Math.max(m, p.id), 0) + 1,
      code: `P${String(parties.length + 1).padStart(4, "0")}`,
      name: input.name,
      party_type: input.party_type,
      id_card_no: input.id_card_no,
      // 与真库 save_party 同口径：核验标记由调用方（证号是否读卡带入）决定，缺省未核验
      id_card_verified: input.id_card_verified ?? 0,
      phone: input.phone ?? "",
      address: input.address ?? "",
      bank_name: input.bank_name ?? null,
      bank_account: input.bank_account ?? null,
      credit_limit_fen: input.credit_limit_fen ?? 0,
      default_warehouse_id: input.default_warehouse_id ?? null,
      default_slot_id: input.default_slot_id ?? null,
      default_vehicle_no: input.default_vehicle_no ?? null,
      last_tare_01kg: input.last_tare_01kg ?? null,
      remark: input.remark ?? null,
      status: "active",
      created_at: localIso(new Date()),
    };
    parties.unshift(created);
    auditMaster("party.create", "party", created.code, input.operator_id);
    return created;
  },

  async saveVariety(
    input: Partial<GrainVariety> & { code: string; name: string; operator_id: number; id?: number | null },
  ): Promise<GrainVariety> {
    await sleep(100);
    const idx = input.id != null ? varieties.findIndex((v) => v.id === input.id) : -1;
    if (idx >= 0) {
      const next: GrainVariety = { ...varieties[idx], ...input, id: varieties[idx].id };
      varieties[idx] = next;
      auditMaster("variety.update", "grain_variety", next.code, input.operator_id);
      return next;
    }
    const created: GrainVariety = {
      id: varieties.reduce((m, v) => Math.max(m, v.id), 0) + 1,
      code: input.code,
      name: input.name,
      category: input.category ?? "其他",
      std_moisture_001pct: input.std_moisture_001pct ?? null,
      std_impurity_001pct: input.std_impurity_001pct ?? null,
      std_unsound_001pct: input.std_unsound_001pct ?? null,
      std_bulk_density: input.std_bulk_density ?? null,
      reject_moisture_001pct: input.reject_moisture_001pct ?? null,
      enabled_indicators: input.enabled_indicators ?? ["moisture", "impurity"],
      default_package_deduct_01kg: input.default_package_deduct_01kg ?? 0,
      sort_order: input.sort_order ?? varieties.length + 1,
      is_active: input.is_active ?? 1,
    };
    varieties.push(created);
    auditMaster("variety.create", "grain_variety", created.code, input.operator_id);
    return created;
  },

  /**
   * 删除品种。mock 不建模外键，但为让预览与桌面端语义一致，
   * 仍先查引用：被价目表或磅单引用过的品种拒绝删除，只能「停用」。
   * 真实实现是软删除（grain_variety.deleted_at），引用查询由数据库层负责。
   */
  async deleteVariety(id: number, operator_id: number): Promise<GrainVariety> {
    await sleep(60);
    const idx = varieties.findIndex((v) => v.id === id);
    if (idx < 0) throw new Error("品种不存在");
    const v = varieties[idx];
    const usedByPrice = priceLists.some((p) => p.variety_id === id);
    const usedByOrder = orders.some((o) => o.variety_id === id);
    if (usedByPrice || usedByOrder) {
      auditMaster("variety.delete", "grain_variety", v.code, operator_id, "仍被价目表或磅单引用，已拒绝");
      throw new Error("该品种已在价目表或历史磅单中被引用，不能删除；如不再使用请改为「停用」");
    }
    const [removed] = varieties.splice(idx, 1);
    auditMaster("variety.delete", "grain_variety", removed.code, operator_id, `删除 ${removed.name}（${removed.code}）`);
    return removed;
  },

  /** 调价：只追加新价目，不改历史价（历史价是已结算单的证据，01 §F2.3） */
  async savePrice(
    input: {
      variety_id: number;
      grade: PriceList["grade"];
      price_fen_per_ton: number;
      effective_from: string;
      effective_to: string;
      basis: string;
      remark?: string | null;
      operator_id: number;
      id?: number | null;
    },
  ): Promise<PriceList> {
    await sleep(100);
    const idx = input.id != null ? priceLists.findIndex((p) => p.id === input.id) : -1;
    if (idx >= 0) {
      const next: PriceList = { ...priceLists[idx], ...input, id: priceLists[idx].id };
      priceLists[idx] = next;
      auditMaster("price.update", "price_list", `${next.variety_id}/${next.grade}`, input.operator_id, "调价");
      return next;
    }
    const created: PriceList = {
      id: priceLists.reduce((m, p) => Math.max(m, p.id), 0) + 1,
      variety_id: input.variety_id,
      grade: input.grade,
      price_fen_per_ton: input.price_fen_per_ton,
      effective_from: input.effective_from,
      effective_to: input.effective_to,
      basis: input.basis,
      made_by: input.operator_id,
      approved_by: users.find((u) => u.role === "station_master")?.id ?? null,
      remark: input.remark ?? null,
    };
    priceLists.unshift(created);
    auditMaster("price.create", "price_list", `${created.variety_id}/${created.grade}`, input.operator_id, "调价");
    return created;
  },

  /**
   * 写站点参数。涉及把单据打到热敏机的选项（打印通道 / 纸型）必须带 `verify`：
   * 真机测试不通过就拒绝保存；浏览器预览测不了则照写，但审计里明写"未经真机验证"。
   */
  async saveSetting(key: string, value: string, operator_id: number, verify: PrintVerify | null = null): Promise<AppSetting[]> {
    await sleep(60);
    if (verify && verify.mode === "device" && !verify.ok) {
      throw new Error(`联机测试未通过，参数未保存：${verify.message}`);
    }
    const s = settings.find((x) => x.key === key);
    if (s) {
      const old = s.value;
      s.value = value;
      const tail = verify === null || verify.mode === "device" ? "" : "（未经真机验证）";
      auditMaster("setting.update", "app_setting", key, operator_id, `${old} → ${value}${tail}`);
    }
    return settings.slice();
  },

  async saveStaff(
    input: Partial<UserAccount> & { username: string; display_name: string; role: UserAccount["role"]; operator_id: number; id?: number | null },
  ): Promise<UserAccount> {
    await sleep(100);
    const idx = input.id != null ? users.findIndex((u) => u.id === input.id) : -1;
    if (idx >= 0) {
      const next: UserAccount = { ...users[idx], ...input, id: users[idx].id };
      users[idx] = next;
      auditMaster("staff.update", "user_account", next.username, input.operator_id);
      return next;
    }
    if (users.some((u) => u.username === input.username)) {
      auditMaster("staff.create", "user_account", input.username, input.operator_id, "登录名重复，已拒绝");
      throw new Error(`登录名 ${input.username} 已存在`);
    }
    const created: UserAccount = {
      id: users.reduce((m, u) => Math.max(m, u.id), 0) + 1,
      username: input.username,
      display_name: input.display_name,
      role: input.role,
      phone: input.phone ?? "",
      is_active: input.is_active ?? 1,
      last_login_at: null,
    };
    users.push(created);
    auditMaster("staff.create", "user_account", created.username, input.operator_id);
    return created;
  },

  /* ------------------------------------------------------------ 设备 */
  async listDevices(): Promise<DeviceConfig[]> {
    await sleep();
    // 逐项拷贝再返回：mock 是在内存数组上原地改字段的，直接把同一批对象引用交给
    // react-query，它做结构比对时会认为"数据没变"而不通知订阅者——联机探测回写后
    // 卡片的状态灯就不会跟着刷新。
    return devices.map((d) => ({ ...d }));
  },

  /** 设备自检：mock 下恒定返回一次探测结果，界面据此演示"测试面板" */
  async testDevice(code: string): Promise<{ ok: boolean; message: string; elapsedMs: number }> {
    await sleep(260);
    const d = devices.find((x) => x.code === code);
    if (!d) return { ok: false, message: "设备不存在", elapsedMs: 0 };
    if (d.last_status === "online") return { ok: true, message: `握手成功，帧族解析正常（${d.driver}）`, elapsedMs: 240 };
    if (d.last_status === "error") return { ok: false, message: d.last_error ?? "自检失败", elapsedMs: 2000 };
    return { ok: false, message: "无响应，请检查供电与连线（超时 2000 ms）", elapsedMs: 2000 };
  },

  async setDeviceMock(code: string, mock: boolean): Promise<DeviceConfig[]> {
    await sleep(60);
    const d = devices.find((x) => x.code === code);
    if (d) d.is_mock = mock ? 1 : 0;
    return devices.map((x) => ({ ...x }));
  },

  async setDeviceEnabled(code: string, enabled: boolean): Promise<DeviceConfig[]> {
    await sleep(60);
    const d = devices.find((x) => x.code === code);
    if (d) {
      d.is_enabled = enabled ? 1 : 0;
      d.last_status = enabled ? "unknown" : "offline";
    }
    return devices.map((x) => ({ ...x }));
  },

  /**
   * 写设备配置（真实实现即 `device_config.config_json`）。
   *
   * 门禁（02 §M9）：改完必须能打通才算配好。桌面端有原生通道时，调用方必须先做一次
   * 联机测试并把结果传进来——不通过就直接拒绝，不留下"保存了但打不出"的配置；
   * 浏览器预览测不了，则允许保存但状态停在"未检测"、把原因写进 last_error，
   * 卡片上表现为黄标，等桌面端验过才转绿。
   */
  async updateDeviceConfig(input: {
    code: string;
    config: Record<string, string | number | boolean>;
    operator_id: number;
    verify: PrintVerify;
  }): Promise<DeviceConfig> {
    await sleep(80);
    const d = devices.find((x) => x.code === input.code);
    if (!d) throw new Error("设备不存在");
    if (input.verify.mode === "device" && !input.verify.ok) {
      throw new Error(`联机测试未通过，配置未保存：${input.verify.message}`);
    }
    const old = JSON.stringify(d.config);
    d.config = { ...d.config, ...input.config };
    if (input.verify.mode === "device") {
      d.last_status = "online";
      d.last_ok_at = stamp();
      d.last_error = null;
      d.err_count = 0;
    } else {
      d.last_status = "unknown";
      d.last_error = input.verify.message;
    }
    auditMaster(
      "device.update",
      "device_config",
      d.code,
      input.operator_id,
      `${old} → ${JSON.stringify(d.config)}${input.verify.mode === "device" ? "" : "（未经真机验证）"}`,
    );
    return { ...d };
  },

  /**
   * 回写一次真实联机探测的结果（不动配置，只更新状态四字段）。
   *
   * 为什么必须有这条：卡片上的状态灯读的是台账 `last_status`，而台账里存的是安装时录入的值。
   * 不做回写，真机明明在线应答 `DLE EOT`，卡片却会一直停在"未检测"——现场读到的是
   * "软件没认出这台机"，而不是"这台机没问题"，等于把一个好设备报成了故障。
   * 真实实现即 `device_config` 的 last_status / last_ok_at / last_error / err_count。
   */
  async reportDeviceProbe(
    code: string,
    res: { status: DeviceStatus; error: string | null; at: string },
  ): Promise<DeviceConfig> {
    await sleep(40);
    const d = devices.find((x) => x.code === code);
    if (!d) throw new Error("设备不存在");
    d.last_status = res.status;
    // 在线时不残留上一次的告警文案，否则绿标旁边挂着红字，等于没有状态
    d.last_error = res.status === "online" ? null : res.error;
    if (res.status === "online") {
      d.last_ok_at = res.at;
      d.err_count = 0;
    } else if (res.status !== "unknown") {
      // "未检测"是"没问到可信状态"，不是设备故障，不计入错误次数
      d.err_count += 1;
    }
    return { ...d };
  },

  /**
   * 登记现场硬件（新增设备）。真实实现即向 `device_config` 插入一行。
   *
   * 编码是台账里的人工主键——「导出配置」和换机重建都按它核对，所以必须唯一；
   * 新设备一律先记「未检测」：登记 ≠ 联机验证，状态灯要等右侧面板做一次真实联机测试
   * 通过后才转绿（02 §M9）。设为默认时自动把同类旧的默认机降级，保证每类至多一台默认。
   */
  async createDevice(input: {
    code: string;
    name: string;
    kind: DeviceConfig["kind"];
    driver: string;
    config: Record<string, string | number | boolean>;
    is_default: boolean;
    is_mock: boolean;
    operator_id: number;
  }): Promise<DeviceConfig> {
    await sleep(100);
    const code = input.code.trim();
    if (!code) throw new Error("设备编码必填");
    if (devices.some((d) => d.code === code)) {
      auditMaster("device.create", "device_config", code, input.operator_id, "编码重复，已拒绝");
      throw new Error(`编码 ${code} 已存在：编码是台账主键，不能重复`);
    }
    if (input.is_default) {
      devices.filter((d) => d.kind === input.kind).forEach((d) => (d.is_default = 0));
    }
    const created: DeviceConfig = {
      id: devices.reduce((m, d) => Math.max(m, d.id), 0) + 1,
      code,
      name: input.name.trim(),
      kind: input.kind,
      driver: input.driver,
      config: input.config,
      is_enabled: 1,
      is_mock: input.is_mock ? 1 : 0,
      is_default: input.is_default ? 1 : 0,
      last_status: "unknown",
      last_ok_at: null,
      last_error: null,
      err_count: 0,
    };
    devices.push(created);
    auditMaster(
      "device.create",
      "device_config",
      created.code,
      input.operator_id,
      `新增 ${created.name}（${created.kind} · 驱动 ${created.driver}），状态未检测待联机测试`,
    );
    return { ...created };
  },

  /**
   * 修改已登记设备（真实实现即 `device_config` 的 UPDATE）。编码与类型不可改：
   * 编码是台账主键、被打印留痕与外键引用；换类型请「停用 + 重新登记」。
   * `config` 合并写入（表单没露出的键保留），改了驱动或配置就把联机结论作废回到未检测。
   */
  async updateDevice(input: {
    code: string;
    name: string;
    kind: DeviceConfig["kind"];
    driver: string;
    config: Record<string, string | number | boolean>;
    is_default: boolean;
    operator_id: number;
  }): Promise<DeviceConfig> {
    await sleep(100);
    const d = devices.find((x) => x.code === input.code);
    if (!d) throw new Error("设备不存在");
    const name = input.name.trim();
    if (!name) throw new Error("设备名称必填：台账靠名字认机器");
    if (!input.driver.trim()) throw new Error("驱动协议必填");
    if (input.kind !== d.kind) throw new Error(`设备类型不可修改（当前 ${d.kind}）；换类型请停用本台后重新登记`);
    const oldCfg = JSON.stringify(d.config);
    d.config = { ...d.config, ...input.config };
    const driverChanged = input.driver.trim() !== d.driver;
    const cfgChanged = JSON.stringify(d.config) !== oldCfg;
    const invalidate = driverChanged || cfgChanged;
    if (input.is_default && d.is_default !== 1) {
      devices.filter((x) => x.kind === d.kind).forEach((x) => (x.is_default = 0));
    }
    d.name = name;
    d.driver = input.driver.trim();
    d.is_default = input.is_default ? 1 : 0;
    if (invalidate) {
      d.last_status = "unknown";
      d.last_ok_at = null;
      d.last_error = null;
    }
    auditMaster(
      "device.update",
      "device_config",
      d.code,
      input.operator_id,
      `编辑 ${d.name}（驱动 ${d.driver}）${invalidate ? "：驱动/配置已变，回到未检测待重测" : ""}`,
    );
    return { ...d };
  },

  /**
   * 删除设备（错录清理）。真实命令会先查 weigh_record / attachment 的引用再决定，
   * 有业务历史的拒删；mock 不建模这些外键，演示机直接移除并留痕。
   */
  async deleteDevice(code: string, operator_id: number): Promise<DeviceConfig[]> {
    await sleep(60);
    const idx = devices.findIndex((x) => x.code === code);
    if (idx < 0) throw new Error("设备不存在");
    const [removed] = devices.splice(idx, 1);
    auditMaster("device.delete", "device_config", code, operator_id, `删除 ${removed.name}（${removed.kind} · 驱动 ${removed.driver}）`);
    return devices.map((x) => ({ ...x }));
  },

  /* ------------------------------------------------------------ 报表 */
  async reportDaily(date: string): Promise<DailyReport> {
    await sleep(160);
    return buildDaily(date);
  },

  async reportLedger(from: string, to: string): Promise<LedgerRow[]> {
    await sleep(220);
    return buildLedger(from, to);
  },

  async reportQuality(from: string, to: string): Promise<QualityReport> {
    await sleep(160);
    return buildQuality(from, to);
  },

  async reportParties(from: string, to: string): Promise<PartyRankRow[]> {
    await sleep(140);
    return buildPartyRank(from, to);
  },

  async reportStaff(from: string, to: string): Promise<StaffLoadRow[]> {
    await sleep(140);
    return buildStaffLoad(from, to);
  },

  async listAudits(keyword = ""): Promise<AuditLog[]> {
    await sleep();
    const kw = keyword.trim().toLowerCase();
    if (!kw) return auditLogs.slice(0, 200);
    return auditLogs.filter((a) => `${a.actor_name} ${a.action} ${a.entity_no ?? ""}`.toLowerCase().includes(kw)).slice(0, 200);
  },

  /* ------------------------------------------------- 工作台写操作（内存态） */

  async createOrder(input: {
    party_id: number;
    variety_id: number;
    vehicle_no: string | null;
    warehouse_id: number | null;
    slot_id: number | null;
    remark: string | null;
    registered_by: number;
    weight_source: "scale" | "manual";
  }): Promise<WeighOrder> {
    await sleep(120);
    const p = parties.find((x) => x.id === input.party_id)!;
    const v = varieties.find((x) => x.id === input.variety_id)!;
    const date = todayKey();
    const now = new Date();
    const o: WeighOrder = {
      id: orders.length + 1000,
      order_no: previewOrderNo(date),
      business_date: date,
      status: "registered",
      party_id: p.id,
      party_name: p.name,
      party_type: p.party_type,
      id_card_no: p.id_card_no,
      variety_id: v.id,
      variety_code: v.code,
      variety_name: v.name,
      grade: null,
      warehouse_id: input.warehouse_id,
      warehouse_name: warehouses.find((w) => w.id === input.warehouse_id)?.name ?? null,
      slot_id: input.slot_id,
      slot_label: ALL_SLOTS.find((s) => s.id === input.slot_id)?.label ?? null,
      vehicle_no: input.vehicle_no,
      driver_name: p.name,
      gross_weight_01kg: null,
      tare_weight_01kg: null,
      net_weight_01kg: null,
      package_deduct_01kg: 0,
      package_count: 0,
      moisture_deduct_01kg: 0,
      impurity_deduct_01kg: 0,
      other_deduct_01kg: 0,
      deduct_total_01kg: 0,
      settlement_weight_01kg: null,
      price_fen_per_ton: null,
      price_list_id: null,
      price_override_reason: null,
      goods_amount_fen: null,
      deduction_fee_fen: 0,
      advance_fee_fen: 0,
      payable_amount_fen: null,
      paid_amount_fen: 0,
      payment_status: "not_required",
      payment_method: null,
      weight_source: input.weight_source,
      tare_override_by: null,
      tare_override_reason: null,
      is_manual_pricing: 1,
      reversed_order_id: null,
      reverse_of_id: null,
      qc_report_id: null,
      registered_by: input.registered_by,
      registered_at: dateKey(now) + "T" + now.toTimeString().slice(0, 8) + tzSuffix(now),
      gross_at: null,
      tare_at: null,
      qc_at: null,
      settled_at: null,
      paid_at: null,
      voided_at: null,
      void_reason: null,
      weigher_id: null,
      inspector_id: null,
      keeper_id: null,
      remark: input.remark,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      records: [],
    };
    orders.unshift(o);
    auditLogs.unshift({
      id: o.id, at: o.registered_at, actor_id: input.registered_by, actor_name: users.find((u) => u.id === input.registered_by)?.display_name ?? "—",
      action: "order.create", entity: "weigh_order", entity_no: o.order_no, reason: null, authorized_by: null, result: "ok",
    });
    return o;
  },

  /** 捕获读数（毛/皮），写称重轨迹并推进状态 */
  async capture(input: {
    order_no: string;
    weigh_type: "gross" | "tare";
    weight_01kg: number;
    source: "scale" | "manual";
    operator_id: number;
    raw_frame?: string;
    has_photo: boolean;
    /** 皮重与历史均值偏差超容差时的授权放行记录，无授权不得传入 */
    tare_override?: { by: number; reason: string } | null;
  }): Promise<WeighOrder | null> {
    await sleep(80);
    const o = orderOf(input.order_no);
    if (!o) return null;
    o.records = o.records ?? [];
    const at = localIso(new Date());
    o.records.push({
      id: (o.records?.length ?? 0) + 1,
      seq: (o.records?.length ?? 0) + 1,
      weigh_type: input.weigh_type,
      weight_01kg: input.weight_01kg,
      aligned_weight_01kg: input.weight_01kg,
      is_adopted: 1,
      adopt_reason: null,
      source: input.source,
      device_code: input.source === "scale" ? "scale1" : "—",
      raw_frame: input.raw_frame ?? null,
      stable: 1,
      captured_at: at,
      operator_id: input.operator_id,
      has_photo: input.has_photo,
    });
    if (input.weigh_type === "gross") {
      o.gross_weight_01kg = input.weight_01kg;
      o.gross_at = at;
    } else {
      o.tare_weight_01kg = input.weight_01kg;
      o.tare_at = at;
    }
    if (input.source === "manual") o.weight_source = "manual";
    o.weigher_id = input.operator_id;
    if (input.weigh_type === "tare" && input.tare_override) {
      o.tare_override_by = input.tare_override.by;
      o.tare_override_reason = input.tare_override.reason;
      auditLogs.unshift({
        id: o.id,
        at,
        actor_id: input.operator_id,
        actor_name: users.find((u) => u.id === input.operator_id)?.display_name ?? "—",
        action: "tare.override",
        entity: "weigh_order",
        entity_no: o.order_no,
        reason: input.tare_override.reason,
        authorized_by: users.find((u) => u.id === input.tare_override!.by)?.display_name ?? "—",
        result: "ok",
      });
    }
    if (o.gross_weight_01kg != null && o.tare_weight_01kg != null) {
      o.net_weight_01kg = Math.abs(o.gross_weight_01kg - o.tare_weight_01kg);
      o.status = "to_settle";
    } else {
      o.status = input.weigh_type === "gross" ? "gross_weighed" : "tare_weighed";
    }
    o.updated_at = at;
    return o;
  },

  /** 保存化验：写指标与人工判等，绝不自动算扣量 */
  async saveQc(input: {
    order_no: string;
    grade: string | null;
    decision: QcReport["decision"];
    test_method: QcReport["test_method"];
    indicators: { code: string; name: string; value_num: number | null; value_text: string | null; unit: "0.01pct" | "gL" | "text"; std_value: number | null; over_std: 0 | 1 }[];
    moisture_deduct_01kg: number;
    impurity_deduct_01kg: number;
    inspector_id: number;
    reject_reason?: string | null;
  }): Promise<QcReport | null> {
    await sleep(120);
    const o = orderOf(input.order_no);
    if (!o) return null;
    const now = localIso(new Date());
    const report: QcReport = {
      id: qcReports.length + 1,
      report_no: `ZJ${station.code}${now.slice(0, 10).replace(/-/g, "")}${String(qcReports.length + 1).padStart(6, "0")}`,
      order_id: o.id,
      order_no: o.order_no,
      party_name: o.party_name,
      sample_no: `YP${now.slice(2, 10).replace(/-/g, "")}${String(o.id % 1000).padStart(3, "0")}`,
      variety_id: o.variety_id,
      grade: (input.grade as QcReport["grade"]) ?? null,
      decision: input.decision,
      reject_reason: input.reject_reason ?? null,
      moisture_deduct_01kg: input.moisture_deduct_01kg,
      impurity_deduct_01kg: input.impurity_deduct_01kg,
      test_method: input.test_method,
      is_recheck: 0,
      first_report_id: null,
      is_effective: 1,
      inspector_id: input.inspector_id,
      inspected_at: now,
      retention_no: `LY${now.slice(2, 10).replace(/-/g, "")}M`,
      retention_until: dateKey(new Date(Date.now() + 30 * 86400000)),
      indicators: input.indicators.map((x, i) => ({ ...x, sort_order: i })),
      remark: null,
    };
    qcReports.push(report);
    o.qc_report_id = report.id;
    o.qc_at = now;
    o.grade = report.grade;
    o.inspector_id = input.inspector_id;
    if (report.decision === "reject") {
      o.status = "rejected";
    } else if (o.gross_weight_01kg == null && o.tare_weight_01kg == null) {
      o.status = "qc_done";
    }
    o.updated_at = now;
    return report;
  },

  /** 结算：写死单价（人工计价），生成应付并进入 settled */
  async settle(input: {
    order_no: string;
    price_fen_per_ton: number;
    package_deduct_01kg: number;
    moisture_deduct_01kg: number;
    impurity_deduct_01kg: number;
    other_deduct_01kg: number;
    deduction_fee_fen: number;
    pay_now: boolean;
    payment_method: PaymentMethod;
    settler_id: number;
    /** 价目表带出时记下来源，便于事后追溯"这个价从哪张表来的" */
    price_list_id?: number | null;
    /** 偏离价目表时的改价事由，迎检必查 */
    price_override_reason?: string | null;
    /** 售粮人是否已在纸质码单上签字 */
    party_signed?: boolean;
  }): Promise<{ order: WeighOrder; settlement: Settlement } | null> {
    await sleep(160);
    // 01 §F2.3：偏离价目或没有生效价目时都是手填价，必须留改价事由（与 Rust 端 settle 同口径）
    if (input.price_list_id == null && !(input.price_override_reason ?? "").trim()) {
      throw new Error("手填单价必须填写改价事由（历史价是已结算单的唯一可追溯出处）");
    }
    const o = orderOf(input.order_no);
    if (!o || o.net_weight_01kg == null) return null;
    const now = localIso(new Date());
    const deduct = input.package_deduct_01kg + input.moisture_deduct_01kg + input.impurity_deduct_01kg + input.other_deduct_01kg;
    const settleWeight = o.net_weight_01kg - deduct;
    if (settleWeight <= 0) return null;
    const goods = amountFen(settleWeight, input.price_fen_per_ton);
    const payable = goods - input.deduction_fee_fen;
    Object.assign(o, {
      package_deduct_01kg: input.package_deduct_01kg,
      moisture_deduct_01kg: input.moisture_deduct_01kg,
      impurity_deduct_01kg: input.impurity_deduct_01kg,
      other_deduct_01kg: input.other_deduct_01kg,
      deduct_total_01kg: deduct,
      settlement_weight_01kg: settleWeight,
      price_fen_per_ton: input.price_fen_per_ton,
      price_list_id: input.price_list_id ?? null,
      price_override_reason: input.price_override_reason ?? null,
      goods_amount_fen: goods,
      deduction_fee_fen: input.deduction_fee_fen,
      payable_amount_fen: payable,
      status: "settled" as OrderStatus,
      settled_at: now,
      updated_at: now,
    });
    if (input.pay_now) {
      o.paid_amount_fen = payable;
      o.payment_status = "paid";
      o.payment_method = input.payment_method;
      o.paid_at = now;
    } else {
      o.paid_amount_fen = 0;
      o.payment_status = "unpaid";
      o.payment_method = null;
    }
    const date = o.business_date;
    const settlement: Settlement = {
      id: settlements.length + 1,
      settle_no: `JS${station.code}${date.replace(/-/g, "")}${String(settlements.length + 1).padStart(6, "0")}`,
      party_id: o.party_id,
      party_name: o.party_name,
      business_date: date,
      period_from: date,
      period_to: date,
      order_count: 1,
      total_net_01kg: o.net_weight_01kg,
      total_deduct_01kg: deduct,
      total_settle_01kg: settleWeight,
      total_goods_fen: goods,
      total_deduction_fen: input.deduction_fee_fen,
      total_advance_fen: 0,
      payable_fen: payable,
      paid_fen: o.paid_amount_fen,
      payment_status: input.pay_now ? "paid" : "unpaid",
      main_method: input.pay_now ? input.payment_method : null,
      payee_name: o.party_name,
      signed_by_party: input.party_signed ? 1 : 0,
      status: "normal",
      settled_at: now,
      settler_id: input.settler_id,
      orders: [{ order_id: o.id, order_no: o.order_no, goods_amount_fen: goods, price_fen_per_ton: input.price_fen_per_ton, settlement_weight_01kg: settleWeight, seq: 1 }],
      remark: "工作台当场结算",
    };
    settlements.push(settlement);
    if (input.pay_now) {
      payments.push({
        id: payments.length + 1,
        pay_no: `FK${station.code}${date.replace(/-/g, "")}${String(payments.length + 1).padStart(6, "0")}`,
        settlement_id: settlement.id,
        settle_no: settlement.settle_no,
        order_id: null,
        order_no: null,
        party_id: o.party_id,
        party_name: o.party_name,
        amount_fen: payable,
        method: input.payment_method,
        trade_no: null,
        payee_name: o.party_name,
        paid_at: now,
        operator_id: input.settler_id,
        voucher_no: null,
        reversed: 0,
        remark: "当场结清",
      });
    }
    return { order: o, settlement };
  },

  /** 作废：单据永不物理删除，只置状态并留授权与原因 */
  async voidOrder(input: { order_no: string; reason: string; operator_id: number; authorized_by: number }): Promise<WeighOrder | null> {
    await sleep(120);
    const o = orderOf(input.order_no);
    if (!o) return null;
    const now = localIso(new Date());
    o.status = "voided";
    o.voided_at = now;
    o.void_reason = input.reason;
    o.updated_at = now;
    auditLogs.unshift({
      id: o.id, at: now, actor_id: input.operator_id,
      actor_name: users.find((u) => u.id === input.operator_id)?.display_name ?? "—",
      action: "order.void", entity: "weigh_order", entity_no: o.order_no,
      reason: input.reason, authorized_by: users.find((u) => u.id === input.authorized_by)?.display_name ?? "—", result: "ok",
    });
    return o;
  },

  /** 登记付款：已结算单转 paid */
  async recordPayment(input: { settle_no: string; amount_fen: number; method: PaymentMethod; operator_id: number; trade_no?: string | null }): Promise<Settlement | null> {
    await sleep(120);
    const s = settlements.find((x) => x.settle_no === input.settle_no);
    if (!s) return null;
    const now = localIso(new Date());
    s.paid_fen += input.amount_fen;
    s.payment_status = s.paid_fen >= s.payable_fen ? "paid" : "partial";
    s.main_method = input.method;
    s.signed_by_party = 1;
    payments.push({
      id: payments.length + 1,
      pay_no: `FK${station.code}${s.business_date.replace(/-/g, "")}${String(payments.length + 1).padStart(6, "0")}`,
      settlement_id: s.id,
      settle_no: s.settle_no,
      order_id: null,
      order_no: null,
      party_id: s.party_id,
      party_name: s.party_name,
      amount_fen: input.amount_fen,
      method: input.method,
      trade_no: input.trade_no ?? null,
      payee_name: s.payee_name,
      paid_at: now,
      operator_id: input.operator_id,
      voucher_no: null,
      reversed: 0,
      remark: null,
    });
    for (const row of s.orders) {
      const o = orderById(row.order_id);
      if (!o) continue;
      o.paid_amount_fen = s.paid_fen / s.order_count;
      o.payment_status = s.payment_status;
      o.payment_method = input.method;
      if (s.payment_status === "paid") o.paid_at = now;
    }
    return s;
  },

  /** 全局检索（Ctrl+K）：单号 / 姓名 / 证号后 4 位 / 车牌 */
  async search(kw: string) {
    await sleep(60);
    const k = kw.trim().toLowerCase();
    if (!k) return { orders: [] as OrderRow[], parties: [] as Party[], settlements: [] as Settlement[] };
    return {
      orders: orders.filter((o) => `${o.order_no} ${o.party_name} ${o.id_card_no.slice(-4)} ${o.vehicle_no ?? ""}`.toLowerCase().includes(k)).slice(0, 8).map(toRow),
      parties: parties.filter((p) => `${p.name} ${p.id_card_no} ${p.phone}`.toLowerCase().includes(k)).slice(0, 6),
      settlements: settlements.filter((s) => `${s.settle_no} ${s.party_name}`.toLowerCase().includes(k)).slice(0, 6),
    };
  },

  /** 打印留痕：真实实现走三通道，这里只记一条日志 */
  async logPrint(input: { doc_type: PrintLog["doc_type"]; doc_no: string; paper: PaperKind; printer_name: string; channel: PrintChannel; is_reprint: boolean; operator_id: number }): Promise<void> {
    await sleep(200);
    const now = localIso(new Date());
    printLogs.push({
      id: printLogs.length + 1,
      doc_type: input.doc_type,
      doc_no: input.doc_no,
      copies: 3,
      paper: input.paper,
      printer_name: input.printer_name,
      channel: input.channel,
      is_reprint: input.is_reprint ? 1 : 0,
      authorized_by: input.is_reprint ? users.find((u) => u.role === "station_master")!.id : null,
      result: "success",
      error_msg: null,
      printed_at: now,
      operator_id: input.operator_id,
    });
  },

  async settlementOf(no: string): Promise<{ settlement: Settlement; orders: OrderRow[]; payments: PaymentRecord[] } | null> {
    await sleep();
    const s = settlements.find((x) => x.settle_no === no);
    if (!s) return null;
    const rows = s.orders
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((row) => orderById(row.order_id))
      .filter((o): o is WeighOrder => o != null)
      .map(toRow);
    return { settlement: s, orders: rows, payments: payments.filter((p) => p.settlement_id === s.id) };
  },

  async settlementOfOrderNo(no: string): Promise<Settlement | null> {
    await sleep(0);
    const o = orderOf(no);
    return o ? settlementOfOrder(o.id) : null;
  },
};

function tzSuffix(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function localIso(d: Date): string {
  return `${dateKey(d)}T${d.toTimeString().slice(0, 8)}${tzSuffix(d)}`;
}

/** 档案写入的审计留痕，与工作台关键动作共用一张表 */
function auditMaster(
  action: string,
  entity: string,
  entityNo: string | null,
  actorId: number | null,
  reason: string | null = null,
): void {
  auditLogs.unshift({
    id: auditLogs.length + 1,
    at: localIso(new Date()),
    actor_id: actorId ?? 0,
    actor_name: users.find((u) => u.id === actorId)?.display_name ?? "—",
    action,
    entity,
    entity_no: entityNo,
    reason,
    authorized_by: null,
    result: "ok",
  });
}

export type Api = typeof api;
