//! 前后端"命令线"守卫。
//!
//! 这条线断过一次：对端只写了 `src/lib/*-native.ts` 的前端包装，Rust 侧的
//! `generate_handler!` 没登记，浏览器预览一切正常、桌面端调用直接 reject。
//! 单靠 `cargo check` 抓不到（TS 里的命令名只是字符串），所以这里把三端拉平对账：
//!
//! 1. Rust 里 `#[command]` / `#[tauri::command]` 定义的命令 → 必须出现在 `generate_handler!`；
//! 2. 前端 `src/lib/*.ts` 里以字面量传给 `call/invoke/route*` 的命令名 → 必须已登记；
//! 3. 登记了的命令 → 前端必须真的有人调（防止"接了线但没人用"的半拉子工程）。

use regex::Regex;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .expect("src-tauri 的上一级就是仓库根")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("读 {} 失败：{e}", path.display()))
}

/// 递归收集 `src-tauri/src` 下所有 `.rs`。
fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("src-tauri/src 必须存在") {
        let path = entry.expect("目录项可读").path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

/// 命令属性后面允许夹文档注释与其它属性，但不许夹别的条目——否则会错配到下一个 `pub fn`。
fn defined_commands() -> BTreeMap<String, String> {
    let attr = Regex::new(
        r"(?s)#\[(?:tauri::)?command\](?:\s*(?:///[^\n]*\n|#!\[[^\]]*\]))*\s*pub\s+(?:async\s+)?fn\s+([a-z][a-z0-9_]*)",
    )
    .expect("正则合法");
    let mut files = Vec::new();
    rust_files(&repo_root().join("src-tauri").join("src"), &mut files);
    let mut map = BTreeMap::new();
    for f in files {
        let text = read(&f);
        for cap in attr.captures_iter(&text) {
            map.insert(
                cap[1].to_string(),
                f.file_name().unwrap().to_string_lossy().into_owned(),
            );
        }
    }
    map
}

/// `generate_handler![...]` 里的每一项：命令名 → 模块路径（`greet` 这种裸名归到 lib.rs 自己）。
fn registered_commands() -> BTreeMap<String, String> {
    let lib_rs = read(&repo_root().join("src-tauri").join("src").join("lib.rs"));
    let head = lib_rs
        .find("generate_handler![")
        .expect("lib.rs 里必须有一个 generate_handler! 宏");
    let rest = &lib_rs[head..];
    let open = rest.find('[').expect("宏有左括号");
    // 注意：`find` 是在 rest[open..] 上做的，偏移量要换算回 rest 的坐标系，
    // 否则最后一个条目会被从中间截断（`search_global` 读成 `search`）。
    let close = rest[open..].find(']').expect("宏有右括号") + open;
    let mut map = BTreeMap::new();
    for item in rest[open + 1..close].split(',') {
        let entry = item.trim();
        if entry.is_empty() {
            continue;
        }
        let (cmd, module) = match entry.rsplit_once("::") {
            Some((m, c)) => (c.to_string(), m.to_string()),
            None => (entry.to_string(), "(lib.rs)".to_string()),
        };
        map.insert(cmd, module);
    }
    map
}

/// 前端调用点：`call("x")` / `invoke<T>("x")` / `route1<...>("x")` / `routeSave<_, _>("x")`，
/// 命令名一律是第一个字符串字面量参数；泛型里不含圆括号，故 `[^()\n]*` 足够。
fn frontend_commands() -> BTreeMap<String, String> {
    let re = Regex::new(
        r#"(?m)(?:^|[^\w.])(?:call|invoke|route|route1|routeSave)(?:<[^()\n]*?>)?\(\s*"([a-z][a-z0-9_]{3,})""#,
    )
    .expect("正则合法");
    let dir = repo_root().join("src").join("lib");
    let mut map = BTreeMap::new();
    let mut entries: Vec<PathBuf> = fs::read_dir(&dir)
        .expect("src/lib 必须存在")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("ts"))
        .collect();
    entries.sort();
    for f in entries {
        let text = read(&f);
        for cap in re.captures_iter(&text) {
            map.insert(
                cap[1].to_string(),
                f.file_name().unwrap().to_string_lossy().into_owned(),
            );
        }
    }
    map
}

