//! 设备台账（03 §9.20 `device_config`；02 §M9「配置必须验过才存」；页面 `src/pages/DevicesPage.tsx`）
//!
//! 这一轮把设备中心整块从 mock 换成真库：台账读、启用/停用、Mock 切换、配置写入、
//! 联机探测回写、登记新设备全部读写 `device_config`。表 0001 就建好了，但此前
//! **没有任何命令碰过它**，所以台账一直读的是 `src/mock/masters.ts` 那份手写数组。
//! 沿用 `settlements.rs` 立的规矩：DTO 与 `src/mock/types.ts` 逐字一致（snake_case）、
//! 业务失败回中文短句、写入走 `orders::write_tx` 并在同一事务里落 `orders::audit` 审计、
//! 入参 `operator_id` 一律忽略（操作人以会话为准）、读不设岗（与 dashboard 同口径）。
//!
//! `test_device` 是这一轮唯一**不只看库**的命令：它按台账里的 `kind`/`driver`/`config_json`
//! 决定能不能真探，只放行本机确实有通道的三类——ESC/POS 小票机走
//! [`crate::printer::printer_status`]（只发 `DLE EOT`，不出纸）、精伦读卡器走
//! [`crate::idcard::idcard_status`]（读 SAM 号）、地磅走 [`crate::scale`] 的那条串口：
//! 读数流正在收数就算在线（判据是 `LiveStatus::connected`，不自己数时间），没在流时
//! `scale::probe_once` 一次性开端口读三帧再归还。其余一律 `ok:false` + 一句人话，
//! 耗时用 `Instant::now()` 实测：把"没探"演成"探过了"是 mock 时代的病，不带来真库。
//!
//! `secret_json`：**本模块仍不写它**。海康 / 大华登记表现在会带一个登录口令（见
//! `src/pages/DevicesPage.tsx` 的 `networkCameraFields`），它随其余参数一起进
//! `config_json`——`camera.rs::target_from_config` 读口令的主路径就是这里。库里存的是
//! 抓图要用的真值，但 `audit_log` 全岗位可筛看，所以两条写配置的留痕都用 `masked_config_json`
//! 把口令类键打成 `***` 再入审计。等 secret_json 的加密基建落地，再补"写时拆进去、读时合回
//! config"这一层；届时只有 camera.rs 的读取处跟着改。
//!
//! 与 mock 的**有意差异**（都是真库才立得住、或页面本来就需要的口径）：
//!  - `test_device` 不再拿 `last_status` 反推一个"看起来测过"的结果，探不到就说探不到。
//!  - 台账里没有的编码，`set_device_mock` / `set_device_enabled` 也回 `设备不存在`
//!    （mock 是 `if (d)` 静默什么都不做，页面却会照样弹"已启用"）。
//!  - 启用/停用、Mock 切换、探测回写**都落审计**（mock 的这几个函数一条都不记）；
//!    开关沿用 mock 的动作名 `device.update`，回写新开一个 `device.probe`。
//!  - 编码重复的拒绝留痕会**真的进库**：`write_tx` 见闭包回 Err 就回滚，直接把审计
//!    写在拒绝分支里会被一起卷掉，所以拒绝文案随事务提交、命令层再还原成 Err（见 [`CreateOutcome`]）。
//!  - `last_ok_at` / `last_err_at` 存的是 `yyyy-MM-dd HH:mm:ss`（与前端 `print-guard.stamp()`
//!    同格式，状态卡上 `最后成功 …` 直接渲染这串字），`created_at` / `updated_at` 与审计
//!    仍是全库统一的 `now_iso()`。
//!  - 名称为空、`kind` 不在 CHECK 值域内会被拦（mock 全放行，页面靠前端校验兜着）。
//!  - 拒绝类审计的 `result` 仍是 `'ok'`：复用 [`crate::orders::audit`]（它不开放这一列），
//!    失败语义按 mock 的 `auditMaster` 同一口径写在 `reason` 里（"编码重复，已拒绝"）——
//!    mock 那边也恒写 `result:"ok"`，两边对得上，审计页的筛选条件不用改。

use std::collections::{BTreeMap, HashMap};
use std::time::Instant;

use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::auth::AuthProfile;
use crate::codes::next_code;
use crate::orders::{audit, read_only, write_tx};

/// 写台账要求的岗位。`src/store/session.ts` 的 `device.manage` 只发给站长，
/// 这里再判一次——前端被改也越不过去（05 §6.1）。
const DEVICE_ROLES: &[&str] = &["station_master"];

/// `device_config.kind` 的 CHECK 值域（03 §9.20），与 `src/lib/constants.ts` 的 `DeviceKind` 同源
const KINDS: &[&str] = &["scale", "idcard", "camera", "printer", "led", "cashbox", "signpad"];
/// `last_status` 的 CHECK 值域，与 `DeviceStatus` 同源
const STATUSES: &[&str] = &["unknown", "online", "offline", "error"];

/// 补号用的编码前缀，必须和 `src/pages/DevicesPage.tsx` 里 `DEVICE_SPEC[kind].prefix`
/// 逐字一致：那边给新增表单填建议号，这边接住"把建议号清空再提交"的补号，
/// 两套前缀拼出来的编码要长得一样。
fn device_code_prefix(kind: &str) -> &str {
    match kind {
        "camera" => "cam",
        "printer" => "prn",
        "cashbox" => "cash",
        "signpad" => "sign",
        other => other,
    }
}

fn now_iso() -> String {
    crate::db::migrate::now_iso()
}

/// 状态列给人看的时刻：mock 与前端 `stamp()` 用的都是这个格式，卡片直接原样渲染
fn now_display() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

