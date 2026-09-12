//! 结构契约守卫。
//!
//! 这一组测试回答的不是"SQL 能不能跑"，而是三个会咬人的问题：
//!   1. 每台机器的结构会不会各自漂移？→ `schema_matches_blessed_snapshot`
//!   2. 建表脚本漏写/多写了一列、索引、CHECK，谁发现？→ `doc_section9_contract_*`
//!   3. 枚举值域在 SQLite / Rust / 前端 constants.ts 三处分叉（80mm 小票 `thermal80`
//!      真就这么漏过一次），谁拦下？→ `enums_are_single_sourced_across_three_places`
//!   4. 现场从旧版本跳级升级、脚本被改动、装回老版本，行为对不对？→ 迁移行为那几条
//!
//! 重新生成快照：`BANGHE_BLESS_SCHEMA=1 cargo test --test schema_contract`
//! 生成后必须 review diff：快照是"期望结构"的账本，不是自动通过的橡皮章。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

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

/// §9 的 26 张表 ⇄ 实际建出来的 26 张表，一张都不许多/少
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
    assert_eq!(declared.len(), 26, "§9 应当是 26 张表");
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
        let r1 = migrate::apply(&mut conn, "0.1.0-test", Some(&dir.join("backup"))).unwrap();
        assert_eq!(r1.applied.len(), MIGRATIONS.len(), "首装应跑全部脚本");
        assert!(r1.backup_path.is_none(), "空库首装不该做迁移前备份");
        let r2 = migrate::apply(&mut conn, "0.1.0-test", Some(&dir.join("backup"))).unwrap();
        assert!(r2.applied.is_empty(), "第二次启动不应再执行任何脚本：{:?}", r2.applied);
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
        let r = migrate::apply_with(&mut conn, "0.1.3", None, OLD).unwrap();
        assert_eq!(r.applied, vec!["0001_init.sql".to_string()]);
        assert_eq!(r.to_version, 1);
        // 老版本没有种子的 22 个参数键
        drop(conn);
    }
    {
        let mut conn = Connection::open(&path).unwrap();
        banghe_lib::db::setup_pragmas(&conn).unwrap();
        let r = migrate::apply(&mut conn, "0.2.0", Some(&dir.join("backup"))).unwrap();
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

/// 改了历史脚本 → 校验和拦下，绝不"顺手再跑一遍"
#[test]
fn tampered_applied_script_refuses_startup() {
    let conn = &mut migrated_conn();
    conn.execute(
        "UPDATE schema_migration SET checksum='0000000000000000000000000000000000000000000000000000000000000000' WHERE name='0001_init.sql'",
        [],
    )
    .unwrap();
    let e = migrate::apply(conn, "0.1.0-test", None).unwrap_err();
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

    let r = migrate::apply(conn, "0.1.0-test", None).expect("老哈希应补记后放行，而不是拒启");
    assert_eq!(r.healed, vec![m.name.to_string()], "补记要报告是哪支脚本");
    let stored: String = conn
        .query_row(
            "SELECT checksum FROM schema_migration WHERE name=?1",
            rusqlite::params![m.name],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored, m.checksum(), "补记后库里应当是规范值");

    let r2 = migrate::apply(conn, "0.1.0-test", None).unwrap();
    assert!(r2.healed.is_empty(), "第二次启动不该再补记");

    // 反向：既不是规范值也不是 CRLF 值 → 照样拒启，补记不能变成后门
    conn.execute(
        "UPDATE schema_migration SET checksum='deadbeef' WHERE name=?1",
        rusqlite::params![m.name],
    )
    .unwrap();
    assert!(
        matches!(
            migrate::apply(conn, "0.1.0-test", None).unwrap_err(),
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
    let e = migrate::apply(conn, "0.1.0-test", None).unwrap_err();
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
    let e = migrate::apply(conn, "0.1.0-test", None).unwrap_err();
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
    let e = migrate::apply_with(&mut conn, "0.1.0-test", None, BROKEN).unwrap_err();
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
