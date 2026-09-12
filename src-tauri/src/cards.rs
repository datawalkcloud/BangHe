//! 流转卡池与一卡一单命令（docs/design/06 篇；§9.26 `card` 表）
//!
//! 卡只认单不认人：`card_no` 是寻卡返回的 UID（大写十六进制归一），占用真相只在
//! `card` 表一行内，`weigh_order.card_no` 只是单据侧的展示快照。本模块提供
//! 06 §6.2 的六个命令，全部走 [`crate::orders::write_tx`] 的会话岗位闸门 + [`crate::orders::audit`]。
//!
//! 有意与 mock 对齐（`src/mock/api.ts` 的 `cardXxx` 同名方法）：错误一律回能给磅员看的
//! 中文短句，前端 `onError` 原样透传；DTO 字段与 `src/mock/types.ts` 逐字一致（沿用本仓
//! 既定 snake_case 直传约定，不做 camelCase 重命名）。
//!
//! 本模块不新增任何读卡原语，也不改称重/结算命令——"刷卡推进哪一步"的判断整段在前端
//! 编排器里，它只是把现成命令按单据状态依次调起来（06 §6.3）。
//!
//! 两个例外不是命令而是被 [`crate::orders::create_order`] 在**同一事务**里调的函数：
//! [`check_card_for_create`]（取号前判这张卡能不能占）与 [`bind_on_create`]（占卡 + 写单据
//! 快照 + 审计），落的是 06 §4.0 的"制单必须绑卡"。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::auth::AuthProfile;
use crate::db::migrate::now_iso;
use crate::orders::{audit, read_only, write_tx};

/// 发卡 / 回收 / 推进写入口位（05 §6.1）：磅房现场三岗 + 值仓，站长兜底。
const CARD_WRITE_ROLES: &[&str] = &["station_master", "registrar", "weigher", "keeper"];

/// 未到终态、可被发卡或刷卡推进的磅单状态（与 orders.rs 的 OPEN_WHERE 同集合）。
const OPEN_STATUS: &[&str] = &[
    "draft",
    "registered",
    "qc_done",
    "gross_weighed",
    "tare_weighed",
    "reweigh",
    "to_settle",
];

/// 卡号归一：去空白与分隔符、转大写十六进制。登记与识别两侧共用，否则大小写不一致
/// 会造成"明明在册却说未登记"。只保留字母数字（Mifare UID 是十六进制串）。
pub fn normalize_card_no(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_uppercase()
}

