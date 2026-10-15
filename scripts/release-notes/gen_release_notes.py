#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 BangHe 的 GitHub Release 正文：下载表格 + 提交清单 + Full Changelog 链接。

移植自 daro 仓库 tool/gen_release_notes.py，按本仓库现实砍掉两块：
  - 不做 PR 反查（本仓库直接推 master，无 PR 流程），因此全程离线、不调 GitHub API；
  - 不按 Conventional Commits 归类（本仓库提交是自由中文短句），直接按时间列全量清单。

保留的核心约束与 daro 一致：
  1. 正文开头的下载表格里，链接文字即源文件名、直指本次 Release 的 asset，
     右侧并上体积与 SHA256 两列（文件大小取自 --artifacts-dir，目录不存在则省略这两列）；
  2. 表里的文件名由 DOWNLOAD_FILES 按版本号拼出——产物改名要同步改这里，
     workflow 里的「校验正文里的下载链接」步骤会拿实际产物逐个比对兜底。

用法：
    python3 scripts/release-notes/gen_release_notes.py --tag v26.10.8 --version 26.10.8 \
        --repo datawalkcloud/BangHe --artifacts-dir artifacts --output release_body.md
    --prev 省略则自动取上一个 tag；首个 release 用全量历史且不输出 compare 链接。

退出码：0 成功（API 无关，不会因网络抖动失败）；2 参数或 git 状态有问题。
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys

FIELD = "\x1f"
RECORD = "\x1e"

# ---------- 下载表格 ----------
# 一个交付物一行：(文件名, 平台/用途, 说明)。版本号用 {version} 占位。
# WebView2 离线运行库**不随发布**（2026-10-11 决定）：只在表下的 OFFLINE_NOTE 里
# 链接微软官方下载页，需要离线环境的自己下去带着走。
DOWNLOAD_FILES = [
    (
        "banghe-{version}-windows-x64-setup.exe",
        "Windows x64 安装包",
        "双击安装。装完首次启动时自动联网获取 WebView2 运行库；未做代码签名，"
        "SmartScreen 提示时点「仍要运行」。",
    ),
]

OFFLINE_NOTE = (
    "磅房机**没有外网**才需要额外准备：先到 "
    "[微软 WebView2 官方下载页](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)"
    "取「Evergreen Standalone Installer · x64」（约 200 MB）装好运行库，再装本软件；"
    "有网络的机器什么都不用做。"
)


def git(*args: str) -> str:
    proc = subprocess.run(
        ["git", *args], capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit(2)
    return proc.stdout


def file_cells(path: str | None) -> tuple[str, str]:
    """返回 (大小, SHA256)；文件不在 artifacts 目录时给出占位而不是崩。"""
    if path is None or not os.path.isfile(path):
        return "—", "—"
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    size = os.path.getsize(path)
    mb = size / (1024 * 1024)
    human = f"{mb:.1f} MB" if mb >= 1 else f"{size:,} B"
    return human, f"`{h.hexdigest()[:16]}…`"


def collect_commits(rev_range: str) -> list[tuple[str, str, str]]:
    """rev_range 内的提交，返回 (短hash, 标题, 作者)，按时间正序。"""
    fmt = FIELD.join(["%h", "%s", "%an"]) + RECORD
    raw = git("log", "--no-merges", "--reverse", f"--format={fmt}", rev_range)
    commits = []
    for record in raw.split(RECORD):
        record = record.strip("\n")
        if not record:
            continue
        parts = record.split(FIELD)
        if len(parts) == 3:
            commits.append(tuple(parts))
    return commits


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default=os.environ.get("GITHUB_REF_NAME") or None)
    ap.add_argument("--version", required=True, help="不带 v 的版本号，用于拼安装包文件名")
    ap.add_argument("--prev", default=None, help="上一个 tag；省略则自动推断")
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"), help="owner/repo")
    ap.add_argument("--artifacts-dir", default="artifacts")
    ap.add_argument("--output", default=None)
    args = ap.parse_args()

    tag = args.tag
    if not tag:
        sys.stderr.write("缺少 --tag（也没有 GITHUB_REF_NAME）\n")
        sys.exit(2)
    repo = args.repo
    if not repo or "/" not in repo:
        sys.stderr.write("缺少 --repo（owner/repo）\n")
        sys.exit(2)
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
        sys.stderr.write(f"版本号不像 x.y.z：{args.version}\n")
        sys.exit(2)

    prev = args.prev
    if prev is None:
        try:
            prev = git("describe", "--tags", "--abbrev=0", f"{tag}^").strip() or None
        except SystemExit:
            prev = None

    rev_range = f"{prev}..{tag}" if prev else tag
    commits = collect_commits(rev_range)

    lines: list[str] = []
    lines.append(f"磅禾粮站收粮系统 {args.version}")
    lines.append("")

    # --- 下载表格 ---
    lines.append("## 下载")
    lines.append("")
    lines.append("| 文件 | 平台 / 用途 | 大小 | SHA256 |")
    lines.append("| --- | --- | --- | --- |")
    have_dir = os.path.isdir(args.artifacts_dir)
    listed = set()
    for name_tpl, platform, note in DOWNLOAD_FILES:
        name = name_tpl.format(version=args.version)
        listed.add(name)
        art = os.path.join(args.artifacts_dir, name) if have_dir else None
        size, sha = file_cells(art)
        url = f"https://github.com/{repo}/releases/download/{tag}/{name}"
        lines.append(f"| [{name}]({url}) | {platform} | {size} | {sha} |")
        lines.append(f"| | {note} | | |")
    if have_dir:
        extra = sorted(
            f
            for f in os.listdir(args.artifacts_dir)
            if os.path.isfile(os.path.join(args.artifacts_dir, f)) and f not in listed
        )
        if extra:
            sys.stderr.write(
                "警告：artifacts 里有表格没列出的文件（记得同步 DOWNLOAD_FILES）: %s\n"
                % ", ".join(extra)
            )
    lines.append("")
    lines.append(OFFLINE_NOTE)
    lines.append("")
    lines.append("| 源码 | [tar.gz](https://github.com/%s/archive/refs/tags/%s.tar.gz) · [zip](https://github.com/%s/archive/refs/tags/%s.zip) | | |" % (repo, tag, repo, tag))
    lines.append("")

    # --- 提交清单 ---
    lines.append(f"## 更新内容（{prev + ' 以来' if prev else '全部历史'}，共 {len(commits)} 次提交）")
    lines.append("")
    if commits:
        for h, subject, author in commits:
            lines.append(f"- `{h}` {subject}（{author}）")
    else:
        lines.append("- 本次没有新提交。")
    lines.append("")

    if prev:
        lines.append(f"**Full Changelog**: https://github.com/{repo}/compare/{prev}...{tag}")
        lines.append("")

    body = "\n".join(lines)
    if args.output:
        with open(args.output, "w", encoding="utf-8", newline="\n") as f:
            f.write(body)
    else:
        sys.stdout.write(body)


if __name__ == "__main__":
    main()
