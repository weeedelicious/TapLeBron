#!/usr/bin/env python3
"""画布保存健康巡检 —— 只读，不改线上任何东西。

为什么需要它：2026-08-14 发现 5 个画布陷在保存 409 死循环里，其中 canvas 115
从前一天 18:09 起一整天没成功保存过一次。用户界面只有一个横幅，没人知道自己在白干，
是靠人来报"东西丢了"才发现的。这个脚本把"谁的保存正在失败"变成一条命令。

它做两件事：
  1. 读 nginx 访问日志，按画布统计时间窗内 /nodes/* 的成功与失败次数
  2. 读数据库补上画布标题、拥有者、当前占用者、最后一次内容落盘时间

注意「最后一次内容落盘」取的是 canvas_revisions 的最新时间，它包含
"保存整体 409 但新节点被单独救下"那条路径写的 revision——所以它比
nginx 的 200 次数更宽，别把两者混为一谈。

判定"正在流血"：窗口内失败 >= 阈值 且 成功 == 0。
这种状态只能靠用户刷新页面跳出，所以输出最后会直接给出"该通知谁"。

用法：
  python tools/save_health.py                 最近 15 分钟
  python tools/save_health.py --window 120    最近 2 小时
  python tools/save_health.py --json          机器可读，可挂 cron
退出码：0 = 没人流血；1 = 有画布正在失败（方便以后做告警）。
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys

HOST = "xindong-server"
REMOTE_ROOT = "/data/wyx_root/tapflow-workbench"
ACCESS_LOGS = ["/var/log/nginx/access.log", "/var/log/nginx/access.log.1"]
FAIL_THRESHOLD = 5

SSH = shutil.which("ssh")

# 在服务器上跑：那里才有 nginx 日志和数据库。输出一行 JSON 给本地格式化。
REMOTE_SCRIPT = r"""
const fs = require('fs');
const { getAdminPool, getContentPool } = require('./server/db');
const { canvasSessionState } = require('./server/services/CanvasAccessSessionService');

const WINDOW_MIN = Number(process.argv[2] || 15);
const LOGS = process.argv.slice(3);
const MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
// 一律用服务器本地时间格式化。toISOString() 会转成 UTC，比 CST 少 8 小时，
// 排查时看着像"凌晨就没保存过了"，会把人带偏。
const pad = (n) => String(n).padStart(2, '0');
const localStamp = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const cutoff = Date.now() - WINDOW_MIN * 60_000;
// 例：[14/Aug/2026:12:36:40 +0800] "POST /api/projects/232/nodes/batch HTTP/1.1" 409
const LINE = /\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) [^\]]*\].*"(?:POST|GET) \/api\/projects\/(\d+)\/nodes\/[a-z0-9-]+[^"]*" (\d{3})/;

const stats = new Map();
for (const file of LOGS) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const at = new Date(Number(m[3]), MONTHS[m[2]], Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
    if (at < cutoff) continue;
    const id = m[7];
    const code = Number(m[8]);
    const entry = stats.get(id) || { canvasId: id, ok: 0, conflict: 0, serverError: 0, other: 0, lastFailAt: 0, lastOkAt: 0 };
    if (code >= 200 && code < 300) { entry.ok += 1; entry.lastOkAt = Math.max(entry.lastOkAt, at); }
    else if (code === 409 || code === 428) { entry.conflict += 1; entry.lastFailAt = Math.max(entry.lastFailAt, at); }
    else if (code >= 500) { entry.serverError += 1; entry.lastFailAt = Math.max(entry.lastFailAt, at); }
    else { entry.other += 1; }
    stats.set(id, entry);
  }
}

