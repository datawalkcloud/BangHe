#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成应用内「检查更新」吃的 latest.json（Tauri updater 更新清单）。

链路：release.yml 构建时以 --config 注入 createUpdaterArtifacts（签名私钥来自
GitHub Secrets 的 TAURI_SIGNING_PRIVATE_KEY，本机与仓库都不落盘），NSIS 主包旁
会多一个同名 .sig（minisign 分离签名）。本脚本把 版本号 + 签名内容 + 安装包下载
地址 拼成 latest.json，随 Release 一起上传；客户端按 tauri.conf.json
plugins.updater.endpoints 拉它，下载前用 plugins.updater.pubkey 验签，验不过直接拒装。

为什么安装包地址默认走 gh-proxy.com 镜像：磅房机直连 GitHub 时通时断，发版说明
（gen_release_notes.py）给人类的链接也走同款镜像。endpoints 里的直连兜底只兜得住
清单本身，兜不住清单里的安装包地址——所以这个地址只能选一个，选能落地的那个。

注意：端点指到 releases/latest/download/latest.json，**Draft Release 拉不到**——
release.yml 直接建正式 Release（draft: false），推 tag 后更新即对客户端生效。

用法：
    python3 scripts/release-notes/gen_updater_manifest.py \
        --version 26.10.9 --tag v26.10.9 --repo datawalkcloud/BangHe \
        --sig-file artifacts/banghe-26.10.9-windows-x64-setup.exe.sig \
        --output artifacts/latest.json

退出码：0 成功；2 参数 / 签名文件 / 版本对不齐等硬错误。
"""

from __future__ import annotations

import argparse
import base64
import datetime
import json
import re
import sys

# 交付物命名与 release.yml 的「校验并规整产物名」步骤是同一份约定：NSIS 默认的
# 中文名产物会被改名成这个 ASCII 形式再上传（避免 Release asset 链接的 URL 编码问题）。
ASSET_TEMPLATE = "banghe-{version}-windows-x64-setup.exe"
# 安装包下载走的镜像前缀；改这里 = 改所有已发客户端能下载到的位置，慎重。
MIRROR_PREFIX = "https://gh-proxy.com/"
DEFAULT_NOTES = "本次为常规更新，安装后程序自动重启即可；变更明细见 Release 页。"


def fail(msg: str) -> None:
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(2)


def main() -> None:
    ap = argparse.ArgumentParser(description="生成 Tauri updater 的 latest.json")
    ap.add_argument("--version", required=True, help="本次版本号（package.json 的 version）")
    ap.add_argument("--tag", required=True, help="本次 tag（如 v26.10.9），安装包下载链接用它拼")
    ap.add_argument("--repo", required=True, help="GitHub 仓库，如 datawalkcloud/BangHe")
    ap.add_argument("--sig-file", required=True, help="NSIS 主包旁的 .sig 文件路径")
    ap.add_argument("--output", required=True, help="latest.json 输出路径")
    ap.add_argument("--notes", default=DEFAULT_NOTES, help="客户端「关于」弹窗里展示的一句说明")
    ap.add_argument("--pub-date", default=None, help="RFC3339 发布时间，缺省取当前 UTC 时间")
    args = ap.parse_args()

    if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
        fail(f"版本号 {args.version} 不是 x.y.z 三段（与版本单源守卫同口径）")
    if args.tag != f"v{args.version}":
        fail(f"tag {args.tag} 与版本 v{args.version} 对不齐，清单里的下载链接会指向错误产物")

    try:
        sig = open(args.sig_file, encoding="utf-8").read().strip()
    except OSError as e:
        fail(f"读不到签名文件 {args.sig_file}：{e}（构建期没开 createUpdaterArtifacts？TAURI_SIGNING_PRIVATE_KEY 没配？）")
    if not sig:
        fail(f"签名文件 {args.sig_file} 是空的")
    # tauri 的 .sig 不是 minisign 的两行明文格式，而是**单行 base64 包裹**（与 .pub 同款，
    # 解开才是 "untrusted comment: ..." 明文）——latest.json 的 signature 字段要的就是
    # 这整行 base64，客户端解开验签。这里解码验证结构，防把别的文件当签名拼进清单。
    try:
        decoded = base64.b64decode(sig, validate=True).decode("utf-8", "replace")
    except Exception:
        fail(f"{args.sig_file} 不是单行 base64（tauri .sig 应与 .pub 同款包裹格式），确认拿的是签名文件本体")
    if not decoded.startswith("untrusted comment:"):
        fail(f"{args.sig_file} 解开缺 untrusted comment 头，不像 tauri 的 minisign 签名，客户端会验签失败")

    asset = ASSET_TEMPLATE.format(version=args.version)
    url = f"{MIRROR_PREFIX}https://github.com/{args.repo}/releases/download/{args.tag}/{asset}"
    pub_date = args.pub_date or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    manifest = {
        "version": args.version,
        "notes": args.notes,
        "pub_date": pub_date,
        "platforms": {
            "windows-x86_64": {
                "signature": sig,
                "url": url,
            }
        },
    }
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"latest.json 就绪：版本 {args.version}，安装包 {asset}")
    print(f"下载地址：{url}")


if __name__ == "__main__":
    main()