/// 卡池列表 / 单据侧展示共用的一行卡信息（snake_case 直传给前端 `CardPoolRow`）。
#[derive(Debug, Serialize)]
pub struct CardPoolRow {
    pub card_no: String,
    pub label: Option<String>,
    pub status: String,
    /// 该卡当前挂着的在途单号（in_use 时非空），供列表与"此卡已挂在 BD…"文案
    pub order_no: Option<String>,
    pub issued_at: Option<String>,
    pub issued_by_name: Option<String>,
    pub remark: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct IssueResult {
    pub card: CardPoolRow,
    pub order_no: String,
}

/// 只读定位结果：前端编排器据此决定这一刷干什么（发卡 / 推进 / 拦下）。
#[derive(Debug, Serialize)]
pub struct LocateResult {
    pub found: bool,
    /// 卡的占用态：in_pool / in_use / retired；found=false 时给 "unknown"
    pub status: String,
    pub order_no: Option<String>,
    pub party_name: Option<String>,
    /// 命中在途单时回它当前状态，编排器据此判缺毛重 / 缺皮重 / 待结算
    pub order_status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RegisterInput {
    pub card_no: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub remark: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub operator_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct IssueInput {
    /// 省略 = 服务端取"最近制单且尚无卡"的在途单（06 §4.1 闸门 1，同事务内判定避免并发抢发）
    #[serde(default)]
    pub order_no: Option<String>,
    /// 卡号必须由前端读卡结果传入，服务端不猜（06 §6.2）
    pub card_no: String,
}

#[derive(Debug, Deserialize)]
pub struct ReleaseInput {
    #[serde(default)]
    pub card_no: Option<String>,
    #[serde(default)]
    pub order_no: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RetireInput {
    pub card_no: String,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct PoolListInput {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub keyword: Option<String>,
}

const CARD_SELECT: &str = "SELECT c.card_no, c.label, c.status, o.order_no, c.issued_at, \
     (SELECT display_name FROM user_account u WHERE u.id = c.issued_by), c.remark \
     FROM card c LEFT JOIN weigh_order o ON o.id = c.current_order_id";

fn map_card_row(r: &rusqlite::Row) -> rusqlite::Result<CardPoolRow> {
    Ok(CardPoolRow {
        card_no: r.get(0)?,
        label: r.get(1)?,
        status: r.get(2)?,
        order_no: r.get(3)?,
        issued_at: r.get(4)?,
        issued_by_name: r.get(5)?,
        remark: r.get(6)?,
    })
}

// ------------------------------------------------------------------ 卡池登记 / 列表

pub fn pool_register(conn: &Connection, actor: &AuthProfile, input: RegisterInput) -> Result<CardPoolRow, String> {
    let card_no = normalize_card_no(&input.card_no);
    if card_no.is_empty() {
        return Err("卡号为空：请先把卡放到读卡器上，或手输贴签编号".into());
    }
    let exists: bool = conn
        .query_row("SELECT 1 FROM card WHERE card_no = ?1", params![card_no], |_| Ok(true))
        .unwrap_or(false);
    let now = now_iso();
    let label = input.label.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let remark = input.remark.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if exists {
        // 已在册：只允许补写贴签/备注，不重置占用态（重复登记不该把挂单中的卡打回空闲）
        conn.execute(
            "UPDATE card SET label = COALESCE(?2, label), remark = COALESCE(?3, remark), updated_at = ?4, updated_by = ?5 \
             WHERE card_no = ?1",
            params![card_no, label, remark, now, actor.id],
        )
        .map_err(|e| format!("更新卡信息失败：{e}"))?;
        audit(conn, actor, "card.register", "card", &card_no, Some("已在册，补写贴签/备注"), None);
    } else {
        conn.execute(
            "INSERT INTO card (card_no, label, status, remark, created_at, created_by) VALUES (?1, ?2, 'in_pool', ?3, ?4, ?5)",
            params![card_no, label, remark, now, actor.id],
        )
        .map_err(|e| format!("登记入库失败：{e}"))?;
        audit(conn, actor, "card.register", "card", &card_no, Some("卡池登记入库"), None);
    }
    load_card(conn, &card_no)?.ok_or_else(|| "登记后读取卡信息失败".to_string())
}

pub fn pool_list(conn: &Connection, input: &PoolListInput) -> Result<Vec<CardPoolRow>, String> {
    let status = input.status.clone().filter(|s| s != "all" && !s.is_empty());
    let kw = input.keyword.clone().unwrap_or_default().trim().to_lowercase();
    let mut sql = format!("{CARD_SELECT} WHERE 1 = 1");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let mut n = 0usize;
    if let Some(s) = &status {
        n += 1;
        sql.push_str(&format!(" AND c.status = ?{n}"));
        args.push(Box::new(s.clone()));
    }
    if !kw.is_empty() {
        n += 1;
        sql.push_str(&format!(" AND (lower(c.card_no) LIKE ?{n} OR lower(COALESCE(c.label, '')) LIKE ?{n} OR lower(COALESCE(o.order_no, '')) LIKE ?{n})"));
        args.push(Box::new(format!("%{}%", kw.replace('%', ""))));
    }
    sql.push_str(" ORDER BY c.status, c.card_no");
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("读取卡池失败：{e}"))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args.iter().map(|b| b.as_ref())), map_card_row)
        .map_err(|e| format!("读取卡池失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取卡池失败：{e}"))?;
    Ok(rows)
}

pub fn pool_retire(conn: &Connection, actor: &AuthProfile, input: RetireInput) -> Result<CardPoolRow, String> {
    let card_no = normalize_card_no(&input.card_no);
    let reason = input.reason.trim().to_string();
    if reason.chars().count() < 4 {
        return Err("注销原因不得少于 4 个字（丢了/磨损要写清，留痕可查）".into());
    }
    let (status, in_use): (String, Option<i64>) = conn
        .query_row(
            "SELECT status, current_order_id FROM card WHERE card_no = ?1",
            params![card_no],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("读取卡失败：{e}"))?
        .ok_or_else(|| "该卡未在卡池登记，无需注销".to_string())?;
    if status == "retired" {
        return Err("该卡已注销".into());
    }
    if in_use.is_some() {
        return Err("该卡仍挂在一张在途单上，请先退卡或走补发换卡再注销".into());
    }
    let now = now_iso();
    conn.execute(
        "UPDATE card SET status = 'retired', retired_at = ?2, retire_reason = ?3, updated_at = ?2, updated_by = ?4 WHERE card_no = ?1",
        params![card_no, now, reason, actor.id],
    )
    .map_err(|e| format!("注销失败：{e}"))?;
    audit(conn, actor, "card.retire", "card", &card_no, Some(&reason), None);
    load_card(conn, &card_no)?.ok_or_else(|| "注销后读取卡信息失败".to_string())
}

fn load_card(conn: &Connection, card_no: &str) -> Result<Option<CardPoolRow>, String> {
    conn.query_row(&format!("{CARD_SELECT} WHERE c.card_no = ?1"), params![card_no], map_card_row)
        .optional()
        .map_err(|e| format!("读取卡信息失败：{e}"))
}

// --------------------------------------------------------------------- 发卡 / 定位 / 回收

/// 发卡（in_pool → in_use）。按 06 §4.1 五道闸门顺序过，第一道不过就停并说清是哪道。
pub fn issue(conn: &Connection, actor: &AuthProfile, input: IssueInput) -> Result<IssueResult, String> {
    let card_no = normalize_card_no(&input.card_no);
    if card_no.is_empty() {
        return Err("没读到卡号：请把卡贴紧读卡器，或检查读卡器是否在线".into());
    }
    // 闸门 1：目标单——显式给了就验它，没给就取最近制单且尚无卡的在途单
    let order: Option<(i64, String, String, Option<String>)> = match input.order_no.as_deref() {
        Some(no) => conn
            .query_row(
                "SELECT id, order_no, status, card_no FROM weigh_order WHERE order_no = ?1",
                params![no.trim()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|e| format!("读取磅单失败：{e}"))?,
        None => conn
            .query_row(
                &format!(
                    "SELECT id, order_no, status, card_no FROM weigh_order WHERE card_no IS NULL AND status IN ({}) \
                     ORDER BY registered_at DESC LIMIT 1",
                    OPEN_STATUS.iter().map(|_| "?").collect::<Vec<_>>().join(",")
                ),
                rusqlite::params_from_iter(OPEN_STATUS.iter().map(|s| *s)),
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|e| format!("读取在途单失败：{e}"))?,
    };
    let (order_id, order_no, order_status, existing_card) =
        order.ok_or_else(|| "没有等待发卡的在途单：请先点「制单」建单".to_string())?;
    // 闸门 5：终态不接受发卡
    if !OPEN_STATUS.contains(&order_status.as_str()) {
        return Err(format!("本单当前为「{order_status}」，已完成的单据请直接去退卡，不再发卡"));
    }
    // 闸门 4：该单未绑卡（已绑→走补发换卡，不报错覆盖）
    if existing_card.is_some() {
        return Err(format!("单 {order_no} 已绑定流转卡，如需换卡请走「补发换卡」"));
    }
    // 闸门 3：卡在册且空闲
    let (card_status, card_order_id): (String, Option<i64>) = conn
        .query_row(
            "SELECT status, current_order_id FROM card WHERE card_no = ?1",
            params![card_no],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("读取卡失败：{e}"))?
        .ok_or_else(|| format!("卡 {card_no} 未登记，请到「流转卡」页登记后再发"))?;
    if card_status == "retired" {
        return Err(format!("卡 {card_no} 已注销，不能再发放"));
    }
    if card_status == "in_use" {
        let held = card_order_id
            .and_then(|id| {
                conn.query_row("SELECT order_no FROM weigh_order WHERE id = ?1", params![id], |r| r.get::<_, String>(0))
                    .ok()
            })
            .unwrap_or_default();
        return Err(format!("卡 {card_no} 已挂在单 {held} 上，请先退卡或直接打开那张单"));
    }
    // 四条写同事务：卡占用、绑单、单据侧快照、发卡时间/操作员
    let now = now_iso();
    conn.execute(
        "UPDATE card SET status = 'in_use', current_order_id = ?2, issued_at = ?3, issued_by = ?4, updated_at = ?3, updated_by = ?4 WHERE card_no = ?1",
        params![card_no, order_id, now, actor.id],
    )
    .map_err(|e| format!("发卡失败：{e}"))?;
    conn.execute(
        "UPDATE weigh_order SET card_no = ?2, updated_at = ?3 WHERE id = ?1",
        params![order_id, card_no, now],
    )
    .map_err(|e| format!("发卡写单失败：{e}"))?;
    audit(conn, actor, "card.issue", "card", &card_no, Some(&format!("发放至 {order_no}")), None);
    let card = load_card(conn, &card_no)?.ok_or_else(|| "发卡后读取卡信息失败".to_string())?;
    Ok(IssueResult { card, order_no })
}

/// 这张卡能不能占来开新单（06 §4.0 三道闸）：在册、未注销、它挂着的磅单不能还没做完。
/// 返回归一卡号与该卡此刻的占用信息，供 [`check_card_for_create`] 与 [`bind_on_create`] 共用。
fn check_usable_for_create(conn: &Connection, card_no_raw: &str) -> Result<(String, String, Option<i64>), String> {
    let card_no = normalize_card_no(card_no_raw);
    if card_no.is_empty() {
        return Err("没读到卡号：请把 IC 卡贴紧读卡器，或检查读卡器是否在线".into());
    }
    let (status, held_order_id): (String, Option<i64>) = conn
        .query_row(
            "SELECT status, current_order_id FROM card WHERE card_no = ?1",
            params![card_no],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("读取流转卡失败：{e}"))?
        .ok_or_else(|| format!("卡 {card_no} 未登记，请到「流转卡」页登记后再制单"))?;
    if status == "retired" {
        return Err(format!("卡 {card_no} 已注销，不能再用它制单"));
    }
    if status == "in_use" {
        let unfinished = match held_order_id {
            Some(id) => conn
                .query_row(
                    "SELECT order_no, status FROM weigh_order WHERE id = ?1",
                    params![id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|e| format!("读取该卡挂着的磅单失败：{e}"))?
                .filter(|(_, st)| OPEN_STATUS.contains(&st.as_str()))
                .map(|(no, _)| no),
            None => None,
        };
        // "这张卡还有没做完的单子"这一条要拦在最前面：一张卡同时只准开一张单
        if let Some(unfinished_no) = unfinished {
            return Err(format!(
                "卡 {card_no} 还挂着没做完的单 {unfinished_no}，一张卡不能同时开两张单：请先给那张单退卡，或换一张空闲卡"
            ));
        }
    }
    Ok((card_no, status, held_order_id))
}

/// 只过闸、不写库。**取号之前**先问一次：闸不过时连磅单流水号都不该消耗掉。
pub fn check_card_for_create(conn: &Connection, card_no_raw: &str) -> Result<String, String> {
    check_usable_for_create(conn, card_no_raw).map(|(card_no, _, _)| card_no)
}

/// 制单那一刻占用这张卡（06 §4.0）：`create_order` 在**同一事务**里调用，与 [`check_card_for_create`]
/// 跑同一份判定，通过才写占用。与 [`issue`] 的差别只在目标单——这张单刚在这笔事务里插进来，
/// 不查"最近无卡单"，所以过闸时机从"事后放卡"提前到了"取号之前"。
///
/// 判定通过却还带着 `current_order_id` 的卡 = 它挂的单已到终态/已删除，只是站点把
/// `card_release_on_terminal` 关了没自动回池；这种卡视同空闲，就地解绑再绑新单，
/// 不必让人先去卡池页点一次退卡。
pub fn bind_on_create(
    conn: &Connection,
    actor: &AuthProfile,
    order_id: i64,
    order_no: &str,
    card_no_raw: &str,
) -> Result<String, String> {
    let (card_no, status, held_order_id) = check_usable_for_create(conn, card_no_raw)?;
    let now = now_iso();
    if status == "in_use" && held_order_id.is_some() {
        conn.execute(
            "UPDATE card SET status = 'in_pool', current_order_id = NULL, updated_at = ?2, updated_by = ?3 WHERE card_no = ?1",
            params![card_no, now, actor.id],
        )
        .map_err(|e| format!("收回旧卡失败：{e}"))?;
    }
    conn.execute(
        "UPDATE card SET status = 'in_use', current_order_id = ?2, issued_at = ?3, issued_by = ?4, updated_at = ?3, updated_by = ?4 WHERE card_no = ?1",
        params![card_no, order_id, now, actor.id],
    )
    .map_err(|e| format!("绑卡失败：{e}"))?;
    conn.execute(
        "UPDATE weigh_order SET card_no = ?2, updated_at = ?3 WHERE id = ?1",
        params![order_id, card_no, now],
    )
    .map_err(|e| format!("绑卡写单失败：{e}"))?;
    audit(conn, actor, "card.issue", "card", &card_no, Some(&format!("随单 {order_no} 制单绑定")), None);
    Ok(card_no)
}

/// 只读定位：前端编排器每读到一张卡先问它，据 status/order_status 决定这一刷干什么。
pub fn locate(conn: &Connection, card_no_raw: &str) -> Result<LocateResult, String> {
    let card_no = normalize_card_no(card_no_raw);
    let row: Option<(String, Option<i64>)> = conn
        .query_row(
            "SELECT status, current_order_id FROM card WHERE card_no = ?1",
            params![card_no],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("读取卡失败：{e}"))?;
    let Some((status, order_id)) = row else {
        return Ok(LocateResult { found: false, status: "unknown".into(), order_no: None, party_name: None, order_status: None });
    };
    let order: Option<(String, String, String)> = match order_id {
        Some(id) => conn
            .query_row(
                "SELECT o.order_no, p.name, o.status FROM weigh_order o JOIN party p ON p.id = o.party_id WHERE o.id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| format!("读取磅单失败：{e}"))?,
        None => None,
    };
    match order {
        Some((no, party, st)) => Ok(LocateResult {
            found: true,
            status,
            order_no: Some(no),
            party_name: Some(party),
            order_status: Some(st),
        }),
        None => Ok(LocateResult { found: true, status, order_no: None, party_name: None, order_status: None }),
    }
}

/// 人工退卡（回收）。不校验卡是不是当前那张单——农户随时可能拿别人的卡来退，退对卡就对了。
pub fn release(conn: &Connection, actor: &AuthProfile, input: ReleaseInput) -> Result<Option<CardPoolRow>, String> {
    let now = now_iso();
    if let Some(cn) = input.card_no.as_deref().map(normalize_card_no).filter(|s| !s.is_empty()) {
        let updated = conn
            .execute(
                "UPDATE card SET status = 'in_pool', current_order_id = NULL, updated_at = ?2, updated_by = ?3 WHERE card_no = ?1 AND status = 'in_use'",
                params![cn, now, actor.id],
            )
            .map_err(|e| format!("退卡失败：{e}"))?;
        if updated == 0 {
            return Err(format!("卡 {cn} 当前未占用，无需退卡"));
        }
        audit(conn, actor, "card.release", "card", &cn, Some("人工退卡回收"), None);
        return load_card(conn, &cn);
    }
    if let Some(no) = input.order_no.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let cn: Option<String> = conn
            .query_row("SELECT card_no FROM weigh_order WHERE order_no = ?1", params![no], |r| r.get(0))
            .optional()
            .map_err(|e| format!("读取磅单失败：{e}"))?
            .flatten();
        let cn = cn.ok_or_else(|| format!("单 {no} 没有绑定流转卡"))?;
        conn.execute(
            "UPDATE card SET status = 'in_pool', current_order_id = NULL, updated_at = ?2, updated_by = ?3 WHERE card_no = ?1",
            params![cn, now, actor.id],
        )
        .map_err(|e| format!("退卡失败：{e}"))?;
        audit(conn, actor, "card.release", "card", &cn, Some(&format!("按单 {no} 退卡")), None);
        return load_card(conn, &cn);
    }
    Err("退卡需给出卡号或单号".into())
}

/// 终态释放：`order_settle` / `order_void` 在**同一事务**里调用（06 §6.3）。
/// 受参数 `card_release_on_terminal` 控制；关掉则留给站点人工退卡。绝不改单据状态，只解绑卡。
pub fn release_for_order(conn: &Connection, order_id: i64) {
    if !crate::orders::setting_bool(conn, "card_release_on_terminal", true) {
        return;
    }
    let _ = conn.execute(
        "UPDATE card SET status = 'in_pool', current_order_id = NULL, updated_at = ?2 WHERE current_order_id = ?1 AND status = 'in_use'",
        params![order_id, now_iso()],
    );
}

// ------------------------------------------------------------------------- 命令层

#[tauri::command]
pub async fn card_pool_list(app: AppHandle, input: PoolListInput) -> Result<Vec<CardPoolRow>, String> {
    read_only(&app, move |conn| pool_list(conn, &input), "卡池读取").await
}

#[tauri::command]
pub async fn card_pool_register(app: AppHandle, input: RegisterInput) -> Result<CardPoolRow, String> {
    write_tx(&app, move |conn, actor| pool_register(conn, actor, input), CARD_WRITE_ROLES, "登记流转卡").await
}

#[tauri::command]
pub async fn card_pool_retire(app: AppHandle, input: RetireInput) -> Result<CardPoolRow, String> {
    write_tx(&app, move |conn, actor| pool_retire(conn, actor, input), &["station_master"], "注销流转卡").await
}

#[tauri::command]
pub async fn card_issue(app: AppHandle, input: IssueInput) -> Result<IssueResult, String> {
    write_tx(&app, move |conn, actor| issue(conn, actor, input), CARD_WRITE_ROLES, "发卡").await
}

#[tauri::command]
pub async fn card_locate(app: AppHandle, card_no: String) -> Result<LocateResult, String> {
    read_only(&app, move |conn| locate(conn, &card_no), "刷卡定位").await
}

#[tauri::command]
pub async fn card_release(app: AppHandle, input: ReleaseInput) -> Result<Option<CardPoolRow>, String> {
    write_tx(&app, move |conn, actor| release(conn, actor, input), CARD_WRITE_ROLES, "退卡").await
}