(async () => {
  const rows = [];
  for (const entry of stats.values()) {
    const [meta] = await getAdminPool().query(
      'SELECT title, owner_id, node_count FROM canvases WHERE id = ? LIMIT 1', [entry.canvasId]);
    if (!meta.length) continue;
    const [owner] = await getAdminPool().query(
      'SELECT username FROM users WHERE id = ? LIMIT 1', [meta[0].owner_id]);
    const [last] = await getContentPool().query(
      'SELECT MAX(created_at) t FROM canvas_revisions WHERE canvas_id = ?', [entry.canvasId]);
    let holder = null;
    try {
      const state = await canvasSessionState(entry.canvasId);
      if (state) {
        const [hu] = await getAdminPool().query(
          'SELECT username FROM users WHERE id = ? LIMIT 1', [state.user_id]);
        holder = {
          username: hu[0] ? hu[0].username : ('user ' + state.user_id),
          lastSeen: localStamp(state.last_seen_at),
        };
      }
    } catch {}
    rows.push({
      ...entry,
      title: meta[0].title,
      owner: owner[0] ? owner[0].username : ('user ' + meta[0].owner_id),
      nodeCount: Number(meta[0].node_count || 0),
      lastSuccessfulSave: localStamp(last[0].t),
      holder,
    });
  }
  console.log('JSON_START' + JSON.stringify({ windowMinutes: WINDOW_MIN, generatedAt: localStamp(Date.now()), canvases: rows }) + 'JSON_END');
  process.exit(0);
})().catch((error) => {
  console.log('JSON_START' + JSON.stringify({ error: String(error && error.message || error) }) + 'JSON_END');
  process.exit(0);
});
"""


def remote_json(window: int) -> dict:
    if not SSH:
        raise SystemExit("本机找不到 ssh 客户端")
    command = f"cd {REMOTE_ROOT} && node - {window} {' '.join(ACCESS_LOGS)}"
    result = subprocess.run(
        [SSH, "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", HOST, command],
        input=REMOTE_SCRIPT.encode("utf-8"),
        capture_output=True,
        timeout=300,
    )
    out = result.stdout.decode("utf-8", "replace")
    if "JSON_START" not in out:
        raise SystemExit(
            "远端没有返回结果。stdout/stderr:\n"
            + out[-800:]
            + result.stderr.decode("utf-8", "replace")[-800:]
        )
    return json.loads(out.split("JSON_START", 1)[1].split("JSON_END", 1)[0])


def short_time(stamp: str | None) -> str:
    # 远端已按服务器本地时间格式化成 MM-DD HH:MM:SS，这里不再做任何转换
    return stamp or "从无"


def main() -> int:
    parser = argparse.ArgumentParser(description="画布保存健康巡检（只读）")
    parser.add_argument("--window", type=int, default=15, help="回看多少分钟，默认 15")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args()

    payload = remote_json(args.window)
    if payload.get("error"):
        raise SystemExit(f"远端出错: {payload['error']}")

    canvases = payload.get("canvases", [])
    burning, degraded, healthy = [], [], []
    for row in canvases:
        fails = row["conflict"] + row["serverError"]
        if fails >= FAIL_THRESHOLD and row["ok"] == 0:
            burning.append(row)
        elif fails:
            degraded.append(row)
        else:
            healthy.append(row)

    if args.json:
        print(json.dumps({**payload, "burning": burning, "degraded": degraded}, ensure_ascii=False, indent=2))
        return 1 if burning else 0

    print(f"窗口 {payload['windowMinutes']} 分钟，涉及 {len(canvases)} 个画布\n")

    if burning:
        print("正在流血（保存全部失败，只能靠刷新页面跳出）:")
        for row in burning:
            holder = row["holder"]["username"] if row.get("holder") else "无人占用"
            print(
                f"  canvas {row['canvasId']:<5} \"{row['title'][:16]}\"  {row['nodeCount']} 节点"
                f"\n        拥有者={row['owner']}  当前占用={holder}"
                f"\n        冲突 {row['conflict']} 次 / 服务端错误 {row['serverError']} 次 / 成功 0 次"
                f"\n        最后一次成功保存: {short_time(row['lastSuccessfulSave'])}"
            )
    else:
        print("没有画布处于全失败状态")

    if degraded:
        print("\n有失败但也有成功（暂时不用管，留意）:")
        for row in degraded:
            print(
                f"  canvas {row['canvasId']:<5} \"{row['title'][:16]}\"  "
                f"成功 {row['ok']} / 冲突 {row['conflict']} / 500 {row['serverError']}"
            )

    if healthy:
        print(f"\n正常保存的画布: {len(healthy)} 个")

    if burning:
        names = sorted({row["holder"]["username"] if row.get("holder") else row["owner"] for row in burning})
        print("\n" + "=" * 52)
        print("要通知这些人刷新页面（不刷新的话改动存不上）:")
        for name in names:
            print(f"  · {name}")
        print("话术：刷新一下 Shotflow 页面，服务端修了保存的问题，不刷新你的修改存不上。")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
