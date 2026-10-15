//! "还剩多少界面在吃假数据"守卫（03 §过渡策略、05 §8）。
//!
//! 真库是逐块接上的：`src/lib/*-native.ts` 每个模块导出一组与 mock **同名**的方法，
//! `src/lib/api.ts` 再把它们逐个展开盖在 `mockApi` 上面。这个结构的好处是页面零改动，
//! 坏处是**没人能一眼看出哪些还没接**——而且接完一块忘了加展开，那块就悄悄退回假数据，
//! 编译、类型、单测全都发现不了（本项目已经为此返过一次工）。
//!
//! 所以这里把三件事钉死：
//! 1. 每个 `*-native.ts` 导出的 `xxxApi` 必须真的被 `api.ts` 展开；
//! 2. `mockApi` 必须排在展开链最前，否则后面的真库反而被它盖掉；
//! 3. mock 面上仍未被覆盖的方法必须逐条写在 `STILL_MOCK` 里并附原因——
//!    新加了假数据会被拦，接完了还留在清单里同样会被拦（清单不许发霉）。
//!
//! 放在 src-tauri/tests 是因为本仓库没有前端测试运行器，`cargo test` 是唯一入口。

use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// 仍指向 mock 的方法 → 为什么允许。接完一块就把对应条目删掉。
///
/// 形状：`("tareHistory", "皮带秤历史只有演示机有数据，等 M12 接工控"),`
const STILL_MOCK: &[(&str, &str)] = &[];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .expect("src-tauri 的上一级就是仓库根")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("读 {} 失败：{e}", path.display()))
}

/// 从 `brace_idx`（对象字面量的左花括号）起逐行扫，只收"深度 1 + 缩进两格"的键名。
/// 两道闸各挡一类误报：光看缩进会把对象外面同缩进写的 interface 成员当成方法；
/// 光看深度会把箭头函数体里 `? call("x") : mock.x()` 这种仍在深度 1 的表达式当成键。
fn object_keys(src: &str, brace_idx: usize) -> Vec<String> {
    let key = Regex::new(r"^  (?:async\s+|get\s+|set\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*[(:]").expect("正则合法");
    let mut depth = 0usize;
    let mut keys = Vec::new();
    // 第一行从左花括号处切起，其余整行
    for line in src[brace_idx..].split('\n') {
        let trimmed = line.strip_prefix('\r').unwrap_or(line);
        if depth == 1 {
            if let Some(cap) = key.captures(trimmed) {
                keys.push(cap[1].to_string());
            }
        }
        depth = match depth_after(depth, trimmed) {
            Some(d) => d,
            // 深度回到 0 ＝这个对象字面量收尾了
            None => break,
        };
    }
    keys
}

/// 走完一行后的括号深度；回到 0 时返回 `None` 表示对象结束。字符串、模板串与注释整体跳过。
fn depth_after(mut depth: usize, line: &str) -> Option<usize> {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    let mut quote: Option<char> = None;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            match c {
                // 模板串里的 `${` 会带进一层花括号，连同配对的 `}` 一起算，不影响平衡
                '\\' => i += 1,
                _ if c == q => quote = None,
                _ => {}
            }
            i += 1;
            continue;
        }
        if c == '"' || c == '\'' || c == '`' {
            quote = Some(c);
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            break; // 行尾注释，本行剩下的都不算
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            break; // 块注释按行处理：对象里的多行注记不改变深度，够用了
        } else if matches!(c, '{' | '[' | '(') {
            depth += 1;
        } else if matches!(c, '}' | ']' | ')') {
            depth -= 1;
            if depth == 0 {
                return None;
            }
        }
        i += 1;
    }
    Some(depth)
}

/// 定位 `export const <name> = {`，行首锚定——文件头的转述注释里也出现同样的字样。
fn top_level_object(src: &str, name: &str) -> Option<usize> {
    let re = Regex::new(&format!(
        r"(?m)^export const {name}\s*(?::[^=\n]+)?=\s*\{{",
        name = name
    ))
    .expect("正则合法");
    re.find(src).map(|m| m.end() - 1)
}

/// 每个 `*-native.ts` 里 `export const xxxApi = { … }` 的方法 → 模块名。
fn native_overrides() -> BTreeMap<String, String> {
    let decl = Regex::new(r"(?m)^export const (\w+Api)\s*(?::[^=\n]+)?=\s*\{").expect("正则合法");
    let mut out = BTreeMap::new();
    for (_, text) in native_files() {
        for cap in decl.captures_iter(&text) {
            let module = cap[1].to_string();
            let brace = cap.get(0).expect("整段匹配存在").end() - 1;
            for key in object_keys(&text, brace) {
                out.insert(key, module.clone());
            }
        }
    }
    out
}