// --------------------------------------------------------------------- 输出结构

/// §9.20 台账行 ↔ TS `DeviceConfig`（mock/types.ts）。
/// `config` 是 `config_json` 解析后的展示用映射；库里 NULL 或 JSON 不是对象时按 `{}` 处理，
/// 一行坏数据不该让整张台账打不开。
#[derive(Debug, Clone, Serialize)]
pub struct DeviceConfig {
    pub id: i64,
    pub code: String,
    pub name: String,
    pub kind: String,
    pub driver: String,
    pub config: HashMap<String, serde_json::Value>,
    pub is_enabled: i64,
    pub is_mock: i64,
    pub is_default: i64,
    pub last_status: String,
    pub last_ok_at: Option<String>,
    pub last_error: Option<String>,
    pub err_count: i64,
}

const DEVICE_SELECT: &str = "SELECT id, code, name, kind, driver, config_json, is_enabled, is_mock, is_default,
        last_status, last_ok_at, last_error, err_count
     FROM device_config";

/// `config_json` → 展示用映射。NULL、空串、非法 JSON、JSON 不是对象都按 `{}` 处理：
/// 一行坏数据不该让整张台账打不开。
fn parse_config(raw: Option<&str>) -> HashMap<String, serde_json::Value> {
    serde_json::from_str::<serde_json::Value>(raw.unwrap_or("{}"))
        .ok()
        .and_then(|v| v.as_object().cloned())
        .map(|obj| obj.into_iter().collect())
        .unwrap_or_default()
}

fn map_device_row(r: &Row) -> rusqlite::Result<DeviceConfig> {
    Ok(DeviceConfig {
        id: r.get(0)?,
        code: r.get(1)?,
        name: r.get(2)?,
        kind: r.get(3)?,
        driver: r.get(4)?,
        config: parse_config(r.get::<_, Option<String>>(5)?.as_deref()),
        is_enabled: r.get(6)?,
        is_mock: r.get(7)?,
        is_default: r.get(8)?,
        last_status: r.get(9)?,
        last_ok_at: r.get(10)?,
        last_error: r.get(11)?,
        err_count: r.get(12)?,
    })
}

/// 键排序后序列化：审计里的 `旧 → 新` 要能逐字比对，HashMap 的随机顺序会把同一份配置
/// 写成两种文本，看上去像"改了又改回去"。
fn config_json(config: &HashMap<String, serde_json::Value>) -> String {
    let sorted: BTreeMap<&str, &serde_json::Value> = config.iter().map(|(k, v)| (k.as_str(), v)).collect();
    serde_json::to_string(&sorted).unwrap_or_else(|_| "{}".to_string())
}

/// 口令类字段名（与 `camera.rs::target_from_config` 读的键名同源）。
const SECRET_KEYS: &[&str] = &["password", "pass", "pwd", "secret"];

/// 审计专用的配置快照：口令键的值一律换成 `***`，键名照旧保留。
/// `device_config.config_json` 里存的是抓图要用的真值，但 `audit.detail` 全岗位可筛看，
/// 把摄像机口令明文抄进留痕等于对全站广播——掩码只发生在这一份文本上，不改库里的真配置。
fn masked_config_json(config: &HashMap<String, serde_json::Value>) -> String {
    let sorted: BTreeMap<&str, serde_json::Value> = config
        .iter()
        .map(|(k, v)| {
            let masked = SECRET_KEYS.iter().any(|s| k.eq_ignore_ascii_case(s));
            (k.as_str(), if masked { serde_json::Value::String("***".into()) } else { v.clone() })
        })
        .collect();
    serde_json::to_string(&sorted).unwrap_or_else(|_| "{}".to_string())
}

/// 台账全表（与 mock.listDevices 同返回）。真库每次查库都是新对象，
/// 不存在 mock 那种"同一批引用交给 react-query 比对不出变化"的问题。
pub fn list_devices(conn: &Connection) -> Result<Vec<DeviceConfig>, String> {
    conn.prepare_cached(&format!("{DEVICE_SELECT} ORDER BY id"))
        .and_then(|mut st| {
            st.query_map([], map_device_row)
                .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        })
        .map_err(|e| format!("读取设备台账失败：{e}"))
}

fn load_device(conn: &Connection, id: i64) -> Result<Option<DeviceConfig>, String> {
    conn.query_row(&format!("{DEVICE_SELECT} WHERE id = ?1"), params![id], map_device_row)
        .optional()
        .map_err(|e| format!("读取设备失败：{e}"))
}

/// 按编码取一行，取不到就是"设备不存在"（mock 的 updateDeviceConfig / reportDeviceProbe 同句）。
fn device_by_code(conn: &Connection, code: &str) -> Result<DeviceConfig, String> {
    conn.query_row(&format!("{DEVICE_SELECT} WHERE code = ?1"), params![code], map_device_row)
        .optional()
        .map_err(|e| format!("读取设备失败：{e}"))?
        .ok_or_else(|| "设备不存在".to_string())
}

// ------------------------------------------------------------------- 启用 / Mock

