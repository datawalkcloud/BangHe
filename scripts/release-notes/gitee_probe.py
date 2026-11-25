#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gitee Go 构建机凭据探测（诊断用，不打印任何令牌）。

目的：确认三件事，决定 Gitee 发布怎么拿令牌——
  1. 检出凭据（git 的 http.extraheader Basic）是不是一个能调 v5 API 的用户令牌；
  2. 若是，它有没有 datawalkcloud/banghe-release 的推送权限（跨仓推送用）；
  3. 仓库「通用变量」和 YAML variables 的替换语法在命令里到底生效不生效。

只输出长度/账号名/HTTP 状态与权限位，令牌本身与密文一律不落日志。
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import urllib.error
import urllib.parse
import urllib.request

API_BASE = "https://gitee.com/api/v5"
UA = "banghe-gitee-probe"


def git(*args: str) -> str:
    proc = subprocess.run(["git", *args], capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    return proc.stdout.strip() if proc.returncode == 0 else ""


def extraheader_token() -> tuple[str, str]:
    """从 git 配置里取出 Basic 凭据，返回 (user, token)；取不到返回 ("", "")。"""
    for line in git("config", "--get-regexp", r"^http\..*extraheader$").splitlines():
        _, _, value = line.partition(" ")
        value = value.strip()
        if ":" not in value:
            continue
        scheme, _, blob = value.partition(":")
        if "basic" not in scheme.lower():
            continue
        try:
            decoded = base64.b64decode(blob.strip()).decode("utf-8", "replace")
        except Exception:
            continue
        if ":" in decoded:
            user, _, token = decoded.partition(":")
            return user, token
    return "", ""


def api(path: str, token: str) -> tuple[int, dict]:
    url = f"{API_BASE}/{path}?access_token={urllib.parse.quote(token)}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read()[:200].decode("utf-8", "replace")
        return e.code, {"error": body}
    except Exception as e:
        return 0, {"error": str(e)}


def main() -> None:
    # 1) 变量替换探针：由流水线命令把长度算好传进来（见 .workflow/gitee-publish.yml）
    print("env BH_GITEE_TOKEN len =", len(os.environ.get("BH_GITEE_TOKEN", "")))
    print("env BH_GITEE_USER  len =", len(os.environ.get("BH_GITEE_USER", "")))
    print("env BH_PROBE        len =", len(os.environ.get("BH_PROBE", "")))

    user, token = extraheader_token()
    print("workspace clone user =", user or "(未找到)")
    if not token:
        print("extraheader 里没有可解析的 Basic 凭据，后续探测跳过")
        return
    print("extraheader token len =", len(token))

    status, info = api("user", token)
    if status == 200:
        print(f"api /user          = 200 login={info.get('login')}")
    else:
        print(f"api /user          = {status} {info.get('error', '')[:120]}")
        return

    for repo in ("datawalkcloud/banghe-release", "datawalkcloud/BangHe"):
        status, info = api(f"repos/{repo}", token)
        perm = info.get("permission") or {}
        if status == 200:
            print(f"api repos/{repo:<28} = 200 push={perm.get('push')} admin={perm.get('admin')}")
        else:
            print(f"api repos/{repo:<28} = {status} {info.get('error', '')[:120]}")


if __name__ == "__main__":
    main()