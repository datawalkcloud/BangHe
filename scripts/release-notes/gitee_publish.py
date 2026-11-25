#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把最新一次 GitHub Release 发布到 Gitee：更新 raw 下载镜像 + 建 Gitee 发行版。

在 Gitee 服务器上执行（.workflow/gitee-publish.yml → build@python 步骤）。
GitHub Actions 发完 GitHub Release 后经 go-api 触发这条流水线
（scripts/release-notes/trigger_gitee_pipeline.py）；也可以在 Gitee Go 页面手动执行。

为什么搬到这里：从 GitHub 的 IP 调 Gitee v5 接口传附件撞过风控；Gitee Go 的构建机
在 Gitee 自己的网络里，推库与调接口都走内网侧，不再受这个限制。Gitee Go 云端没有
Windows runner，所以 Tauri + NSIS 的构建仍留在 GitHub。

流程（幂等，可重跑）：
  1. 定位目标 tag：TARGET_TAG 环境变量优先，否则取 GitHub「latest release」重定向；
  2. 从该 GitHub Release 下载 安装包 / latest.json / release_body.md（正文缺失时
     用最小正文兜底——补发 2026-11-25 之前打过 tag 的旧版本会碰到）；
  3. 造 orphan 工作树：版本号包 + 固定名包 + 改写安装包地址的 latest.json + README，
     强推到 datawalkcloud/banghe-release（raw 直链，客户端 endpoints 首位拉的就是它）；
     同一提交上打 tag 并推过去——Gitee 发行版绑 git tag，tag 不在创建接口直接失败；
  4. 建/复用发行版并挂附件（含回读校验），两个仓各建一次：
     - datawalkcloud/banghe-release：下载镜像仓，人类按版本翻的入口；
     - datawalkcloud/BangHe：源码镜像仓，项目首页「发行版」区要能直接看到最新版。
       镜像同步是手动/滞后的，tag 还没同步过去时从 GitHub 原样取过来推过去
       （提交与 GitHub 一致，之后的镜像同步不会打架）；
  5. 回读 raw latest.json，确认客户端实际拉的地址已是本次版本。

凭据（Gitee Go 仓库级「通用变量」，界面配置，不进仓库；名字不能以 GITEE_ 开头）：
  BH_GITEE_TOKEN  必填，私人令牌（projects 权限）
  BH_GITEE_USER   可选，令牌所属账号登录名；缺省用令牌调 /api/v5/user 反查
建完变量还要在流水线里引用才会进构建（.workflow/gitee-publish.yml 的
variables.global 列表；可视化界面是「编辑流水线 → 变量设置 → 引用变量」）。
本地手工跑时用 GITEE_TOKEN / GITEE_USER 也行（同名变量优先取 BH_ 前缀的）。
其余可用环境变量覆盖：GITEE_OWNER / GITEE_REPO / GITEE_SRC_REPO / GITEE_BRANCH /
GH_REPO / TARGET_TAG。

退出码：0 成功或已是对应版本；2 参数/凭据/下载/接口/回读任一环节不对。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "banghe-gitee-publish"
GITEE_HOST = "https://gitee.com"

OWNER = os.environ.get("GITEE_OWNER", "datawalkcloud").strip()
REPO = os.environ.get("GITEE_REPO", "banghe-release").strip()
# 源码镜像仓（Gitee Go 流水线所在的仓），发行版在那边也建一份
SRC_REPO = os.environ.get("GITEE_SRC_REPO", "BangHe").strip()
BRANCH = os.environ.get("GITEE_BRANCH", "master").strip()
GH_REPO = os.environ.get("GH_REPO", "datawalkcloud/BangHe").strip()


def env_first(*names: str) -> str:
    for name in names:
        val = os.environ.get(name, "").strip()
        if val:
            return val
    return ""


# Gitee Go 的「通用变量」不许用 GITEE_ 前缀（系统级参数占用），流水线里配的是
# BH_GITEE_TOKEN / BH_GITEE_USER；GITEE_* 留给本地手工跑与 GitHub Actions。
TOKEN = env_first("BH_GITEE_TOKEN", "GITEE_TOKEN")
if not TOKEN:
    # 构建机自带一份用于检出的 Basic 凭据（git extraheader）。通用变量没接上的话
    # 直接沿用这份——能否跨仓推送由 Gitee 侧的权限决定，不行会在第一次接口/推送上报错。
    try:
        from gitee_probe import extraheader_token

        TOKEN = extraheader_token()[1]
    except Exception:
        TOKEN = ""
    if TOKEN:
        print("BH_GITEE_TOKEN 没进环境，改用构建机检出凭据充当令牌", flush=True)