/// 启用 / 停用。停用的设备仍留在台账里（页面靠徽标区分），只是不参与作业，
/// 所以状态直接落 `offline`——"关掉了"比"没检测"更贴近现场事实。
pub fn set_device_enabled(conn: &Connection, actor: &AuthProfile, code: &str, enabled: bool) -> Result<Vec<DeviceConfig>, String> {
    let d = device_by_code(conn, code)?;
    conn.execute(
        "UPDATE device_config SET is_enabled = ?2, last_status = ?3, updated_at = ?4 WHERE id = ?1",
        params![d.id, enabled as i64, if enabled { "unknown" } else { "offline" }, now_iso()],
    )
    .map_err(|e| format!("设备启用状态保存失败：{e}"))?;
    audit(
        conn,
        actor,
        "device.update",
        "device_config",
        &d.code,
        Some(&format!("{}：{}（{}）", if enabled { "启用" } else { "停用" }, d.name, if enabled { "状态待联机测试" } else { "停用后不参与作业，台账仍保留" })),
        None,
    );
    list_devices(conn)
}

/// Mock / 真实设备切换。**不动 `last_status`**：切的是"数据从哪儿来"，
/// 不是"这台机现在通不通"，把状态灯一起改色等于拿一个开关冒充一次联机。
pub fn set_device_mock(conn: &Connection, actor: &AuthProfile, code: &str, mock: bool) -> Result<Vec<DeviceConfig>, String> {
    let d = device_by_code(conn, code)?;
    conn.execute("UPDATE device_config SET is_mock = ?2, updated_at = ?3 WHERE id = ?1", params![d.id, mock as i64, now_iso()])
        .map_err(|e| format!("设备 Mock 开关保存失败：{e}"))?;
    let label = |on: bool| if on { "Mock 模拟" } else { "真实设备" };
    audit(
        conn,
        actor,
        "device.update",
        "device_config",
        &d.code,
        Some(&format!("数据来源 {} → {}（{}）", label(d.is_mock == 1), label(mock), d.name)),
        None,
    );
    list_devices(conn)
}

// -------------------------------------------------------------------- 配置写入

/// 一次联机验证的结果。前端 `src/lib/print-guard.ts` 的 `PrintVerify` 只有
/// `{mode:"device", ok, at, message}` 带 `ok`，`mode:"none"` 那一支没有，故 `#[serde(default)]`。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintVerify {
    pub mode: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub at: String,
    #[serde(default)]
    pub message: String,
}

impl PrintVerify {
    /// 桌面端真机验过（`mode:"device"` 且通过）才算验证态；`mode:"none"` 是浏览器预览。
    fn verified(&self) -> bool {
        self.mode == "device"
    }
}

/// 与 mock.updateDeviceConfig 入参逐字段同名；`operator_id` 只为兼容前端签名而保留。
#[derive(Debug, Deserialize)]
pub struct UpdateDeviceConfigInput {
    pub code: String,
    #[serde(default)]
    pub config: HashMap<String, serde_json::Value>,
    #[allow(dead_code)]
    #[serde(default)]
    pub operator_id: Option<i64>,
    pub verify: PrintVerify,
}

/// 改配置（02 §M9）：**能测就必须测过**，`mode:"device"` 而未通过时一句短句拒绝，
/// 绝不留下"保存了但打不出"的配置。浏览器预览测不了，允许保存但状态停在 `unknown`、
/// 把原因写进 `last_error`，卡片上是黄标，等桌面端验过才转绿。
pub fn update_device_config(conn: &Connection, actor: &AuthProfile, input: UpdateDeviceConfigInput) -> Result<DeviceConfig, String> {
    if !matches!(input.verify.mode.as_str(), "device" | "none") {
        return Err("联机验证结果不完整，配置未保存".into());
    }
    let d = device_by_code(conn, &input.code)?;
    if input.verify.mode == "device" && !input.verify.ok {
        return Err(format!("联机测试未通过，配置未保存：{}", input.verify.message));
    }

    let mut next = d.config.clone();
    for (k, v) in &input.config {
        next.insert(k.clone(), v.clone());
    }
    let new = config_json(&next);

    conn.execute(
        "UPDATE device_config SET config_json = ?2, last_status = ?3, last_ok_at = ?4, last_error = ?5, err_count = ?6, updated_at = ?7 WHERE id = ?1",
        params![
            d.id, new,
            if input.verify.verified() { "online" } else { "unknown" },
            if input.verify.verified() { Some(now_display()) } else { d.last_ok_at.clone() },
            if input.verify.verified() { None } else { Some(input.verify.message.clone()) },
            if input.verify.verified() { 0 } else { d.err_count },
            now_iso(),
        ],
    )
    .map_err(|e| format!("设备配置保存失败：{e}"))?;

    audit(
        conn,
        actor,
        "device.update",
        "device_config",
        &d.code,
        Some(&format!(
            "{} → {}{}",
            masked_config_json(&d.config),
            masked_config_json(&next),
            if input.verify.verified() { "" } else { "（未经真机验证）" }
        )),
        None,
    );
    load_device(conn, d.id)?.ok_or_else(|| "设备配置保存失败：改动后读不到该行".to_string())
}

// -------------------------------------------------------------------- 探测回写

/// 一次真实联机探测的结果（mock.reportDeviceProbe 的第二参数）。
/// 页面还会带一个 `name`（状态来源的机器名），serde 忽略即可。
#[derive(Debug, Deserialize)]
pub struct ProbeResult {
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub at: String,
}

