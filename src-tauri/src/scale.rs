//! 地磅串口读数流（04 §2；替换原占位）
//!
//! 这一路补上"磅秤读数由 `Math.random()` 造数"的最后一块硬件缺口：Rust 侧独占打开
//! 串口 → 按 `device_config.config_json` 的**通用帧模板**切帧/解析（04 §2.3，不按仪表
//! 型号硬编码）→ 判稳（04 §2.4 流程图的 F 节点）→ 以 tauri event `device://scale`
//! 推给前端。前端只订阅，**判稳不在前端重做**。
//!
//! 硬性约束（都来自 04 §2.4「关键实现点」）：
//!  1. 读线程是 `std::thread` + `serialport` 阻塞读，**不跑在 Tauri 异步运行时上**——
//!     串口/仪表卡死不能把 IPC 一起拖走（§2.4 点 1）；
//!  2. 不稳定帧最多 10 帧/秒下发，**稳定后立刻补发一次**（§2.4 点 2）；
//!  3. **设备层不碰业务表**：`weigh_record` 仍由 `orders::capture` 写（§2.4 点 3）。
//!     台账列 `device_config.last_ok_at`/`err_count` 也**不在读线程里回写**——那要把全局
//!     连接锁带进读循环，别的命令正持锁做事务时读数就会停摆，违反点 1。计数一律由
//!     [`scale_status`] 交出，设备中心自己落库（04 §6 的帧监视器同源）。
//!  4. 无帧 5 s → 推**一次** `connected:false` + 中文原因（§2.4 点 4）。设备层**不拦业务**，
//!     是否切手工录入（`weight_source='manual'`）由工作台判。
//!
//! 本轮**没有真机**。所以与硬件无关的部分全部做成纯函数并单测覆盖：模板反序列化、
//! 切帧、取数、判稳、节流与饥饿判定（[`StreamCore::feed`]）。真机独有的只有
//! [`open_port`] 的参数映射与 [`read_loop`] 的重试节奏。

use std::io::{Read as _, Write as _};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// 事件名：`src/store/device.ts` 头注里写明要订阅的就是这个。
pub const SCALE_EVENT: &str = "device://scale";

/// 串口单次读的兜底超时：既让读线程周期性回头看停止位，又不至于长阻塞。
const READ_TIMEOUT: Duration = Duration::from_millis(200);
/// 不稳定帧节流：最多 10 帧/秒（§2.4 点 2）
const MIN_FRAME_INTERVAL_MS: u64 = 100;
/// 无帧多久算饥饿（§2.4 点 4）
const STARVE_MS: u64 = 5_000;
/// 连续多少帧校验/解析失败判 BadFrame（§2.4 C1 节点）
const BAD_FRAME_STREAK: u64 = 20;
/// 单次 read 最多取多少字节
const READ_CHUNK: usize = 1024;
/// 连续多少个串口 I/O 错误就认为设备已经掉了，退掉线程而不是空转
const IO_ERROR_LIMIT: u64 = 5;
/// 判稳窗口最多保留多少帧样本。正常配置永远碰不到（默认 5 帧 / 400 ms，连 1 ms 一帧的
/// 离谱仪表也只要 405 帧），它只兜 `stable_ms` 写错成几十秒时把读线程内存吃光这一种事故。
const MAX_WINDOW_SAMPLES: usize = 512;

// ====================================================================== 配置模板

/// 04 §2.3 通用帧模板，存 `device_config.config_json`（`kind='scale'`）。
///
/// 六段字段名与文档逐字一致；**整段缺、字段缺都落到文档默认值**（`window_frames=5`、
/// `max_spread_divisions=2`、`min_weight_01kg=0`（不设起称限制）、`stable_ms=400`、`division_01kg=100`），
/// 现场从 `{}` 起步、只填 `transport.port` 就能跑。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct FrameTemplate {
    pub transport: Transport,
    pub framing: Framing,
    pub payload: Payload,
    pub stability: Stability,
    pub align: Align,
    pub query: Query,
}

/// 传输层。04 §2.2 的 D 族（TCP 透传）本轮未接，见 [`open_port`] 的中文拒绝。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct Transport {
    pub kind: String,
    pub port: String,
    pub baud: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: u8,
    /// `kind="tcp"` 时才用（本轮未接）
    pub host: String,
    pub tcp_port: u16,
}

/// 切帧方式与帧校验。`checksum` 是 §2.3 之外的可选扩展：C 族应答帧带校验和、
/// §2.4 的 C 节点要求校验，而文档模板里没有这个位置。默认 `"none"` 不校验，
/// A 族连续帧因此完全不受影响。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct Framing {
    /// `delimited`（A/B/D 族）| `fixed_len`（C 族）
    pub mode: String,
    pub start: String,
    pub terminator: String,
    /// 只影响原帧的可读显示；数字一律按 ASCII 字节位取
    pub encoding: String,
    pub max_len: usize,
    /// `mode="fixed_len"` 时的定长（含起始符与结尾校验字节）
    pub fixed_len: usize,
    /// `none` | `sum8` | `sum8_comp` | `xor8`
    pub checksum: String,
}

/// 从帧里取重量的位置化描述。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct Payload {
    /// 符号位在帧内的下标（帧**含起始符**，与文档示例 `start="="` + `sign_index=1` 对齐）。
    /// 负数 = 无符号位，一律当正读。
    pub sign_index: i32,
    /// 数字位掩码（文档示例 `"0123456"`）。**生效方式是数字区宽度**：帧内数字个数超过
    /// `max(本串的数字字符个数, DIGIT_SLACK)` 判为粘帧/坏帧。数字本身一律按 `'0'..='9'`
    /// 接受——把示例串当"合法字符集"死抠会让 52.7 kg 变坏帧，现场不可接受。
    pub digits: String,
    /// 小数位数。帧内**有**小数点时按点的位置取（位数不足右补 0）；
    /// **无**小数点时按 §2.3 的"按 kg 直接换算"。
    /// 与 [`Payload::decimal_count_index`] 互斥：后者配了就以帧内那一位为准，本字段忽略。
    pub decimal_places: u8,
    /// **小数位数标志位**所在下标（帧含起始符，与 [`Payload::sign_index`] 同口径）。
    ///
    /// 耀华 XK3190-A9 连续帧里**没有真正的小数点**，而是在 6 位重量数字之后跟一位数字，
    /// 表示"小数点从右往左数几位"（0～4）。配了本字段时：数字扫描到该下标为止（不把这一位
    /// 当重量数字吃进去），再取该下标的数字当小数位数，重量 = 帧内整数 / 10^该位数。
    /// `null` = 不用此机制，回落到帧内小数点 / [`Payload::decimal_places`] 的老口径。
    pub decimal_count_index: Option<i32>,
    /// 扫描途中可跳过的填充字符（空格填充的仪表用 `" "`)
    pub skip_chars: String,
    /// 单位换算：`kg`（默认）| `g` | `t` | `0.1kg`
    pub unit: String,
    /// 预留：仪表状态字节下标（04 §2.2 B 族"稳定才发"用 [`Payload::stable_flag`]）
    pub status_bytes: Vec<u8>,
    /// 设备标稳标志所在字节下标；`null` = 纯本地判稳（文档示例即此）
    pub status_stable_byte: Option<usize>,
    /// 标稳位掩码；`null` = 该字节非零即稳
    pub status_stable_mask: Option<u8>,
}

/// 判稳窗口（§2.4 的 F 节点）。窗口与容差**只读这里**，不读 `app_setting`，避免两处真相。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct Stability {
    pub window_frames: usize,
    pub max_spread_divisions: i64,
    /// 起称阈值（0.1 kg）。**默认 0 = 不设任何起称限制**，任何读数都照常判稳/判上磅。
    /// 只有现场确实要用阈值挡掉空磅漂移时才配一个正数；配了之后低于它的读数不算稳、不算上磅。
    pub min_weight_01kg: i64,
    pub stable_ms: u64,
}

/// 分度取整（§2.3 末段、风险 H9）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct Align {
    pub division_01kg: i64,
    /// `nearest_div` | `floor_div` | `ceil_div` | `none`
    pub mode: String,
}

/// C 族询问-应答：主机按 `interval_ms` 节流主动发 `command_hex`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct Query {
    pub enabled: bool,
    /// 空格分隔的十六进制，如 `"02 3F 57 45 03"`；`"023F574503"` 也认
    pub command_hex: String,
    pub interval_ms: u64,
}

/// `digits` 掩码偏窄时的数字位数兜底：60 t 磅满量程 999999.9 kg 也才 10 位，留 2 位余量；
/// 超过就说明一"帧"里混进了两帧的数字（粘帧）。
const DIGIT_SLACK: usize = 12;

impl Default for FrameTemplate {
    fn default() -> Self {
        Self {
            transport: Transport::default(),
            framing: Framing::default(),
            payload: Payload::default(),
            stability: Stability::default(),
            align: Align::default(),
            query: Query::default(),
        }
    }
}

impl Default for Transport {
    fn default() -> Self {
        Self {
            kind: "serial".into(),
            port: String::new(),
            baud: 9600,
            data_bits: 8,
            parity: "none".into(),
            stop_bits: 1,
            host: String::new(),
            tcp_port: 0,
        }
    }
}

