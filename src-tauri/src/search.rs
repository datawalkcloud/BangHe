//! 全局检索（05 §5 顶栏 Ctrl/Alt+K；01 §F1 快捷检索）
//!
//! 顶栏那个搜索框整块还挂在 mock 上：桌面端当场录进真库的磅单、售粮人、结算单
//! 一个都搜不出来。本模块只把 `api.search` 换成 SQLite 读，命中口径与分组上限
//! 逐字对齐 `src/mock/api.ts` 的 `search`（磅单 8 / 售粮人 6 / 结算单 6），
//! 消费方 `components/business/GlobalSearch.tsx` 一行不改。
//! 读操作，不设岗位闸门（与 dashboard / reports / ledger 同口径）。
//!
//! 四条只在真库侧才需要交代的判断：
//!  - **不给搜索加审计**。Ctrl+K 每次按键都会打一次，把关键词原样落 audit_log
//!    等于把身份证号、手机号这类 PII 明文抄进一张人人都能翻的表，比现状更糟；
//!    mock 侧本来也没有这一条，接真库不该顺手加戏。
//!  - **上限写在 SQL 的 LIMIT 里**，不是取全表回前端再截：weigh_order 是本站增长
//!    最快的一张表，全表捞回来说话量与手感都撑不住。
//!  - **LIKE 一律转义并配 `ESCAPE '\'`**（抄 reports.rs `settlement_list` 的
//!    `like_pattern` 思路）：不转义时"100%"这类关键词会命中全表；而转义符自身若
//!    不先加倍，关键词里的反斜杠就能把后面那个通配符"解放"出来。
//!  - **磅单行即 OrderRow**：直接复用 [`orders::ORDER_SELECT`] + [`orders::map_order_row`]，
//!    records / photos / prints / timeline 那四个"详情才带"的字段在 WeighOrder 里本就是
//!    `Option` 且带 `skip_serializing_if = "Option::is_none"`，而 map_order_row 恒置 None，
//!    序列化出来的 JSON 天然等于 mock 的 `OrderRow`（Omit 掉那四键），不必再包一层 DTO。

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::AppHandle;

use crate::orders::{
    load_settlement_by_id, map_order_row, map_party_row, read_only, Party, Settlement, WeighOrder, ORDER_SELECT, PARTY_SELECT,
};

/// 分组上限：与 mock.search 的 slice(0, 8) / slice(0, 6) / slice(0, 6) 同数
const ORDER_LIMIT: i64 = 8;
const PARTY_LIMIT: i64 = 6;
const SETTLEMENT_LIMIT: i64 = 6;

/// `api.search` 的返回体：三组命中，字段名即前端契约
#[derive(Debug, Clone, Default, Serialize)]
pub struct SearchResult {
    pub orders: Vec<WeighOrder>,
    pub parties: Vec<Party>,
    pub settlements: Vec<Settlement>,
}

/// LIKE 模式转义：`\` 先自转，再转 `%` 与 `_`（顺序反了会把刚加的转义符又转一遍）。
/// 关键词整体小写后再进来——SQLite 的 `lower()` 只管 ASCII，与 mock 的
/// `toLowerCase()` 在这批字段（单号 / 车牌 / 数字证号）上等价。
fn like_pattern(kw: &str) -> String {
    let escaped = kw.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("%{escaped}%")
}

/// 磅单海堆：单号 / 售粮人姓名 / **证号后 4 位** / 车牌（与 mock 拼的那串同字段）。
/// 证号存在过渡期的明文 BLOB 列里，必须先 CAST 成 TEXT 再 substr，照 ORDER_SELECT 的写法。
/// 后 4 位是"取尾再比"，不是"整证号包含"——拿证号中段的出生年去搜出不属于它的单是误命中。
const ORDER_HIT: &str = "(\
     lower(o.order_no) LIKE ?1 ESCAPE '\\' \
  OR lower(p.name) LIKE ?1 ESCAPE '\\' \
  OR lower(COALESCE(o.vehicle_no, '')) LIKE ?1 ESCAPE '\\' \
  OR substr(COALESCE(CAST(p.id_card_no_enc AS TEXT), ''), -4) LIKE ?1 ESCAPE '\\')";

