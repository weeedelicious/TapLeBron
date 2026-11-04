"""把 CGTeamWork「火炬之光_Film / 电影部_资产」里英雄的「局内代号」同步成 Shotflow 项目资产库的英雄名单。

在装了 CGTeamWork 客户端、并已登录的 Windows 电脑上运行（借客户端的登录状态查询，不需要账号密码）：
    python tools/sync_cgtw_hero_names.py           # 有变化才上传
    python tools/sync_cgtw_hero_names.py --dry-run # 只打印，不上传

服务器端读 server/data/project-asset-heroes.json，文件变了不用重启（见 ProjectAssetLibraryService.currentHeroAssets）。
CGTeamWork 查不到或没有任何英雄时不上传，服务器保留上一份名单。
"""
import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import push  # noqa: E402

CGTW_PYTHON = Path(r'C:/CgTeamWork_v7/python/py3/python.exe')
CGTW_SDK = r'C:/CgTeamWork_v7/bin/base'
REMOTE_FILE = 'server/data/project-asset-heroes.json'
DATABASE = 'proj_tli_film'
MODULE = 'm_asset'

QUERY = r'''
import sys, json
sys.path.insert(0, %r)
import cgtw2
t = cgtw2.tw()
ids = t.info.get_id(%r, %r, [], limit='5000')
rows = t.info.get(%r, %r, ids, ['m_asset.entity', 'm_asset.cn_name', 'm_asset.gamename'])
out = [{'code': r.get('m_asset.entity') or '', 'cnName': r.get('m_asset.cn_name') or '', 'gameName': r.get('m_asset.gamename') or ''} for r in rows]
sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8'))
''' % (CGTW_SDK, DATABASE, MODULE, DATABASE, MODULE)


def query_cgtw():
    result = subprocess.run([str(CGTW_PYTHON), '-I', '-c', QUERY], capture_output=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError('CGTeamWork 查询失败：' + result.stderr.decode('utf-8', 'replace').strip()[-400:])
    return json.loads(result.stdout.decode('utf-8'))


def build_list(rows):
    heroes = []
    for row in rows:
        game_name = str(row.get('gameName') or '').strip()
        code = str(row.get('code') or '').strip()
        if not code or not game_name.startswith('英雄'):
            continue
        heroes.append({'code': code, 'gameName': game_name, 'cnName': str(row.get('cnName') or '').strip()})
    heroes.sort(key=lambda item: item['code'])
    return heroes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    heroes = build_list(query_cgtw())
    if not heroes:
        print('CGTeamWork 里没有找到任何英雄的局内代号，保留服务器上的名单，不上传')
        return 1

    remote = push.fetch_remote(REMOTE_FILE)
    previous = []
    if remote:
        try:
            previous = json.loads(remote.decode('utf-8')).get('heroes', [])
        except ValueError:
            previous = []
    strip = lambda items: [{'code': i.get('code'), 'gameName': i.get('gameName')} for i in items]
    if strip(previous) == strip(heroes):
        print(f'名单没有变化（{len(heroes)} 个英雄），不上传')
        return 0

    document = {
        'source': f'CGTeamWork {DATABASE} {MODULE}.gamename（局内代号）',
        'updatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'heroes': heroes,
    }
    payload = (json.dumps(document, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    for hero in heroes:
        print(f"  {hero['code']}  {hero['gameName']}")
    if args.dry_run:
        print(f'--dry-run：{len(heroes)} 个英雄，未上传')
        return 0

    target = f'{push.REMOTE_ROOT}/{REMOTE_FILE}'
    staged = target + '.sync-tmp'
    result = push.run_remote(
        f"mkdir -p {push.quote(str(Path(target).parent.as_posix()))} && cat > {push.quote(staged)} && "
        f"chown {push.REMOTE_OWNER} {push.quote(staged)} && chmod 0644 {push.quote(staged)} && mv {push.quote(staged)} {push.quote(target)}",
        payload=payload,
    )
    if result.returncode != 0:
        raise RuntimeError('上传失败：' + result.stderr.decode('utf-8', 'replace')[:300])
    print(f'已更新服务器英雄名单：{len(heroes)} 个英雄（之前 {len(previous)} 个）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