impl Default for Framing {
    fn default() -> Self {
        Self {
            mode: "delimited".into(),
            start: "=".into(),
            terminator: "\r\n".into(),
            encoding: "ascii".into(),
            max_len: 20,
            fixed_len: 0,
            checksum: "none".into(),
        }
    }
}

impl Default for Payload {
    fn default() -> Self {
        Self {
            sign_index: 1,
            digits: "0123456".into(),
            decimal_places: 1,
            decimal_count_index: None,
            skip_chars: " ".into(),
            unit: "kg".into(),
            status_bytes: Vec::new(),
            status_stable_byte: None,
            status_stable_mask: None,
        }
    }
}

impl Default for Stability {
    fn default() -> Self {
        Self {
            window_frames: 5,
            max_spread_divisions: 2,
            min_weight_01kg: 0,
            stable_ms: 400,
        }
    }
}

impl Default for Align {
    fn default() -> Self {
        Self {
            division_01kg: 100,
            mode: "nearest_div".into(),
        }
    }
}

impl Default for Query {
    fn default() -> Self {
        Self {
            enabled: false,
            command_hex: "02 3F 57 45 03".into(),
            interval_ms: 200,
        }
    }
}

/// 反序列化错误一律收成一句中文——现场看到的是设备中心的红字，不是 Rust 的 Debug 串。
///
/// 为什么要"先读成 Value、再逐段解"：`serde_json` 整份解时的报错只有
/// `invalid type: string "five", expected u32`，点不出键名，而设备中心里躺着六段配置，
/// 运维看不出该改哪一行。段内再逐键重试一次就能报出 `stability.window_frames`。
///
/// 未知键**故意容忍**（不用 `deny_unknown_fields`）：`config_json` 是设备中心几种驱动共用
/// 的一个 JSON blob，打印机/身份证的 `preset` 之类也写在同一份里，严格校验会让磅一读到
/// 别的模块写的键就起不来。
pub fn parse_template(json: &str) -> Result<FrameTemplate, String> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return Ok(FrameTemplate::default());
    }
    let root: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => {
            return Err(templ_err("整份配置不是合法 JSON", &serde_head(&e.to_string())));
        }
    };
    let obj = match &root {
        serde_json::Value::Null => return Ok(FrameTemplate::default()),
        serde_json::Value::Object(m) => m.clone(),
        _ => return Err(templ_err("整份配置应该是个 JSON 对象", "照 §2.3 的六段结构写")),
    };
    Ok(FrameTemplate {
        transport: decode_section("transport", &obj)?,
        framing: decode_section("framing", &obj)?,
        payload: decode_section("payload", &obj)?,
        stability: decode_section("stability", &obj)?,
        align: decode_section("align", &obj)?,
        query: decode_section("query", &obj)?,
    })
}

fn templ_err(what: &str, why: &str) -> String {
    format!("帧模板解析失败：{what}（{why}），照 04 §2.3 改或删掉这一段用默认值")
}

/// 剥掉 serde 尾部的 `at line 1 column 20`——行列号对着一份压缩过的 JSON 没有任何意义。
fn serde_head(why: &str) -> String {
    why.split(" at line").next().unwrap_or(why).trim().to_string()
}

fn decode_section<T>(
    name: &str,
    root: &serde_json::Map<String, serde_json::Value>,
) -> Result<T, String>
where
    T: DeserializeOwned + Default,
{
    let Some(v) = root.get(name) else {
        return Ok(T::default());
    };
    if v.is_null() {
        return Ok(T::default());
    }
    let Some(map) = v.as_object() else {
        return Err(templ_err(&format!("{name} 这一段应该是个对象"), "如 \"stability\": { ... }"));
    };
    match serde_json::from_value::<T>(v.clone()) {
        Ok(t) => Ok(t),
        Err(e) => {
            let why = serde_head(&e.to_string());
            for (k, val) in map {
                let mut one = serde_json::Map::new();
                one.insert(k.clone(), val.clone());
                // 单键能解出来的就不是它；容器级 default 让"只给一个键"成为合法输入
                if serde_json::from_value::<T>(serde_json::Value::Object(one)).is_err() {
                    return Err(templ_err(&format!("{name}.{k} 的值不对"), &why));
                }
            }
            Err(templ_err(&format!("{name} 这一段"), &why))
        }
    }
}

impl Payload {
    fn is_skip(&self, b: u8) -> bool {
        !self.skip_chars.is_empty() && self.skip_chars.contains(b as char)
    }

    fn digit_limit(&self) -> usize {
        let mask = self.digits.chars().filter(|c| c.is_ascii_digit()).count();
        mask.max(DIGIT_SLACK)
    }

    /// 仪表自报"稳定"（04 §2.2 B 族）。没配 `status_stable_byte` 时回 `None`，
    /// 意思是"设备没说话，全靠本地判稳"。
    pub fn stable_flag(&self, frame: &[u8]) -> Option<bool> {
        let idx = self.status_stable_byte?;
        let byte = *frame.get(idx)?;
        Some(match self.status_stable_mask {
            Some(mask) if mask != 0 => byte & mask != 0,
            _ => byte != 0,
        })
    }
}

// ====================================================================== 切帧

/// [`split_frames`] 的完整结论：帧 + 丢掉的字节数与丢掉的超长帧数。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SplitOutcome {
    pub frames: Vec<Vec<u8>>,
    /// 起始符之前被吃掉的字节（上电噪声、波特率不对的乱码、上一帧的尾巴）
    pub dropped_bytes: usize,
    /// 超过 `framing.max_len` 被整帧丢弃的个数
    pub dropped_frames: usize,
}

/// 按 `framing` 从缓冲区切出完整帧；**没有终止符的尾巴留在缓冲区里**，下次接着用。
///
/// 为什么半帧必须留下：9600 bps 下 17 字节的帧常被串口拆成两三段到达，
/// 每次 read 都从头找终止符会把一帧的数字读成两半，读数就永远跳不定。
pub fn split_frames(buf: &mut Vec<u8>, framing: &Framing) -> Vec<Vec<u8>> {
    split_frames_ex(buf, framing).frames
}