/// 回写状态四字段，**不碰 config**。
///
/// 为什么必须有这条：卡片状态灯读的是台账 `last_status`，不回写的话真机明明在线应答
/// `DLE EOT`，卡片也会一直挂着"未检测"。`unknown` 不计错误次数——它是"没问到可信状态"，
/// 不是设备故障，计入会把一次浏览器预览刷成十次故障（与 mock 同一口径）。
pub fn report_device_probe(conn: &Connection, actor: &AuthProfile, code: &str, res: ProbeResult) -> Result<DeviceConfig, String> {
    if !STATUSES.contains(&res.status.as_str()) {
        return Err(format!("设备状态「{}」不在值域内", res.status));
    }
    let d = device_by_code(conn, code)?;
    let at = if res.at.trim().is_empty() { now_display() } else { res.at.trim().to_string() };
    let error = res.error.clone().filter(|s| !s.trim().is_empty());

    match res.status.as_str() {
        // 在线时不残留上一次的告警文案，否则绿标旁边挂着红字，等于没有状态
        "online" => conn.execute(
            "UPDATE device_config SET last_status = 'online', last_ok_at = ?2, last_error = NULL, err_count = 0, updated_at = ?3 WHERE id = ?1",
            params![d.id, at, now_iso()],
        ),
        "offline" | "error" => conn.execute(
            "UPDATE device_config SET last_status = ?2, last_error = ?3, last_err_at = ?4, err_count = err_count + 1, updated_at = ?5 WHERE id = ?1",
            params![d.id, res.status, error, at, now_iso()],
        ),
        _ => conn.execute(
            "UPDATE device_config SET last_status = 'unknown', last_error = ?2, updated_at = ?3 WHERE id = ?1",
            params![d.id, error, now_iso()],
        ),
    }
    .map_err(|e| format!("设备状态回写失败：{e}"))?;

    audit(
        conn,
        actor,
        "device.probe",
        "device_config",
        &d.code,
        Some(&format!("联机回写 {}：{at}{}", res.status, error.map(|e| format!("（{e}）")).unwrap_or_default())),
        None,
    );
    load_device(conn, d.id)?.ok_or_else(|| "设备状态回写失败：改动后读不到该行".to_string())
}

// ---------------------------------------------------------------------- 登记设备

#[derive(Debug, Deserialize)]
pub struct CreateDeviceInput {
    pub code: String,
    pub name: String,
    pub kind: String,
    pub driver: String,
    #[serde(default)]
    pub config: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub is_mock: bool,
    #[allow(dead_code)]
    #[serde(default)]
    pub operator_id: Option<i64>,
}

/// [`create_device`] 的回执。
///
/// 拒绝也必须留痕，但 `write_tx` 见闭包回 Err 就回滚——审计直接写在拒绝分支里会被一起
/// 卷掉。所以拒绝文案随事务提交，由命令层 [`CreateOutcome::into_result`] 还原成前端的 Error。
#[derive(Debug, Clone)]
pub struct CreateOutcome {
    pub device: Option<DeviceConfig>,
    pub rejected: Option<String>,
}

impl CreateOutcome {
    fn created(device: DeviceConfig) -> Self {
        Self { device: Some(device), rejected: None }
    }
    fn rejected(msg: impl Into<String>) -> Self {
        Self { device: None, rejected: Some(msg.into()) }
    }
    /// 命令层用：随事务提交的拒绝 → 前端 Error（页面写的就是 `e.message`）
    pub fn into_result(self) -> Result<DeviceConfig, String> {
        match self.rejected {
            Some(e) => Err(e),
            None => self.device.ok_or_else(|| "登记设备失败：新增行在读取途中消失".to_string()),
        }
    }
}

/// 登记现场硬件（新增一行）。编码是台账里的人工主键（导出配置、换机重建都按它核对），
/// 站内唯一，但**不要求操作员自己想**：表单按类型给了建议号，清空提交就在这里补号。
/// `is_default` 先把同类旧的默认机降级再插入——`uk_dev_default` 是
/// 部分唯一索引，同事务不降级就会直接撞 UNIQUE。新设备一律"未检测"：登记 ≠ 联机验证。
pub fn create_device(conn: &Connection, actor: &AuthProfile, input: CreateDeviceInput) -> Result<CreateOutcome, String> {
    let mut code = input.code.trim().to_string();
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("设备名称必填：台账靠名字认机器".into());
    }
    if !KINDS.contains(&input.kind.as_str()) {
        return Err(format!("设备类型「{}」不在值域内", input.kind));
    }
    if input.driver.trim().is_empty() {
        return Err("驱动协议必填".into());
    }
    if code.is_empty() {
        code = next_code(
            conn,
            "SELECT COUNT(*) FROM device_config WHERE code = ?1",
            device_code_prefix(&input.kind),
            1,
            "设备",
        )?;
    }

    let taken: i64 = conn
        .query_row("SELECT COUNT(*) FROM device_config WHERE code = ?1", params![code], |r| r.get(0))
        .map_err(|e| format!("检查设备编码失败：{e}"))?;
    if taken > 0 {
        audit(conn, actor, "device.create", "device_config", &code, Some("编码重复，已拒绝"), None);
        return Ok(CreateOutcome::rejected(format!("编码 {code} 已存在：编码是台账主键，不能重复")));
    }

    let config = config_json(&input.config);
    let now = now_iso();
    if input.is_default {
        conn.execute("UPDATE device_config SET is_default = 0, updated_at = ?2 WHERE kind = ?1 AND is_default = 1", params![input.kind, now])
            .map_err(|e| format!("同类默认设备降级失败：{e}"))?;
    }
    conn.execute(
        "INSERT INTO device_config (code, name, kind, driver, config_json, secret_json, is_enabled, is_mock, is_default,
                last_status, last_ok_at, last_err_at, last_error, err_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, 1, ?6, ?7, 'unknown', NULL, NULL, NULL, 0, ?8, ?8)",
        params![code, name, input.kind, input.driver, config, input.is_mock as i64, input.is_default as i64, now],
    )
    .map_err(|e| {
        // 并发双开时预检会漏，让 UNIQUE 兜底成同一句话
        if e.to_string().contains("UNIQUE") {
            format!("编码 {code} 已存在：编码是台账主键，不能重复")
        } else {
            format!("设备登记失败：{e}")
        }
    })?;

    let row = load_device(conn, conn.last_insert_rowid())?.ok_or_else(|| "设备登记失败：新增行读不回来".to_string())?;
    audit(
        conn,
        actor,
        "device.create",
        "device_config",
        &row.code,
        Some(&format!("新增 {}（{} · 驱动 {}），状态未检测待联机测试", row.name, row.kind, row.driver)),
        None,
    );
    Ok(CreateOutcome::created(row))
}

