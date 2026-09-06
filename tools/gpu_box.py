"""4090 worker 机（172.26.166.238，Windows）的远程操作入口。

为什么是 paramiko 而不是 ssh / SMB：
  - 本机 Git Bash 没有 sshpass，非交互 shell 下 ssh 没法喂密码；
  - SMB 走不通：那台机已经有一个到 \\\\172.26.166.238\\sd_output 的活动会话，
    用另一个用户对同一服务器建第二个连接必撞系统错误 1219，唯一解法是断掉用户
    正在用的挂载 —— 不动它。

密码只从环境变量 GPU_BOX_PASSWORD 读，不写进这个文件、不写进任何配置。

用法：
    GPU_BOX_PASSWORD=... python tools/gpu_box.py exec "powershell -c ..."
    GPU_BOX_PASSWORD=... python tools/gpu_box.py put <本地文件> <远端绝对路径>
    GPU_BOX_PASSWORD=... python tools/gpu_box.py info
"""

import os
import posixpath
import stat
import sys

import paramiko

HOST = os.environ.get("GPU_BOX_HOST", "172.26.166.238")
PORT = int(os.environ.get("GPU_BOX_PORT", "22"))
USER = os.environ.get("GPU_BOX_USER", "User")


def password() -> str:
    value = os.environ.get("GPU_BOX_PASSWORD", "")
    if not value:
        raise SystemExit("缺少环境变量 GPU_BOX_PASSWORD")
    return value


def connect() -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=HOST,
        port=PORT,
        username=USER,
        password=password(),
        look_for_keys=False,
        allow_agent=False,
        timeout=25,
    )
    return client


def run(client: paramiko.SSHClient, command: str, timeout: int = 600) -> int:
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    stdin.close()
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out.rstrip())
    if err.strip():
        print("[stderr]", err.rstrip())
    return code


def put(client: paramiko.SSHClient, local: str, remote: str) -> None:
    sftp = client.open_sftp()
    try:
        # 远端是 Windows，路径用反斜杠；SFTP 服务端接受正斜杠，这里统一成正斜杠再建目录。
        normalized = remote.replace("\\", "/")
        parent = posixpath.dirname(normalized)
        parts = []
        while parent and parent not in ("/", ""):
            parts.append(parent)
            nxt = posixpath.dirname(parent)
            if nxt == parent:
                break
            parent = nxt
        for path in reversed(parts):
            try:
                sftp.stat(path)
            except IOError:
                try:
                    sftp.mkdir(path)
                except IOError:
                    pass
        sftp.put(local, normalized)
        info = sftp.stat(normalized)
        print(f"已上传 {local} -> {remote}  ({info.st_size} bytes)")
    finally:
        sftp.close()


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    action = sys.argv[1]
    client = connect()
    try:
        if action == "info":
            return run(
                client,
                'powershell -NoProfile -Command "'
                "$ErrorActionPreference=\\'Continue\\';"
                "whoami; "
                "\\'--- admin? \\' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); "
                "\\'--- GPU ---\\'; nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv; "
                "\\'--- C:\\Shotflow ---\\'; Get-ChildItem C:\\Shotflow | Select-Object -ExpandProperty Name"
                '"',
            )
        if action == "exec":
            if len(sys.argv) < 3:
                raise SystemExit("exec 需要一条命令")
            return run(client, sys.argv[2])
        if action == "put":
            if len(sys.argv) < 4:
                raise SystemExit("put 需要本地文件和远端路径")
            put(client, sys.argv[2], sys.argv[3])
            return 0
        if action == "get":
            if len(sys.argv) < 4:
                raise SystemExit("get 需要远端路径和本地文件")
            sftp = client.open_sftp()
            try:
                sftp.get(sys.argv[2].replace("\\", "/"), sys.argv[3])
                print(f"已下载 {sys.argv[2]} -> {sys.argv[3]}")
            finally:
                sftp.close()
            return 0
        raise SystemExit(f"未知动作: {action}")
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