/// 带丢弃计数的版本——设备中心帧监视器与 `err_count` 要的是这个。
pub fn split_frames_ex(buf: &mut Vec<u8>, framing: &Framing) -> SplitOutcome {
    let mut out = SplitOutcome::default();
    let max_len = if framing.max_len == 0 { 256 } else { framing.max_len };
    let start = framing.start.as_bytes();
    let term = framing.terminator.as_bytes();

    if framing.mode == "fixed_len" {
        let want = framing.fixed_len;
        if want == 0 {
            // 定长却没给长度：留着字节只会永远切不出帧，直接清掉并交给上层报错
            out.dropped_bytes += buf.len();
            buf.clear();
            return out;
        }
        while buf.len() >= want {
            let frame: Vec<u8> = buf.drain(..want).collect();
            if frame.len() > max_len {
                out.dropped_frames += 1;
            } else {
                out.frames.push(frame);
            }
        }
        return out;
    }

    let mut guard = 0usize;
    loop {
        guard += 1;
        if guard > 8192 {
            // 防病态配置（起始符含终止符等）把这里写成死循环：读线程绝不能卡死
            buf.clear();
            break;
        }
        match find(buf, start) {
            Some(0) => {}
            Some(pos) => {
                // 起始符之前的字节属于一个残帧：丢掉并计数，留着会挡住后面的好帧
                out.dropped_bytes += pos;
                buf.drain(..pos);
                continue;
            }
            None => {
                if !start.is_empty() {
                    // 整段缓冲里没有起始符：全丢。留着不会变好，却会在"仪表只发不换行垃圾"
                    // 时让缓冲区无上限长大。
                    out.dropped_bytes += buf.len();
                    buf.clear();
                }
                break;
            }
        }
        if term.is_empty() {
            // 没配终止符：攒够 max_len 就当一帧切出去（定长 ASCII 流用）
            if buf.len() >= max_len {
                let frame: Vec<u8> = buf.drain(..max_len).collect();
                out.frames.push(frame);
                continue;
            }
            break;
        }
        match find(&buf[start.len()..], term).map(|p| p + start.len()) {
            Some(end) => {
                let stop = (end + term.len()).min(buf.len());
                let frame: Vec<u8> = buf.drain(..stop).collect();
                if frame.len() > max_len {
                    // 带终止符却超长：是垃圾（或波特率不对），丢掉继续找下一帧
                    out.dropped_frames += 1;
                } else {
                    out.frames.push(frame);
                }
            }
            None => {
                // 半帧：留着等下一次 read。只有它自己已经超过 max_len 才判垃圾，
                // 且只截掉 max_len 字节——后面可能还跟着一个完整的好帧。
                if buf.len() > max_len {
                    out.dropped_frames += 1;
                    buf.drain(..max_len);
                    continue;
                }
                break;
            }
        }
    }
    out
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    if hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

// ====================================================================== 取数

/// 位置化取出 `weight_01kg`（0.1 kg 整数；负数=负读数，回皮/空磅负值用）。
///
/// 失败回中文短句，调用方按坏帧计数（§2.4 C1）。
pub fn parse_weight(frame: &[u8], payload: &Payload) -> Result<i64, String> {
    if frame.is_empty() {
        return Err("空帧".into());
    }
    let ascii: Vec<char> = frame.iter().map(|b| *b as char).collect();
    let upper: String = ascii.iter().map(|c| c.to_ascii_uppercase()).collect();
    for token in ["OVER", "O_L", "O L", "OL"] {
        if upper.contains(token) {
            return Err("仪表显示超载（OL），本帧不作读数".into());
        }
    }

    // 扫描起点在符号位之后；符号位越界时退回帧头找第一个数字（宽容残帧）
    let mut cursor = if payload.sign_index >= 0 {
        (payload.sign_index as usize).saturating_add(1)
    } else {
        0
    };
    if cursor > frame.len() {
        cursor = 0;
    }
    let negative = if payload.sign_index >= 0 {
        matches!(frame.get(payload.sign_index as usize), Some(b'-') | Some(b'S'))
    } else {
        upper.contains('-')
    };

    // 连续取数字：允许一个小数点、允许 skip_chars 夹在中间；撞到别的字符（单位、状态字节）即止
    let mut int_part: i64 = 0;
    let mut int_digits = 0usize;
    let mut frac_part: i64 = 0;
    let mut frac_digits = 0usize;
    let mut seen_dot = false;
    let limit = payload.digit_limit();
    // 小数位数标志位（A9 式）：数字扫描到该下标为止，绝不把这一位当重量数字吃进去。
    // 用 `i >= s` 而不是 `i == s`：sign_index 配得比它还靠后时也要当场收住，别越界乱吃。
    let dec_stop = payload.decimal_count_index.filter(|i| *i >= 0).map(|i| i as usize);
    let mut i = cursor;
    while i < frame.len() {
        if dec_stop.is_some_and(|s| i >= s) {
            break;
        }
        let c = ascii[i];
        i += 1;
        if payload.is_skip(c as u8) {
            continue;
        }
        if c.is_ascii_digit() {
            let d = (c as u8 - b'0') as i64;
            if seen_dot {
                frac_part = frac_part * 10 + d;
                frac_digits += 1;
            } else {
                int_part = int_part * 10 + d;
                int_digits += 1;
            }
            if int_digits + frac_digits > limit {
                return Err(format!(
                    "一帧里挤进 {} 位数字（模板 digits 声明的数字区只有 {} 位宽），按坏帧丢弃",
                    int_digits + frac_digits,
                    limit
                ));
            }
            continue;
        }
        if (c == '.' || c == ',') && !seen_dot {
            seen_dot = true;
            continue;
        }
        break;
    }
    if int_digits == 0 && frac_digits == 0 {
        return Err("帧里找不到数字位（sign_index / start 与实帧对不上？用帧监视器看原帧）".into());
    }

    // 帧内数字先构成"以 payload.unit 为单位的定值小数"：value = num / den
    let (num, den) = match dec_stop {
        // A9 式：帧内整数就是"去掉小数点后的数字"，量级由标志位那一位数字定死。
        Some(s) => {
            let dec_count = match frame.get(s) {
                Some(b @ b'0'..=b'9') => (*b - b'0') as usize,
                Some(_) => {
                    return Err(format!(
                        "小数位数标志位（帧第 {s} 字节 = '{}'）不是数字，请核对 payload.decimal_count_index 与实帧",
                        frame[s] as char
                    ));
                }
                None => {
                    return Err(format!("帧只有 {} 字节，取不到第 {s} 字节的小数位数标志位", frame.len()));
                }
            };
            if dec_count > 18 {
                return Err(format!("小数位数标志位 = {dec_count} 超出可解析范围（0～18）"));
            }
            (int_part, 10i64.pow(dec_count as u32))
        }
        // 老口径：帧内小数点 / 固定 decimal_places
        None => {
            let eff = frac_digits.max(payload.decimal_places as usize);
            if eff > 18 {
                // 10^eff 已超出 i64：无论来自帧内小数位还是配错的 decimal_places，都按坏帧处理。
                // 绝不能让下面 `10i64.pow(eff)` 在 release(panic=abort) 下把整个进程带走（04 §2.4）。
                return Err(format!(
                    "小数定值位宽 eff={eff} 超出可解析范围，请核对帧模板 payload.decimal_places"
                ));
            }
            let mut num = int_part;
            if seen_dot || eff > 0 {
                for _ in 0..eff - frac_digits {
                    frac_part *= 10; // 右补：52.3 配 dp=2 视作 52.30
                }
                for _ in 0..eff {
                    num *= 10;
                }
                num += frac_part;
            }
            let den = 10i64.pow(if seen_dot || eff > 0 { eff as u32 } else { 0 });
            (num, den)
        }
    };
    // 再按单位换算到 0.1 kg（§2.3：无小数点时按 kg 直接换算；有小数点时量级由点定死）
    let (factor_num, factor_den): (i64, i64) = match payload.unit.trim().to_ascii_lowercase().as_str() {
        "" | "kg" => (10, 1),
        "0.1kg" | "dag" | "d" => (1, 1),
        "g" => (1, 100),
        "t" => (10_000, 1),
        other => {
            return Err(format!("不认识的单位「{other}」，模板 unit 只支持 kg/g/t/0.1kg"));
        }
    };
    let scale = den * factor_den;
    let scaled = num.saturating_mul(factor_num);
    let value_01kg = (scaled + scale / 2) / scale; // 四舍五入到 0.1 kg
    Ok(if negative { -value_01kg } else { value_01kg })
}

// ====================================================================== 判稳

/// 一次判稳的结论。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Judgement {
    pub stable: bool,
    pub aligned_01kg: i64,
    pub on_scale: bool,
    pub mean_01kg: i64,
    pub spread_01kg: i64,
    pub samples: Vec<i64>,
    pub window_ms: u64,
}

/// 滑动窗口判稳器。
///
/// **与前端 `src/store/device.ts:165` 的 `tick()` 的等价关系**（本轮替换的就是那段模拟）：
///  - `WINDOW = 5`              ↔ `stability.window_frames = 5`（**帧数只是下限**：窗口还得
///    真持续满 `stable_ms` 才算数，所以 20 ms 一帧的快仪表会多留几帧，慢仪表就是模拟流那 5 帧）
///  - `TOLERANCE = 50`（0.1kg）  ↔ `max_spread_divisions × division_01kg`；配
///    `{max_spread_divisions:1, division_01kg:50}` 就是 `max-min <= 50` 的同一条线。
///    文档默认 2 分度（=200 个 0.1 kg=20 kg）**比模拟流宽松 4 倍**：稳定来得更快，
///    但 10–20 kg 的真实晃动也会被判稳，这正是 H9 的取整争议源。
///  - `aligned = Math.round(raw/DIVISION)*DIVISION` ↔ [`Align::apply`] 的 `nearest_div`，
///    同样作用于**当前帧读数**而非窗口均值，所以定格瞬间数字不会莫名跳一格。
///  - 模拟流没有、真机可选的一条：`min_weight_01kg`（**默认 0 = 不设起称限制**；只有配了正数
///    才把低于阈值的读数挡在"有效/判稳/上磅"之外，代价是空磅或轻载不会被判稳）；以及真机必须的
///    `stable_ms`（窗口要真的持续 400 ms 才算稳——帧攒够但时长不够时**继续多攒几帧**，
///    而不是像旧写法那样把窗口封死在 5 帧、让快仪表永远判不稳）。
#[derive(Debug, Clone)]
pub struct StabilityJudge {
    stability: Stability,
    align: Align,
    samples: Vec<(i64, u64)>,
}

impl StabilityJudge {
    pub fn new(stability: Stability, align: Align) -> Self {
        let window = stability.window_frames.max(1);
        Self {
            stability,
            align,
            samples: Vec::with_capacity(window),
        }
    }

    pub fn reset(&mut self) {
        self.samples.clear();
    }

    /// 当前窗口内容（事件里的 `samples`，设备中心画波形用）
    pub fn window(&self) -> Vec<i64> {
        self.samples.iter().map(|(w, _)| *w).collect()
    }

    /// 当前窗口的（极差 0.1 kg，首尾帧实际时长 ms）。
    ///
    /// 与 [`Self::window`] 一起下发，界面才能解释"为什么还不稳"：极差与时长都必须按
    /// **此刻窗口里这几帧**算，不能拿上一次已发出事件的结论来配这一批样本（帧被节流挡掉时
    /// 两者会错位，界面就成了"样本在跳、极差却是 0"的谜）。
    pub fn stats(&self) -> (i64, u64) {
        let spread = match (self.samples.iter().map(|(w, _)| *w).max(), self.samples.iter().map(|(w, _)| *w).min()) {
            (Some(hi), Some(lo)) => hi - lo,
            _ => 0,
        };
        let span = match (self.samples.first(), self.samples.last()) {
            (Some((_, t0)), Some((_, t1))) => t1.saturating_sub(*t0),
            _ => 0,
        };
        (spread, span)
    }

