//! 结构契约守卫。
//!
//! 这一组测试回答的不是"SQL 能不能跑"，而是三个会咬人的问题：
//!   1. 每台机器的结构会不会各自漂移？→ `schema_matches_blessed_snapshot`
//!   2. 建表脚本漏写/多写了一列、索引、CHECK，谁发现？→ `doc_section9_contract_*`
//!   3. 枚举值域在 SQLite / Rust / 前端 constants.ts 三处分叉（80mm 小票 `thermal80`
//!      真就这么漏过一次），谁拦下？→ `enums_are_single_sourced_across_three_places`
//!      同一口径也管版本号：package.json / tauri.conf.json / Cargo.toml / Cargo.lock
//!      四处必须一致，界面不许自带第二个版本号 → `app_version_is_single_sourced`
//!   4. 现场从旧版本跳级升级、脚本被改动、装回老版本，行为对不对？→ 迁移行为那几条；
//!      覆盖安装（安装器落 `install.stamp` 记号）与纯升版本号的"升级首启"必须先拍到
//!      `pre_upgrade_` 快照、且同一次安装只拍一次 → `overwrite_install_*` / `version_bump_*`
//!
//! 重新生成快照：`BANGHE_BLESS_SCHEMA=1 cargo test --test schema_contract`
//! 生成后必须 review diff：快照是"期望结构"的账本，不是自动通过的橡皮章。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use chrono::Local;
use regex::Regex;
use rusqlite::Connection;

use banghe_lib::db::migrate::{self, Migration, MIGRATIONS};
use banghe_lib::db::in_memory_migrated;
use banghe_lib::domain::enums::ENUM_SPECS;

const DOC_PATH: &str = "../docs/design/03-技术架构与数据模型.md";
const TS_PATH: &str = "../src/lib/constants.ts";
const MIGRATION_DIR: &str = "src/db/migrations";
const SNAPSHOT_PATH: &str = "tests/schema_snapshot.sql";