#[test]
fn every_rust_command_is_registered_in_invoke_handler() {
    let defined = defined_commands();
    let registered = registered_commands();
    let missing: Vec<String> = defined
        .keys()
        .filter(|c| !registered.contains_key(*c))
        .map(|c| format!("{c}（定义在 {}.rs）", defined[c]))
        .collect();
    assert!(
        missing.is_empty(),
        "这些 #[command] 没进 generate_handler!，桌面端调用会 reject：\n  {}",
        missing.join("\n  ")
    );
}

#[test]
fn every_frontend_command_has_a_registered_backend() {
    let frontend = frontend_commands();
    let registered = registered_commands();
    let dangling: Vec<String> = frontend
        .keys()
        .filter(|c| !registered.contains_key(*c))
        .map(|c| format!("{c}（前端在 {}）", frontend[c]))
        .collect();
    assert!(
        dangling.is_empty(),
        "前端调了后端没登记的命令，浏览器走 mock 一切正常、装到桌面端才炸：\n  {}",
        dangling.join("\n  ")
    );
}

#[test]
fn every_registered_command_is_called_by_the_frontend() {
    // `greet` 是 Tauri 脚手架自带的示例命令，保留作 app-shell 冒烟用。
    const ALLOW_UNCALLED: &[&str] = &["greet"];
    let frontend = frontend_commands();
    let registered = registered_commands();
    let dead: Vec<&String> = registered
        .keys()
        .filter(|c| !frontend.contains_key(*c) && !ALLOW_UNCALLED.contains(&c.as_str()))
        .collect();
    assert!(
        dead.is_empty(),
        "这些命令登记了但前端没人调，说明接了一半就停了：\n  {}\n（真要做\"后端预留接口\"就把它加进 ALLOW_UNCALLED 并写清原因）",
        dead.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n  ")
    );
}

#[test]
fn handler_module_prefixes_are_declared_modules() {
    let lib_rs = read(&repo_root().join("src-tauri").join("src").join("lib.rs"));
    let declared: Vec<String> = Regex::new(r"(?m)^(?:pub(?:\(crate\))?\s+)?mod ([a-z_][a-z0-9_]*)\s*;")
        .expect("正则合法")
        .captures_iter(&lib_rs)
        .map(|c| c[1].to_string())
        .collect();
    let registered = registered_commands();
    let orphans: Vec<&String> = registered
        .iter()
        .filter(|(_, module)| *module != "(lib.rs)" && !declared.contains(module))
        .map(|(_, module)| module)
        .collect();
    assert!(
        orphans.is_empty(),
        "generate_handler! 引用了未声明的模块 {orphans:?}；lib.rs 顶部缺 `pub mod`"
    );
}

// ============================================================ 事件线（device://）

/// 地磅这类高频读数不走 invoke 命令，走 tauri event，所以命令名对账盖不到它：Rust 改了
/// 通道名而前端还在听旧的，界面就只剩"一直没读数"一个谜，`cargo check` 与 `tsc` 都抓不到。
/// 这里把 `device://` 当作"本机外设通道"的命名空间，两边拉平对账。
fn web_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("src 必须存在") {
        let path = entry.expect("目录项可读").path();
        if path.is_dir() {
            web_files(&path, out);
        } else if matches!(
            path.extension().and_then(|e| e.to_str()).unwrap_or(""),
            "ts" | "tsx"
        ) {
            out.push(path);
        }
    }
}