    /// 推入一帧读数并判稳。`device_stable` = 仪表自报已稳（B 族）时把本地窗口条件
    /// **减半而不是免除**——04 §2.2 明确"有帧即稳仍需本地二次确认"。
    pub fn push(&mut self, weight_01kg: i64, now_ms: u64, device_stable: Option<bool>) -> Judgement {
        let window = self.stability.window_frames.max(1);
        let flagged = device_stable == Some(true);
        let need_frames = if flagged { (window + 1) / 2 } else { window };
        let need_ms = if flagged { self.stability.stable_ms / 2 } else { self.stability.stable_ms };

        self.samples.push((weight_01kg, now_ms));
        // 窗口先"够长"、再"够帧数"。旧写法是**先按帧数封顶**（攒满 window_frames 就挤掉最老的），
        // 于是 20 ms 一帧的快仪表永远只有 100 ms 的窗口，`span_ms >= stable_ms` 这一条
        // 数学上就不可能成立：磅上明明压着车，判稳灯却永远灰着，操作员只能一直手录。
        // 现在保留"覆盖到 need_ms 所需的最少样本"，一旦去掉最老一帧仍然够长就收掉它——
        // 慢仪表（周期 > need_ms/窗口数）行为与从前逐帧一致，仍是那 5 帧窗口。
        while self.samples.len() > window {
            let span_without_oldest = now_ms.saturating_sub(self.samples[1].1);
            if span_without_oldest >= need_ms {
                self.samples.remove(0);
            } else {
                break;
            }
        }
        if self.samples.len() > MAX_WINDOW_SAMPLES {
            // 兜底：`stable_ms` 写错成几十秒 + 毫秒级仪表会把缓冲撑到无限大。
            // 宁可退回"判不稳"（现场看得见、还能手录），也不让读线程吃光内存。
            let cut = self.samples.len() - MAX_WINDOW_SAMPLES;
            self.samples.drain(..cut);
        }

        let values: Vec<i64> = self.samples.iter().map(|(w, _)| *w).collect();
        let sum: i64 = values.iter().sum();
        let mean = sum / values.len() as i64;
        let spread = *values.iter().max().unwrap_or(&mean) - *values.iter().min().unwrap_or(&mean);
        let oldest = self.samples.first().map(|(_, t)| *t).unwrap_or(now_ms);
        let span_ms = now_ms.saturating_sub(oldest);

        let tolerance = self
            .stability
            .max_spread_divisions
            .saturating_mul(self.align.division_01kg.max(1));

        let stable = values.len() >= need_frames
            && spread <= tolerance
            && mean.abs() >= self.stability.min_weight_01kg
            && span_ms >= need_ms;

        Judgement {
            stable,
            aligned_01kg: self.align.apply(weight_01kg),
            // on_scale 取绝对值：负读数只表示"比参考皮轻"，磅上确实压着车
            on_scale: weight_01kg.abs() >= self.stability.min_weight_01kg
                || mean.abs() >= self.stability.min_weight_01kg,
            mean_01kg: mean,
            spread_01kg: spread,
            samples: values,
            window_ms: span_ms,
        }
    }
}

impl Align {
    /// 分度取整。`nearest_div` 与前端 `Math.round(raw/DIVISION)*DIVISION` 同口径，
    /// 负值按"远离零"进位（与仪表显示一致）。
    pub fn apply(&self, w: i64) -> i64 {
        let d = self.division_01kg;
        if d <= 0 {
            return w;
        }
        match self.mode.as_str() {
            "none" | "" => w,
            "floor_div" => w.div_euclid(d) * d,
            "ceil_div" => -((-w).div_euclid(d) * d),
            _ => {
                if w >= 0 {
                    (w + d / 2) / d * d
                } else {
                    -((w.abs() + d / 2) / d * d)
                }
            }
        }
    }
}

// ====================================================================== 事件

/// `device://scale` 的 payload。前 8 个字段逐字对齐 `src/store/device.ts` 的
/// `ScaleState`（connected / onScale / weight01kg / stable，加上原帧与时间戳），
/// 后面是附加信息：**只加不减**，前端不认的字段忽略即可。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScaleEvent {
    pub connected: bool,
    pub on_scale: bool,
    pub weight_01kg: i64,
    pub aligned_01kg: i64,
    pub stable: bool,
    pub raw_frame: String,
    pub at: String,
    pub error: Option<String>,
    // ---- 以下附加 ----
    /// 错误分类（04 §1.1）：Offline / Timeout / BadFrame / Unsupported / Busy
    pub error_kind: Option<String>,
    pub code: String,
    pub device_id: i64,
    pub port: String,
    /// 判稳窗口内容（前端 `samples` 直用）
    pub samples: Vec<i64>,
    pub mean_01kg: i64,
    pub division_01kg: i64,
    pub frame_count: u64,
    pub err_count: u64,
    // ---- 判稳依据快照：设备中心帧监视器解释"为什么还在波动中"就靠这五项 ----
    //
    // 界面自己算不出这些：极差要按 0.1 kg 整数算（浮点显示值会丢位）、窗口时长只有读线程
    // 知道、容差是 `max_spread_divisions × division_01kg` 的乘积。把判据连同结论一起下发，
    // 现场才能一眼看出卡在"帧数不够"还是"晃得太厉害"，而不是对着一个"波动中"猜。
    /// 当前窗口的极差（0.1 kg）
    pub spread_01kg: i64,
    /// 当前窗口首尾帧的实际时长（ms）
    pub window_ms: u64,
    /// 配置的判稳窗口帧数（`stability.window_frames`，至少 1）
    pub window_frames: u64,
    /// 容差（0.1 kg）= `max_spread_divisions × division_01kg`
    pub tolerance_01kg: i64,
    /// 窗口要真实持续多久（ms，`stability.stable_ms`）
    pub stable_ms: u64,
}

impl Default for ScaleEvent {
    fn default() -> Self {
        Self {
            connected: false,
            on_scale: false,
            weight_01kg: 0,
            aligned_01kg: 0,
            stable: false,
            raw_frame: String::new(),
            at: String::new(),
            error: None,
            error_kind: None,
            code: String::new(),
            device_id: 0,
            port: String::new(),
            samples: Vec::new(),
            mean_01kg: 0,
            division_01kg: 100,
            frame_count: 0,
            err_count: 0,
            spread_01kg: 0,
            window_ms: 0,
            window_frames: 5,
            tolerance_01kg: 200,
            stable_ms: 400,
        }
    }
}

/// 设备台账的一行（`is_mock` / `driver='mock'` 决定命令层拒不拒）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRow {
    pub id: i64,
    pub code: String,
    pub name: String,
    pub kind: String,
    pub driver: String,
    pub config_json: String,
    pub is_mock: bool,
    pub is_enabled: bool,
}

/// 原帧的可读形式：可打印字符照出，控制字符转义。
/// 帧监视器（04 §6）与 `weigh_record.raw_frame` 存的就是这个串。
pub fn frame_display(frame: &[u8]) -> String {
    let mut s = String::with_capacity(frame.len() + 8);
    for b in frame {
        match b {
            b'\r' => s.push_str("\\r"),
            b'\n' => s.push_str("\\n"),
            b'\t' => s.push_str("\\t"),
            0x20..=0x7e => s.push(*b as char),
            other => s.push_str(&format!("\\x{other:02X}")),
        }
    }
    s
}

/// `"02 3F 57 45 03"` / `"023F574503"` → 字节。现场从仪表面板抄指令时两种写法都会有。
pub fn parse_hex(text: &str) -> Result<Vec<u8>, String> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return Ok(Vec::new());
    }
    if compact.len() % 2 != 0 {
        return Err("查询指令的十六进制长度是奇数，少半个字节".into());
    }
    (0..compact.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&compact[i..i + 2], 16)
                .map_err(|_| format!("查询指令「{}」里有非十六进制字符", text.trim()))
        })
        .collect()
}

// ====================================================================== 流内核

/// 与串口无关的那半条流水线：缓冲 → 切帧 → 校验 → 取数 → 判稳 → 节流成事件。
///
/// 单独成结构的原因：真机不在这台机器上，而 §2.4 的三条实现点（节流、稳定补发、
/// 5 秒饥饿）恰好是最容易写错、又完全能在没有硬件时验的部分。读线程只负责
/// "把字节喂进来、把事件发出去"。
#[derive(Clone)]
pub struct StreamCore {
    pub tpl: FrameTemplate,
    judge: StabilityJudge,
    buf: Vec<u8>,
    pub code: String,
    pub device_id: i64,
    pub port: String,
    pub frame_count: u64,
    pub err_count: u64,
    pub err_streak: u64,
    pub dropped_bytes: u64,
    pub dropped_frames: u64,
    pub bytes_in: u64,
    /// 最后一次**成功解析**的读数快照：坏帧事件与离线事件也要带着它下发，
    /// 否则界面在"仪表刚掉线"那一刻会把数字清成 0，看着像空磅而不是断线。
    last_weight: i64,
    last_aligned: i64,
    last_mean: i64,
    last_stable: bool,
    last_on_scale: bool,
    last_raw: String,
    last_good_ms: Option<u64>,
    last_emit_ms: Option<u64>,
    last_emit_stable: bool,
    starve_reported: bool,
    /// `None` = 还没问过。用 0 起算会让 `now_ms < interval_ms` 的首次轮询白白丢掉。
    last_query_ms: Option<u64>,
    last_error: Option<(String, String)>,
}

impl StreamCore {
    pub fn new(tpl: FrameTemplate, code: &str, device_id: i64) -> Self {
        Self {
            judge: StabilityJudge::new(tpl.stability.clone(), tpl.align.clone()),
            port: tpl.transport.port.clone(),
            tpl,
            buf: Vec::new(),
            code: code.to_string(),
            device_id,
            frame_count: 0,
            err_count: 0,
            err_streak: 0,
            dropped_bytes: 0,
            dropped_frames: 0,
            bytes_in: 0,
            last_weight: 0,
            last_aligned: 0,
            last_mean: 0,
            last_stable: false,
            last_on_scale: false,
            last_raw: String::new(),
            last_good_ms: None,
            last_emit_ms: None,
            last_emit_stable: false,
            starve_reported: false,
            last_query_ms: None,
            last_error: None,
        }
    }