fn repo_file(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn read(rel: &str) -> String {
    std::fs::read_to_string(repo_file(rel))
        .unwrap_or_else(|e| panic!("读取 {rel} 失败：{e}"))
}

fn re(p: &str) -> Regex {
    Regex::new(p).unwrap_or_else(|e| panic!("正则 {p} 无效：{e}"))
}

/// 把空白压成单个空格，去掉行尾空白，便于逐字比对
fn norm(s: &str) -> String {
    re(r"\s+").replace_all(s.trim(), " ").trim().to_string()
}

fn backticked(s: &str) -> Vec<String> {
    re(r"`([^`]+)`").captures_iter(s).map(|c| c[1].to_string()).collect()
}

// ============================================================== 文档 §9 解析

#[derive(Debug, Clone)]
struct DocCol {
    names: Vec<String>,
    /// 与 names 等长（已按广播/逐列展开），未给类型时为空串
    types: Vec<String>,
    constraint: String,
    note: String,
}

#[derive(Debug, Clone)]
struct DocIndex {
    cols: Vec<String>,
    unique: bool,
}

#[derive(Debug, Default)]
struct DocTable {
    cols: Vec<DocCol>,
    indexes: BTreeMap<String, DocIndex>,
}

#[derive(Debug, Default)]
struct Doc {
    /// 表名 → 表定义（保持插入序由 BTreeMap 承担）
    tables: BTreeMap<String, DocTable>,
    states: Vec<String>,
    setting_keys: Vec<String>,
    views: Vec<String>,
}

fn split_cells(line: &str) -> Vec<String> {
    line.split('|')
        .skip(1)
        .map(|c| norm(c))
        .collect::<Vec<_>>()
}

/// 一格里的多个列名：`` `a`/`b` `` 或 `` `a` / `b` ``
fn names_of(cell: &str) -> Vec<String> {
    backticked(cell)
}

/// 把 types 展开成与 names 等长：1 个则广播，等长则逐列，否则留空
fn types_of(type_cell: &str, n: usize) -> Vec<String> {
    let raw: Vec<String> = type_cell
        .split('/')
        .map(|t| norm(t).to_uppercase())
        .filter(|t| !t.is_empty())
        .collect();
    if raw.len() == n {
        raw
    } else if raw.len() == 1 {
        vec![raw[0].clone(); n]
    } else if raw.is_empty() {
        vec![String::new(); n]
    } else {
        vec![String::new(); n] // 类型对不上列数：不做类型断言，交给快照与人工评审
    }
}

fn parse_doc() -> Doc {
    let md = read(DOC_PATH);
    let mut doc = Doc::default();
    let mut cur: Option<String> = None;
    let mut fence = false;

    // §4.1 状态表
    let mut in_states = false;
    let mut in_settings = false;
    let mut in_views = false;
    let mut in_section9 = false;

    for raw in md.lines() {
        let line = raw.trim_end();
        let t = line.trim();

        if t.starts_with("### 4.1 ") {
            in_states = true;
            continue;
        }
        if t.starts_with("### 4.2 ") {
            in_states = false;
        }
        if in_states && t.starts_with("| `") {
            if let Some(n) = backticked(t).first() {
                doc.states.push(n.clone());
            }
            continue;
        }

        if t.starts_with("## 9 ") {
            in_section9 = true;
            continue;
        }
        if t.starts_with("## 10 ") {
            in_section9 = false;
            continue;
        }
        if !in_section9 {
            continue;
        }

        if t.starts_with("```") {
            fence = !fence;
            continue;
        }

        if t.starts_with("### 9.") {
            in_settings = t.starts_with("### 9.3 ");
            in_views = t.starts_with("### 9.24");
            let toks = backticked(t);
            cur = toks.first().cloned();
            if let Some(n) = &cur {
                doc.tables.entry(n.clone()).or_default();
            }
            continue;
        }

        // 一节里的独立 `name` 行 = 换到另一张表（§9.9 一节两张表）
        if !fence && t.starts_with('`') && t.ends_with('`') && t.matches('`').count() == 2 {
            let n = t.trim_matches('`').to_string();
            doc.tables.entry(n.clone()).or_default();
            cur = Some(n);
            continue;
        }

        // CREATE INDEX 语句（§9.11 的 sql 块），按语句里的表名归属
        if let Some(c) = re(r"(?i)CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)").captures(line) {
            let table = c[3].to_string();
            let name = c[2].to_string();
            let cols = c[4].split(',').map(|x| norm(x)).collect::<Vec<_>>();
            doc.tables.entry(table).or_default().indexes.insert(
                name,
                DocIndex { cols, unique: c.get(1).is_some() },
            );
            continue;
        }

        // 索引：`idx_x(a, b)`、`uk_y(c) UNIQUE` …… 归属当前表
        if t.contains("索引：") {
            if let Some(tbl) = &cur {
                for tok in backticked(t) {
                    if let Some(c) = re(r"(?i)^([A-Za-z_]\w*)\s*\(([^)]*)\)(.*)$").captures(&tok) {
                        let name = c[1].to_string();
                        if name.eq_ignore_ascii_case("unique") {
                            continue; // `UNIQUE(party_id,kind) WHERE ...` 这种没点名的写法
                        }
                        let cols = c[2].split(',').map(|x| norm(x)).collect::<Vec<_>>();
                        doc.tables.entry(tbl.clone()).or_default().indexes.insert(
                            name,
                            DocIndex { cols, unique: c[3].to_uppercase().contains("UNIQUE") },
                        );
                    }
                }
            }
            continue;
        }

        if in_settings && !t.starts_with("|") {
            let body = t.split("--").next().unwrap_or(t);
            for c in re(r"([a-z][A-Za-z0-9_]*)\s*=").captures_iter(body) {
                let k = c[1].to_string();
                if !doc.setting_keys.contains(&k) {
                    doc.setting_keys.push(k);
                }
            }
        }

        if in_views {
            if let Some(c) = re(r"(?i)CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)").captures(t) {
                doc.views.push(c[1].to_string());
            }
            continue;
        }

        // 字段表格行
        if t.starts_with("| ") {
            let cells = split_cells(t);
            if cells.len() < 3 {
                continue;
            }
            if cells[0] == "字段" || cells[0].starts_with("---") {
                continue;
            }
            let names = names_of(&cells[0]);
            if names.is_empty() {
                continue;
            }
            let types = types_of(&cells[1], names.len());
            let tbl = cur.clone().expect("§9 里出现不属于任何表的表格行");
            doc.tables.entry(tbl).or_default().cols.push(DocCol {
                names,
                types,
                constraint: cells.get(2).cloned().unwrap_or_default(),
                note: cells.get(3).cloned().unwrap_or_default(),
            });
        }
    }
    doc
}

/// 文档声明的值域：`见 4.1` → 状态表；否则取约束列 `CHECK IN (...)` 的反引号列表；
/// 再退一步取说明列里 `` `a`/`b`/`c` `` 这种斜杠分隔清单（如 print_log.paper 没有 CHECK）。
fn doc_values(col: &DocCol, doc: &Doc) -> Option<Vec<String>> {
    if col.constraint.contains("见 4.1") {
        return Some(doc.states.clone());
    }
    if let Some(c) = re(r"(?i)CHECK\s+IN\s*\(([^)]*)\)").captures(&col.constraint) {
        let v = backticked(&c[1]);
        if !v.is_empty() {
            return Some(v);
        }
    }
    let v = value_tokens(&col.note);
    if v.len() >= 2 {
        return Some(v);
    }
    None
}

/// `A4`/`dot241`/`thermal58` 这种斜杠分隔的反引号值列表
fn value_tokens(s: &str) -> Vec<String> {
    backticked(s)
        .into_iter()
        .filter(|v| v.chars().count() <= 24 && !v.contains(' '))
        .collect()
}

// ============================================================= 实际结构读取

#[derive(Debug)]
struct ActualCol {
    name: String,
    declared_type: String,
    notnull: bool,
    pk: bool,
}

#[derive(Debug)]
struct ActualIndex {
    name: String,
    cols: Vec<String>,
    unique: bool,
}

#[derive(Debug)]
struct ActualTable {
    cols: Vec<ActualCol>,
    indexes: Vec<ActualIndex>,
    fks: Vec<(String, String)>, // (本表列, 引用表)
    sql: String,
    check_sets: BTreeMap<String, BTreeSet<String>>, // 列名 → CHECK (col IN (...)) 值集合
}

fn actual_tables(conn: &Connection) -> BTreeMap<String, ActualTable> {
    let names: Vec<String> = {
        let mut st = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap();
        st.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
    };
    let mut out = BTreeMap::new();
    for name in names {
        out.insert(name.clone(), actual_table(conn, &name));
    }
    out
}

fn actual_table(conn: &Connection, name: &str) -> ActualTable {
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get(0),
        )
        .unwrap();

    let cols = {
        let mut st = conn.prepare(&format!("PRAGMA table_info(\"{name}\")")).unwrap();
        st.query_map([], |r| {
            Ok(ActualCol {
                name: r.get::<_, String>(1)?,
                declared_type: r.get::<_, String>(2)?.to_uppercase(),
                notnull: r.get::<_, i64>(3)? != 0,
                pk: r.get::<_, i64>(5)? != 0,
            })
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    };

    let fks = {
        let mut st = conn.prepare(&format!("PRAGMA foreign_key_list(\"{name}\")")).unwrap();
        st.query_map([], |r| Ok((r.get::<_, String>(3)?, r.get::<_, String>(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };

    let mut indexes = Vec::new();
    {
        let rows: Vec<(String, i64)> = {
            let mut st = conn.prepare(&format!("PRAGMA index_list(\"{name}\")")).unwrap();
            st.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        for (iname, unique) in rows {
            if iname.starts_with("sqlite_autoindex") {
                continue; // 内联 UNIQUE 生成的自动索引，由表 SQL 文本单独判定
            }
            let cols: Vec<String> = {
                let mut st = conn.prepare(&format!("PRAGMA index_info(\"{iname}\")")).unwrap();
                st.query_map([], |r| r.get::<_, Option<String>>(2))
                    .unwrap()
                    .filter_map(|x| x.ok().flatten())
                    .collect()
            };
            indexes.push(ActualIndex { name: iname, cols, unique: unique != 0 });
        }
    }

    let mut check_sets: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for c in re(r"(?i)CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)").captures_iter(&sql) {
        let col = c[1].to_string();
        let vals: BTreeSet<String> = c[2]
            .split(',')
            .map(|v| norm(v).trim_matches('\'').to_string())
            .filter(|v| !v.is_empty())
            .collect();
        check_sets.insert(col, vals);
    }

    ActualTable { cols, indexes, fks, sql, check_sets }
}

/// 该列是否带内联 UNIQUE（自动索引不出现在 index_list 里，只能看 DDL 文本）
fn inline_unique(t: &ActualTable, col: &str) -> bool {
    re(&format!(r"(?im)^\s*{col}\s+[^,\n]*\bUNIQUE\b")).is_match(&t.sql)
}

fn index_covering(t: &ActualTable, col: &str) -> bool {
    t.indexes
        .iter()
        .any(|i| i.unique && i.cols.len() == 1 && i.cols[0] == col)
}

// ================================================================== 公共夹具

fn migrated() -> Connection {
    in_memory_migrated("0.1.0-test", MIGRATIONS).expect("全量迁移应当成功")
}

fn assert_empty(problems: Vec<String>, header: &str) {
    if problems.is_empty() {
        return;
    }
    let mut msg = format!(
        "\n{header}：{} 处不一致\n",
        problems.len()
    );
    for p in problems.iter().take(60) {
        msg.push_str("  · ");
        msg.push_str(p);
        msg.push('\n');
    }
    if problems.len() > 60 {
        msg.push_str(&format!("  …… 另有 {} 处\n", problems.len() - 60));
    }
    msg.push_str("修法是让「文档 / 建表脚本 / 前端常量」三者对齐，不要单独放宽某一项。");
    panic!("{msg}");
}

// ===================================================================== 测试

/// 期望结构 = 全部迁移跑一遍的产物。快照由本测试生成，人不手写。
#[test]
fn schema_matches_blessed_snapshot() {
    let conn = migrated();
    let dump = dump_schema(&conn);

    let path = repo_file(SNAPSHOT_PATH);
    if std::env::var("BANGHE_BLESS_SCHEMA").is_ok() {
        std::fs::write(&path, &dump).expect("写快照失败");
        println!("已生成快照 {}（{} 个对象）", path.display(), dump.lines().count());
        return;
    }
    if !path.exists() {
        panic!(
            "缺少结构快照 {}。先跑 `BANGHE_BLESS_SCHEMA=1 cargo test --test schema_contract` 生成并 review。",
            path.display()
        );
    }
    let expected = std::fs::read_to_string(&path).unwrap();
    if expected != dump {
        let mut msg = String::from("实际结构与快照不一致（同一批脚本必须在任何机器上得到逐字相同的结构）：\n");
        for line in diff_lines(&expected, &dump).take(40) {
            msg.push_str("  ");
            msg.push_str(&line);
            msg.push('\n');
        }
        panic!("{msg}");
    }
}

fn dump_schema(conn: &Connection) -> String {
    let rows: Vec<(String, String, String)> = {
        let mut st = conn
            .prepare(
                "SELECT type, name, sql FROM sqlite_master
                  WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
                  ORDER BY type DESC, name ASC",
            )
            .unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    let mut out = String::new();
    out.push_str("-- 由 tests/schema_contract.rs 生成：0001..00NN 全量迁移跑完后的实际结构\n");
    out.push_str("-- 重新生成：BANGHE_BLESS_SCHEMA=1 cargo test --test schema_contract\n");
    for (ty, name, sql) in rows {
        out.push_str(&format!("{ty}\t{name}\t{}\n", norm(&sql)));
    }
    out
}

fn diff_lines(a: &str, b: &str) -> impl Iterator<Item = String> {
    use std::collections::BTreeSet;
    let sa: BTreeSet<&str> = a.lines().collect();
    let sb: BTreeSet<&str> = b.lines().collect();
    sa.symmetric_difference(&sb).map(|s| s.to_string()).collect::<Vec<_>>().into_iter()
}

/// 目录里有脚本没登记 → 永远不会被执行；登记了却不在目录 → 内嵌内容与现场不一致
#[test]
fn every_migration_file_is_registered() {
    let dir = repo_file(MIGRATION_DIR);
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("读 {} 失败：{e}", dir.display()))
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".sql"))
        .collect();
    files.sort();
    let registered: Vec<String> = MIGRATIONS.iter().map(|m| m.name.to_string()).collect();
    assert_eq!(files, registered, "migrations/ 目录与 migrate::MIGRATIONS 清单不一致");
    let mut order: Vec<u32> = files.iter().map(|n| migrate::version_of(n)).collect();
    order.sort();
    assert_eq!(order.first(), Some(&1), "首号应为 0001");
    for w in order.windows(2) {
        assert!(w[1] > w[0], "迁移序号必须唯一递增：{order:?}");
    }
}

/// §9 的 28 张表 ⇄ 实际建出来的 28 张表，一张都不许多/少
/// （第 28 张是 0020 的 `outbound_order` 粮食出库单，02 §M11）
#[test]
fn doc_section9_table_set_matches_database() {
    let doc = parse_doc();
    let conn = migrated();
    let mut actual = actual_tables(&conn).into_keys().collect::<Vec<_>>();
    actual.retain(|t| t != "schema_migration"); // 迁移执行器自己的账本，不属 §9
    let declared: Vec<String> = doc.tables.keys().cloned().collect();
    assert_eq!(
        declared, actual,
        "§9 声明的表与实际库不一致（左=文档 右=实际）。schema_migration 已由执行器建，不参与比对"
    );
    assert_eq!(declared.len(), 28, "§9 应当是 28 张表");
}

/// 剥掉部分索引写法带来的 `WHERE ...` 尾巴：`UNIQUE WHERE NOT NULL` 描述的是
/// 「对非空值唯一」，不是列级 NOT NULL（§9.6 `id_card_no_fp`）。
fn constraint_only(c: &str) -> String {
    match c.to_uppercase().find(" WHERE ") {
        Some(i) => c[..i].to_string(),
        None => c.to_string(),
    }
}

/// 逐列核对：存在性、类型、NOT NULL、PK、FK、CHECK 值域，以及"实际多出来的列"
#[test]
fn doc_section9_columns_match_database() {
    let doc = parse_doc();
    let conn = migrated();
    let actual = actual_tables(&conn);
    let mut problems = Vec::new();
    let mut skipped = Vec::new();

    for (tname, dt) in &doc.tables {
        let Some(at) = actual.get(tname) else { continue }; // 上一条测试已报缺表
        let declared: BTreeSet<String> = dt.cols.iter().flat_map(|c| c.names.clone()).collect();
        let real: BTreeSet<String> = at.cols.iter().map(|c| c.name.clone()).collect();
        for missing in declared.difference(&real) {
            problems.push(format!("{tname}.{missing}：§9 有该列，库里没有（建表脚本漏写？）"));
        }
        for extra in real.difference(&declared) {
            problems.push(format!("{tname}.{extra}：库里有该列，§9 没有（文档没同步，或脚本多写了）"));
        }

        for dc in &dt.cols {
            for (i, col) in dc.names.iter().enumerate() {
                let Some(ac) = at.cols.iter().find(|c| &c.name == col) else { continue };
                let ty = dc.types.get(i).cloned().unwrap_or_default();
                if !ty.is_empty() && ac.declared_type != ty {
                    problems.push(format!("{tname}.{col}：类型 §9={ty} 实际={}", ac.declared_type));
                }
                if ac.declared_type.is_empty() {
                    problems.push(format!("{tname}.{col}：实际未声明类型"));
                }

                let c = &constraint_only(&dc.constraint);
                if c.contains("PK") && !ac.pk {
                    problems.push(format!("{tname}.{col}：§9 要求主键，实际不是"));
                }
                if !c.contains("PK") && ac.pk && tname != "role_permission" {
                    problems.push(format!("{tname}.{col}：实际是主键列，§9 未声明 PK"));
                }

                // NOT NULL：`NOT NULL(前两项)` 只约束前一半（§9.11 的 created_at 组）
                let want_notnull = if c.contains("前两项") {
                    i < dc.names.len() / 2 && c.contains("NOT NULL")
                } else {
                    c.contains("NOT NULL")
                };
                if want_notnull && !ac.notnull {
                    problems.push(format!("{tname}.{col}：§9 要求 NOT NULL，实际可空"));
                }

                let single_token = dc.names.len() == 1;
                if single_token && c.contains("UNIQUE") && !inline_unique(at, col) && !index_covering(at, col) {
                    problems.push(format!("{tname}.{col}：§9 要求 UNIQUE，实际既无内联约束也无单列唯一索引"));
                }

                // 外键：只对声明为 INTEGER 的列断言（§9 里一格多列共用一个 FK→X 的写法
                // 存在歧义，例如 `period_from / period_to`、`variety_id / grade`）
                if ty == "INTEGER" {
                    if let Some(cap) = re(r"FK\s*→\s*([A-Za-z_]\w*)").captures(c) {
                        let target = cap[1].to_string();
                        if !at.fks.iter().any(|(from, to)| from == col && to == &target) {
                            problems.push(format!("{tname}.{col}：§9 声明 FK→{target}，实际无该外键"));
                        }
                    }
                }

                if !ty.is_empty() && ty != "INTEGER" && ty != "TEXT" && ty != "BLOB" {
                    skipped.push(format!("{tname}.{col} 类型 {ty}"));
                }
            }
        }
    }

    if !skipped.is_empty() {
        println!("提示：{} 处非常规类型写法按实际类型为准，例 {:?}", skipped.len(), &skipped[..skipped.len().min(3)]);
    }
    assert_empty(problems, "§9 表结构 ↔ 实际结构");
}

/// §9 点名的具名索引（含 §9.11 的 sql 块）必须存在且列一致；视图同样核对
#[test]
fn doc_named_indexes_and_views_exist() {
    let doc = parse_doc();
    let conn = migrated();
    let actual = actual_tables(&conn);
    let mut problems = Vec::new();

    for (tname, dt) in &doc.tables {
        let Some(at) = actual.get(tname) else { continue };
        for (iname, want) in &dt.indexes {
            match at.indexes.iter().find(|i| &i.name == iname) {
                None => problems.push(format!("{tname}：§9 点名索引 {iname} 不存在")),
                Some(got) => {
                    if &got.cols != &want.cols {
                        problems.push(format!("{tname}.{iname}：列不一致 §9={:?} 实际={:?}", want.cols, got.cols));
                    }
                    if want.unique && !got.unique {
                        problems.push(format!("{tname}.{iname}：§9 要求唯一，实际不是"));
                    }
                }
            }
        }
        // 实际多出来的具名索引只提示，不失败（结构本身由快照 review）
        for got in &at.indexes {
            if !dt.indexes.contains_key(&got.name) {
                println!("提示：{tname}.{} 是脚本新增的具名索引，§9 未点名", got.name);
            }
        }
    }

    let views: Vec<String> = {
        let mut st = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name")
            .unwrap();
        st.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
    };
    assert_eq!(doc.views, views, "§9.24 视图与实际不一致（左=文档 右=实际）");

    assert_empty(problems, "§9 具名索引");
}

/// 核心一条：枚举值域三处同源。`thermal80` 当初就只在 constants.ts 里补了。
#[test]
fn enums_are_single_sourced_across_three_places() {
    let doc = parse_doc();
    let conn = migrated();
    let actual = actual_tables(&conn);
    let ts = parse_ts_unions();

    let mut problems = Vec::new();
    let mut notes = Vec::new();
    let mut covered: BTreeSet<(String, String)> = BTreeSet::new();

    for spec in ENUM_SPECS {
        let rust: BTreeSet<String> = spec.values.iter().map(|s| s.to_string()).collect();
        if rust.len() != spec.values.len() {
            problems.push(format!("{}：Rust 值域内部有重复", spec.rust));
        }
        let Some(table) = spec.table else { continue };
        covered.insert((table.to_string(), spec.column.to_string()));
        let at = actual
            .get(table)
            .unwrap_or_else(|| panic!("{} 指向不存在的表 {table}", spec.rust));

        // 文档侧
        let docvals = doc
            .tables
            .get(table)
            .and_then(|dt| dt.cols.iter().find(|c| c.names.iter().any(|n| n == spec.column)))
            .and_then(|c| doc_values(c, &doc));
        if let Some(dv) = &docvals {
            let set: BTreeSet<String> = dv.iter().cloned().collect();
            if &set != &rust {
                problems.push(format!(
                    "{table}.{}：文档值域与 Rust {} 不一致 文档={:?} Rust={:?}",
                    spec.column, spec.rust, sorted(&set), sorted(&rust)
                ));
            }
        } else {
            notes.push(format!("{table}.{}（{}）：§9 未声明值域清单", spec.column, spec.rust));
        }

        // 数据库侧
        match at.check_sets.get(spec.column) {
            Some(sqlset) => {
                if sqlset != &rust {
                    problems.push(format!(
                        "{table}.{}：CHECK 值域与 Rust {} 不一致 库={:?} Rust={:?}",
                        spec.column, spec.rust, sorted(sqlset), sorted(&rust)
                    ));
                }
            }
            None => notes.push(format!(
                "{table}.{}（{}）：§3.6 要求枚举带 CHECK，实际没有——值域只靠代码约束",
                spec.column, spec.rust
            )),
        }

        // 前端侧
        if let Some(t) = spec.ts {
            let tv = ts
                .get(t)
                .unwrap_or_else(|| panic!("constants.ts 里找不到前端类型 {t}（{} 登记了它）", spec.rust));
            let tset: BTreeSet<String> = tv.iter().cloned().collect();
            let missing: Vec<&String> = rust.iter().filter(|v| !tset.contains(*v)).collect();
            if !missing.is_empty() {
                problems.push(format!(
                    "{table}.{}：后端值域在前端 {t} 没有标签 → {:?}（现场会显示成空白或 unknown）",
                    spec.column, missing
                ));
            }
            if spec.ts_strict {
                let extra: Vec<&String> = tset.iter().filter(|v| !rust.contains(*v)).collect();
                if !extra.is_empty() {
                    problems.push(format!(
                        "{table}.{}：前端 {t} 多出的值后端不认 → {:?}（要么后端补，要么前端删）",
                        spec.column, extra
                    ));
                }
            } else {
                let extra: Vec<&String> = tset.iter().filter(|v| !rust.contains(*v)).collect();
                if !extra.is_empty() {
                    notes.push(format!("{table}.{}：前端 {t} 是共用显示字典，多出 {:?}", spec.column, extra));
                }
            }
        }
    }

    // 反向：库里每个 CHECK (col IN (...)) 都必须被登记，防止"加了约束忘了进表"
    for (tname, at) in &actual {
        for (col, set) in &at.check_sets {
            if !covered.contains(&(tname.clone(), col.clone())) {
                problems.push(format!(
                    "{tname}.{col}：库里有 CHECK 值域 {set:?}，但 ENUM_SPECS 未登记（前端与 Rust 各是什么？）"
                ));
            }
        }
    }

    for n in &notes {
        println!("待拍板：{n}");
    }
    assert_empty(problems, "枚举三处同源");
}

fn parse_ts_unions() -> BTreeMap<String, Vec<String>> {
    let src = read(TS_PATH);
    let mut out = BTreeMap::new();
    for c in re(r#"export type (\w+)\s*=\s*([^;]+);"#).captures_iter(&src) {
        let vals = re(r#""([^"]+)""#)
            .captures_iter(&c[2])
            .map(|q| q[1].to_string())
            .collect::<Vec<_>>();
        if !vals.is_empty() {
            out.insert(c[1].to_string(), vals);
        }
    }
    // export const GRADES = ["一等", ...] as const
    for c in re(r"export const (\w+)\s*=\s*\[([^\]]*)\]").captures_iter(&src) {
        let vals = re(r#""([^"]+)""#)
            .captures_iter(&c[2])
            .map(|q| q[1].to_string())
            .collect::<Vec<_>>();
        if !vals.is_empty() {
            out.insert(c[1].to_string(), vals);
        }
    }
    out
}

fn sorted(s: &BTreeSet<String>) -> Vec<&str> {
    s.iter().map(|x| x.as_str()).collect()
}

// ============================================================ 首版数据基线

/// §9.3.1 的参数键必须与库里实际写入的一致（少写一个键 = 设置页缺项）
#[test]
fn seed_baseline_matches_design_doc() {
    let doc = parse_doc();
    let conn = migrated();
    let keys: Vec<String> = conn
        .prepare("SELECT key FROM app_setting ORDER BY key")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let mut doc_keys = doc.setting_keys.clone();
    doc_keys.sort();
    assert_eq!(doc_keys, keys, "§9.3.1 参数键与 0002_seed 不一致（左=文档 右=库）");
    assert!(doc_keys.len() >= 20, "§9.3.1 键数异常：{}", doc_keys.len());

    let kinds: Vec<(String, String)> = conn
        .prepare("SELECT key, value_type FROM app_setting ORDER BY key")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for (k, ty) in &kinds {
        assert!(
            ["string", "int", "bool", "json"].contains(&ty.as_str()),
            "参数 {k} 的 value_type = {ty} 不在 §9.3 值域内"
        );
    }
    // value_json 必须真能按声明类型解析，否则设置页会读到脏值
    for (k, ty) in &kinds {
        let raw: String = conn
            .query_row("SELECT value_json FROM app_setting WHERE key=?1", [k], |r| r.get(0))
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("参数 {k} 的 value_json={raw} 不是合法 JSON：{e}"));
        match ty.as_str() {
            "string" => assert!(v.is_string(), "{k} 应存字符串，实际 {raw}"),
            "int" => assert!(v.is_i64() || v.is_u64(), "{k} 应存整数，实际 {raw}"),
            "bool" => assert!(v.is_boolean(), "{k} 应存布尔，实际 {raw}"),
            _ => assert!(v.is_object() || v.is_array(), "{k} 应存 JSON 结构，实际 {raw}"),
        }
    }

    let varieties: Vec<String> = conn
        .prepare("SELECT code FROM grain_variety ORDER BY sort_order")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(varieties, vec!["YM", "XM", "DG", "DD"], "§6 默认品种基线");

    // 指标编码必须是 constants.ts 指标字典里的项，否则化验页会出现空行
    let ts = parse_ts_unions();
    let ind: Vec<String> = conn
        .prepare("SELECT enabled_indicators_json FROM grain_variety")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for row in ind {
        let v: Vec<String> = serde_json::from_str(&row).unwrap();
        assert!(!v.is_empty(), "品种启用的指标不能为空：{row}");
        for code in &v {
            assert!(
                read(TS_PATH).contains(&format!("{code}:")),
                "启用的指标 {code} 不在 constants.ts 指标字典里"
            );
        }
    }
    let _ = ts;

    let (n_station, station_code): (i64, String) = conn
        .query_row("SELECT count(*), min(code) FROM station", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!((n_station, station_code.as_str()), (1, "01"), "v1 仅一条站点（§9.2）");

    let (pwd, must, role): (String, i64, String) = conn
        .query_row(
            "SELECT password_hash, must_change_pwd, role FROM user_account WHERE username='admin'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(role, "station_master");
    assert_eq!(must, 1, "初始账号必须首登强制改密");
    assert!(pwd.starts_with('!'), "password_hash 应为待设占位符，不能是看起来可用的假哈希：{pwd}");

    let (ver, appv): (String, String) = conn
        .query_row(
            "SELECT (SELECT value FROM app_meta WHERE key='schema_version'), (SELECT value FROM app_meta WHERE key='app_version')",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(ver, MIGRATIONS.len().to_string(), "app_meta.schema_version 应由迁移执行器写全");
    assert_eq!(appv, "0.1.0-test");

    // §9.4 索引与 §9.5 空表：P1 才启用授权，首版不得凭空造权限
    let perms: i64 = conn
        .query_row("SELECT count(*) FROM role_permission", [], |r| r.get(0))
        .unwrap();
    assert_eq!(perms, 0, "role_permission 首版建表不灌数据，默认授予集待业务确认");
}

// ============================================================ 迁移执行器行为

/// 第二次启动不应重复执行任何脚本（现场每天重启一次）
#[test]
fn migrate_is_idempotent_across_restarts() {
    let dir = temp_dir("idempotent");
    let path = dir.join("banghe.db");
    {
        let mut conn = Connection::open(&path).unwrap();
        banghe_lib::db::setup_pragmas(&conn).unwrap();
        let r1 = migrate::apply(&mut conn, "0.1.0-test", None, Some(&dir.join("backup"))).unwrap();
        assert_eq!(r1.applied.len(), MIGRATIONS.len(), "首装应跑全部脚本");
        assert!(r1.backup_path.is_none(), "空库首装不该做迁移前备份");
        let r2 = migrate::apply(&mut conn, "0.1.0-test", None, Some(&dir.join("backup"))).unwrap();
        assert!(r2.applied.is_empty(), "第二次启动不应再执行任何脚本：{:?}", r2.applied);
        assert!(r2.backup_path.is_none(), "普通重启（版本没变、没有新的安装记号）不该备份");
    }
    std::fs::remove_dir_all(&dir).ok();
}

/// 跳级升级：停在 0.1.3（只跑过 0001）的库，装上新版后自动补跑中间脚本并先备份
#[test]
fn upgrade_from_older_version_backs_up_and_fills_gap() {
    let dir = temp_dir("upgrade");
    let path = dir.join("banghe.db");
    {
        // 老版本二进制只带 0001
        let mut conn = Connection::open(&path).unwrap();
        banghe_lib::db::setup_pragmas(&conn).unwrap();
        static OLD: &[Migration] = &[Migration {
            name: "0001_init.sql",
            sql: include_str!("../src/db/migrations/0001_init.sql"),
        }];
        let r = migrate::apply_with(&mut conn, "0.1.3", None, None, OLD).unwrap();
        assert_eq!(r.applied, vec!["0001_init.sql".to_string()]);
        assert_eq!(r.to_version, 1);
        // 老版本没有种子的 22 个参数键
        drop(conn);
    }
    {
        let mut conn = Connection::open(&path).unwrap();
        banghe_lib::db::setup_pragmas(&conn).unwrap();
        let r = migrate::apply(&mut conn, "0.2.0", None, Some(&dir.join("backup"))).unwrap();
        let expected: Vec<String> = MIGRATIONS[1..].iter().map(|m| m.name.to_string()).collect();
        assert_eq!(r.applied, expected, "只补跑缺的那几个（按清单顺序）");
        assert_eq!((r.from_version, r.to_version), (1, MIGRATIONS.len() as u32));
        let backup = r.backup_path.expect("非空库迁移必须先自动备份");
        assert!(backup.exists() && backup.metadata().unwrap().len() > 0, "备份快照缺失：{backup:?}");
        let prefix = format!("pre_migrate_0001_to_{:04}_", MIGRATIONS.len());
        assert!(backup.file_name().unwrap().to_string_lossy().starts_with(&prefix), "快照名应体现起止版本：{backup:?}");
        let n: i64 = conn
            .query_row("SELECT count(*) FROM app_setting", [], |r| r.get(0))
            .unwrap();
        assert!(n >= 20, "补跑 0002 后参数键应当写入，实际 {n} 行");
        // 备份快照是迁移前的库：里面不该有种子数据
        let n2: i64 = rusqlite::Connection::open(&backup)
            .unwrap()
            .query_row("SELECT count(*) FROM app_setting", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n2, 0, "迁移前备份应当是老结构（无种子数据）");
        drop(conn);
    }
    std::fs::remove_dir_all(&dir).ok();
}

/// 0013 手机号唯一：现场库里同号的多份档案（中介拿自己号给几户建档是真事）若直接建
/// 唯一索引，站点机会开不了机——人进不了界面改档案。脚本必须自己把冲突收敛掉：
/// **同号只留最早那份**，其余置空并逐条留审计；空号一律 NULL（NULL 不占唯一位）。
#[test]
fn migration_0013_dedupes_party_phones_before_the_unique_index() {
    // 按名字定位而不是 `len()-1`：以后再往末尾补 0014、0015 时这个测试不必跟着改
    let idx = MIGRATIONS
        .iter()
        .position(|m| m.name == "0013_party_phone_unique.sql")
        .expect("0013 必须还在迁移清单里");
    let before: &'static [Migration] = &MIGRATIONS[..idx];
    // 执行器会核对"库里记的脚本都在清单里"，所以子集要一直带到 0013，而不是只给那一条
    let through_0013: &'static [Migration] = &MIGRATIONS[..idx + 1];
    assert_eq!(before.last().unwrap().name, "0012_reader_prompt_voice.sql");
    let mut conn = in_memory_migrated("0.1.0-test", before).expect("0013 之前的脚本应能独立跑完");

    {
        let ins = |name: &str, phone: &str| {
            conn.execute(
                "INSERT INTO party (name, party_type, phone_enc, created_at, created_by)
                 VALUES (?1, 'farmer', NULLIF(?2, ''), '2026-09-01T08:00:00.000', 1)",
                rusqlite::params![name, phone],
            )
            .unwrap();
        };
        ins("孙大娘", "138-0013 8000"); // 同号里最早的一份，且带分隔符
        ins("李二", "13800138000");
        ins("王三", "");
        ins("赵四", "   ");
    }

    // 补跑 0013：走生产同一执行器（校验和、逐脚本事务、记账都真）
    let r = migrate::apply_with(&mut conn, "0.1.0-test", None, None, through_0013).expect("0013 应当补齐并成功");
    assert_eq!(r.applied, vec!["0013_party_phone_unique.sql".to_string()]);

    let phones: Vec<(String, Option<String>)> = {
        let mut st = conn
            .prepare("SELECT name, CAST(phone_enc AS TEXT) FROM party ORDER BY id")
            .unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(
        phones,
        vec![
            ("孙大娘".into(), Some("13800138000".into())),
            ("李二".into(), None),
            ("王三".into(), None),
            ("赵四".into(), None),
        ],
        "保留方还要归一成比对形状；只填空白的号码算没填，不许互相顶掉"
    );

    let cleared: Vec<String> = {
        let mut st = conn.prepare("SELECT reason FROM audit_log WHERE action = 'party.phone.dedupe'").unwrap();
        st.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
    };
    assert_eq!(cleared.len(), 1, "置空要留得下一张补录清单：{cleared:?}");
    assert!(cleared[0].contains("13800138000"), "审计要点清被抹掉的号码：{cleared:?}");

    // 索引真立起来了：绕过服务层直接写库也顶不动
    let e = conn
        .execute(
            "INSERT INTO party (name, party_type, phone_enc, created_at, created_by)
             VALUES ('绕过服务层', 'farmer', '13800138000', '2026-09-01T09:00:00.000', 1)",
            [],
        )
        .unwrap_err()
        .to_string();
    assert!(e.contains("party.phone_enc"), "实际：{e}");
    let dup_idx: i64 = conn
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_party_phone'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(dup_idx, 0, "唯一索引顶掉普通索引后，同一列上不该留两个索引");
}

/// 0024 重建 `device_config`（扩 `kind` 值域加 `scanner`）——**被外键指向的父表**重建，
/// 外键开关必须在事务**外**关（`migrate.rs` 的 `FK_OFF_MIGRATIONS` 那条路上跑）：
/// `defer_foreign_keys` 记的是 DROP 那一刻那笔账，父表当时已不在，COMMIT 时哪怕新表
/// 已改回同名、行 id 一个不差、子表一行悬挂都没有，照样 `FOREIGN KEY constraint failed`。
/// 现场表现是 setup 钩子 panic、装机版双击没反应（2026-10-07 本机实测，逐句 bisect 到
/// 第 6 句 `DROP TABLE device_config` 必炸）。
///
/// 这条测试因此必须**带着子表引用行**跑：存量库里真有 `attachment.source_device_id`
/// 指着被重建的表，才复现得了"升级即开不了机"。顺带钉住三件收尾：行保号、新值域
/// `scanner` 真能用、越界值照旧被 CHECK 拦住。
#[test]
fn migration_0024_rebuilds_device_config_with_inbound_foreign_keys() {
    let idx = MIGRATIONS
        .iter()
        .position(|m| m.name == "0024_device_scanner_kind.sql")
        .expect("0024 必须还在迁移清单里");
    let before: &'static [Migration] = &MIGRATIONS[..idx];
    let through_0024: &'static [Migration] = &MIGRATIONS[..idx + 1];
    let mut conn = in_memory_migrated("0.1.0-test", before).expect("0024 之前的脚本应能独立跑完");

    // 设备台账不是种子数据（现场在设备中心里一台台加出来的），测试自己摆两台：
    // 一台被抓拍附件引用着，正是"父表被外键指着"的那个形状
    conn.execute(
        "INSERT INTO device_config (code, name, kind, driver) VALUES ('cam1', '磅区抓拍', 'camera', 'hikvision_isapi')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO device_config (code, name, kind, driver) VALUES ('prn1', '小票机', 'printer', 'raw_escpos')",
        [],
    )
    .unwrap();
    let device_id: i64 = conn
        .query_row("SELECT id FROM device_config WHERE code = 'cam1'", [], |r| r.get(0))
        .unwrap();
    let ids_before: Vec<(i64, String)> = {
        let mut st = conn.prepare("SELECT id, code FROM device_config ORDER BY id").unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<Result<_, _>>().unwrap()
    };
    let user_id: i64 = conn
        .query_row("SELECT id FROM user_account ORDER BY id LIMIT 1", [], |r| r.get(0))
        .unwrap();
    conn.execute(
        "INSERT INTO attachment (biz_type, file_path, file_size, sha256, captured_at, source_device_id, created_at, created_by)
         VALUES ('scale_capture', 'x.jpg', 1, 'sha-0024', '2026-10-07T09:00:00.000', ?1, '2026-10-07T09:00:00.000', ?2)",
        rusqlite::params![device_id, user_id],
    )
    .unwrap();

    // 补跑 0024：走生产同一执行器（外键开关、事务、校验和记账都真）
    let r = migrate::apply_with(&mut conn, "0.1.0-test", None, None, through_0024)
        .expect("0024 应当能重建带外键指向的 device_config（关外键走事务外那条路）");
    assert_eq!(r.applied, vec!["0024_device_scanner_kind.sql".to_string()]);

    // 行保号：id 与台号一个不变（子表外键指着它，换号等于砸引用）
    let kept: Vec<(i64, String)> = {
        let mut st = conn.prepare("SELECT id, code FROM device_config ORDER BY id").unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<Result<_, _>>().unwrap()
    };
    assert_eq!(kept, ids_before, "重建后设备行应原样保号");
    let refs: i64 = conn
        .query_row("SELECT count(*) FROM attachment WHERE source_device_id = ?1", [device_id], |r| r.get(0))
        .unwrap();
    assert_eq!(refs, 1, "重建不该动到子表里的引用行");

    // 新值域真的能用；越界值照旧被拦（重建后的 CHECK 确实在）
    conn.execute(
        "INSERT INTO device_config (code, name, kind, driver) VALUES ('scanner1', '串口扫码枪', 'scanner', 'serial_com')",
        [],
    )
    .unwrap();
    let e = conn
        .execute(
            "INSERT INTO device_config (code, name, kind, driver) VALUES ('bogus1', '坏类别', 'laser', 'serial_com')",
            [],
        )
        .unwrap_err()
        .to_string();
    assert!(e.contains("CHECK"), "越界 kind 应被 CHECK 拦住，实际：{e}");

    // 收尾不该留悬挂引用（执行器 post_checks 也会查，这里显式钉一遍）
    let dangling: i64 = {
        let mut st = conn.prepare("PRAGMA foreign_key_check").unwrap();
        st.query_map([], |_| Ok(())).unwrap().count() as i64
    };
    assert_eq!(dangling, 0, "重建后不应有悬挂外键引用");
}

/// 0029 把 `weigh_record` 从"磅单专用"改成两条单据链共用，并给出库单加上毛/皮两列。
///
/// 守的三件事都是只有真跑一遍 SQLite 才知道对不对：
///  1. **行保号**——`attachment.biz_id` 指着 `weigh_record.id`（过磅抓拍图），重建换号等于
///     把历史抓拍全部对不回称重记录，而这件事只在有人去点那张图时才暴露。
///  2. **`order_id` 上的外键真的没了**——留着它，出库那条轨迹要么写不进（那个数字在磅单里
///     不存在），要么更糟：碰巧是某张不相干磅单的 id，外键"通过"了、数据却是错的。
///  3. **唯一键按单据类型分开**——`uk_record` 不带 `doc_kind` 的话，出库 1 号与磅单 1 号
///     的第二捕会撞 `UNIQUE (order_id, seq)`，而现场表现只是"点捕获没反应"。
#[test]
fn migration_0029_weigh_record_serves_both_doc_chains() {
    let idx = MIGRATIONS
        .iter()
        .position(|m| m.name == "0029_outbound_scale_weigh.sql")
        .expect("0029 必须已在迁移清单里");
    let before: &'static [Migration] = &MIGRATIONS[..idx];
    let through_0029: &'static [Migration] = &MIGRATIONS[..idx + 1];
    let mut conn = in_memory_migrated("0.1.0-test", before).expect("0029 之前的脚本应能独立跑完");

    // 造一个"已经被引用过"的称重记录：磅单 + 两条轨迹（毛/皮各一）+ 挂在毛重那一条上的抓拍
    let user_id: i64 = conn
        .query_row("SELECT id FROM user_account ORDER BY id LIMIT 1", [], |r| r.get(0))
        .unwrap();
    let party_id: i64 = conn
        .query_row("SELECT id FROM party ORDER BY id LIMIT 1", [], |r| r.get(0))
        .ok()
        .unwrap_or_else(|| {
            // 档案不是种子数据（现场一份份建出来的），测试自己摆一个：磅单要求 party_id 非空
            conn.execute(
                "INSERT INTO party (name, party_type, status, created_at, created_by)
                 VALUES ('0029 测试档案', 'farmer', 'active', '2026-10-08T08:00:00.000', 1)",
                [],
            )
            .unwrap();
            conn.last_insert_rowid()
        });
    let variety_id: i64 = conn
        .query_row("SELECT id FROM grain_variety ORDER BY id LIMIT 1", [], |r| r.get(0))
        .unwrap();
    conn.execute(
        "INSERT INTO weigh_order (order_no, station_id, business_date, status, party_id, variety_id,
                 registered_by, registered_at, created_at, created_by)
         VALUES ('BD01TEST0001', (SELECT id FROM station WHERE is_active = 1 ORDER BY id LIMIT 1),
                 '2026-10-08', 'to_settle', ?1, ?2, ?3,
                 '2026-10-08T09:00:00.000', '2026-10-08T09:00:00.000', ?3)",
        rusqlite::params![party_id, variety_id, user_id],
    )
    .unwrap();
    let order_id: i64 = conn.query_row("SELECT id FROM weigh_order WHERE order_no = 'BD01TEST0001'", [], |r| r.get(0)).unwrap();
    for (seq, wt, w) in [(1, "gross", 25000_i64), (2, "tare", 12000_i64)] {
        conn.execute(
            "INSERT INTO weigh_record (order_id, seq, weigh_type, weight_01kg, aligned_weight_01kg,
                     is_adopted, source, stable, captured_at, operator_id)
             VALUES (?1, ?2, ?3, ?4, ?4, 1, 'scale', 1, '2026-10-08T09:10:00.000', ?5)",
            rusqlite::params![order_id, seq, wt, w, user_id],
        )
        .unwrap();
    }
    let gross_record: i64 = conn
        .query_row("SELECT id FROM weigh_record WHERE seq = 1", [], |r| r.get(0))
        .unwrap();
    conn.execute(
        "INSERT INTO attachment (biz_type, biz_id, file_path, file_size, sha256, captured_at, created_at, created_by)
         VALUES ('scale_capture', ?1, 'p/0029.jpg', 1, 'sha-0029', '2026-10-08T09:10:00.000', '2026-10-08T09:10:00.000', ?2)",
        rusqlite::params![gross_record, user_id],
    )
    .unwrap();

    let r = migrate::apply_with(&mut conn, "0.1.0-test", None, None, through_0029)
        .expect("0029 应当能重建 weigh_record（它是子表，不必关外键）");
    assert_eq!(r.applied, vec!["0029_outbound_scale_weigh.sql".to_string()]);

    // 1) 行保号 + 历史行一律归到磅单侧
    let kept: (i64, String, i64, String) = conn
        .query_row(
            "SELECT id, doc_kind, seq, weigh_type FROM weigh_record WHERE order_id = ?1 AND seq = 1",
            [order_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(kept, (gross_record, "weigh_order".to_string(), 1, "gross".to_string()), "重建必须原样保号并把历史行标成磅单侧");
    let photo_still_resolves: i64 = conn
        .query_row(
            "SELECT count(*) FROM attachment a JOIN weigh_record wr ON wr.id = a.biz_id WHERE a.sha256 = 'sha-0029'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(photo_still_resolves, 1, "历史抓拍必须还对得回称重记录，否则升级等于删了现场的照片");
    let total: i64 = conn.query_row("SELECT count(*) FROM weigh_record", [], |r| r.get(0)).unwrap();
    assert_eq!(total, 2, "重建不许多搬一行，也不许漏搬");

    // 2) 外键真的没了：这个 order_id 在 weigh_order 里不存在，出库侧照样写得进去
    conn.execute(
        "INSERT INTO weigh_record (doc_kind, order_id, seq, weigh_type, weight_01kg, aligned_weight_01kg,
                 is_adopted, source, stable, captured_at, operator_id)
         VALUES ('outbound_order', 999999, 1, 'gross', 30000, 30000, 1, 'scale', 1, '2026-10-08T10:00:00.000', ?1)",
        rusqlite::params![user_id],
    )
    .expect("order_id 上的外键必须已撤掉，否则出库轨迹根本落不进库");

    // 3) 唯一键按 doc_kind 分开：同一个数字、同一个序号，两张单据链各一条
    conn.execute(
        "INSERT INTO weigh_record (doc_kind, order_id, seq, weigh_type, weight_01kg, aligned_weight_01kg,
                 is_adopted, source, stable, captured_at, operator_id)
         VALUES ('outbound_order', ?1, 1, 'tare', 10000, 10000, 1, 'scale', 1, '2026-10-08T10:20:00.000', ?2)",
        rusqlite::params![order_id, user_id],
    )
    .expect("磅单 1 号与出库 1 号的 seq=1 必须互不冲突");
    let e = conn
        .execute(
            "INSERT INTO weigh_record (doc_kind, order_id, seq, weigh_type, weight_01kg, aligned_weight_01kg,
                     is_adopted, source, stable, captured_at, operator_id)
             VALUES ('outbound_order', ?1, 1, 'tare', 10000, 10000, 1, 'scale', 1, '2026-10-08T10:20:00.000', ?2)",
            rusqlite::params![order_id, user_id],
        )
        .unwrap_err()
        .to_string();
    assert!(e.contains("UNIQUE"), "同一条单据链内 (order_id, seq) 仍必须唯一，实际：{e}");

    // 新列的 CHECK 确实在：越界的 doc_kind 进不来
    let e = conn
        .execute(
            "INSERT INTO weigh_record (doc_kind, order_id, seq, weigh_type, weight_01kg, aligned_weight_01kg,
                     is_adopted, source, stable, captured_at, operator_id)
             VALUES ('qc_report', 1, 9, 'gross', 1, 1, 1, 'scale', 1, '2026-10-08T10:00:00.000', ?1)",
            rusqlite::params![user_id],
        )
        .unwrap_err()
        .to_string();
    assert!(e.contains("CHECK"), "越界 doc_kind 应被 CHECK 拦住，实际：{e}");

    // 出库单那两个新列在（迁移是 ALTER ADD COLUMN，漏一句就是运行时 no such column）
    let cols: Vec<String> = {
        let mut st = conn.prepare("SELECT name FROM pragma_table_info('outbound_order')").unwrap();
        st.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
    };
    for c in ["gross_weight_01kg", "tare_weight_01kg"] {
        assert!(cols.iter().any(|n| n == c), "outbound_order.{c} 没加上，捕获路径会在运行时炸");
    }

    let dangling: i64 = {
        let mut st = conn.prepare("PRAGMA foreign_key_check").unwrap();
        st.query_map([], |_| Ok(())).unwrap().count() as i64
    };
    assert_eq!(dangling, 0, "重建后不应有悬挂外键引用");
}

/// 0030 重建 `print_log` 只为把 `doc_type` 的值域扩两格，所以这里守的是"除了那一格，别的都没动"：
///  1. **行保号**——print_log 是审计流水，换号等于把历史留痕对不回经办人与单据；
///  2. **两个新值真写得进去**（写不进去的现场表现是"纸出来了、留痕失败"，浏览器预览看不出来）；
///  3. **值域仍有边界**——没扩进去的种类照样撞 CHECK，别把闸门一拆了之；
///  4. **两个索引按原口径建回**——`idx_print_doc(doc_type, doc_id)` 是详情页「已打几张」那条查询的口。
#[test]
fn migration_0030_widens_print_doc_type_without_disturbing_history() {
    let idx = MIGRATIONS
        .iter()
        .position(|m| m.name == "0030_print_doc_type_outbound.sql")
        .expect("0030 必须已在迁移清单里");
    let before: &'static [Migration] = &MIGRATIONS[..idx];
    let through_0030: &'static [Migration] = &MIGRATIONS[..idx + 1];
    let mut conn = in_memory_migrated("0.1.0-test", before).expect("0030 之前的脚本应能独立跑完");

    let user_id: i64 = conn
        .query_row("SELECT id FROM user_account ORDER BY id LIMIT 1", [], |r| r.get(0))
        .unwrap();
    // 老值域里已有的种类 + 一条补打，构成本次的"存量"
    for (n, dt) in [("A", "weigh_order"), ("B", "settlement_voucher")] {
        conn.execute(
            "INSERT INTO print_log (doc_type, doc_id, doc_no, copies, paper, printer_name, channel, is_reprint, result, printed_at, operator_id)
             VALUES (?1, 7, ?2, 1, 'A4', 'p1', 'pdf_silent', ?3, 'success', '2026-10-08T09:00:00.000', ?4)",
            rusqlite::params![dt, n, if n == "B" { 1 } else { 0 }, user_id],
        )
        .unwrap();
    }
    let ids_before: Vec<(i64, String, String, i64)> = {
        let mut st = conn.prepare("SELECT id, doc_type, doc_no, is_reprint FROM print_log ORDER BY id").unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    // 老值域此刻还不含付款小票——这正是历史上那个漏网：写得进 mock、写不进真库
    let before_err = conn
        .execute(
            "INSERT INTO print_log (doc_type, doc_id, doc_no, copies, paper, printer_name, channel, result, printed_at, operator_id)
             VALUES ('payment_receipt', 1, 'P', 1, 'thermal80', 'p1', 'raw', 'success', '2026-10-08T09:00:00.000', ?1)",
            rusqlite::params![user_id],
        )
        .unwrap_err()
        .to_string();
    assert!(before_err.contains("CHECK"), "0030 之前 payment_receipt 就该被拦（这条断言同时证明本测试真的跑在旧结构上）：{before_err}");

    let r = migrate::apply_with(&mut conn, "0.1.0-test", None, None, through_0030)
        .expect("0030 应当能重建 print_log（它是叶子表，不必关外键）");
    assert_eq!(r.applied, vec!["0030_print_doc_type_outbound.sql".to_string()]);

    let kept: Vec<(i64, String, String, i64)> = {
        let mut st = conn.prepare("SELECT id, doc_type, doc_no, is_reprint FROM print_log ORDER BY id").unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(kept, ids_before, "存量留痕必须原样保号、补打标记一位都不能变");

    for dt in ["payment_receipt", "outbound_order"] {
        conn.execute(
            "INSERT INTO print_log (doc_type, doc_id, doc_no, copies, paper, printer_name, channel, result, printed_at, operator_id)
             VALUES (?1, 1, ?2, 1, 'A4', 'p1', 'pdf_silent', 'success', '2026-10-08T10:00:00.000', ?3)",
            rusqlite::params![dt, dt, user_id],
        )
        .unwrap_or_else(|e| panic!("{dt} 的留痕写不进去，出库码单/付款小票的补打角标就永远不准：{e}"));
    }
    let e = conn
        .execute(
            "INSERT INTO print_log (doc_type, doc_id, doc_no, copies, paper, printer_name, channel, result, printed_at, operator_id)
             VALUES ('passport', 1, 'X', 1, 'A4', 'p1', 'preview', 'success', '2026-10-08T10:00:00.000', ?1)",
            rusqlite::params![user_id],
        )
        .unwrap_err()
        .to_string();
    assert!(e.contains("CHECK"), "值域仍要有边界，实际：{e}");

    let idx_names: Vec<String> = {
        let mut st = conn
            .prepare("SELECT name FROM pragma_index_list('print_log') WHERE name LIKE 'idx_print%' ORDER BY name")
            .unwrap();
        st.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
    };
    assert_eq!(idx_names, vec!["idx_print_date", "idx_print_doc"], "两个打印索引必须都建回来");
    let doc_cols: Vec<String> = {
        let mut st = conn
            .prepare("SELECT name FROM pragma_index_info('idx_print_doc') ORDER BY seqno")
            .unwrap();
        st.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
    };
    // 列序也钉住：`(doc_type, doc_id)` 最左前缀正是"这张单打过几次"那条查询走的口，
    // 建成 `(doc_id, doc_type)` 或丢了 doc_type，详情页每次打开都要全表扫 print_log
    assert_eq!(doc_cols, vec!["doc_type", "doc_id"], "idx_print_doc 的列序变了");

    let dangling: i64 = {
        let mut st = conn.prepare("PRAGMA foreign_key_check").unwrap();
        st.query_map([], |_| Ok(())).unwrap().count() as i64
    };
    assert_eq!(dangling, 0, "重建后不应有悬挂外键引用");
}

/// 0025 把样品号与留样号纳入统一取号，顺带回灌存量、建部分唯一索引。
///
/// 这条脚本最会咬人的不是回灌本身，而是**回灌完不给 `seq_counter` 补账**：某一天的号已经
/// 发到 000002，账上还是空的，升级后第一次保存化验单就重发 000001，一头撞在同一个脚本刚建起来的
/// 唯一索引上——现场表现是"升完级保存化验单必失败"，而且是主操作，不是边角。所以这里三段都钉：
/// 回灌结果、游标是否抬到已发号之上、以及拿手插行真把索引咬一口（占用的号必拒、下一个号必通）。
#[test]
fn migration_0025_backfills_sample_labels_and_seeds_the_counter() {
    let idx = MIGRATIONS
        .iter()
        .position(|m| m.name == "0025_qc_sample_no.sql")
        .expect("0025 必须还在迁移清单里");
    let before: &'static [Migration] = &MIGRATIONS[..idx];
    let mut conn = in_memory_migrated("0.1.0-test", before).expect("0025 之前的脚本应能独立跑完");

    // 日期段取**今天**：回灌沿用当初的化验日，而升级后新取的号按本机当天走，
    // 两者落在同一个日桶里，才测得出"补的账到底接不接得上"。
    let today = Local::now().format("%Y-%m-%d").to_string();
    let tomorrow = (Local::now() + chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
    let ymd = Local::now().format("%Y%m%d").to_string();

    let (a, b): (i64, i64) = {
        let xm: i64 = conn
            .query_row("SELECT id FROM grain_variety WHERE code = 'XM'", [], |r| r.get(0))
            .unwrap();
        let stamp = |t: &str| format!("{today}T{t}:00.000+08:00");
        conn.execute(
            "INSERT INTO party (name, party_type, created_at, created_by) VALUES ('存量户','farmer',?1,1)",
            rusqlite::params![stamp("08:00")],
        )
        .unwrap();
        let party = conn.last_insert_rowid();
        let new_order = |no: &str| -> i64 {
            conn.execute(
                "INSERT INTO weigh_order (order_no, station_id, business_date, status, party_id, variety_id,
                     deduct_total_01kg, weight_source, registered_by, registered_at, created_at, created_by)
                 VALUES (?1, 1, ?2, 'registered', ?3, ?4, 0, 'scale', 1, ?5, ?5, 1)",
                rusqlite::params![no, today, party, xm, stamp("08:00")],
            )
            .unwrap();
            conn.last_insert_rowid()
        };
        // 旧写法的两种翻车形状都摆出来：同一天两张单的样品号一模一样、留样号更是全站的同一串
        let new_report = |no: &str, oid: i64, eff: i64, at: &str, sample: Option<&str>, retention: Option<&str>| {
            conn.execute(
                "INSERT INTO qc_report (report_no, order_id, sample_no, variety_id, decision, test_method,
                     is_effective, inspector_id, inspected_at, retention_no, retention_until, created_at, created_by)
                 VALUES (?1, ?2, ?3, ?4, 'accept', 'lab', ?5, 1, ?6, ?7, '2099-01-01', ?6, 1)",
                rusqlite::params![no, oid, sample, xm, eff, at, retention],
            )
            .unwrap();
        };
        let a = new_order("01LEGACY000001");
        let b = new_order("01LEGACY000002");
        new_report("0120261008000401", a, 1, &stamp("09:00"), Some("YP261008001"), Some("LY261008M"));
        // 复检拖到次日：旧写法按天拼号，同一单的两行于是拿到**两个**样品号（瓶只有一瓶）
        new_report("0120261008000402", a, 0, &format!("{tomorrow}T10:00:00.000+08:00"), Some("YP261009001"), Some("LY261009M"));
        new_report("0120261008000403", b, 1, &stamp("11:00"), Some("YP261008001"), Some("LY261008M"));
        // 第三张单没留样（拒收那一路），两列都是空——回灌不许无中生有给它发号
        let c = new_order("01LEGACY000003");
        new_report("0120261008000404", c, 1, &stamp("12:00"), None, None);
        // ★ 空串不是"没号"，是一个**有值但为空**的值：SQLite 的 UNIQUE 允许任意多个 NULL
        //   并存，却会把两个 '' 判成重复。装机库里只要有一行是这样（早期手改库、或从
        //   老备份里回来的行），回灌后建索引就会在 COMMIT 上炸——正是 0024 那个闪退形状。
        let d = new_order("01LEGACY000004");
        let e = new_order("01LEGACY000005");
        new_report("0120261008000405", d, 1, &stamp("13:00"), Some(""), Some(""));
        new_report("0120261008000406", e, 1, &stamp("14:00"), Some(""), Some(""));
        (a, b)
    };
    // ── 回灌前先逐条钉住脏形状确实种进去了：零行会让下面所有断言空转成"假绿"
    let same_day: i64 = conn
        .query_row("SELECT COUNT(*) FROM qc_report WHERE is_effective = 1 AND retention_no = 'LY261008M'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(same_day, 2, "两张有效单的留样号应当就是同一串——这正是要修的形状，别让它悄悄改掉");
    let two_labels: i64 = conn
        .query_row("SELECT COUNT(DISTINCT sample_no) FROM qc_report WHERE order_id = ?1", rusqlite::params![a], |r| r.get(0))
        .unwrap();
    assert_eq!(two_labels, 2, "同一单的首检与次日复检在旧写法下拿到两个号（瓶只有一瓶）");
    let empty_rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM qc_report WHERE is_effective = 1 AND retention_no = ''", [], |r| r.get(0))
        .unwrap();
    assert_eq!(empty_rows, 2, "两行空串——UNIQUE 容得下任意多个 NULL，却会把两个 '' 判成重复");

    let through_0025: &'static [Migration] = &MIGRATIONS[..idx + 1];
    let r = migrate::apply_with(&mut conn, "0.1.0-test", None, None, through_0025)
        .expect("0025 应当能回灌存量样品号/留样号并建起部分唯一索引（同值行已先改号）");
    assert_eq!(r.applied, vec!["0025_qc_sample_no.sql".to_string()]);

    let one = |sql: &str, oid: i64| -> String {
        conn.query_row(sql, rusqlite::params![oid], |r| r.get(0)).unwrap()
    };
    assert_eq!(
        one("SELECT sample_no FROM qc_report WHERE order_id = ?1 ORDER BY id LIMIT 1", a),
        format!("YP01{ymd}000001"),
        "新号形：YP + 站码2 + 到日的 8 位 + 流水6"
    );
    assert_eq!(
        one("SELECT sample_no FROM qc_report WHERE order_id = ?1 ORDER BY id LIMIT 1", b),
        format!("YP01{ymd}000002"),
        "同日两张单回灌后必须各一枚号"
    );
    assert_eq!(
        one("SELECT retention_no FROM qc_report WHERE order_id = ?1 ORDER BY id LIMIT 1", a),
        format!("LY01{ymd}000001")
    );
    let per_order: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT sample_no) FROM qc_report WHERE order_id = ?1 AND sample_no IS NOT NULL",
            rusqlite::params![a],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(per_order, 1, "同一单的复检留档行必须与首检并成一枚号（一单一号，§3.5 例外条）");
    let merged: i64 = conn
        .query_row("SELECT COUNT(DISTINCT sample_no) FROM qc_report WHERE order_id = ?1", rusqlite::params![a], |r| r.get(0))
        .unwrap();
    assert_eq!(merged, 1, "首检与次日复检的两行必须并成一枚号，且用的是首检那天的日期段");
    let still_empty: i64 = conn
        .query_row("SELECT COUNT(*) FROM qc_report WHERE sample_no = '' OR retention_no = ''", [], |r| r.get(0))
        .unwrap();
    assert_eq!(still_empty, 0, "空串必须回灌成真 NULL：留着它，两行 '' 会在唯一索引上判重，升级当场炸在 COMMIT");

    let untouched: Option<String> = conn
        .query_row("SELECT sample_no FROM qc_report WHERE order_id = (SELECT id FROM weigh_order WHERE order_no = '01LEGACY000003')", [], |r| r.get(0))
        .unwrap();
    assert_eq!(untouched, None, "本来没留样的行回灌后仍是空，不许无中生有发一个号");

    for doc in ["YP", "LY"] {
        let cur: i64 = conn
            .query_row("SELECT current FROM seq_counter WHERE prefix_key = ?1", rusqlite::params![format!("{doc}:01:{ymd}")], |r| r.get(0))
            .unwrap();
        assert_eq!(cur, 2, "{doc} 的按日游标必须抬到已发号之上，漏了这一步升级后第一次取号就撞自己的索引");
    }
    let partial: String = conn
        .query_row("SELECT \"sql\" FROM sqlite_master WHERE name = 'uk_qc_sample'", [], |r| r.get(0))
        .unwrap();
    assert!(partial.contains("UNIQUE") && partial.contains("WHERE is_effective"), "索引必须是建在有效行上的部分唯一索引，否则复检复用同一枚号会被自己拦死：{partial}");

    // 索引与游标各咬一口：占用中的号必拒，游标指向的下一个号必通，留档行复用必通
    let xm: i64 = conn.query_row("SELECT id FROM grain_variety WHERE code = 'XM'", [], |r| r.get(0)).unwrap();
    let party: i64 = conn.query_row("SELECT id FROM party ORDER BY id LIMIT 1", [], |r| r.get(0)).unwrap();
    let stamp = format!("{today}T13:00:00.000+08:00");
    conn.execute(
        "INSERT INTO weigh_order (order_no, station_id, business_date, status, party_id, variety_id,
             deduct_total_01kg, weight_source, registered_by, registered_at, created_at, created_by)
         VALUES ('01LEGACY000009', 1, ?1, 'registered', ?2, ?3, 0, 'scale', 1, ?4, ?4, 1)",
        rusqlite::params![today, party, xm, stamp],
    )
    .unwrap();
    let probe = |no: &str, sample: &str, eff: i64| -> Result<(), rusqlite::Error> {
        conn.execute(
            "INSERT INTO qc_report (report_no, order_id, sample_no, variety_id, decision, test_method,
                 is_effective, inspector_id, inspected_at, retention_no, created_at, created_by)
             VALUES (?1, (SELECT id FROM weigh_order WHERE order_no = '01LEGACY000009'), ?2, ?3, 'accept', 'lab', ?4, 1, ?5, 'LY-不撞的那一列', ?5, 1)",
            rusqlite::params![no, sample, xm, eff, stamp],
        )
        .map(|_| ())
    };
    let e = probe("0120261008000409", &format!("YP01{ymd}000002"), 1).unwrap_err().to_string();
    assert!(e.contains("qc_report.sample_no"), "占用中的样品号必须被唯一索引拦下，实际：{e}");
    probe("0120261008000410", &format!("YP01{ymd}000003"), 1).expect("游标指向的下一个号必须能落——它正是升级后第一次取号拿到的那个");
    probe("0120261008000411", &format!("YP01{ymd}000003"), 0).expect("留档行复用同一枚号必须放行（一单一号的余地）");
}

/// 0027 把样品号与留样号从化验单搬回磅单。这条脚本的两个失败面都要钉：**搬家丢号**
/// （磅单上没落下来，历史单的样品号从此查不到，纸质质检单与库对不上）和
/// **旧列没撤干净**（留着一份没人维护的副本，早晚漂移成两份真相）。
/// 顺带把"根治"这件事本身钉住：索引必须变成不带 WHERE 的全表唯一，且真的咬人。
#[test]
fn migration_0027_moves_sample_labels_onto_the_order_and_retires_the_old_columns() {
    let idx = MIGRATIONS
        .iter()
        .position(|m| m.name == "0027_qc_labels_to_order.sql")
        .expect("0027 必须还在迁移清单里");
    let before: &'static [Migration] = &MIGRATIONS[..idx];
    let mut conn = in_memory_migrated("0.1.0-test", before).expect("0027 之前的脚本应能独立跑完");

    let today = Local::now().format("%Y-%m-%d").to_string();
    let ymd = Local::now().format("%Y%m%d").to_string();
    let xm: i64 = conn
        .query_row("SELECT id FROM grain_variety WHERE code = 'XM'", [], |r| r.get(0))
        .unwrap();
    conn.execute(
        "INSERT INTO party (name, party_type, created_at, created_by) VALUES ('搬家户','farmer',?1,1)",
        rusqlite::params![format!("{today}T08:00:00.000+08:00")],
    )
    .unwrap();
    let party = conn.last_insert_rowid();
    let new_order = |no: &str| -> i64 {
        conn.execute(
            "INSERT INTO weigh_order (order_no, station_id, business_date, status, party_id, variety_id,
                 deduct_total_01kg, weight_source, registered_by, registered_at, created_at, created_by)
             VALUES (?1, 1, ?2, 'registered', ?3, ?4, 0, 'scale', 1, ?5, ?5, 1)",
            rusqlite::params![no, today, party, xm, format!("{today}T08:00:00.000+08:00")],
        )
        .unwrap();
        conn.last_insert_rowid()
    };
    // 库里 `retention_until` 写的是日期（`%Y-%m-%d`），种子照这个口径给，别用时间戳糊过去
    let new_report = |no: &str, oid: i64, eff: i64, day: &str, sample: &str, retention: &str, until: &str| {
        conn.execute(
            "INSERT INTO qc_report (report_no, order_id, sample_no, variety_id, decision, test_method,
                 is_effective, inspector_id, inspected_at, retention_no, retention_until, created_at, created_by)
             VALUES (?1, ?2, ?3, ?4, 'accept', 'lab', ?5, 1, ?6, ?7, ?8, ?6, 1)",
            rusqlite::params![no, oid, sample, xm, eff, format!("{day}T09:00:00.000+08:00"), retention, until],
        )
        .unwrap();
    };
    // 三张化验过的单：其中一张是跨天复检链（旧写法留过两个号，搬家必须并成一枚），
    // 再加一张从没化验的单——它的三列在搬完之后必须是 NULL，不能被回填误填
    let a = new_order("01MOVE00000001");
    let b = new_order("01MOVE00000002");
    let c = new_order("01MOVE00000003");
    let never_qc = new_order("01MOVE00000004");
    new_report("0120261008000601", a, 1, &today, &format!("YP01{ymd}000001"), &format!("LY01{ymd}000001"), &format!("{today}"));
    new_report("0120261008000602", b, 1, &today, &format!("YP01{ymd}000002"), &format!("LY01{ymd}000002"), &format!("{today}"));
    new_report("0120261008000603", b, 0, &today, &format!("YP01{ymd}000002"), &format!("LY01{ymd}000002"), &format!("{today}"));
    new_report("0120261008000604", c, 1, "2026-10-07", "YP0120261007000009", "LY0120261007000009", "2026-11-06");

    let through_0027: &'static [Migration] = &MIGRATIONS[..idx + 1];
    let r = migrate::apply_with(&mut conn, "0.1.0-test", None, None, through_0027)
        .expect("0027 应当把两枚号搬到磅单上并撤掉化验单侧的旧列");
    assert_eq!(r.applied, vec!["0027_qc_labels_to_order.sql".to_string()]);

    // ① 号没丢，且一单一枚
    let on_order = |oid: i64| -> (Option<String>, Option<String>, Option<String>) {
        conn.query_row(
            "SELECT sample_no, retention_no, retention_until FROM weigh_order WHERE id = ?1",
            rusqlite::params![oid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    };
    assert_eq!(on_order(a).0.as_deref(), Some(format!("YP01{ymd}000001").as_str()), "首检单的样品号必须搬到磅单上");
    assert_eq!(on_order(a).1.as_deref(), Some(format!("LY01{ymd}000001").as_str()));
    assert_eq!(on_order(b).0.as_deref(), Some(format!("YP01{ymd}000002").as_str()), "复检链搬完仍是一枚");
    assert_eq!(on_order(c).0.as_deref(), Some("YP0120261007000009"), "取该单最早那行带号的化验记录");
    assert_eq!(on_order(c).2.as_deref(), Some("2026-11-06"), "留样到期日跟瓶走，搬的是首次那天算出来的值");
    assert_eq!(on_order(never_qc), (None, None, None), "没化验过的单三列必须是 NULL——回填不许无中生有");

    // ② 旧列真的撤干净了：留着就是一份没人维护的副本
    let qc_cols: Vec<String> = {
        let mut st = conn.prepare("PRAGMA table_info(qc_report)").unwrap();
        st.query_map([], |r| r.get::<_, String>(1)).unwrap().collect::<Result<_, _>>().unwrap()
    };
    for gone in ["sample_no", "retention_no", "retention_until"] {
        assert!(!qc_cols.iter().any(|c| c == gone), "qc_report.{gone} 没撤掉，两份真相迟早漂移");
    }

    // ③ 索引形态：全表唯一（不带 WHERE），而且真的咬人。
    // 用 `PRAGMA index_list` 而不是查 `sqlite_master`——后者压根没有 partial 这一列，
    // `sqlite_sequence` 那种印象是错的，写上去只会 "no such column: partial"。
    let idx_rows: Vec<(String, i64, i64)> = {
        let mut st = conn.prepare("PRAGMA index_list(weigh_order)").unwrap();
        st.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(4)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    for name in ["uk_order_sample", "uk_order_retention"] {
        let (_, uniq, partial) = idx_rows.iter().find(|(n, _, _)| n == name).unwrap_or_else(|| panic!("{name} 必须存在，实际索引：{idx_rows:?}"));
        assert_eq!(*uniq, 1, "{name} 必须是唯一索引");
        assert_eq!(*partial, 0, "{name} 不该再带 WHERE——一单一行由表结构保证，这正是这次搬家要换来的东西");
    }
    let qc_idx: Vec<String> = {
        let mut st = conn.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='qc_report' AND name NOT LIKE 'sqlite_%'").unwrap();
        st.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
    };
    assert!(!qc_idx.iter().any(|n| n == "uk_qc_sample" || n == "uk_qc_retention"), "化验单侧的部分唯一索引必须撤掉：{qc_idx:?}");

    let clash = conn.execute(
        "UPDATE weigh_order SET sample_no = ?1 WHERE id = ?2",
        rusqlite::params![format!("YP01{ymd}000001"), b],
    );
    let e = clash.unwrap_err().to_string();
    assert!(e.contains("weigh_order.sample_no"), "两张磅单共用一枚样品号必须被全表唯一拦下，实际：{e}");
    // NULL 可并存：未化验的单可以无限多张，这既是 0025 空串事故的反面，也是搬家后仍要成立的前提
    conn.execute("UPDATE weigh_order SET retention_no = NULL WHERE id IN (?1, ?2)", rusqlite::params![a, never_qc])
        .expect("多行 NULL 必须能并存（唯一索引不拦 NULL，所以空号一律用 NULL 表示）");
}

/// 0017 磅单品种改可空。这条迁移的写法是 `DROP COLUMN` + `ADD COLUMN`（重建表要把
/// `weigh_order` 上 9 条外键关系全拖进文本改写），而 **`DROP COLUMN` 连数据一起消失**——
/// 老站升完级历史单的品种全变成空，是那种"升级当天没人发现、月底对账才炸"的错。
/// 所以这里按行断言存量品种保号，顺带钉住三个配套的收尾：列真的可空、
/// `v_open_order` 已换 LEFT JOIN（否则没品种的在途单从看板上凭空消失）、索引建回。
#[test]
fn migration_0017_keeps_legacy_varieties_and_lets_new_rows_be_null() {
    // 按名字定位，别写 len()-1：以后再往末尾补 0018、0019 时这条测试不必跟着改
    let idx = MIGRATIONS
        .iter()
        .position(|m| m.name == "0017_order_variety_nullable.sql")
        .expect("0017 必须还在迁移清单里");
    let before: &'static [Migration] = &MIGRATIONS[..idx];
    let mut conn = in_memory_migrated("0.1.0-test", before).expect("0017 之前的脚本应能独立跑完");

    let xm: i64 = conn
        .query_row("SELECT id FROM grain_variety WHERE code = 'XM'", [], |r| r.get(0))
        .unwrap();
    // 第二行故意挂**另一个**品种：备份/还原那条相关子查询要是写错了关联条件，
    // 最典型的翻车是整表被盖成同一个品种——只有一行有品种照样查不出来。
    let ym: i64 = conn
        .query_row("SELECT id FROM grain_variety WHERE code = 'YM'", [], |r| r.get(0))
        .unwrap();
    conn.execute(
        "INSERT INTO party (name, party_type, created_at, created_by) VALUES ('存量户', 'farmer', '2026-09-01T08:00:00.000', 1)",
        [],
    )
    .unwrap();
    let party = conn.last_insert_rowid();
    let ins = |no: &str, variety: Option<i64>| {
        conn.execute(
            "INSERT INTO weigh_order (order_no, station_id, business_date, status, party_id, variety_id,
                 deduct_total_01kg, weight_source, registered_by, registered_at, created_at, created_by)
             VALUES (?1, 1, '2026-09-01', 'registered', ?2, ?3, 0, 'scale', 1, '2026-09-01T08:00:00.000', '2026-09-01T08:00:00.000', 1)",
            rusqlite::params![no, party, variety],
        )
        .unwrap();
    };
    // 迁移前这一列还是 NOT NULL，所以存量行只能带着品种来——这正是 0017 要放开的那道闸
    ins("BD01202609000001", Some(xm));
    ins("BD01202609000002", Some(ym));

    // 补跑 0017：走生产同一执行器（校验和、逐脚本事务、记账都真）
    let through_0017: &'static [Migration] = &MIGRATIONS[..idx + 1];
    let r = migrate::apply_with(&mut conn, "0.1.0-test", None, None, through_0017).expect("0017 应当补齐并成功");
    assert_eq!(r.applied, vec!["0017_order_variety_nullable.sql".to_string()]);

    let kept: Option<i64> = conn
        .query_row("SELECT variety_id FROM weigh_order WHERE order_no = 'BD01202609000001'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(kept, Some(xm), "存量单的品种必须逐行还原，不许被 DROP COLUMN 带走");
    let kept2: Option<i64> = conn
        .query_row("SELECT variety_id FROM weigh_order WHERE order_no = 'BD01202609000002'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(kept2, Some(ym), "第二行还原成它自己的品种——整表盖成同一个也是「升级当天没人发现」的错");

    // 列确实可空了：新单不写品种也落得下去
    conn.execute(
        "INSERT INTO weigh_order (order_no, station_id, business_date, status, party_id,
             deduct_total_01kg, weight_source, registered_by, registered_at, created_at, created_by)
         VALUES ('BD01202609000003', 1, '2026-09-01', 'registered', ?1, 0, 'scale', 1, '2026-09-01T08:00:00.000', '2026-09-01T08:00:00.000', 1)",
        rusqlite::params![party],
    )
    .expect("制单不带品种必须能落库（02 §F1.1 两刷零按键）");

    // 视图换成 LEFT JOIN 的真正目的：没品种的在途单还得出现在看板与在途条上
    let open: Vec<(String, Option<String>)> = {
        let mut st = conn
            .prepare("SELECT order_no, variety_name FROM v_open_order WHERE station_id = 1 ORDER BY order_no")
            .unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(open.len(), 3, "三张在途单都要看得见，实际：{open:?}");
    assert_eq!(open[0].1.as_deref(), Some("小麦"), "有品种的仍带出品种名");
    assert_eq!(open[1].1.as_deref(), Some("玉米"), "第二行带出自己的品种，视图不许串行串到别人身上");
    assert_eq!(open[2].1, None, "没品种的那张视图里是 NULL，不是整行消失");

    // 索引建回（日报按品种+日期分组走它）；DROP COLUMN 会连带删掉引用它的索引
    let idx_back: i64 = conn
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_order_variety_date'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(idx_back, 1, "idx_order_variety_date 必须原样建回");

    // 新列带着 REFERENCES 加回来：坏品种号照样顶不动，且整库外键体检归零
    let e = conn
        .execute(
            "UPDATE weigh_order SET variety_id = 99999 WHERE order_no = 'BD01202609000003'",
            [],
        )
        .unwrap_err()
        .to_string();
    assert!(e.contains("FOREIGN KEY"), "新列的外键约束要真生效，实际：{e}");
    let fk_bad: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_check('weigh_order')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(fk_bad, 0, "迁移后的外键体检必须干净");
}

/// 覆盖安装端到端：走生产同一条 `open_and_migrate`，记号是临时目录里**真的**
/// `install.stamp` 文件（安装包 NSIS 钩子写的），只认它的修改时间。
/// 「首装 → 重启若干 → 再覆盖装 → 重启」全程：每次"新安装"恰好一份快照，普通重启零噪音。
#[test]
fn overwrite_install_snapshots_once_per_install() {
    let dir = temp_dir("stamp-e2e");
    let stamp = dir.join(banghe_lib::db::INSTALL_STAMP_FILE);
    {
        let (_db, r) = banghe_lib::db::open_and_migrate(&dir, "0.1.0-e2e").unwrap();
        assert!(r.backup_path.is_none(), "空库首装没有可回退的东西，不拍快照");
    }
    std::fs::write(&stamp, b"banghe").unwrap();
    {
        let (_db, r) = banghe_lib::db::open_and_migrate(&dir, "0.1.0-e2e").unwrap();
        let b = r.backup_path.expect("覆盖安装后的首次启动必须在写入前留下快照");
        let name = b.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("pre_upgrade_0.1.0-e2e_"), "同版本重装的名字只带当前版本：{name}");
        assert!(b.exists() && b.metadata().unwrap().len() > 0, "快照没落盘：{b:?}");
    }
    {
        // 记号没变（之后都是普通重启）：不重复备份
        let (_db, r) = banghe_lib::db::open_and_migrate(&dir, "0.1.0-e2e").unwrap();
        assert!(r.backup_path.is_none(), "同一次安装只备份一次，不能被同一记号反复触发");
    }
    // 第二次覆盖安装：安装器重写记号，mtime 必变。睡 1.1 秒是因为快照名按秒打戳，
    // 同秒撞名走的是 fail-closed（宁可拒启也不覆盖退路），测试不该去踩这条生产守卫。
    std::thread::sleep(std::time::Duration::from_millis(1100));
    std::fs::write(&stamp, b"banghe").unwrap();
    {
        let (_db, r) = banghe_lib::db::open_and_migrate(&dir, "0.1.0-e2e").unwrap();
        assert!(r.backup_path.is_some(), "每一次覆盖安装都要各留一份退路");
    }
    std::fs::remove_dir_all(&dir).ok();
}

/// 版本号变了就是升级——哪怕没有安装器记号（绿色拷贝、老安装包）：
/// 先拍 `pre_upgrade_<旧版>_to_<新版>_` 快照，记账之后普通重启不再触发。
#[test]
fn version_bump_without_marker_snapshots_pre_upgrade() {
    let dir = temp_dir("ver-bump");
    {
        let (_db, r) = banghe_lib::db::open_and_migrate(&dir, "0.1.0-a").unwrap();
        assert!(r.backup_path.is_none(), "首装不拍");
    }
    {
        let (_db, r) = banghe_lib::db::open_and_migrate(&dir, "0.2.0").unwrap();
        let b = r.backup_path.expect("版本变了、开库写入前必须备份");
        assert!(
            b.file_name().unwrap().to_string_lossy().starts_with("pre_upgrade_0.1.0-a_to_0.2.0_"),
            "名字要能看出从哪个版本升到哪个版本：{b:?}"
        );
    }
    {
        let (_db, r) = banghe_lib::db::open_and_migrate(&dir, "0.2.0").unwrap();
        assert!(r.backup_path.is_none(), "新版本已经记进账，重启就是普通启动");
    }
    std::fs::remove_dir_all(&dir).ok();
}

/// 改了历史脚本 → 校验和拦下，绝不"顺手再跑一遍"
#[test]
fn tampered_applied_script_refuses_startup() {
    let conn = &mut migrated_conn();
    conn.execute(
        "UPDATE schema_migration SET checksum='0000000000000000000000000000000000000000000000000000000000000000' WHERE name='0001_init.sql'",
        [],
    )
    .unwrap();
    let e = migrate::apply(conn, "0.1.0-test", None, None).unwrap_err();
    assert!(
        matches!(e, migrate::MigrateError::ChecksumMismatch { .. }),
        "应当报校验和不一致，实际：{e:?}"
    );
    assert!(e.to_string().contains("不允许修改"), "现场提示要说明怎么办：{e}");
}

/// 校验和只认内容，不认检出时的换行符：`core.autocrlf=true` 的机器把 .sql 检出成
/// CRLF，逐字节哈希会让同一份脚本算出两个值，两台机器互相拒启。
/// 同时钉住反向：真的改了内容照样要不同和，别把归一做成把守卫关掉。
#[test]
fn checksum_ignores_line_endings() {
    static LF: &str = "CREATE TABLE t(x INT);\nINSERT INTO t VALUES (1);\n";
    static CRLF: &str = "CREATE TABLE t(x INT);\r\nINSERT INTO t VALUES (1);\r\n";
    static TAMPERED: &str = "CREATE TABLE t(x INT);\nINSERT INTO t VALUES (2);\n";

    let of = |sql: &'static str| Migration { name: "x.sql", sql }.checksum();
    assert_eq!(of(LF), of(CRLF), "同一份脚本换行符不同也必须同和");
    assert_ne!(of(LF), of(TAMPERED), "改了一个字符就必须不同和");
}

/// 老库兼容：换行归一之前 Windows 构建记的是 CRLF flavor 哈希 → 启动时补记一次并
/// 放行（现场从那种构建升上来不该拒启），库里随即换成规范值，第二次不再触发。
#[test]
fn legacy_crlf_checksum_is_healed_once_and_accepted() {
    let conn = &mut migrated_conn();
    let m = &MIGRATIONS[0];
    assert_ne!(
        m.checksum(),
        m.crlf_checksum(),
        "脚本按 LF 检出时两种 flavor 必须不同，否则这条测试没意义"
    );
    conn.execute(
        "UPDATE schema_migration SET checksum=?1 WHERE name=?2",
        rusqlite::params![m.crlf_checksum(), m.name],
    )
    .unwrap();

    let r = migrate::apply(conn, "0.1.0-test", None, None).expect("老哈希应补记后放行，而不是拒启");
    assert_eq!(r.healed, vec![m.name.to_string()], "补记要报告是哪支脚本");
    let stored: String = conn
        .query_row(
            "SELECT checksum FROM schema_migration WHERE name=?1",
            rusqlite::params![m.name],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored, m.checksum(), "补记后库里应当是规范值");

    let r2 = migrate::apply(conn, "0.1.0-test", None, None).unwrap();
    assert!(r2.healed.is_empty(), "第二次启动不该再补记");

    // 反向：既不是规范值也不是 CRLF 值 → 照样拒启，补记不能变成后门
    conn.execute(
        "UPDATE schema_migration SET checksum='deadbeef' WHERE name=?1",
        rusqlite::params![m.name],
    )
    .unwrap();
    assert!(
        matches!(
            migrate::apply(conn, "0.1.0-test", None, None).unwrap_err(),
            migrate::MigrateError::ChecksumMismatch { .. }
        ),
        "对不上任何合法 flavor 的哈希必须仍然拦下"
    );
}

/// 库来自更新的程序版本：拒绝启动（不能"忽略未知列"继续收粮）
#[test]
fn newer_database_version_refuses_startup() {
    // 版本更高
    let conn = &mut migrated_conn();
    conn.execute(
        "INSERT INTO schema_migration(name,checksum,applied_at,app_version) VALUES ('0099_future.sql','x','2026-09-11T00:00:00.000+08:00','9.9.9')",
        [],
    )
    .unwrap();
    let e = migrate::apply(conn, "0.1.0-test", None, None).unwrap_err();
    assert!(
        matches!(e, migrate::MigrateError::Downgrade { db: 99, app } if app == MIGRATIONS.len() as u32),
        "实际：{e:?}"
    );
    assert!(e.to_string().contains("恢复"), "提示要给出回退路径：{e}");

    // 版本不高但脚本不认识
    let conn = &mut migrated_conn();
    conn.execute(
        "INSERT INTO schema_migration(name,checksum,applied_at,app_version) VALUES ('0001_ghost.sql','x','2026-09-11T00:00:00.000+08:00','0.0.1')",
        [],
    )
    .unwrap();
    let e = migrate::apply(conn, "0.1.0-test", None, None).unwrap_err();
    assert!(matches!(e, migrate::MigrateError::UnknownScript { .. }), "实际：{e:?}");
}

/// 脚本中途失败 → 整体回滚，库里不留下"改了一半"的结构，账上也没记
#[test]
fn failed_script_rolls_back_and_is_not_recorded() {
    static BROKEN: &[Migration] = &[
        Migration {
            name: "0001_init.sql",
            sql: include_str!("../src/db/migrations/0001_init.sql"),
        },
        Migration {
            name: "0002_broken.sql",
            sql: "INSERT INTO no_such_table (x) VALUES (1);",
        },
    ];
    let mut conn = Connection::open_in_memory().unwrap();
    banghe_lib::db::setup_pragmas_memory(&conn).unwrap();
    let e = migrate::apply_with(&mut conn, "0.1.0-test", None, None, BROKEN).unwrap_err();
    assert!(matches!(e, migrate::MigrateError::Failed { .. }), "实际：{e:?}");
    let recorded: Vec<String> = conn
        .prepare("SELECT name FROM schema_migration ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(recorded, vec!["0001_init.sql".to_string()], "失败脚本不应记账");
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM grain_variety", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 0, "回滚后不该有品种数据");
    let ver: Option<String> = conn
        .query_row("SELECT value FROM app_meta WHERE key='schema_version'", [], |r| r.get(0))
        .ok();
    assert_eq!(ver, None, "迁移未全程成功，不该写 schema_version");
}

/// 外键真的在生效：§1.2 的 `foreign_keys=ON` 与 §9 的 FK 不是装饰
#[test]
fn foreign_keys_are_enforced() {
    let conn = migrated();
    let e = conn.execute(
        "INSERT INTO weigh_record (order_id, seq, weigh_type, weight_01kg, aligned_weight_01kg, captured_at, operator_id)
         VALUES (999999, 1, 'gross', 1000, 1000, '2026-09-11T08:00:00.000+08:00', 1)",
        [],
    );
    assert!(e.is_err(), "悬挂外键必须被拒，实际成功：{e:?}");
    // 枚举 CHECK 同样在挡脏值
    let e2 = conn.execute(
        "INSERT INTO party (name, party_type, created_at, created_by)
         VALUES ('测试', 'zhuanhu', '2026-09-11T08:00:00.000+08:00', 1)",
        [],
    );
    assert!(e2.is_err(), "未登记的业务类型必须被 CHECK 拒绝");
    let e3 = conn.execute(
        "INSERT INTO party (name, party_type, created_at, created_by)
         VALUES ('测试', 'farmer', '2026-09-11T08:00:00.000+08:00', 1)",
        [],
    );
    assert!(e3.is_ok(), "登记内的值应当可写：{e3:?}");
}

fn migrated_conn() -> Connection {
    migrated()
}

fn temp_dir(tag: &str) -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let p = std::env::temp_dir().join(format!("banghe-{tag}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&p).unwrap();
    assert!(p.is_dir());
    p
}

/// 版本号四处单源。
///
/// `app_version` 不只是一个显示字符串：它进 `app_meta`、进「覆盖安装/升级首启」的
/// `pre_upgrade_<旧版>_to_<新版>` 快照名、进装机包文件名。而界面上那行脚注以前是
/// 写死的字面量，升版本时没人回头改它——现象就是"跑着新版本、报着上一个版本"，
/// 现场贴图过来排查时还会把人往错误的构建上带。
///
/// 这里把四处钉成同一个值，并禁止前端再出现第二个版本号来源。
#[test]
fn app_version_is_single_sourced() {
    let first_capture = |pattern: &str, text: &str, where_: &str| -> String {
        re(pattern)
            .captures(text)
            .unwrap_or_else(|| panic!("{where_} 里找不到版本号（口径 {pattern}）"))
            [1]
            .to_string()
    };

    let npm = first_capture(r#""version"\s*:\s*"([^"]+)""#, &read("../package.json"), "package.json");
    let conf = first_capture(
        r#""version"\s*:\s*"([^"]+)""#,
        &read("tauri.conf.json"),
        "tauri.conf.json",
    );
    // Cargo.toml 里 [dependencies] 段也有 version = "..."，只认顶格的（[package] 段那一条）
    let cargo = first_capture(r#"(?m)^version\s*=\s*"([^"]+)""#, &read("Cargo.toml"), "Cargo.toml");
    let locked = first_capture(
        r#"name = "banghe"\r?\nversion = "([^"]+)""#,
        &read("Cargo.lock"),
        "Cargo.lock",
    );

    assert_eq!(npm, conf, "package.json 与 tauri.conf.json 的版本号分叉了");
    assert_eq!(npm, cargo, "package.json 与 Cargo.toml 的版本号分叉了");
    assert_eq!(
        npm, locked,
        "Cargo.lock 没跟着升（改了 Cargo.toml 忘了 `cargo check` 刷新锁文件）"
    );
    assert!(
        re(r"^\d+\.\d+\.\d+$").is_match(&npm),
        "版本号必须是 x.y.z 三段（Tauri 按 semver 解析，装机包文件名与快照名都吃它）：当前 {npm}"
    );

    // 前端不许自带第二个版本号
    let topbar = read("../src/components/layout/AppTopbar.tsx");
    assert!(
        topbar.contains("pkg.version"),
        "顶栏版本号必须取自 package.json（import pkg from \"../../../package.json\"）"
    );
    assert!(
        !re(r"粮站收粮系统\s*[0-9]").is_match(&topbar),
        "顶栏里又出现了写死的版本号字面量——升版本时它不会自己变"
    );
}
