#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在 Gitee 仓自动创建发行版（Release）并把本次安装包挂成附件。

调用方是 scripts/release-notes/gitee_publish.py（跑在 Gitee Go 流水线里），它会先后
对下载镜像仓 banghe-release 与源码镜像仓 BangHe 各调一次本脚本，两个仓各有一份同
tag 的发行版。

前置：调用方已经把含安装包的 orphan 工作树强推到 Gitee 下载镜像仓并推上 tag；源码
镜像仓的 tag 也已确认存在（镜像同步滞后时由调用方从 GitHub 取过来推）。Gitee 的发行版
绑死 git tag，tag 不在创建接口就直接失败，而 tag 走 git 推比调 /tags 接口稳（那接口对
ref_name 的口径没有实测依据）。

接口口径（v5，2026-11-19 实测）：
  - 请求体一律 application/x-www-form-urlencoded; charset=utf-8。官方 swagger 写的是
    application/json，但同一个不带凭据的 POST，表单编码回的是「Access token does not
    exist」、JSON 回的是「登录失效，无权限访问该资源」——两条都被解析了，而社区实测
    JSON 通道会丢字段、中文名乱码，所以这里固定用表单编码。
  - 查是否已存在：GET /repos/{owner}/{repo}/releases/tags/{tag}（公开仓匿名可读，
    不存在回 404 JSON）
  - 创建：POST /repos/{owner}/{repo}/releases → 返回对象含 id
  - 传附件：POST /repos/{owner}/{repo}/releases/{release_id}/attach_files
    （multipart/form-data，文件字段名 file）
  - 列附件：GET /repos/{owner}/{repo}/releases/{release_id}/attach_files
    → 每项含 name / size / browser_download_url
  - 附件直链：browser_download_url 形如
    https://gitee.com/{owner}/{repo}/releases/download/{tag}/{name}，302 跳到
    foruda.gitee.com 的签名地址，匿名 200 能落地（已实测）。同一形态还支持把 {tag}
    换成 latest 拿"永远指向最新版"的链接。

配额红线（Gitee 帮助中心）：单附件 ≤100 MB、每仓附件总量 ≤1 GB（推荐项目 5 GB、
GVP 20 GB）。主包 ~7 MB，一次发版一份附件，攒到上限要清老的——本脚本只传不删。

退出码：0 成功；2 参数/凭据缺失、接口报错或附件回读对不上（红得明确，不静默跳过）。

用法（跑在 Gitee Go 流水线里，凭据来自项目级全局参数 GITEE_TOKEN；本地可传 --dry-run 核对）：
    GITEE_TOKEN=... python3 scripts/release-notes/gitee_release.py \
        --owner datawalkcloud --repo banghe-release --tag v26.11.19 --version 26.11.19 \
        --title "磅禾粮站收粮系统 26.11.19" --body-file release_body.md \
        --assets artifacts/banghe-26.11.19-windows-x64-setup.exe
    --dry-run 只打印将要做什么、不碰网络，用于本地核对参数。
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API_BASE = "https://gitee.com/api/v5"
USER_AGENT = "banghe-release-bot"


def fail(msg: str) -> None:
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(2)


def send(method: str, url: str, data: bytes | None = None, headers: dict | None = None,
         timeout: int = 180) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT,
                                                          **(headers or {})}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        # Gitee 的错误也是 JSON（形如 {"message": "..."}），状态码非 2xx 不等于没响应
        return e.code, e.read()
    except Exception as e:
        fail(f"请求 {method} {url} 传输层失败：{e}")


def brief(body: bytes) -> str:
    text = body.decode("utf-8", "replace").strip().replace("\n", " ")
    return text[:200] if text else "(空响应)"