    pub fn buffer_len(&self) -> usize {
        self.buf.len()
    }

    pub fn last_error(&self) -> Option<(String, String)> {
        self.last_error.clone()
    }

    /// 喂进一段串口字节，返回**此刻应当下发**的事件（被节流挡掉时为空）。
    pub fn feed(&mut self, bytes: &[u8], now_ms: u64) -> Vec<ScaleEvent> {
        self.bytes_in += bytes.len() as u64;
        self.buf.extend_from_slice(bytes);
        let split = split_frames_ex(&mut self.buf, &self.tpl.framing);
        self.dropped_bytes += split.dropped_bytes as u64;
        self.dropped_frames += split.dropped_frames as u64;
        let mut events: Vec<ScaleEvent> = Vec::new();
        let mut last_err: Option<(String, String)> = None;
        let mut good = false;
        for frame in &split.frames {
            match self.on_frame(frame, now_ms) {
                Ok(Some(ev)) => {
                    good = true;
                    events.push(ev);
                }
                Ok(None) => {}
                Err(e) => last_err = Some(e),
            }
        }
        if let Some((kind, msg)) = last_err {
            // 坏帧单独成一条事件，不把原因挂在某条有效读数上——那条读数是算成功的；
            // 一次喂进多帧时也只带最后一条原因，界面要的是"现在不对"而不是坏帧流水。
            let mut ev = self.event(now_ms);
            ev.connected = self.last_good_ms.is_some();
            ev.error_kind = Some(kind);
            ev.error = Some(msg);
            events.push(ev);
        }
        if good {
            // 只有真的解析出一帧才重新武装离线判定：一直吐乱码的串口必须继续报"读不到"
            self.starve_reported = false;
        }
        events
    }

    /// 到点没帧 → 推**一次**离线事件（§2.4 点 4）；收到帧后 [`Self::feed`] 会重新武装。
    pub fn watchdog(&mut self, now_ms: u64) -> Option<ScaleEvent> {
        if self.starve_reported {
            return None;
        }
        match self.last_good_ms {
            Some(t) => {
                if now_ms.saturating_sub(t) < STARVE_MS {
                    return None;
                }
            }
            // 一帧都没收到过：给足首次等待，别在接线开口的 5 秒里就喊离线
            None => {
                if now_ms < STARVE_MS {
                    return None;
                }
            }
        }
        self.starve_reported = true;
        self.err_streak += 1;
        let msg = format!(
            "串口 {} 已 {} 秒没有收到读数帧：仪表未上电、波特率不符或 COM 口被别的程序占着",
            self.port,
            STARVE_MS / 1000
        );
        self.last_error = Some(("Offline".into(), msg.clone()));
        let mut ev = self.event(now_ms);
        ev.stable = false;
        ev.error_kind = Some("Offline".into());
        ev.error = Some(msg);
        Some(ev)
    }

    /// C 族查询节流：到 `interval_ms` 回指令字节（A 族连续发送永远回 `None`）。
    pub fn query_due(&mut self, now_ms: u64) -> Option<Vec<u8>> {
        if !self.tpl.query.enabled {
            return None;
        }
        if let Some(t) = self.last_query_ms {
            if now_ms.saturating_sub(t) < self.tpl.query.interval_ms.max(1) {
                return None;
            }
        }
        self.last_query_ms = Some(now_ms);
        parse_hex(&self.tpl.query.command_hex).ok().filter(|v| !v.is_empty())
    }

    /// 单帧：校验 → 取数 → 判稳 → 节流。`Err` 里是（错误分类, 中文短句）。
    fn on_frame(&mut self, frame: &[u8], now_ms: u64) -> Result<Option<ScaleEvent>, (String, String)> {
        self.frame_count += 1;
        let raw = frame_display(frame);
        if let Err(msg) = verify_checksum(frame, &self.tpl.framing) {
            self.count_err("BadFrame", &msg);
            return Err(("BadFrame".into(), msg));
        }
        let weight = match parse_weight(frame, &self.tpl.payload) {
            Ok(w) => w,
            Err(msg) => {
                self.count_err("BadFrame", &msg);
                return Err(("BadFrame".into(), msg));
            }
        };
        self.err_streak = 0;
        self.last_good_ms = Some(now_ms);
        let flag = self.tpl.payload.stable_flag(frame);
        let j = self.judge.push(weight, now_ms, flag);
        // 为什么稳定之后还要绕过节流立刻补发一次：不稳定帧压到 10 帧/秒是防"数字乱跳
        // 看不清"（§2.4 点 2），但**定格**这一瞬间必须马上到界面——否则司机已经能下磅了、
        // 捕获按钮还灰着。
        let due = self
            .last_emit_ms
            .map(|t| now_ms.saturating_sub(t) >= MIN_FRAME_INTERVAL_MS)
            .unwrap_or(true);
        let changed = j.stable != self.last_emit_stable;
        if !due && !changed {
            return Ok(None);
        }
        self.last_emit_ms = Some(now_ms);
        self.last_emit_stable = j.stable;
        self.last_weight = weight;
        self.last_aligned = j.aligned_01kg;
        self.last_mean = j.mean_01kg;
        self.last_stable = j.stable;
        self.last_on_scale = j.on_scale;
        self.last_raw = raw;
        let mut ev = self.event(now_ms);
        ev.connected = true;
        // 好帧必须把旧的错误原因冲掉：last_error 是累计留痕，挂着它界面会一直红着
        ev.error = None;
        ev.error_kind = None;
        Ok(Some(ev))
    }

    /// 坏帧计数；连续 BAD_FRAME_STREAK 次升级为"整条链路不对"的醒目提示（§2.4 C1）。
    fn count_err(&mut self, kind: &str, msg: &str) {
        self.err_count += 1;
        self.err_streak += 1;
        self.last_error = Some((kind.to_string(), msg.to_string()));
        if self.err_streak % BAD_FRAME_STREAK == 0 {
            self.judge.reset();
            self.last_error = Some((
                "BadFrame".into(),
                format!("连续 {BAD_FRAME_STREAK} 帧校验不过：帧模板和实际输出对不上，请在设备中心用帧监视器核对实帧（最后一次原因：{msg}）"),
            ));
        }
    }

    /// 用当前状态拼一条事件。`connected` 一律先置 false，由调用方按语义覆写。
    fn event(&self, _now_ms: u64) -> ScaleEvent {
        // 极差与窗口时长都按**此刻窗口里这几帧**现算，和下面的 `samples` 出自同一批数据；
        // 拿上一次已发出事件的结论来配这一批样本，帧被节流挡掉时就会错位
        //（界面成了"样本在跳、极差却是 0"的谜）。
        let (spread_01kg, window_ms) = self.judge.stats();
        ScaleEvent {
            connected: false,
            on_scale: self.last_on_scale,
            weight_01kg: self.last_weight,
            aligned_01kg: self.last_aligned,
            stable: self.last_stable,
            raw_frame: self.last_raw.clone(),
            at: crate::db::migrate::now_iso(),
            error: self.last_error.as_ref().map(|(_, m)| m.clone()),
            error_kind: self.last_error.as_ref().map(|(k, _)| k.clone()),
            code: self.code.clone(),
            device_id: self.device_id,
            port: self.port.clone(),
            samples: self.judge.window(),
            mean_01kg: self.last_mean,
            division_01kg: self.tpl.align.division_01kg,
            frame_count: self.frame_count,
            err_count: self.err_count,
            spread_01kg,
            window_ms,
            window_frames: self.tpl.stability.window_frames.max(1) as u64,
            // 与 StabilityJudge::push 里那条 tolerance 同一个乘式：界面上说的就是判的
            tolerance_01kg: self
                .tpl
                .stability
                .max_spread_divisions
                .saturating_mul(self.tpl.align.division_01kg.max(1)),
            stable_ms: self.tpl.stability.stable_ms,
        }
    }
}