// ---------------------------------------------------------------------- 修改设备

/// [`update_device`] 入参：`code` 只用来定位行（主键本身不可改），`kind` 用于校验与库一致。
#[derive(Debug, Deserialize)]
pub struct UpdateDeviceInput {
    pub code: String,
    pub name: String,
    pub kind: String,
    pub driver: String,
    #[serde(default)]
    pub config: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub is_default: bool,
    #[allow(dead_code)]
    #[serde(default)]
    pub operator_id: Option<i64>,
}

/// 编辑已登记设备（改名称 / 驱动 / 关键参数 / 默认标记）。
///
/// **编码与类型不可改**：编码是台账主键、被磅单打印留痕与外键引用，改它会把历史接不上；
/// 类型锁死是因为换 `kind` 等于换一整套 config 语义与探测通道——错录类型应「停用 + 重新登记」。
/// `config` 走**合并**（与 [`update_device_config`] 同口径）：表单没露出的键保留不动，绝不
/// 因为"这次没提交"就把现场配好的参数悄悄抹掉。改了驱动或配置就把上次联机结论作废、回到
/// 未检测——不留着"参数都变了还挂上次绿标"的假在线（02 §M9 的精神）。
pub fn update_device(conn: &Connection, actor: &AuthProfile, input: UpdateDeviceInput) -> Result<DeviceConfig, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("设备名称必填：台账靠名字认机器".into());
    }
    let driver = input.driver.trim().to_string();
    if driver.is_empty() {
        return Err("驱动协议必填".into());
    }
    let d = device_by_code(conn, &input.code)?;
    if input.kind != d.kind {
        return Err(format!("设备类型不可修改（当前 {}）；换类型请停用本台后重新登记", d.kind));
    }

    let old_cfg = config_json(&d.config);
    let mut next = d.config.clone();
    for (k, v) in &input.config {
        next.insert(k.clone(), v.clone());
    }
    let new_cfg = config_json(&next);
    let driver_changed = driver != d.driver;
    let cfg_changed = new_cfg != old_cfg;
    let invalidate = driver_changed || cfg_changed;

    let now = now_iso();
    if input.is_default && d.is_default != 1 {
        conn.execute("UPDATE device_config SET is_default = 0, updated_at = ?2 WHERE kind = ?1 AND is_default = 1", params![d.kind, now])
            .map_err(|e| format!("同类默认设备降级失败：{e}"))?;
    }
    conn.execute(
        "UPDATE device_config SET name = ?2, driver = ?3, config_json = ?4, is_default = ?5,
                last_status = ?6, last_ok_at = ?7, last_error = ?8, updated_at = ?9
         WHERE id = ?1",
        params![
            d.id,
            name,
            driver,
            new_cfg,
            input.is_default as i64,
            if invalidate { "unknown" } else { d.last_status.as_str() },
            if invalidate { None::<String> } else { d.last_ok_at.clone() },
            if invalidate { None::<String> } else { d.last_error.clone() },
            now,
        ],
    )
    .map_err(|e| format!("设备修改保存失败：{e}"))?;

    let mut diff: Vec<String> = Vec::new();
    if name != d.name {
        diff.push(format!("名称 {} → {}", d.name, name));
    }
    if driver_changed {
        diff.push(format!("驱动 {} → {}", d.driver, driver));
    }
    if cfg_changed {
        diff.push(format!("配置 {} → {}", masked_config_json(&d.config), masked_config_json(&next)));
    }
    if input.is_default && d.is_default != 1 {
        diff.push("设为默认".into());
    }
    if !input.is_default && d.is_default == 1 {
        diff.push("取消默认".into());
    }
    audit(
        conn,
        actor,
        "device.update",
        "device_config",
        &d.code,
        Some(&format!(
            "{}{}",
            if diff.is_empty() { "无改动".to_string() } else { diff.join("；") },
            if invalidate { "（驱动/配置已变，联机结论作废，回到未检测待重测）" } else { "" }
        )),
        None,
    );
    load_device(conn, d.id)?.ok_or_else(|| "设备修改保存失败：改动后读不到该行".to_string())
}