fn search_orders(conn: &Connection, pat: &str) -> Result<Vec<WeighOrder>, String> {
    let sql = format!(
        "{ORDER_SELECT} WHERE {ORDER_HIT} ORDER BY o.business_date DESC, o.order_no DESC LIMIT {ORDER_LIMIT}"
    );
    conn.prepare_cached(&sql)
        .and_then(|mut st| st.query_map(params![pat], map_order_row).and_then(|m| m.collect::<Result<Vec<_>, _>>()))
        .map_err(|e| format!("检索磅单失败：{e}"))
}

/// 售粮人海堆：姓名 / 证号 / 手机号。软删档案不进结果——真库独有的 deleted_at 列，
/// mock 里没有对应概念，但命中一条点进去就是死链。
const PARTY_HIT: &str = "(\
     lower(name) LIKE ?1 ESCAPE '\\' \
  OR lower(COALESCE(CAST(id_card_no_enc AS TEXT), '')) LIKE ?1 ESCAPE '\\' \
  OR lower(COALESCE(CAST(phone_enc AS TEXT), '')) LIKE ?1 ESCAPE '\\')";

fn search_parties(conn: &Connection, pat: &str) -> Result<Vec<Party>, String> {
    let sql = format!(
        "{PARTY_SELECT} WHERE deleted_at IS NULL AND {PARTY_HIT} \
         ORDER BY CASE WHEN lower(name) LIKE ?1 ESCAPE '\\' THEN 0 ELSE 1 END, id LIMIT {PARTY_LIMIT}"
    );
    conn.prepare_cached(&sql)
        .and_then(|mut st| st.query_map(params![pat], map_party_row).and_then(|m| m.collect::<Result<Vec<_>, _>>()))
        .map_err(|e| format!("检索售粮人失败：{e}"))
}

/// 结算单只取 id，再逐张交给 [`orders::load_settlement_by_id`]：最多 6 张的 N+1
/// 在单机站点的量级下不构成手感问题，换来的是与工作台 / 台账**完全同一份**的
/// 结算单形状（settlements.rs 的挂账账龄就是同一个理由）。
fn search_settlements(conn: &Connection, pat: &str) -> Result<Vec<Settlement>, String> {
    let ids: Vec<i64> = conn
        .prepare_cached(
            "SELECT s.id FROM settlement s JOIN party p ON p.id = s.party_id
             WHERE (lower(s.settle_no) LIKE ?1 ESCAPE '\\' OR lower(p.name) LIKE ?1 ESCAPE '\\')
             ORDER BY COALESCE(s.created_at, s.settled_at) DESC, s.id DESC LIMIT ?2",
        )
        .and_then(|mut st| {
            st.query_map(params![pat, SETTLEMENT_LIMIT], |r| r.get::<_, i64>(0))
                .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        })
        .map_err(|e| format!("检索结算单失败：{e}"))?;

    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        // 读途中的并发撤销 / 删除只会少一条命中，不该让整个搜索框报错
        if let Some(s) = load_settlement_by_id(conn, id)? {
            out.push(s);
        }
    }
    Ok(out)
}

/// 纯业务函数：空关键词直接回三空，**一次库都不碰**（与 mock 一致，
/// 且搜索框每次按键都进来一趟，空转查询是白给的压力）。
pub fn global_search(conn: &Connection, kw: &str) -> Result<SearchResult, String> {
    let k = kw.trim().to_lowercase();
    if k.is_empty() {
        return Ok(SearchResult::default());
    }
    let pat = like_pattern(&k);
    Ok(SearchResult {
        orders: search_orders(conn, &pat)?,
        parties: search_parties(conn, &pat)?,
        settlements: search_settlements(conn, &pat)?,
    })
}

// ----------------------------------------------------------------- Tauri 命令
// 命令名与上面的纯函数错开（同 settlements.rs 的 settlement_get / settlement_detail）。
// 入参 `kw` 没有大小写，camelCase ↔ snake_case 转换对它无影响。

#[tauri::command]
pub async fn search_global(app: AppHandle, kw: String) -> Result<SearchResult, String> {
    read_only(&app, move |conn| global_search(conn, &kw), "全局检索").await
}
