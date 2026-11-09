"""把 CGTeamWork 里 RO_Film（仙境传说_Film）的资产列表同步成项目资产库 RO 的清单：CGTW 多了就补，少了就删。

由 tools/sync_cgtw_hero_names.py 顺带调用（本机计划任务「Shotflow CGTW Hero Names」每 15 分钟一次），也可以单独跑：
    python tools/sync_cgtw_asset_rows.py           # 有变化才上传
    python tools/sync_cgtw_asset_rows.py --dry-run # 只打印，不上传

服务器端读 server/data/project-asset-rows-ro.json（见 ProjectAssetLibraryService 的 sources[].rowsFile），
文件改了不用重启。CGTW 查不到或一个资产都没有时不上传，服务器保留上一份；文件没有时用 project-asset-sheet.json 里写死的行兜底。
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
REMOTE_FILE = 'server/data/project-asset-rows-ro.json'
DATABASE = 'proj_ro_film'
ASSET_ROOT = 'X:\\projects2024\\RO\\Asset'
PROJECT_LABEL, PROJECT_CODE = 'RO2_PV', 'ro2_pv'
ATMOSPHERE = 'X:\\projects2024\\RO\\RO2_PV\\00_Production_Guide\\03-影创美术\\气氛图'
KIND_ORDER = {'Cha': 0, 'Env': 1, 'Prop': 2}

QUERY = r'''
import sys, json
sys.path.insert(0, %r)
import cgtw2
t = cgtw2.tw()
ids = t.info.get_id(%r, 'm_asset', [], limit='5000')
rows = t.info.get(%r, 'm_asset', ids, ['m_asset.entity', 'm_asset.cn_name', 'm_asset.type'])
out = [{'code': r.get('m_asset.entity') or '', 'name': r.get('m_asset.cn_name') or '', 'type': r.get('m_asset.type') or ''} for r in rows]
sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8'))
''' % (CGTW_SDK, DATABASE, DATABASE)


def query_cgtw():
    result = subprocess.run([str(CGTW_PYTHON), '-I', '-c', QUERY], capture_output=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError('CGTeamWork 查询失败：' + result.stderr.decode('utf-8', 'replace').strip()[-400:])
    return json.loads(result.stdout.decode('utf-8'))


def build_rows(assets):
    keep = []
    for item in assets:
        code = str(item.get('code') or '').strip()
        kind = str(item.get('type') or '').strip()
        # 测试资产（C999_test 之类）不进资产库
        if not code or kind not in KIND_ORDER or 'test' in code.lower():
            continue
        keep.append({'code': code, 'name': str(item.get('name') or '').strip() or code, 'kind': kind})
    keep.sort(key=lambda a: (KIND_ORDER[a['kind']], a['code'].lower()))
    rows = []
    for index, item in enumerate(keep):
        first = index == 0
        rows.append({
            'label': PROJECT_LABEL if first else '', 'projectCode': PROJECT_CODE if first else '',
            'kind': item['kind'], 'name': item['name'], 'code': item['code'], 'gameName': '',
            'assetDir': f"{ASSET_ROOT}\\{item['kind']}\\{item['code']}", 'd2': '', 'd3': '',
            'atmosphere': ATMOSPHERE if first else '',
        })
    return rows


def sync(dry_run=False):
    rows = build_rows(query_cgtw())
    if not rows:
        print('RO：CGTeamWork 里没有可用资产，保留服务器上的清单，不上传')
        return 1
    remote = push.fetch_remote(REMOTE_FILE)
    previous = []
    if remote:
        try:
            previous = json.loads(remote.decode('utf-8')).get('rows', [])
        except ValueError:
            previous = []
    codes = lambda items: [(r.get('code'), r.get('name'), r.get('kind')) for r in items]
    if codes(previous) == codes(rows):
        print(f'RO：资产清单没有变化（{len(rows)} 个），不上传')
        return 0
    old = {r.get('code') for r in previous}
    new = {r['code'] for r in rows}
    print(f"RO：新增 {sorted(new - old)}，移除 {sorted(old - new)}")
    if dry_run:
        print(f'--dry-run：{len(rows)} 个资产，未上传')
        return 0
    document = {
        'source': f'CGTeamWork {DATABASE} m_asset（去掉测试资产）',
        'updatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'rows': rows,
    }
    payload = (json.dumps(document, ensure_ascii=False, indent=1) + '\n').encode('utf-8')
    target = f'{push.REMOTE_ROOT}/{REMOTE_FILE}'
    staged = target + '.sync-tmp'
    result = push.run_remote(
        f"mkdir -p {push.quote(str(Path(target).parent.as_posix()))} && cat > {push.quote(staged)} && "
        f"chown {push.REMOTE_OWNER} {push.quote(staged)} && chmod 0644 {push.quote(staged)} && mv {push.quote(staged)} {push.quote(target)}",
        payload=payload,
    )
    if result.returncode != 0:
        raise RuntimeError('上传失败：' + result.stderr.decode('utf-8', 'replace')[:300])
    print(f'RO：已更新服务器资产清单 {len(rows)} 个（之前 {len(previous)} 个）')
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    return sync(parser.parse_args().dry_run)


if __name__ == '__main__':
    sys.exit(main())