/// 删除设备（错录清理）。**有业务历史的一律拒删**：只要被任一称重记录 `device_id`
/// 或抓拍附件 `source_device_id` 引用，删掉会把那些磅单/照片的"哪台设备采的"删成悬空、
/// 审计接不上（02 §M9 要可追溯）——这类只能「停用」（留在台账、不再参与作业）。
/// 只有两处引用都为 0 才真删；拒绝不写任何行（`write_tx` 见 Err 回滚也无所谓）。
pub fn delete_device(conn: &Connection, actor: &AuthProfile, code: &str) -> Result<Vec<DeviceConfig>, String> {
    let d = device_by_code(conn, code)?;
    let refs: [(&str, &str); 2] = [
        ("weigh_record", "SELECT COUNT(*) FROM weigh_record WHERE device_id = ?1"),
        ("attachment", "SELECT COUNT(*) FROM attachment WHERE source_device_id = ?1"),
    ];
    let mut total: i64 = 0;
    let mut hits: Vec<String> = Vec::new();
    for (table, sql) in refs {
        let n: i64 = conn
            .query_row(sql, params![d.id], |r| r.get(0))
            .map_err(|e| format!("检查设备引用失败：{e}"))?;
        total += n;
        if n > 0 {
            hits.push(format!("{table} {n} 条"));
        }
    }
    if total > 0 {
        return Err(format!(
            "设备「{}」已被{}引用，删除会让这些磅单/照片的设备出处悬空、审计接不上——不能删，请改用「停用」（留在台账、不再参与作业）",
            d.name,
            hits.join("、")
        ));
    }

    conn.execute("DELETE FROM device_config WHERE id = ?1", params![d.id])
        .map_err(|e| format!("删除设备失败：{e}"))?;
    audit(
        conn,
        actor,
        "device.delete",
        "device_config",
        &d.code,
        Some(&format!("删除 {}（{} · 驱动 {}），无任何业务历史", d.name, d.kind, d.driver)),
        None,
    );
    list_devices(conn)
}

// -------------------------------------------------------------------- 联机自检

/// 台账一行的"能怎么探"。命令层照它派发到本机真通道，测不到的绝不假装成功。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbePlan {
    /// ESC/POS 小票机：只发状态查询不出纸；vid/pid 齐了才指定，否则由驱动取枚举第一台
    Printer { vid: Option<u16>, pid: Option<u16> },
    /// 精伦 Routon 读卡器：读 SAM 号即算联机
    IdCard,
    /// 地磅：本机通道就是那条串口读数流（正在收数即在线；没在流时一次性开端口试读几帧）
    Scale,
    /// 内网摄像机：按台账端点真抓一次图（与过磅抓拍、工作台预览同一条 `grab` 通道，
    /// 测过就等于出得来图）。`max_bytes` 是这次读台账时算出的单图上限。
    Camera {
        target: crate::camera::SnapshotTarget,
        max_bytes: usize,
    },
    /// 本机没有这条驱动对应的探测通道
    NotWired { message: String },
    /// 台账里没有这个编码（与 mock 一致：回 ok=false，不抛错）
    Missing,
}

/// config 里的 VID/PID 常手写成 `"0x0483"`，与 `src/lib/print-guard.ts` 的 `parseHex` 同口径。
fn parse_hex_u16(v: Option<&serde_json::Value>) -> Option<u16> {
    match v? {
        serde_json::Value::Number(n) => n.as_u64().and_then(|n| u16::try_from(n).ok()),
        serde_json::Value::String(s) => {
            let s = s.trim().to_ascii_lowercase();
            let body = s.strip_prefix("0x").unwrap_or(s.as_str());
            u16::from_str_radix(body, 16).ok()
        }
        _ => None,
    }
}

/// 决定"这台机能不能真探"。判据是台账里的 `kind` + `driver`，不是前端传什么就探什么。
pub fn probe_plan(conn: &Connection, code: &str) -> Result<ProbePlan, String> {
    let Some(d) = conn
        .query_row(&format!("{DEVICE_SELECT} WHERE code = ?1"), params![code], map_device_row)
        .optional()
        .map_err(|e| format!("读取设备台账失败：{e}"))?
    else {
        return Ok(ProbePlan::Missing);
    };
    // 与 PrinterPanel 的 `escpos` 判据同源：只有走 usbprint.sys 直写的两类能发 DLE EOT，
    // preview / raw_escp 是窗口预览与针式队列，探它们等于拿别的机器的应答来糊弄这台。
    if d.kind == "printer" && matches!(d.driver.as_str(), "escpos_usbprint" | "raw_escpos") {
        return Ok(ProbePlan::Printer {
            vid: parse_hex_u16(d.config.get("vid")),
            pid: parse_hex_u16(d.config.get("pid")),
        });
    }
    // 精伦走进程内 Sdtapi.dll 直调，读得到 SAM 号才算通（见 crate::idcard 头注）
    if d.kind == "idcard" && d.driver.starts_with("routon") {
        return Ok(ProbePlan::IdCard);
    }
    // 地磅不看驱动名，看台账开关：磅的本机通道是**那条串口**，任何驱动名探的都是同一条路。
    // 但标成 Mock / 已停用的两台绝不能去开口——`resolve_template` 就是这么挡读线程的，
    // 自检绕过去开一次端口，等于让"演示磅"真的把 COM 口占了。
    if d.kind == "scale" {
        if d.is_mock == 1 || d.driver == "mock" {
            return Ok(ProbePlan::NotWired {
                message: format!("这台磅「{}」在台账里是 Mock，走的是演示读数流，不做真机探测", d.name),
            });
        }
        if d.is_enabled == 0 {
            return Ok(ProbePlan::NotWired {
                message: format!("这台磅「{}」在台账里已停用，先在设备中心启用再做联机测试", d.name),
            });
        }
        return Ok(ProbePlan::Scale);
    }
    // 内网摄像机：探的就是抓拍与工作台预览那条 HTTP 通道，测过＝磅单出得来图、画面看得见。
    // Mock / 停用 / 本机 USB 三条**绝不开口**：本机机的探测通道只存在于 WebView2 里
    // （`src/lib/local-camera.ts` 的 probeLocalCamera 真开一次流），服务端去抓它只会
    // 拿一句"未配置 host"，把一台好机器报成故障。
    if d.kind == "camera" {
        if d.is_mock == 1 || d.driver == "mock" {
            return Ok(ProbePlan::NotWired {
                message: format!("这台摄像机「{}」在台账里是 Mock，不出真画面，不做真机探测", d.name),
            });
        }
        if d.is_enabled == 0 {
            return Ok(ProbePlan::NotWired {
                message: format!("这台摄像机「{}」在台账里已停用，先在设备中心启用再做联机测试", d.name),
            });
        }
        let cfg = config_json(&d.config);
        if crate::camera::is_local_camera(&cfg) {
            return Ok(ProbePlan::NotWired {
                message: "本机 USB 摄像头由工作台直接开流显示，服务端不探测：设备中心的「联机测试」会真开一次流取一帧".to_string(),
            });
        }
        // 口令在 `secret_json` 那一列（展示用的 DTO 特意不带它），探测要拿真口令所以单独读
        let secret = conn
            .query_row("SELECT secret_json FROM device_config WHERE id = ?1", params![d.id], |r| {
                r.get::<_, Option<String>>(0)
            })
            .unwrap_or(None);
        return match crate::camera::target_from_config(d.id, &d.code, &cfg, secret.as_deref()) {
            Ok(target) => Ok(ProbePlan::Camera {
                target,
                max_bytes: crate::camera::max_snapshot_bytes(conn),
            }),
            // 配置非法不是"探测失败"而是"没配好"：回话要指向设备中心那几个输入框，而不是记一次网络故障
            Err(reason) => Ok(ProbePlan::NotWired { message: reason }),
        };
    }
    Ok(ProbePlan::NotWired { message: format!("该驱动（{}）暂未接入本机探测通道，请在设备面板按指引验证", d.driver) })
}