def get_json(path: str, *, optional: bool = False) -> dict | list | None:
    """GET 开放接口；optional=True 时把 404 当成"不存在"返回 None。"""
    status, body = send("GET", f"{API_BASE}/{path.lstrip('/')}", timeout=60)
    if status == 404 and optional:
        return None
    if status != 200:
        fail(f"GET {path} 回 {status}：{brief(body)}")
    try:
        return json.loads(body)
    except ValueError:
        fail(f"GET {path} 回 200 但不是 JSON：{brief(body)}")


def multipart(fields: dict, filename: str, blob: bytes) -> tuple[bytes, str]:
    boundary = "----banghe" + os.urandom(8).hex()
    ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    head = ""
    for key, val in fields.items():
        head += (f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n'
                 f"{val}\r\n")
    head += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
             f'filename="{filename}"\r\nContent-Type: {ctype}\r\n\r\n')
    payload = head.encode("utf-8") + blob + f"\r\n--{boundary}--\r\n".encode("utf-8")
    return payload, f"multipart/form-data; boundary={boundary}"


def head_len(url: str) -> tuple[int, int | None]:
    """HEAD 附件直链（跟 302 到 foruda 签名地址），返回 (状态码, Content-Length)。"""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT}, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            length = resp.headers.get("Content-Length")
            return resp.status, int(length) if length and length.isdigit() else None
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:
        fail(f"HEAD {url} 传输层失败：{e}")


def release_id_for_tag(owner: str, repo: str, tag: str, title: str, body_md: str,
                       ref: str, token: str, dry: bool) -> int:
    """已有同 tag 的发行版就复用，没有就建——重跑 workflow 不该堆出两个同名发行版。"""
    found = get_json(f"repos/{owner}/{repo}/releases/tags/{urllib.parse.quote(tag)}",
                     optional=True)
    if isinstance(found, dict) and found.get("id"):
        print(f"Gitee 发行版已存在（id={found['id']}），复用：tag {tag}")
        return int(found["id"])
    if dry:
        print(f"[dry-run] 将 POST repos/{owner}/{repo}/releases："
              f"tag_name={tag} name={title} target_commitish={ref} body={len(body_md)} 字符")
        return -1
    status, resp = send(
        "POST", f"{API_BASE}/repos/{owner}/{repo}/releases",
        data=urllib.parse.urlencode({
            "access_token": token, "tag_name": tag, "name": title, "body": body_md,
            "target_commitish": ref, "prerelease": "false",
        }).encode("utf-8"),
        headers={"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"},
    )
    if status not in (200, 201):
        fail(f"创建 Gitee 发行版失败，回 {status}：{brief(resp)}\n"
             f"（tag {tag} 要先存在于 {owner}/{repo}；表单编码这条口径别再换回 JSON）")
    try:
        rid = int(json.loads(resp)["id"])
    except Exception:
        fail(f"创建发行版回 {status} 但解析不到 id：{brief(resp)}")
    print(f"Gitee 发行版已创建：id={rid}")
    return rid