/// 帧尾校验和。
///
/// - `sum8` / `sum8_comp` / `xor8`：`body` = 去掉起始符与终止符后的中段，**最后一字节**为原始校验字节。
/// - `xor_ascii_hex`（耀华 XK3190-A9 连续帧）：校验 = 中段各字节异或，输出成**终止符前的两个
///   ASCII 十六进制字符**（高字节在前、大小写不敏感），而不是一个原始字节。
fn verify_checksum(frame: &[u8], framing: &Framing) -> Result<(), String> {
    let kind = framing.checksum.trim().to_ascii_lowercase();
    if kind.is_empty() || kind == "none" {
        return Ok(());
    }
    let start = framing.start.as_bytes();
    let term = framing.terminator.as_bytes();
    let head = if !start.is_empty() && frame.starts_with(start) { start.len() } else { 0 };
    let tail = if !term.is_empty() && frame.ends_with(term) { term.len() } else { 0 };
    let end = frame.len().saturating_sub(tail);

    if kind == "xor_ascii_hex" {
        // 中段至少 1 字节 + 2 个 ASCII 十六进制字符
        if end < head + 3 {
            return Err("帧太短，放不下校验体与两字符 ASCII 十六进制校验".into());
        }
        let body = &frame[head..end - 2];
        let got = &frame[end - 2..end];
        let xor = body.iter().fold(0u8, |a, b| a ^ *b);
        let want = format!("{xor:02X}");
        if got.eq_ignore_ascii_case(want.as_bytes()) {
            Ok(())
        } else {
            Err(format!(
                "校验和不对：帧尾 ASCII 校验「{}{}」，按 xor_ascii_hex 应为 {want}",
                got[0] as char, got[1] as char
            ))
        }
    } else {
        if end <= head + 1 {
            return Err("帧太短，没有校验字节的位置".into());
        }
        let body = &frame[head..end - 1];
        let got = frame[end - 1];
        let sum: u8 = body.iter().fold(0u8, |a, b| a.wrapping_add(*b));
        let want = match kind.as_str() {
            "sum8" => sum,
            "sum8_comp" => sum.wrapping_neg(),
            "xor8" => body.iter().fold(0u8, |a, b| a ^ *b),
            other => {
                return Err(format!(
                    "不支持的校验方式「{other}」，可选 none/sum8/sum8_comp/xor8/xor_ascii_hex"
                ));
            }
        };
        if want == got {
            Ok(())
        } else {
            Err(format!("校验和不对：帧尾 0x{got:02X}，按 {kind} 应为 0x{want:02X}"))
        }
    }
}

// ====================================================================== 台账读取

/// 按编码读一行 `device_config`。**只读**，不写台账也不写业务表。
pub fn load_device(conn: &Connection, code: &str) -> Result<Option<DeviceRow>, String> {
    conn.query_row(
        "SELECT id, code, name, kind, driver, config_json, is_mock, is_enabled
         FROM device_config WHERE code = ?1",
        params![code],
        |r| {
            Ok(DeviceRow {
                id: r.get::<_, i64>(0)?,
                code: r.get::<_, String>(1)?,
                name: r.get::<_, String>(2)?,
                kind: r.get::<_, String>(3)?,
                driver: r.get::<_, String>(4)?,
                config_json: r.get::<_, String>(5)?,
                is_mock: r.get::<_, i64>(6)? != 0,
                is_enabled: r.get::<_, i64>(7)? != 0,
            })
        },
    )
    .optional()
    .map_err(|e| format!("读设备台账失败：{e}"))
}

// ====================================================================== 型号预设

/// 耀华 XK3190-A9 **连续发送**这一档的完整帧模板（04 §2.2 A 族、§2.3 通用模板的一个预设）。
///
/// 真机实测（2026-09-12，现场 62 kg）一帧：
/// `02 2B 30 30 30 30 36 32 30 31 46 03`
/// = `STX` `+` `000062` `0` `1F` `ETX`，即：
///  - 起始符 `STX(0x02)`、终止符 `ETX(0x03)`（**不是** `=` … `\r\n`）；
///  - 符号位在下标 1、6 位重量数字在下标 2..7、下标 8 是**小数位数标志位**（`0` = 整数 kg）；
///  - 下标 9..10 是**两字符 ASCII 十六进制异或校验**（`+`~小数位这 8 字节异或 = 0x1F → `"1F"`）。
///
/// 这是"通用帧模板 + 型号预设"里的**预设**：现场只填 `port`/`baud` 就能跑；要微调仍可在
/// `config_json` 写完整的嵌套模板（那时 [`maybe_apply_driver_preset`] 不再套本预设）。
pub fn yaohua_xk3190_cont() -> FrameTemplate {
    FrameTemplate {
        transport: Transport {
            kind: "serial".into(),
            port: String::new(),
            baud: 9600,
            data_bits: 8,
            parity: "none".into(),
            stop_bits: 1,
            host: String::new(),
            tcp_port: 0,
        },
        framing: Framing {
            mode: "delimited".into(),
            start: "\u{02}".into(),
            terminator: "\u{03}".into(),
            encoding: "ascii".into(),
            max_len: 24,
            fixed_len: 0,
            checksum: "xor_ascii_hex".into(),
        },
        payload: Payload {
            sign_index: 1,
            digits: "0123456".into(),
            decimal_places: 1,
            decimal_count_index: Some(8),
            skip_chars: String::new(),
            unit: "kg".into(),
            status_bytes: Vec::new(),
            status_stable_byte: None,
            status_stable_mask: None,
        },
        stability: Stability::default(),
        align: Align {
            division_01kg: 100,
            mode: "nearest_div".into(),
        },
        query: Query::default(),
    }
}

/// 驱动 → 预设模板。认不出的驱动回 `None`（那就完全按 `config_json` 里的嵌套模板走）。
pub fn driver_preset(driver: &str) -> Option<FrameTemplate> {
    match driver.trim().to_ascii_lowercase().as_str() {
        "yaohua_xk3190" | "yaohua_xk3190_cont" | "xk3190" => Some(yaohua_xk3190_cont()),
        _ => None,
    }
}

/// 台账存的是**扁平表单**（`{port, baud, frameFamily}` 这类）还是**完整嵌套模板**？
/// 只有前者才套驱动预设；后者是运维手调或帧监视器校准过的，必须原样生效，不能被预设悄悄改掉。
fn maybe_apply_driver_preset(
    row: &DeviceRow,
    parsed: FrameTemplate,
) -> Result<FrameTemplate, String> {
    let obj: serde_json::Value = serde_json::from_str(&row.config_json).unwrap_or(serde_json::Value::Null);
    let has_template_section = ["transport", "framing", "payload", "stability", "align", "query"]
        .iter()
        .any(|k| obj.get(*k).is_some());
    if has_template_section {
        return Ok(parsed);
    }
    let Some(mut preset) = driver_preset(&row.driver) else {
        return Ok(parsed);
    };
    // 把扁平表单里的串口参数覆盖到预设上（现场只改这两个字段就能对上真机）
    if let Some(map) = obj.as_object() {
        if let Some(p) = map.get("port").and_then(|v| v.as_str()) {
            preset.transport.port = p.to_string();
        }
        if let Some(b) = map.get("baud").and_then(json_u32) {
            preset.transport.baud = b;
        }
        if let Some(d) = map.get("data_bits").and_then(json_u8) {
            preset.transport.data_bits = d;
        }
        if let Some(p) = map.get("parity").and_then(|v| v.as_str()) {
            preset.transport.parity = p.to_string();
        }
        if let Some(s) = map.get("stop_bits").and_then(json_u8) {
            preset.transport.stop_bits = s;
        }
    }
    Ok(preset)
}