/// 一次自检的回执：TS 侧就是 `{ ok, message, elapsedMs }`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTestOutcome {
    pub ok: bool,
    pub message: String,
    pub elapsed_ms: u64,
}

// ------------------------------------------------------------------ 地磅自检口径

/// 没在流时一次性开端口试读的预算：9600 波特下耀华连续帧约 4–5 帧/秒，2 秒足够读到数，
/// 又不至于让设备中心的"联机测试"按钮卡到像死机。
const SCALE_PROBE_BUDGET: std::time::Duration = std::time::Duration::from_millis(2000);
/// 试读凑够几帧就收工（3 帧：够看出"在持续发数"，不是一帧噪声凑巧过校验）
const SCALE_PROBE_FRAMES: u64 = 3;

/// 0.1 kg → 界面口径的 kg 文本
fn kg_text(weight_01kg: i64) -> String {
    format!("{:.1}", weight_01kg as f64 / 10.0)
}

/// **正在收数**时的结论。判据完全跟着 `scale::LiveStatus::connected`（串口开着且近
/// `STARVE_MS`=5 秒内解析出过帧），设备中心不再自己数时间，避免两处真相。
pub fn scale_verdict_from_stream(s: &crate::scale::LiveStatus) -> (bool, String) {
    if s.connected {
        let read = s.last.as_ref().map(|l| format!("，最新读数 {}", kg_text(l.weight_01kg))).unwrap_or_default();
        let at = s.last_frame_at.clone().unwrap_or_else(|| "—".into());
        (true, format!("读数流在线：串口 {} 已打开，累计 {} 帧{read}（最后收帧 {at}）", s.port, s.frame_count))
    } else {
        (
            false,
            s.error.clone().unwrap_or_else(|| {
                format!("串口 {} 已打开但 5 秒内没有解析出读数帧：仪表未上电、波特率不符或帧模板对不上", s.port)
            }),
        )
    }
}

/// **没在流**时一次性试读的结论。"打得开端口"与"读得到可解析帧"分开说：前者失败是 COM 号 /
/// 占用问题，后者失败是仪表与波特率问题，现场要拧的螺丝不一样。
pub fn scale_verdict_from_probe(port: &str, out: &crate::scale::ProbeOutcome) -> (bool, String) {
    if out.good_frames == 0 {
        return (
            false,
            out.error.clone().unwrap_or_else(|| {
                format!(
                    "串口 {port} 开了 2 秒，一帧可解析读数都没读到：仪表未上电、波特率不符，或 COM 口被别的程序占着"
                )
            }),
        );
    }
    let read = out.weight_01kg.map(|w| format!("，读到 {} kg", kg_text(w))).unwrap_or_default();
    let first = out.first_good_ms.map(|ms| format!("{ms} ms")).unwrap_or_else(|| "—".into());
    let bad = if out.bad_frames > 0 { format!("；另有 {} 帧校验不过", out.bad_frames) } else { String::new() };
    (true, format!("串口 {port} 已打开并解析出 {} 帧{read}（首帧 {first}{bad}）", out.good_frames))
}

// ----------------------------------------------------------------- Tauri 命令

#[tauri::command]
pub async fn device_list(app: AppHandle) -> Result<Vec<DeviceConfig>, String> {
    read_only(&app, list_devices, "设备台账读取").await
}

