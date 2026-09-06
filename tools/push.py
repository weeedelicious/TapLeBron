#!/usr/bin/env python3
"""Shotflow 代码推送工具。

生产环境没有 git，靠本机直传。本地工作区长期存在"未部署 / 超出本次范围"的改动，
而且有些修复是直接在服务器上做的，所以这个工具的默认行为是：

  先比对 → 显示会删掉服务器上哪些内容 → 确认 → 备份 → 上传 → 校验 → 按需重启

只推送你明确列出的文件，绝不整目录同步。

用法
----
  python tools/push.py server/canvasRoutes.js              # 比对+确认+推送(后端会重启)
  python tools/push.py -y dist/assets/foo.js               # 跳过确认
  python tools/push.py diff server/db.js                   # 只看差异，不推
  python tools/push.py pull server/canvasRoutes.js         # 服务器 → 本地(先备份本地)
  python tools/push.py status                              # 服务状态 + 健康检查
  python tools/push.py restart                             # 只重启后端

常用参数
  -y, --yes         不询问直接执行
  --no-restart      推了 server/ 也不重启
  --no-verify       跳过 dist/assets 的 esbuild 解析校验
  --label NAME      服务器备份目录名(默认 push)
  -v, --verbose     打印完整 diff
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tarfile
import time
from datetime import datetime
from pathlib import Path

HOST = "xindong-server"
REMOTE_ROOT = "/data/wyx_root/tapflow-workbench"
SERVICE = "tapflow-workbench"
HEALTH_URL = "http://127.0.0.1:3020/Shotflow"
REMOTE_OWNER = "tapflow:tapflow"
LOCAL_ROOT = Path(__file__).resolve().parent.parent

# 绝不推送：凭据、依赖、运行期数据、备份
DENY = (".env", "node_modules/", "data/", "backups/", "tmp/", ".git/")

SSH = shutil.which("ssh")
NODE = shutil.which("node")


class Fail(Exception):
    pass


def run_remote(command: str, payload: bytes | None = None, timeout: int = 180, retries: int = 3):
    """在服务器上执行一条命令。payload 会作为 stdin 传入。

    每次调用都是一条新 ssh 连接，连续几十次会撞上 sshd 的连接限流并被拒，
    所以对"连接层"失败（返回码 255）重试，业务失败不重试。
    """
    if not SSH:
        raise Fail("本机找不到 ssh 客户端")
    result = None
    for attempt in range(retries):
        result = subprocess.run(
            [SSH, "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", HOST, command],
            input=payload,
            capture_output=True,
            timeout=timeout,
        )
        if result.returncode != 255:
            return result
        time.sleep(1.5 * (attempt + 1))
    return result


def remote_text(command: str, timeout: int = 180) -> str:
    result = run_remote(command, timeout=timeout)
    if result.returncode != 0:
        raise Fail(f"远端命令失败: {result.stderr.decode('utf-8', 'replace').strip()[:400]}")
    return result.stdout.decode("utf-8", "replace")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def quote(path: str) -> str:
    return "'" + path.replace("'", "'\\''") + "'"


def resolve_targets(raw_paths: list[str]) -> list[str]:
    """把用户给的路径归一化成相对工程根目录的 POSIX 路径。"""
    targets: list[str] = []
    for raw in raw_paths:
        candidate = Path(raw)
        absolute = candidate if candidate.is_absolute() else (Path.cwd() / candidate)
        try:
            relative = absolute.resolve().relative_to(LOCAL_ROOT)
        except ValueError:
            raise Fail(f"{raw} 不在工程目录内: {LOCAL_ROOT}")
        posix = relative.as_posix()
        if any(posix == item.rstrip("/") or posix.startswith(item) for item in DENY):
            raise Fail(f"拒绝推送受保护路径: {posix}")
        if posix not in targets:
            targets.append(posix)
    if not targets:
        raise Fail("没有指定文件")
    return targets


def local_precheck(targets: list[str]) -> None:
    """推之前先在本地做语法检查，别把坏文件传上去。"""
    if not NODE:
        return
    for posix in targets:
        if not posix.endswith((".js", ".cjs", ".mjs")):
            continue
        if posix.startswith("dist/"):
            continue  # 打包产物用服务器上的 esbuild 校验
        path = LOCAL_ROOT / posix
        result = subprocess.run([NODE, "--check", str(path)], capture_output=True)
        if result.returncode != 0:
            raise Fail(
                f"本地语法检查失败 {posix}:\n"
                + result.stderr.decode("utf-8", "replace").strip()[:600]
            )


def read_local(posix: str) -> bytes:
    path = LOCAL_ROOT / posix
    if not path.is_file():
        raise Fail(f"本地文件不存在: {posix}")
    return path.read_bytes()


def fetch_remote(posix: str) -> bytes | None:
    """取回远端文件内容；不存在返回 None。"""
    result = run_remote(f"cat {quote(REMOTE_ROOT + '/' + posix)}")
    return None if result.returncode != 0 else result.stdout


def is_text(data: bytes) -> bool:
    if b"\x00" in data[:4096]:
        return False
    try:
        data.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def normalize(data: bytes) -> bytes:
    """服务器上一律是 LF。本地 Windows 编辑器常写成 CRLF，上传前统一掉，
    否则每一行都会算成改动，diff 没法看，也会把 CRLF 带进生产。"""
    return data.replace(b"\r\n", b"\n") if is_text(data) else data


def diff_report(posix: str, local: bytes, remote: bytes | None, verbose: bool):
    """返回 (新增行, 删除行, 要打印的 diff 片段)。删除行代表会丢掉服务器上的内容。"""
    if remote is None:
        return (len(local.splitlines()), 0, ["  (服务器上是新文件)"])
    if not (is_text(local) and is_text(remote)):
        return (0, 0, [f"  二进制文件，本地 {len(local)}B / 服务器 {len(remote)}B"])

    remote_lines = remote.decode("utf-8", "replace").splitlines(keepends=True)
    local_lines = local.decode("utf-8", "replace").splitlines(keepends=True)
    added = removed = 0
    body: list[str] = []
    for line in difflib.unified_diff(
        remote_lines, local_lines, fromfile=f"[server] {posix}", tofile=f"[local] {posix}", n=2
    ):
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
        body.append("  " + line.rstrip("\n"))
    if not verbose and len(body) > 40:
        body = body[:40] + [f"  ... 还有 {len(body) - 40} 行差异（-v 看完整 diff）"]
    return (added, removed, body)


def backup_and_upload(targets: list[str], label: str) -> str:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = f"backups/{label}-pre-{stamp}"
    for posix in targets:
        remote = f"{REMOTE_ROOT}/{posix}"
        backup_path = f"{REMOTE_ROOT}/{backup_dir}/{posix}"
        remote_text(
            f"mkdir -p {quote(str(Path(backup_path).parent.as_posix()))} && "
            f"if [ -f {quote(remote)} ]; then cp -p {quote(remote)} {quote(backup_path)}; fi"
        )

        payload = normalize(read_local(posix))
        staged = f"{remote}.push-tmp"
        upload = run_remote(
            f"mkdir -p {quote(str(Path(remote).parent.as_posix()))} && cat > {quote(staged)}",
            payload=payload,
        )
        if upload.returncode != 0:
            raise Fail(f"上传失败 {posix}: {upload.stderr.decode('utf-8', 'replace')[:300]}")

        verify = remote_text(f"sha256sum {quote(staged)} | cut -d' ' -f1").strip()
        if verify != sha256_bytes(payload):
            run_remote(f"rm -f {quote(staged)}")
            raise Fail(f"{posix} 上传后校验和不一致，已丢弃，未覆盖线上文件")

        remote_text(
            f"mv {quote(staged)} {quote(remote)} && "
            f"chown {REMOTE_OWNER} {quote(remote)} && chmod 0644 {quote(remote)}"
        )
    return backup_dir


def remote_verify(targets: list[str], skip_bundle: bool) -> list[str]:
    notes: list[str] = []
    for posix in targets:
        remote = f"{REMOTE_ROOT}/{posix}"
        if posix.startswith("server/") and posix.endswith((".js", ".cjs", ".mjs")):
            result = run_remote(f"cd {quote(REMOTE_ROOT)} && node --check {quote(remote)}")
            if result.returncode != 0:
                raise Fail(
                    f"服务器语法检查失败 {posix}（文件已回滚点在 backups/）:\n"
                    + result.stderr.decode("utf-8", "replace")[:500]
                )
            notes.append(f"node --check {posix} 通过")
        elif not skip_bundle and posix.startswith("dist/assets/") and posix.endswith(".js"):
            result = run_remote(
                f"cd {quote(REMOTE_ROOT)} && npx esbuild {quote(remote)} "
                f"--format=esm --outfile=/dev/null --log-level=error",
                timeout=300,
            )
            if result.returncode != 0:
                raise Fail(
                    f"打包产物无法解析 {posix}:\n"
                    + result.stderr.decode("utf-8", "replace")[:500]
                )
            notes.append(f"esbuild 解析 {posix} 通过")
    return notes


def runtime_state() -> dict:
    output = remote_text(
        f"cd {quote(REMOTE_ROOT)} && node -e "
        "\"console.log('STATE='+JSON.stringify(require('./server/canvasRoutes').generationRuntimeState()))\"",
        timeout=120,
    )
    match = re.search(r"STATE=(\{.*\})", output)
    if not match:
        raise Fail("读取生成任务状态失败，为安全起见不重启")
    return json.loads(match.group(1))


def service_state() -> dict:
    output = remote_text(
        f"systemctl show {SERVICE} -p ActiveState -p SubState -p MainPID --no-pager"
    )
    state = {}
    for line in output.splitlines():
        key, _, value = line.partition("=")
        state[key.strip()] = value.strip()
    return state


def health_code() -> str:
    output = remote_text(
        f"curl -sS -o /dev/null -w '%{{http_code}}' {HEALTH_URL} || true"
    )
    return output.strip() or "000"


def wait_healthy(timeout: int = 60) -> str:
    """systemd 报 active 之后，进程还要跑迁移才开始监听，所以要轮询而不是查一次。"""
    deadline = time.time() + timeout
    code = "000"
    while time.time() < deadline:
        code = health_code()
        if code == "200":
            return code
        time.sleep(3)
    return code


def restart_service(force_when_busy: bool = False) -> None:
    state = runtime_state()
    busy = {k: v for k, v in state.items() if k != "draining" and v}
    if busy and not force_when_busy:
        raise Fail(f"有在途生成任务，未重启: {busy}（等它跑完，或用 restart --yes 强制）")

    old_pid = service_state().get("MainPID", "0")
    run_remote(f"nohup systemctl restart {SERVICE} > /tmp/push-restart.log 2>&1 &", timeout=30)

    deadline = time.time() + 60
    killed = False
    while time.time() < deadline:
        time.sleep(4)
        state = service_state()
        if state.get("ActiveState") == "active" and state.get("SubState") == "running":
            break
        # 这个服务经常卡在 stop-sigterm，需要强杀旧进程
        if state.get("SubState") == "stop-sigterm" and not killed and old_pid not in ("", "0"):
            run_remote(f"kill -KILL {old_pid} 2>/dev/null || true", timeout=30)
            killed = True
    else:
        raise Fail(f"重启超时，最后状态: {service_state()}")

    code = wait_healthy()
    if code != "200":
        raise Fail(f"重启后健康检查返回 {code}，请立刻检查 journalctl -u {SERVICE}")
    print(f"  重启完成{'（强杀了旧进程 ' + old_pid + '）' if killed else ''}，/Shotflow = {code}")


def cmd_status() -> int:
    state = service_state()
    print(f"服务   {state.get('ActiveState')}/{state.get('SubState')}  pid={state.get('MainPID')}")
    print(f"健康   /Shotflow = {health_code()}")
    try:
        print(f"在途   {runtime_state()}")
    except Fail as error:
        print(f"在途   读取失败: {error}")
    return 0


def cmd_diff(targets: list[str], verbose: bool) -> int:
    changed = 0
    for posix in targets:
        local = normalize(read_local(posix))
        remote = fetch_remote(posix)
        if remote is not None and normalize(remote) == local:
            print(f"一致   {posix}")
            continue
        changed += 1
        added, removed, body = diff_report(posix, local, remote, verbose)
        flag = "  ← 会删掉服务器上的内容" if removed else ""
        print(f"差异   {posix}  +{added} -{removed}{flag}")
        for line in body:
            print(line)
    print(f"\n共 {changed}/{len(targets)} 个文件与服务器不同")
    return 0


def cmd_pull(targets: list[str], assume_yes: bool) -> int:
    if not assume_yes:
        print("将用服务器版本覆盖以下本地文件（本地原文件备份为 .bak-<时间戳>）：")
        for posix in targets:
            print(f"  {posix}")
        if input("确认? [y/N] ").strip().lower() not in ("y", "yes"):
            print("已取消")
            return 1
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    # 一条 ssh 连接用 tar 流把所有文件取回来，避免几十次连接被 sshd 限流拒掉
    listing = " ".join(quote(posix) for posix in targets)
    result = run_remote(
        f"cd {quote(REMOTE_ROOT)} && tar -cf - --ignore-failed-read {listing} 2>/dev/null",
        timeout=600,
    )
    if result.returncode != 0 and not result.stdout:
        raise Fail(f"拉取失败: {result.stderr.decode('utf-8', 'replace')[:300]}")

    pulled = set()
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            posix = member.name.lstrip("./")
            handle = archive.extractfile(member)
            if handle is None:
                continue
            data = handle.read()
            path = LOCAL_ROOT / posix
            if path.is_file():
                if path.read_bytes().replace(b"\r\n", b"\n") == data.replace(b"\r\n", b"\n"):
                    pulled.add(posix)
                    continue  # 内容一样就不动，也不留多余 .bak
                path.with_suffix(path.suffix + f".bak-{stamp}").write_bytes(path.read_bytes())
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            pulled.add(posix)
            print(f"拉取   {posix}  ({len(data)}B)")

    for posix in targets:
        if posix not in pulled:
            print(f"跳过   {posix}（服务器上不存在）")
    print(f"\n共拉取 {len(pulled)}/{len(targets)} 个文件")
    return 0


def guard_frontend_release(targets: list[str], skip: bool) -> None:
    """前端产物必须来自源码构建，且不能让功能变少。

    生产曾长期"在上一个编译产物上手工打补丁"，新产物从旧产物派生，一次取错基线就会
    静默丢掉之前的修复（2026-08-12 的图片节点伪黑边修复就这样丢过）。所以推 dist/
    之前强制跑一次 release_check：产物必须是构建出来的，且功能标记不许比线上少。
    """
    bundles = [p for p in targets if p.startswith("dist/assets/") and p.endswith((".js", ".css"))]
    if not bundles:
        return
    if skip:
        print("  已按要求跳过发布对账（--no-release-check）")
        return

    checker = LOCAL_ROOT / "tools" / "release_check.py"
    if not checker.is_file():
        raise Fail("找不到 tools/release_check.py，无法做发布对账")

    js = [p for p in bundles if p.endswith(".js")]
    css = [p for p in bundles if p.endswith(".css")]
    if not js or not css:
        raise Fail(
            "发布前端产物必须同时给出 JS 和 CSS，否则样式和脚本会错版。\n"
            "先跑 `npx vite build`，把 dist/assets/index-*.js 与 index-*.css 复制成本次发布名再推。"
        )

    # 先跑测试再对账。对账只比文本标记，跑不到代码——2026-08-14 就是这样把一个
    # debounce().cancel 缺失（loadProject 直接抛 TypeError、任何画布都打不开）编进产物
    # 发上线的，哈希一致、标记齐全、对账全绿。文本检查永远发现不了这种事。
    print("  跑回归测试（发布前必须绿）…")
    tests = subprocess.run(
        ["npx", "vitest", "run", "--reporter", "dot"],
        cwd=LOCAL_ROOT,
        capture_output=True,
        shell=(sys.platform == "win32"),
        timeout=900,
    )
    test_output = (tests.stdout + tests.stderr).decode("utf-8", "replace").strip()
    for line in test_output.splitlines()[-12:]:
        print(f"    {line}")
    if tests.returncode != 0:
        raise Fail("回归测试未通过，已拒绝发布（要强行发布请显式加 --no-release-check）")

    print("  发布对账中（产物必须由源码构建、功能不许变少）…")
    result = subprocess.run(
        [sys.executable, str(checker), "check", str(LOCAL_ROOT / js[0]), str(LOCAL_ROOT / css[0])],
        cwd=LOCAL_ROOT,
        capture_output=True,
        timeout=900,
    )
    output = (result.stdout + result.stderr).decode("utf-8", "replace").strip()
    for line in output.splitlines():
        print(f"    {line}")
    if result.returncode != 0:
        raise Fail("发布对账未通过，已拒绝推送（要强行发布请显式加 --no-release-check）")


def cmd_push(args, targets: list[str]) -> int:
    local_precheck(targets)
    guard_frontend_release(targets, args.no_release_check)

    pending: list[str] = []
    total_removed = 0
    for posix in targets:
        raw = read_local(posix)
        local = normalize(raw)
        if local != raw:
            print(f"       {posix}: 本地是 CRLF，上传时会转成 LF（与生产一致）")
        remote = fetch_remote(posix)
        if remote is not None and normalize(remote) == local:
            print(f"一致   {posix}（跳过）")
            continue
        added, removed, body = diff_report(posix, local, remote, args.verbose)
        total_removed += removed
        flag = "  ← 会删掉服务器上的内容" if removed else ""
        print(f"待推   {posix}  +{added} -{removed}{flag}")
        if args.verbose or removed:
            for line in body:
                print(line)
        pending.append(posix)

    if not pending:
        print("\n服务器已经和本地一致，无需推送")
        return 0

    if total_removed:
        print(
            f"\n注意：本次推送会移除服务器上 {total_removed} 行内容。"
            "\n如果那是直接在服务器上做的修复，先 `pull` 同步到本地再改，否则会把线上修复覆盖掉。"
        )
    if not args.yes:
        if input(f"\n推送 {len(pending)} 个文件到生产? [y/N] ").strip().lower() not in ("y", "yes"):
            print("已取消，服务器未改动")
            return 1

    backup_dir = backup_and_upload(pending, args.label)
    print(f"\n已备份   {backup_dir}")
    for note in remote_verify(pending, args.no_verify):
        print(f"  {note}")

    needs_restart = any(posix.startswith("server/") for posix in pending)
    if needs_restart and not args.no_restart:
        print("  后端有改动，正在重启…")
        restart_service()
    elif needs_restart:
        print("  后端有改动但按要求未重启（改动尚未生效）")
    else:
        print(f"  静态资源已生效，/Shotflow = {health_code()}")

    print(f"\n完成：{len(pending)} 个文件已上线")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="把改好的文件推到 Shotflow 生产服务器",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "command",
        nargs="?",
        default="push",
        help="push(默认) | diff | pull | status | restart",
    )
    parser.add_argument("paths", nargs="*", help="相对工程根目录的文件路径")
    parser.add_argument("-y", "--yes", action="store_true", help="不询问")
    parser.add_argument("--no-restart", action="store_true", help="推了后端也不重启")
    parser.add_argument("--no-verify", action="store_true", help="跳过 dist 打包产物解析校验")
    parser.add_argument(
        "--no-release-check",
        action="store_true",
        help="跳过前端发布对账（只在明确知道自己在做什么时用）",
    )
    parser.add_argument("--label", default="push", help="服务器备份目录名")
    parser.add_argument("-v", "--verbose", action="store_true", help="打印完整 diff")

    # argparse 不接受把开关夹在位置参数中间（`pull -y a.js` 会解析失败），
    # 所以先把开关和路径分开，再按 开关+路径 的顺序交给 argparse。
    flags: list[str] = []
    positionals: list[str] = []
    argv = sys.argv[1:]
    index = 0
    while index < len(argv):
        token = argv[index]
        if token == "--label":
            flags.extend([token, argv[index + 1] if index + 1 < len(argv) else ""])
            index += 2
        elif token.startswith("-"):
            flags.append(token)
            index += 1
        else:
            positionals.append(token)
            index += 1
    args = parser.parse_args(flags + positionals)

    command = args.command
    paths = args.paths
    # 允许 `push.py server/x.js`——第一个参数其实是文件时自动当成 push
    if command not in ("push", "diff", "pull", "status", "restart"):
        paths = [command] + paths
        command = "push"

    try:
        if command == "status":
            return cmd_status()
        if command == "restart":
            restart_service(force_when_busy=args.yes)
            return 0
        targets = resolve_targets(paths)
        if command == "diff":
            return cmd_diff(targets, args.verbose)
        if command == "pull":
            return cmd_pull(targets, args.yes)
        return cmd_push(args, targets)
    except Fail as error:
        print(f"\n失败: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\n已中断", file=sys.stderr)
        return 130
    except subprocess.TimeoutExpired:
        print("\n失败: 远端命令超时", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