ASSET_TPL = "banghe-{version}-windows-x64-setup.exe"
STABLE_ASSET = "banghe-latest-windows-x64-setup.exe"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RELEASE_SCRIPT = os.path.join(SCRIPT_DIR, "gitee_release.py")


def log(msg: str) -> None:
    print(msg, flush=True)


def fail(msg: str) -> None:
    print(f"::error::{msg}", file=sys.stderr, flush=True)
    sys.exit(2)


def http(url: str, *, method: str = "GET", timeout: int = 60, headers: dict | None = None,
         dest: str | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, method=method,
                                 headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if dest:
                with open(dest, "wb") as f:
                    shutil.copyfileobj(resp, f)
                return resp.status, b""
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode("utf-8", "replace")


def resolve_tag() -> str:
    tag = os.environ.get("TARGET_TAG", "").strip()
    if tag:
        return tag
    # github.com 的 latest 重定向不带 API 配额；被墙/超时时依次退到 gh-proxy 与 JSON 接口
    redirect_urls = [
        f"https://github.com/{GH_REPO}/releases/latest",
        f"https://gh-proxy.com/https://github.com/{GH_REPO}/releases/latest",
    ]
    for url in redirect_urls:
        try:
            req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as resp:
                final = resp.geturl()
        except urllib.error.HTTPError as e:
            final = e.geturl() if hasattr(e, "geturl") else ""
        except Exception as e:
            log(f"  解析 latest 失败（{url}）：{e}")
            continue
        m = re.search(r"/releases/tag/(v[0-9][^/?#]*)", final or "")
        if m:
            return m.group(1)
        log(f"  解析 latest 未拿到 tag（{url} → {final}）")
    api_urls = [
        f"https://api.github.com/repos/{GH_REPO}/releases/latest",
        f"https://gh-proxy.com/https://api.github.com/repos/{GH_REPO}/releases/latest",
    ]
    for url in api_urls:
        status, body = http(url, timeout=40, headers={"Accept": "application/vnd.github+json"})
        if status == 200:
            try:
                tag = json.loads(body).get("tag_name") or ""
            except ValueError:
                tag = ""
            if tag:
                return tag
        log(f"  解析 latest 失败（{url}）：HTTP {status}")
    fail("定位不到最新 GitHub Release 的 tag（GitHub 网络不通？）。"
         "可在 Gitee Go 给这次构建设环境变量 TARGET_TAG=vX.Y.Z 后重跑。")


def download(tag: str, name: str, dest: str, *, optional: bool = False) -> bool:
    bases = [
        f"https://gh-proxy.com/https://github.com/{GH_REPO}/releases/download/{tag}",
        f"https://github.com/{GH_REPO}/releases/download/{tag}",
    ]
    for base in bases:
        url = f"{base}/{name}"
        if os.path.exists(dest):
            os.remove(dest)
        status, _ = http(url, timeout=300, dest=dest)
        if status == 200 and os.path.isfile(dest) and os.path.getsize(dest) > 0:
            size = os.path.getsize(dest)
            log(f"  下载 {name}（{size / 1048576:.1f} MB）← {url}")
            return True
        log(f"  下载失败（HTTP {status}）：{url}")
    if optional:
        return False
    fail(f"从 GitHub Release {tag} 下载不到 {name}（直连与 gh-proxy 都失败）")


def gitee_raw_version() -> str | None:
    url = f"{GITEE_HOST}/{OWNER}/{REPO}/raw/{BRANCH}/latest.json?t={int(time.time())}"
    status, body = http(url, timeout=30)
    if status != 200:
        return None
    try:
        return json.loads(body.decode("utf-8")).get("version")
    except ValueError:
        return None


def push_user() -> str:
    user = env_first("BH_GITEE_USER", "GITEE_USER")
    if user:
        return user
    status, body = http(
        f"https://gitee.com/api/v5/user?access_token={urllib.parse.quote(TOKEN)}", timeout=30)
    if status == 200:
        try:
            login = json.loads(body).get("login")
            if login:
                return login
        except ValueError:
            pass
    # Gitee 也接受把 oauth2 当 HTTPS 用户名，令牌当密码
    return "oauth2"


def git(*args: str, cwd: str, env: dict | None = None, hint: str = "") -> str:
    proc = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True,
                          text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        fail(f"git {' '.join(args)} 失败：\n{proc.stderr.strip() or proc.stdout.strip()}{hint}")
    return proc.stdout


def ensure_src_tag(repo: str, tag: str, auth: list[str], env: dict) -> None:
    """源码镜像仓里也得有同一个 tag，发行版才建得起来。

    镜像同步是手动/滞后的，刚发的 tag 多半还没过去。从 GitHub 原样取这个 tag 再推，
    指向的提交与 GitHub 一致；别推 orphan 里的同名 tag——那会让之后的镜像同步对不上。
    """
    src_url = f"{GITEE_HOST}/{OWNER}/{SRC_REPO}.git"
    if git("ls-remote", src_url, f"refs/tags/{tag}", cwd=repo, env=env).strip():
        return
    log(f"{SRC_REPO} 还没有 tag {tag}（镜像未同步），从 GitHub 取过来再推")
    git("fetch", "-q", "--no-tags", f"https://github.com/{GH_REPO}.git",
        f"+refs/tags/{tag}:refs/banghe-src/{tag}", cwd=repo, env=env,
        hint=(f"\n（Gitee 构建机连不上 GitHub：到 Gitee 的 {SRC_REPO} 仓库页点「同步」把 tag"
              f"带过来，再重跑这条流水线；或给构建配 TARGET_TAG 后重跑）"))
    git(*auth, "push", "-q", src_url, f"refs/banghe-src/{tag}:refs/tags/{tag}",
        cwd=repo, env=env)
    log(f"已把 tag {tag} 推到 {SRC_REPO}")


def make_release(repo_name: str, tag: str, version: str, body_path: str, ref: str,
                 asset: str) -> None:
    log(f"建/复用 Gitee 发行版 {repo_name} 并挂附件（含回读校验）")
    proc = subprocess.run(
        [sys.executable, RELEASE_SCRIPT,
         "--owner", OWNER, "--repo", repo_name, "--tag", tag, "--version", version,
         "--title", f"磅禾粮站收粮系统 {version}", "--body-file", body_path,
         "--ref", ref, "--assets", asset],
        env={**os.environ, "GITEE_TOKEN": TOKEN})
    if proc.returncode != 0:
        fail(f"{repo_name} 的发行版步骤失败（退出码 {proc.returncode}），见上方输出")


def build_tree(work: str, exe: str, manifest: dict) -> tuple[str, str]:
    """造 orphan 工作树，返回 (仓库目录, 带版本号的安装包路径)。"""
    repo = os.path.join(work, "repo")
    os.makedirs(repo)
    version = manifest["version"]
    asset = ASSET_TPL.format(version=version)
    shutil.copyfile(exe, os.path.join(repo, asset))
    # 固定文件名一份：官网/README 的下载直链只认 banghe-latest-*，改版号不用动网页
    shutil.copyfile(exe, os.path.join(repo, STABLE_ASSET))

    # 只把安装包地址换成 raw 直链，签名与版本原样保留（客户端用的仍是同一把 minisign 公钥）
    rawbase = f"{GITEE_HOST}/{OWNER}/{REPO}/raw/{BRANCH}"
    for plat in (manifest.get("platforms") or {}).values():
        plat["url"] = f"{rawbase}/{asset}"
    with open(os.path.join(repo, "latest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    with open(os.path.join(repo, "README.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write("# 磅禾粮站收粮系统 · 下载\n\n"
                f"当前版本：{version}\n\n"
                f"稳定直链（始终指向最新版，可直接用）：\n{rawbase}/{STABLE_ASSET}\n\n"
                "本仓仅存放最新安装包与在线更新清单（latest.json），不含源码。\n")
    return repo, os.path.join(repo, asset)


def main() -> None:
    if not TOKEN:
        fail("没有 GITEE_TOKEN：通用变量建了不等于生效，流水线必须在 variables.global "
             "列表里引用它（可视化界面里是「编辑流水线 → 变量设置 → 引用变量」，"
             "保存后写进 YAML 的就是这个列表）——没被引用的变量不会进构建环境。"
             "见 .workflow/gitee-publish.yml 的 variables.global")

    if "${" in TOKEN:
        fail("BH_GITEE_TOKEN 拿到的还是 ${...} 字面量：变量被引用了但值没替换进构建。"
             "到「编辑流水线 → 变量设置 → 引用变量」确认 BH_GITEE_TOKEN 已勾选并保存，"
             "再在「通用变量」里确认值不是占位符")

    tag = resolve_tag()
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        fail(f"tag「{tag}」不是 vX.Y.Z 形态，安装包名与发行版标题会对不齐")
    version = tag[1:]
    log(f"目标：GitHub {GH_REPO} Release {tag} → Gitee {OWNER}/{REPO}"
        + (f" + {OWNER}/{SRC_REPO}" if SRC_REPO and SRC_REPO != REPO else ""))

    work = tempfile.mkdtemp(prefix="gitee-publish-")
    try:
        asset_name = ASSET_TPL.format(version=version)
        exe = os.path.join(work, "installer.exe")
        manifest_path = os.path.join(work, "latest.json")
        body_path = os.path.join(work, "release_body.md")
        download(tag, asset_name, exe)
        if os.path.getsize(exe) < 1024 * 1024:
            fail(f"下载到的安装包只有 {os.path.getsize(exe)} B，不像安装包本体")
        download(tag, "latest.json", manifest_path)
        # 正文缺失只发生在补发旧版本时（release_body.md 是 2026-11-25 才作为附件上传的）
        if not download(tag, "release_body.md", body_path, optional=True):
            log("  这次 Release 没有 release_body.md，用最小正文兜底（补发旧版本的情况）")
            with open(body_path, "w", encoding="utf-8", newline="\n") as f:
                f.write(f"磅禾粮站收粮系统 {version}\n\n"
                        f"安装包见本页附件；完整更新说明见 GitHub Release：\n"
                        f"https://github.com/{GH_REPO}/releases/tag/{tag}\n")

        try:
            with open(manifest_path, encoding="utf-8") as f:
                manifest = json.load(f)
        except ValueError as e:
            fail(f"下载到的 latest.json 不是 JSON：{e}")
        if manifest.get("version") != version:
            fail(f"latest.json 版本 {manifest.get('version')} 与 tag {tag} 对不上")
        if not (manifest.get("platforms") or {}).get("windows-x86_64", {}).get("signature"):
            fail("latest.json 缺 windows-x86_64 签名，客户端会验签失败拒装")
        with open(body_path, encoding="utf-8") as f:
            if not f.read().strip():
                fail("下载到的 release_body.md 是空的（GitHub Release 漏传了？）")

        repo, asset_path = build_tree(work, exe, manifest)
        git("init", "-q", ".", cwd=repo)
        git("config", "user.email", "ci@datawalk.cn", cwd=repo)
        git("config", "user.name", "BangHe CI", cwd=repo)
        git("add", "-A", cwd=repo)
        git("commit", "-qm", f"sync {version}", cwd=repo)
        git("tag", "-f", tag, cwd=repo)

        user = push_user()
        cred = os.path.join(work, "git-credentials")
        with open(cred, "w", encoding="utf-8") as f:
            f.write(f"https://{urllib.parse.quote(user, safe='')}:"
                    f"{urllib.parse.quote(TOKEN, safe='')}@gitee.com\n")
        os.chmod(cred, 0o600)
        # 令牌只落在临时凭据文件里：不进 argv、不进 URL、不进报错信息。
        # 路径转正斜杠——git 把 helper 值当命令解析，Windows 反斜杠会被当转义。
        helper = f"credential.helper=store --file={cred.replace(os.sep, '/')}"
        auth = ["-c", "credential.helper=", "-c", helper]
        env = os.environ.copy()
        env["GIT_TERMINAL_PROMPT"] = "0"
        env.pop("GIT_ASKPASS", None)

        url = f"{GITEE_HOST}/{OWNER}/{REPO}.git"
        if gitee_raw_version() == version:
            log(f"raw 镜像已是 {version}，跳过 branch 推送（tag 与发行版照常校正）")
        else:
            git(*auth, "push", "-f", "-q", url, f"HEAD:refs/heads/{BRANCH}", cwd=repo, env=env)
            log(f"已强推 {REPO}@{BRANCH}（只保留最新版，不累积历史）")
        git(*auth, "push", "-f", "-q", url, f"refs/tags/{tag}", cwd=repo, env=env)
        log(f"已推 tag {tag}")

        make_release(REPO, tag, version, body_path, BRANCH, asset_path)

        if SRC_REPO and SRC_REPO != REPO:
            ensure_src_tag(repo, tag, auth, env)
            make_release(SRC_REPO, tag, version, body_path, "master", asset_path)

        # 客户端 endpoints 首位就是这份 raw latest.json：回读不到版本 = 新版被藏起来
        for _ in range(5):
            if gitee_raw_version() == version:
                log(f"raw 更新清单已生效：{GITEE_HOST}/{OWNER}/{REPO}/raw/{BRANCH}/latest.json"
                    f"（版本 {version}）")
                log(f"发行版页面：{GITEE_HOST}/{OWNER}/{REPO}/releases/tag/{tag}")
                if SRC_REPO and SRC_REPO != REPO:
                    log(f"           {GITEE_HOST}/{OWNER}/{SRC_REPO}/releases/tag/{tag}")
                return
            time.sleep(3)
        fail(f"raw latest.json 回读不到版本 {version}，客户端会停在旧版")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()