/// 前端表单常把数字存成字符串（`"9600"`），台账里也可能是数字（`9600`）——两种都吃。
fn json_u32(v: &serde_json::Value) -> Option<u32> {
    match v {
        serde_json::Value::Number(n) => n.as_u64().map(|x| x as u32),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn json_u8(v: &serde_json::Value) -> Option<u8> {
    json_u32(v).and_then(|x| u8::try_from(x).ok())
}

/// 一行台账 → 可跑的模板。Mock / 停用 / 没配串口都在这里挡掉，
/// 回的必须是现场能照着做的中文短句。
pub fn resolve_template(row: &DeviceRow) -> Result<FrameTemplate, String> {
    if row.driver == "mock" || row.is_mock {
        return Err(format!("这台磅「{}」在台账里是 Mock，不会去开串口", row.name));
    }
    if !row.is_enabled {
        return Err(format!("这台磅「{}」在台账里已停用，先在设备中心把它启用", row.name));
    }
    let mut tpl = maybe_apply_driver_preset(row, parse_template(&row.config_json)?)?;
    let kind = tpl.transport.kind.trim();
    if !kind.is_empty() && !kind.eq_ignore_ascii_case("serial") {
        // D 族（TCP 透传）没接：在配置阶段就说清，别等读线程起来才发现
        return Err(format!(
            "这台磅「{}」配的是传输方式「{kind}」，本轮只接了串口 serial；TCP 透传是 04 §2.2 的 D 族，要另开一路",
            row.name
        ));
    }
    if tpl.transport.port.trim().is_empty() {
        return Err(format!(
            "这台磅「{}」的帧模板没写串口名，请在设备中心填 transport.port（如 COM3）",
            row.name
        ));
    }
    tpl.transport.port = tpl.transport.port.trim().to_string();
    if tpl.query.enabled {
        // 开了轮询却写不出指令，read_loop 会一声不响地一个字节都不发（C 族表现为"永久离线"），
        // 所以在这里就拒掉。
        let cmd = parse_hex(&tpl.query.command_hex)
            .map_err(|e| format!("这台磅「{}」开了轮询，但 query.command_hex 有问题：{e}", row.name))?;
        if cmd.is_empty() {
            return Err(format!(
                "这台磅「{}」开了轮询（query.enabled=true）却没写指令，请在设备中心填 query.command_hex（如 \"02 3F 57 45 03\"）",
                row.name
            ));
        }
        tpl.query.command_hex = tpl.query.command_hex.trim().to_string();
    }
    // 配置数值边界（P0）：这些值直通读线程的分配与解析。离谱值在 release(panic=abort) 下
    // 会让整机消失（with_capacity 巨量分配 / 无界缓冲 / 10^eff 溢出），必须在开串口前拒掉。
    if tpl.stability.window_frames > 1000 {
        return Err(format!(
            "这台磅「{}」的 stability.window_frames={} 过大（合理区间 0..=1000）",
            row.name, tpl.stability.window_frames
        ));
    }
    if tpl.payload.decimal_places > 6 {
        return Err(format!(
            "这台磅「{}」的 payload.decimal_places={} 过大（重量小数位最多 6）",
            row.name, tpl.payload.decimal_places
        ));
    }
    if tpl.framing.max_len > 1024 {
        return Err(format!(
            "这台磅「{}」的 framing.max_len={} 过大（单帧上限 0..=1024 字节，0 表示用默认 256）",
            row.name, tpl.framing.max_len
        ));
    }
    if tpl.align.division_01kg > 1_000_000 {
        return Err(format!(
            "这台磅「{}」的 align.division_01kg={} 不合理（分度以 0..=1000000 个 0.1kg 为限）",
            row.name, tpl.align.division_01kg
        ));
    }
    let digit_width = tpl.payload.digits.chars().filter(|c| c.is_ascii_digit()).count();
    if digit_width > 12 {
        return Err(format!(
            "这台磅「{}」的 payload.digits 声明了 {} 位数字区，超过 12 位（数值解析会溢出），请核对帧模板",
            row.name, digit_width
        ));
    }
    Ok(tpl)
}

/// 读台账一行并给出模板。编码不存在 / 不是磅都回中文短句。
pub fn load_config(conn: &Connection, code: &str) -> Result<Option<(DeviceRow, FrameTemplate)>, String> {
    let row = match load_device(conn, code)? {
        Some(r) => r,
        None => {
            return Err(format!(
                "台账里没有编码为「{code}」的设备；到设备中心看这台磅的编码（如 scale1）再试"
            ))
        }
    };
    if row.kind != "scale" {
        return Err(format!("「{}」不是地磅（台账 kind={}），这条通道只接汽车衡", row.name, row.kind));
    }
    let tpl = resolve_template(&row)?;
    Ok(Some((row, tpl)))
}

// ====================================================================== 托管状态

/// Tauri 托管状态：`app.manage(scale::ScaleHub::default());`
/// 应用退出前调 [`ScaleHub::shutdown`] 收线程（见 `lib.rs` 的 `RunEvent::Exit` 分支）。
#[derive(Clone, Default)]
pub struct ScaleHub {
    inner: Arc<Mutex<HubState>>,
}

#[derive(Default)]
struct HubState {
    worker: Option<Worker>,
    live: Arc<Mutex<LiveStatus>>,
    generation: u64,
}

struct Worker {
    stop: Arc<AtomicBool>,
    joiner: Option<JoinHandle<()>>,
}

/// 读线程回写的实时状态（`scale_status` 的数据源，也是底栏状态灯/帧监视器的数据源）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStatus {
    pub running: bool,
    pub code: String,
    pub device_id: i64,
    pub port: String,
    pub connected: bool,
    pub generation: u64,
    pub started_at: String,
    pub frame_count: u64,
    pub err_count: u64,
    pub err_streak: u64,
    pub bytes_in: u64,
    pub dropped_frames: u64,
    pub last_frame_at: Option<String>,
    pub last: Option<ScaleEvent>,
    pub error: Option<String>,
}

/// 命令层交给前端的形状。
pub type ScaleStatus = LiveStatus;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn update_live(store: &Arc<Mutex<LiveStatus>>, f: impl FnOnce(&mut LiveStatus)) {
    let mut g = lock(store);
    f(&mut g);
}

impl ScaleHub {
    fn live_store(&self) -> Arc<Mutex<LiveStatus>> {
        lock(&self.inner).live.clone()
    }

    /// 当前状态快照（不碰串口、不碰库，纯内存）。
    pub fn snapshot(&self) -> ScaleStatus {
        let store = self.live_store();
        let mut s = lock(&store).clone();
        // worker 还在不在才是"是否在流"的唯一真相：读线程自己退出（设备掉了）时
        // 状态位可能还是 true
        s.running = lock(&self.inner).worker.is_some();
        s
    }

    /// 停掉当前读线程并等它退出：端口句柄必须随线程一起归还，否则第二次
    /// `scale_start` 打不开同一个 COM 口。
    fn stop_locked(&self, inner: &mut HubState) {
        let Some(mut w) = inner.worker.take() else {
            return;
        };
        w.stop.store(true, Ordering::SeqCst);
        let joiner = w.joiner.take();
        let store = inner.live.clone();
        // 读线程只锁 live、不锁 inner，所以这里可以持着 inner 直接 join
        if let Some(j) = joiner {
            let _ = j.join();
        }
        update_live(&store, |s| {
            s.running = false;
            s.connected = false;
        });
    }

    /// 应用退出时调用。
    pub fn shutdown(&self) {
        let mut guard = lock(&self.inner);
        self.stop_locked(&mut guard);
    }

    fn start(&self, app: &AppHandle, tpl: FrameTemplate, code: String, device_id: i64) -> Result<ScaleStatus, String> {
        let mut guard = lock(&self.inner);
        self.stop_locked(&mut guard);
        guard.generation = guard.generation.saturating_add(1);
        let generation = guard.generation;
        let store = guard.live.clone();
        let started_at = crate::db::migrate::now_iso();
        update_live(&store, |s| {
            *s = LiveStatus {
                running: true,
                code: code.clone(),
                device_id,
                port: tpl.transport.port.clone(),
                generation,
                started_at: started_at.clone(),
                ..LiveStatus::default()
            };
        });
        let stop = Arc::new(AtomicBool::new(false));
        let thread_store = store.clone();
        let thread_stop = stop.clone();
        let app_clone = app.clone();
        let tpl_for_thread = tpl.clone();
        let code_for_thread = code.clone();
        let joiner = std::thread::Builder::new()
            .name(format!("scale-read-{code_for_thread}"))
            .spawn(move || read_loop(app_clone, tpl_for_thread, code_for_thread, device_id, thread_store, thread_stop))
            .map_err(|_| "起不了读数线程（系统线程资源不足，重启程序再试）".to_string())?;
        guard.worker = Some(Worker {
            stop,
            joiner: Some(joiner),
        });
        drop(guard);
        let mut snap = lock(&store).clone();
        snap.running = true;
        Ok(snap)
    }
}

// ====================================================================== 读线程

/// 独占串口直到被要求停止或设备掉了。**跑在 std::thread 上**（§2.4 点 1）。
fn read_loop(
    app: AppHandle,
    tpl: FrameTemplate,
    code: String,
    device_id: i64,
    store: Arc<Mutex<LiveStatus>>,
    stop: Arc<AtomicBool>,
) {
    let mut core = StreamCore::new(tpl.clone(), &code, device_id);
    let t0 = Instant::now();
    let mut port = match open_port(&tpl.transport) {
        Ok(p) => p,
        Err(msg) => {
            // 打不开端口不 panic：把结论写进状态并推一次事件，让底栏灯与横幅同步
            core.err_count += 1;
            core.last_error = Some(("Offline".into(), msg));
            let ev = core.event(0);
            sync_live(&store, &core, &ev, false);
            let _ = app.emit(SCALE_EVENT, &ev);
            let mut guard = lock(&store);
            guard.running = false;
            drop(guard);
            return;
        }
    };
    let mut buf = [0u8; READ_CHUNK];
    let mut last_rx = Instant::now();
    let mut io_errors: u64 = 0;
    let mut broken: Option<String> = None;
    while !stop.load(Ordering::SeqCst) {
        let now_ms = elapsed_ms(t0);
        match port.read(&mut buf) {
            Ok(n) if n > 0 => {
                last_rx = Instant::now();
                io_errors = 0;
                // 这里**不能**提前 continue：事件被节流挡掉时，C 族查询与饥饿看门狗
                // 仍要照常跑（否则询问应答式仪表一次都问不到）。
                for ev in core.feed(&buf[..n], now_ms) {
                    sync_live(&store, &core, &ev, ev.connected);
                    let _ = app.emit(SCALE_EVENT, &ev);
                }
            }
            // 超时/没数据：正常空转，回头看停止位
            Ok(_) => {}
            Err(ref e) if matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) => {}
            Err(e) => {
                io_errors += 1;
                core.err_count += 1;
                core.err_streak += 1;
                core.last_error = Some(("Offline".into(), format!("串口 {} 读不动了：{}", core.port.clone(), describe_io(e.to_string().as_str()))));
                if io_errors >= IO_ERROR_LIMIT {
                    broken = core.last_error.as_ref().map(|(_, m)| m.clone());
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        // C 族：按 interval_ms 节流主动问一次（A 族连续发送时 query_due 恒 None）
        if let Some(cmd) = core.query_due(elapsed_ms(t0)) {
            if port.write_all(&cmd).is_err() {
                core.err_count += 1;
                core.last_error = Some(("Timeout".into(), format!("发不出查询指令：串口 {} 写不动", core.port.clone())));
            }
            let _ = port.flush();
        }
        // §2.4 点 4：无帧 5 秒 → 推一次离线（watchdog 自己保证只推一次）
        if last_rx.elapsed() >= Duration::from_millis(STARVE_MS) {
            let now_ms = elapsed_ms(t0);
            if let Some(ev) = core.watchdog(now_ms) {
                sync_live(&store, &core, &ev, false);
                let _ = app.emit(SCALE_EVENT, &ev);
            }
        }
    }
    if let Some(msg) = broken {
        let mut ev = core.event(elapsed_ms(t0));
        ev.error = Some(msg);
        ev.error_kind = Some("Offline".into());
        sync_live(&store, &core, &ev, false);
        let _ = app.emit(SCALE_EVENT, &ev);
    }
    // 句柄随线程退出归还：这是"第二次 scale_start 能干净打开同一个 COM 口"的前提
    drop(port);
    let mut guard = lock(&store);
    guard.running = false;
    guard.connected = false;
}

fn elapsed_ms(t0: Instant) -> u64 {
    t0.elapsed().as_millis() as u64
}

fn sync_live(store: &Arc<Mutex<LiveStatus>>, core: &StreamCore, ev: &ScaleEvent, connected: bool) {
    update_live(store, |s| {
        s.connected = connected;
        s.frame_count = core.frame_count;
        s.err_count = core.err_count;
        s.err_streak = core.err_streak;
        s.bytes_in = core.bytes_in;
        s.dropped_frames = core.dropped_frames;
        s.last_frame_at = if ev.raw_frame.is_empty() { s.last_frame_at.clone() } else { Some(ev.at.clone()) };
        s.error = ev.error.clone();
        s.last = Some(ev.clone());
    });
}

// ====================================================================== 串口

/// 打开串口。**公开**是给契约测试与设备中心自检（04 §6）用的：没有真机时也要能验
/// "打不开端口回的是中文短句、不是 panic"。
pub fn open_port(t: &Transport) -> Result<Box<dyn serialport::SerialPort>, String> {
    let kind = t.kind.trim();
    if !kind.is_empty() && !kind.eq_ignore_ascii_case("serial") {
        return Err(format!(
            "传输方式「{kind}」本轮没接：现在只支持串口 serial（TCP 透传是 04 §2.2 的 D 族，要另开一路）"
        ));
    }
    let port = t.port.trim();
    if port.is_empty() {
        return Err("帧模板没写串口名：transport.port 是空的".into());
    }
    let data_bits = match t.data_bits {
        5 => serialport::DataBits::Five,
        6 => serialport::DataBits::Six,
        7 => serialport::DataBits::Seven,
        _ => serialport::DataBits::Eight,
    };
    let parity = match t.parity.trim().to_ascii_lowercase().as_str() {
        "even" | "e" => serialport::Parity::Even,
        "odd" | "o" => serialport::Parity::Odd,
        _ => serialport::Parity::None,
    };
    let stop_bits = match t.stop_bits {
        2 => serialport::StopBits::Two,
        _ => serialport::StopBits::One,
    };
    match serialport::new(port, t.baud.max(1200))
        .timeout(READ_TIMEOUT)
        .data_bits(data_bits)
        .parity(parity)
        .stop_bits(stop_bits)
        .open()
    {
        Ok(p) => Ok(p),
        Err(e) => Err(format!("串口 {port} 打不开：{}", describe_io(e.to_string().as_str()))),
    }
}

/// OS 的原文太长太英文，这里按关键字归成人话；认不出来的也不整段吐 Debug 串。
fn describe_io(raw: &str) -> String {
    let low = raw.to_ascii_lowercase();
    if low.contains("access is denied") || low.contains("permission") || low.contains("busy") || low.contains("denied") {
        return "端口已被占用（关掉另一个串口工具）或没有访问权限".into();
    }
    if low.contains("file not found") || low.contains("cannot find the file") || low.contains("invalid handle") || low.contains("not found") {
        return "端口不存在或已被占用（确认 COM 号；USB 转串口还要看驱动装没装）".into();
    }
    if raw.chars().any(|c| !c.is_ascii()) {
        // 系统已经给了中文提示就直接用，别翻译成更差的话
        return raw.to_string();
    }
    "端口不存在或已被占用（确认 COM 号与波特率）".into()
}

// ====================================================================== 命令层

fn hub_of(app: &AppHandle) -> Result<ScaleHub, String> {
    app.try_state::<ScaleHub>()
        .map(|h| (*h).clone())
        .ok_or_else(|| "地磅通道未托管：lib.rs 里缺 app.manage(scale::ScaleHub::default())".to_string())
}

/// 当前读数流的快照；**通道没托管时回 `None` 而不是报错**。
///
/// 给设备中心的联机自检（`crate::devices::probe_plan` 的 Scale 分支）用：正在收数这件事本身
/// 就是这台磅在线的凭据，没必要为了"测一下"再去抢一次串口。
pub fn live_snapshot(app: &AppHandle) -> Option<ScaleStatus> {
    hub_of(app).ok().map(|h| h.snapshot())
}

/// [`probe_once`] 的结论。字段都是"给现场看的一句话"要用的，不做界面绑定。
#[derive(Debug, Clone, Default)]
pub struct ProbeOutcome {
    /// 试读期间解析成功的帧数（**0 = 一帧都没读到**）
    pub good_frames: u64,
    /// 最后一帧的读数（0.1 kg）
    pub weight_01kg: Option<i64>,
    /// 首帧解析成功的时刻（自开端口起算，ms）——就是现场要的"响应时间"
    pub first_good_ms: Option<u64>,
    /// 解析失败次数（校验不过 / 取不到数）
    pub bad_frames: u64,
    /// 打不开端口等原因（中文短句）；与"打得开但读不到数"分开，两者的处置动作不一样
    pub error: Option<String>,
}

/// 一次性开端口试读：`budget` 内凑够 `want_good` 帧就收工，**退出前把端口句柄还掉**。
///
/// 为什么设备中心需要它：读数流是工作台挂载时才开的，而站长常常是**先开设备中心验货**
/// （新装磅、换 COM 口、仪表刚上电）。那时 `live_snapshot` 是"没在流"，若据此回"探不到"，
/// 现场拿到的是一个既不能证明通、也不能证明不通的空结论——和 mock 时代的假失败没有区别。
/// 所以没在流时就直接开一次端口读几帧：这是本机真通道，代价只是最多 `budget` 的阻塞。
///
/// 与读线程共用同一套 [`StreamCore`]（切帧、校验、取数一条逻辑），自检通过即等价于读数流能跑。
pub fn probe_once(tpl: &FrameTemplate, budget: Duration, want_good: u64) -> ProbeOutcome {
    let mut out = ProbeOutcome::default();
    let mut core = StreamCore::new(tpl.clone(), "probe", 0);
    let mut port = match open_port(&tpl.transport) {
        Ok(p) => p,
        Err(msg) => {
            out.error = Some(msg);
            return out;
        }
    };
    let t0 = Instant::now();
    let mut buf = [0u8; READ_CHUNK];
    while t0.elapsed() < budget {
        match port.read(&mut buf) {
            Ok(n) if n > 0 => {
                let now = elapsed_ms(t0);
                let before_err = core.err_count;
                for ev in core.feed(&buf[..n], now) {
                    if ev.error.is_some() {
                        continue;
                    }
                    out.good_frames += 1;
                    out.weight_01kg = Some(ev.weight_01kg);
                    if out.first_good_ms.is_none() {
                        out.first_good_ms = Some(now);
                    }
                }
                out.bad_frames += core.err_count.saturating_sub(before_err);
                if out.good_frames >= want_good.max(1) {
                    break;
                }
            }
            Ok(_) => {}
            // 超时/没数据是正常空转：预算时间就是靠它走完的
            Err(ref e) if matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) => {}
            Err(e) => {
                out.error = Some(format!("串口 {} 读不动了：{}", tpl.transport.port, describe_io(e.to_string().as_str())));
                break;
            }
        }
    }
    // 句柄必须在这里归还：自检开过端口之后，工作台的读数流才还能打开同一个 COM 口
    drop(port);
    out
}

/// 开始读这台磅。`code` = `device_config.code`（如 `scale1`）。
#[tauri::command]
pub async fn scale_start(app: AppHandle, code: String) -> Result<ScaleStatus, String> {
    let code = code.trim().to_string();
    if code.is_empty() {
        return Err("没有指定磅的编码：scale_start 要的是设备台账里的 code（如 scale1）".into());
    }
    let pool = app
        .try_state::<crate::db::Db>()
        .map(|d| d.shared())
        .ok_or_else(|| "数据库尚未就绪（启动迁移未完成）".to_string())?;
    let hub = hub_of(&app)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 先读台账：Mock / 停用 / 模板不合一开口就回中文，绝不先去碰串口
        let (row, tpl) = {
            let conn = lock(&pool);
            match load_config(&conn, &code)? {
                Some(pair) => pair,
                None => return Err(format!("台账里没有编码为「{code}」的设备")),
            }
        };
        hub.start(&app2, tpl, row.code.clone(), row.id)
    })
    .await
    .map_err(|e| format!("启动地磅读数任务失败：{e}"))?
}

/// 停止读数并释放串口。没在跑时回当前状态即可（幂等：关页面、切 Mock 都可能重复调）。
#[tauri::command]
pub async fn scale_stop(app: AppHandle) -> Result<ScaleStatus, String> {
    let hub = hub_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = lock(&hub.inner);
        hub.stop_locked(&mut guard);
        drop(guard);
        Ok(hub.snapshot())
    })
    .await
    .map_err(|e| format!("停止地磅读数任务失败：{e}"))?
}

/// 当前是否在流 + 最后一次解析结果 + 帧/错误计数（设备中心帧监视器与底栏状态灯用）。
#[tauri::command]
pub async fn scale_status(app: AppHandle) -> Result<ScaleStatus, String> {
    let hub = hub_of(&app)?;
    Ok(hub.snapshot())
}