/// Rust 声明的外设通道：`(常量名, 通道名, 所在文件)`。
fn declared_channels() -> Vec<(String, String, String)> {
    let re = Regex::new(r#"pub\s+const\s+([A-Z][A-Z0-9_]*)\s*:\s*&str\s*=\s*"(device://[a-z0-9/_-]+)""#)
        .expect("正则合法");
    let mut files = Vec::new();
    rust_files(&repo_root().join("src-tauri").join("src"), &mut files);
    let mut out = Vec::new();
    for f in files {
        let text = read(&f);
        for c in re.captures_iter(&text) {
            out.push((
                c[1].to_string(),
                c[2].to_string(),
                f.file_name().unwrap().to_string_lossy().into_owned(),
            ));
        }
    }
    out
}

/// Rust 实际 `emit` 出去的通道（常量与字面量两种写法都收）。
fn emitted_channels() -> Vec<(String, String)> {
    let re = Regex::new(r#"\.emit(?:_to|_specific)?\(\s*(?:"([^"]+)"|([A-Z][A-Z0-9_]*))"#).expect("正则合法");
    let mut files = Vec::new();
    rust_files(&repo_root().join("src-tauri").join("src"), &mut files);
    let mut out = Vec::new();
    for f in files {
        let text = read(&f);
        for c in re.captures_iter(&text) {
            let name = c.get(1).or_else(|| c.get(2)).expect("两个分支必有一个命中").as_str();
            out.push((name.to_string(), f.file_name().unwrap().to_string_lossy().into_owned()));
        }
    }
    out
}

/// 前端出现过的 `device://` 字面量 → 文件。
fn frontend_channels() -> BTreeMap<String, String> {
    let re = Regex::new(r#""(device://[a-z0-9/_-]+)""#).expect("正则合法");
    let mut files = Vec::new();
    web_files(&repo_root().join("src"), &mut files);
    let mut map = BTreeMap::new();
    for f in files {
        let text = read(&f);
        for c in re.captures_iter(&text) {
            map.entry(c[1].to_string())
                .or_insert_with(|| f.file_name().unwrap().to_string_lossy().into_owned());
        }
    }
    map
}

#[test]
fn every_emit_targets_a_declared_channel() {
    let declared = declared_channels();
    // 常量名 → 通道名，`emit(SCALE_EVENT, ..)` 这种写法要能查回真通道
    let by_const: BTreeMap<&str, &str> = declared
        .iter()
        .map(|(name, channel, _)| (name.as_str(), channel.as_str()))
        .collect();
    let unknown: Vec<String> = emitted_channels()
        .iter()
        .filter(|(n, _)| !n.starts_with("device://"))
        .filter(|(n, _)| !by_const.contains_key(n.as_str()))
        .map(|(n, f)| format!("{n}（{f} 里的 emit）"))
        .collect();
    assert!(
        unknown.is_empty(),
        "emit 打到了未声明的通道；外设通道一律写成 `pub const X_EVENT: &str = \"device://...\"` 再引用，\n两边才对得上：\n  {}",
        unknown.join("\n  ")
    );
}

#[test]
fn device_event_channels_are_declared_on_both_sides() {
    let declared = declared_channels();
    let frontend = frontend_channels();
    let unlistened: Vec<String> = declared
        .iter()
        .filter(|(_, channel, _)| !frontend.contains_key(channel))
        .map(|(_, channel, file)| format!("{channel}（后端在 {file} 推，前端无人订阅）"))
        .collect();
    let dangling: Vec<String> = frontend
        .iter()
        .filter(|(channel, _)| !declared.iter().any(|(_, c, _)| c == *channel))
        .map(|(channel, file)| format!("{channel}（前端在 {file} 听，后端没这个通道）"))
        .collect();
    assert!(
        unlistened.is_empty() && dangling.is_empty(),
        "外设事件通道两边对不上：\n  {}",
        unlistened.into_iter().chain(dangling).collect::<Vec<_>>().join("\n  ")
    );
}