/// 联机自检：读台账 → 派发到本机真通道 → 实测耗时。全程不写库（回写另有 `device_probe_report`）。
#[tauri::command]
pub async fn device_test(app: AppHandle, code: String) -> Result<DeviceTestOutcome, String> {
    let started = Instant::now();
    // `code` 下面要移动进 probe_plan 的闭包，地磅分支还要再用一次，先克隆一份
    let scale_code = code.clone();
    let plan = read_only(&app, move |conn| probe_plan(conn, &code), "设备自检读取").await?;
    let (ok, message) = match plan {
        ProbePlan::Missing => (false, "设备不存在".to_string()),
        ProbePlan::NotWired { message } => (false, message),
        ProbePlan::Printer { vid, pid } => match crate::printer::printer_status(vid, pid).await {
            Err(e) => (false, e),
            Ok(p) => {
                let s = p.status;
                let note = if s.note.trim().is_empty() { s.source.clone() } else { s.note.clone() };
                if !s.responding {
                    (false, format!("设备未应答状态查询（{note}）"))
                } else if !s.online {
                    (false, "设备未联机（检查脱机键、上盖与纸卷）".to_string())
                } else {
                    let byte = match s.raw_byte {
                        Some(b) => format!("状态字节 0x{b:02X}"),
                        None => s.source.clone(),
                    };
                    let paper = if s.paper_adequate { String::new() } else { "；纸将尽或缺纸".to_string() };
                    (true, format!("握手成功，设备已应答（{byte}）{paper}"))
                }
            }
        },
        ProbePlan::IdCard => match crate::idcard::idcard_status(app.clone()).await {
            Err(e) => (false, e),
            Ok(r) => {
                if r.connected {
                    (true, format!("读卡器已联机（SAM {}）", r.sam_id.unwrap_or_else(|| "未读到序列号".into())))
                } else {
                    (false, r.error.unwrap_or_else(|| "读卡器无响应，检查 USB 线与供电".into()))
                }
            }
        },
        ProbePlan::Scale => {
            // 正在收数就是这台磅在线的凭据，**绝不再去开一次端口**：工作台开着流的时候
            // 第二次 open 同一个 COM 口必然失败，那会把一条好链路报成故障。
            match crate::scale::live_snapshot(&app).filter(|s| s.running && s.code == scale_code) {
                Some(stream) => scale_verdict_from_stream(&stream),
                None => {
                    // 没在流（多半是站长开设备中心验货、工作台还没起来）：读台账拿模板，
                    // 一次性开端口读几帧再归还。台账那句中文（Mock / 停用 / 没写 COM 口）
                    // 由 load_config 直接抛回，现场照着一改就能重测。
                    let tpl = read_only(
                        &app,
                        move |conn| crate::scale::load_config(conn, &scale_code).map(|o| o.map(|(_, t)| t)),
                        "设备自检读取",
                    )
                    .await?;
                    match tpl {
                        None => (false, "台账里没有这台磅，请核对编码".to_string()),
                        Some(tpl) => {
                            let port = tpl.transport.port.clone();
                            let out = tauri::async_runtime::spawn_blocking(move || {
                                crate::scale::probe_once(&tpl, SCALE_PROBE_BUDGET, SCALE_PROBE_FRAMES)
                            })
                            .await
                            .map_err(|e| format!("地磅自检任务失败：{e}"))?;
                            scale_verdict_from_probe(&port, &out)
                        }
                    }
                }
            }
        }
        ProbePlan::Camera { target, max_bytes } => {
            // 一次 HTTP 往返最长 3 秒（Digest 是两趟，最坏 6 秒），丢给一次性线程去等，
            // 别占住 async 运行时那几条工作线程——同屏还有磅的读数与别的命令要用它。
            tauri::async_runtime::spawn_blocking(move || crate::camera::probe_snapshot(&target, max_bytes))
                .await
                .map_err(|e| format!("摄像机自检任务失败：{e}"))?
        }
    };
    Ok(DeviceTestOutcome { ok, message, elapsed_ms: started.elapsed().as_millis() as u64 })
}

#[tauri::command]
pub async fn device_enabled(app: AppHandle, code: String, enabled: bool) -> Result<Vec<DeviceConfig>, String> {
    write_tx(&app, move |conn, actor| set_device_enabled(conn, actor, &code, enabled), DEVICE_ROLES, "启用或停用设备").await
}

#[tauri::command]
pub async fn device_mock(app: AppHandle, code: String, mock: bool) -> Result<Vec<DeviceConfig>, String> {
    write_tx(&app, move |conn, actor| set_device_mock(conn, actor, &code, mock), DEVICE_ROLES, "切换设备数据来源").await
}

#[tauri::command]
pub async fn device_config_update(app: AppHandle, input: UpdateDeviceConfigInput) -> Result<DeviceConfig, String> {
    write_tx(&app, move |conn, actor| update_device_config(conn, actor, input), DEVICE_ROLES, "修改设备配置").await
}

#[tauri::command]
pub async fn device_probe_report(app: AppHandle, code: String, res: ProbeResult) -> Result<DeviceConfig, String> {
    write_tx(&app, move |conn, actor| report_device_probe(conn, actor, &code, res), DEVICE_ROLES, "回写设备联机状态").await
}

#[tauri::command]
pub async fn device_create(app: AppHandle, input: CreateDeviceInput) -> Result<DeviceConfig, String> {
    write_tx(&app, move |conn, actor| create_device(conn, actor, input), DEVICE_ROLES, "登记设备")
        .await?
        .into_result()
}

/// 修改已登记设备（名称 / 驱动 / 关键参数 / 默认标记）。编码与类型不可改（见 [`update_device`]）。
#[tauri::command]
pub async fn device_update(app: AppHandle, input: UpdateDeviceInput) -> Result<DeviceConfig, String> {
    write_tx(&app, move |conn, actor| update_device(conn, actor, input), DEVICE_ROLES, "修改设备").await
}

/// 删除设备。有业务历史（被称重记录或抓拍附件引用）的一律拒删，见 [`delete_device`]。
#[tauri::command]
pub async fn device_delete(app: AppHandle, code: String) -> Result<Vec<DeviceConfig>, String> {
    write_tx(&app, move |conn, actor| delete_device(conn, actor, &code), DEVICE_ROLES, "删除设备").await
}