def upload_assets(owner: str, repo: str, rid: int, assets: list[str], tag: str,
                  token: str, dry: bool) -> None:
    base = f"repos/{owner}/{repo}/releases/{rid}/attach_files"
    existing = {} if rid < 0 else {a["name"] for a in get_json(base) or []}
    expected = []
    for path in assets:
        name = os.path.basename(path)
        expected.append(name)
        if not os.path.isfile(path):
            fail(f"读不到要挂进发行版的产物：{path}")
        size = os.path.getsize(path)
        if size > 100 * 1024 * 1024:
            fail(f"{name} 有 {size / 1048576:.0f} MB，超 Gitee 单附件 100 MB 上限")
        if name in existing:
            print(f"附件已存在，跳过：{name}")
            continue
        if dry:
            print(f"[dry-run] 将上传附件 {name}（{size / 1048576:.1f} MB）→ {base}")
            continue
        blob = open(path, "rb").read()
        payload, ctype = multipart({"access_token": token, "release_id": str(rid)}, name, blob)
        status, resp = send("POST", f"{API_BASE}/{base}", data=payload,
                            headers={"Content-Type": ctype})
        if status not in (200, 201):
            fail(f"上传附件 {name} 失败，回 {status}：{brief(resp)}")
        info = {}
        try:
            info = json.loads(resp)
        except ValueError:
            pass
        print(f"附件已上传：{name}（{size / 1048576:.1f} MB）")
        if info.get("browser_download_url"):
            print(f"  直链：{info['browser_download_url']}")

    if dry:
        return
    # 回读一遍发行版的附件清单，确认本次要挂的都在——「接口 200 但页面没附件」
    # 等于发版没完成，和 raw latest.json 那步的回读同一口径。
    now = {a["name"]: a for a in get_json(base) or []}
    missing = [n for n in expected if n not in now]
    if missing:
        fail(f"发行版附件回读缺：{', '.join(missing)}（上传接口没报错但附件不在，别当成功）")
    for name in expected:
        # 只发 HEAD：Gitee 的附件直链不认 Range（实测带 bytes=0-1023 仍整包回），
        # 拿头里的 Content-Length 跟接口报的 size 比，既不白下 7 MB 又能证明字节落地。
        url = now[name].get("browser_download_url") or \
            f"https://gitee.com/{owner}/{repo}/releases/download/{tag}/{name}"
        status, length = head_len(url)
        if status != 200:
            fail(f"附件直链回读 {name} 回 {status}（发行版页面上有附件但链接不通）")
        api_size = now[name].get("size")
        if length is not None and api_size is not None and length != api_size:
            fail(f"附件 {name} 直链长度 {length} 与接口报的 {api_size} 不一致，链接指向的不是这份产物")
        print(f"  匿名可下：{url}（HTTP {status}，{length if length is not None else api_size} B）")


def main() -> None:
    ap = argparse.ArgumentParser(description="在 Gitee 建发行版并挂安装包附件")
    ap.add_argument("--owner", required=True, help="Gitee 命名空间（Secret GITEE_OWNER）")
    ap.add_argument("--repo", required=True, help="Gitee 镜像仓名，如 banghe-release")
    ap.add_argument("--tag", required=True, help="git tag，如 v26.11.19（须已推到该仓）")
    ap.add_argument("--version", required=True, help="不带 v 的版本号")
    ap.add_argument("--title", required=True, help="发行版标题，与 GitHub Release 同名")
    ap.add_argument("--body-file", required=True, help="发行版正文文件（复用 release_body.md）")
    ap.add_argument("--ref", default="master", help="target_commitish，Gitee 镜像仓默认分支")
    ap.add_argument("--assets", nargs="+", required=True, help="要挂成附件的产物路径")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不发任何请求")
    args = ap.parse_args()

    if args.tag != f"v{args.version}":
        fail(f"tag {args.tag} 与版本 v{args.version} 对不齐，发行版标题和附件会串版")

    token = os.environ.get("GITEE_TOKEN", "").strip()
    if not token and not args.dry_run:
        fail("环境变量 GITEE_TOKEN 没给（Gitee 私人令牌，需 projects 权限）")
    try:
        body_md = open(args.body_file, encoding="utf-8").read()
    except OSError as e:
        fail(f"读不到发行版正文 {args.body_file}：{e}")
    if not body_md.strip():
        fail(f"发行版正文 {args.body_file} 是空的")

    print(f"Gitee 目标：{args.owner}/{args.repo} tag {args.tag}")
    rid = release_id_for_tag(args.owner, args.repo, args.tag, args.title, body_md,
                             args.ref, token, args.dry_run)
    upload_assets(args.owner, args.repo, rid, args.assets, args.tag, token, args.dry_run)
    if not args.dry_run:
        print(f"发行版页面：https://gitee.com/{args.owner}/{args.repo}/releases/tag/{args.tag}")


if __name__ == "__main__":
    main()