fn native_files() -> Vec<(String, String)> {
    let dir = repo_root().join("src").join("lib");
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .expect("src/lib 必须存在")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().ends_with("-native.ts"))
                .unwrap_or(false)
        })
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|p| {
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            let text = read(&p);
            (name, text)
        })
        .collect()
}

fn mock_surface() -> Vec<String> {
    let src = read(&repo_root().join("src").join("mock").join("api.ts"));
    let brace = top_level_object(&src, "api").expect("src/mock/api.ts 里要有 `export const api = {`");
    object_keys(&src, brace)
}

/// `api.ts` 展开链上的对象名，按书写顺序。
fn api_spread_chain() -> Vec<String> {
    let src = read(&repo_root().join("src").join("lib").join("api.ts"));
    let start = src.find("export const api").expect("api.ts 必须导出 api");
    let end = src[start..]
        .find(';')
        .map(|p| start + p)
        .expect("导出语句以分号结束");
    Regex::new(r"\.\.\.(\w+)")
        .expect("正则合法")
        .captures_iter(&src[start..end])
        .map(|c| c[1].to_string())
        .collect()
}

#[test]
fn every_native_module_is_merged_into_api_ts() {
    let chain: BTreeSet<String> = api_spread_chain().into_iter().collect();
    let modules: BTreeSet<String> = native_overrides().values().cloned().collect();
    let missing: Vec<&str> = modules
        .iter()
        .map(String::as_str)
        .filter(|m| !chain.contains(*m))
        .collect();
    assert!(
        missing.is_empty(),
        "这些原生模块写了却没被 api.ts 展开，页面上这一块仍是假数据：{missing:?}"
    );
}

#[test]
fn mock_api_is_spread_first() {
    let chain = api_spread_chain();
    assert_eq!(
        chain.first().map(String::as_str),
        Some("mockApi"),
        "展开顺序错了：`...mockApi` 必须排第一，否则它会盖掉后面的真库通道"
    );
}

#[test]
fn native_overrides_do_not_collide() {
    let decl = Regex::new(r"(?m)^export const (\w+Api)\s*(?::[^=\n]+)?=\s*\{").expect("正则合法");
    let mut seen: BTreeMap<String, String> = BTreeMap::new();
    let mut clashes = Vec::new();
    for (file, text) in native_files() {
        for cap in decl.captures_iter(&text) {
            let module = cap[1].to_string();
            let brace = cap.get(0).expect("整段匹配存在").end() - 1;
            for key in object_keys(&text, brace) {
                if let Some(prev) = seen.insert(key.clone(), module.clone()) {
                    clashes.push(format!("{key}：{prev} 和 {file} 都在覆盖它"));
                }
            }
        }
    }
    assert!(
        clashes.is_empty(),
        "同一个方法被两个原生模块覆盖，谁生效取决于展开顺序：\n  {}",
        clashes.join("\n  ")
    );
}

#[test]
fn remaining_mock_surface_is_documented() {
    let covered = native_overrides();
    let uncovered: Vec<String> = mock_surface()
        .into_iter()
        .filter(|k| !covered.contains_key(k))
        .collect();
    let undocumented: Vec<&str> = uncovered
        .iter()
        .map(String::as_str)
        .filter(|k| !STILL_MOCK.iter().any(|(name, _)| name == k))
        .collect();
    assert!(
        undocumented.is_empty(),
        "这些方法还在吃 mock，既没接真库也没写原因：\n  {}\n接完就补原生模块；确实要留假数据（演示、等硬件）就写进 STILL_MOCK 并说明为什么",
        undocumented.join("\n  ")
    );
    let stale: Vec<&str> = STILL_MOCK
        .iter()
        .map(|(name, _)| *name)
        .filter(|name| !uncovered.iter().any(|k| k == name))
        .collect();
    assert!(
        stale.is_empty(),
        "STILL_MOCK 里这几条已经接完了（或方法名变了），把豁免一起清掉：{stale:?}"
    );
}

#[test]
fn mock_surface_is_not_empty() {
    // 守卫自己的哨兵：解析一旦失效（mock 改了导出名、方法不再写在同一层），
    // 上面几条会集体变成"零未完成"而全绿——那比没有守卫更糟。
    let n = mock_surface().len();
    assert!(n > 40, "mock 方法面只解析到 {n} 个，本文件的花括号扫描需要修");
    let overrides = native_overrides().len();
    assert!(overrides > 40, "原生覆盖只解析到 {overrides} 个，扫描需要修");
}
