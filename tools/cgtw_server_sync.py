"""项目资产库的 CGTW 同步（在 Shotflow 服务器上跑，Python 3.7 + /opt/CgTeamWork_v7.0 的 cgtw2）。

用审核看板（tli_sc）已配好的 CGTW 专用账号，只读：
  - 火炬之光（proj_tli_film）m_asset.gamename，CGTW 里叫「英雄」：有值的资产进「英雄」筛选；
  - RO（proj_ro_film）m_asset.gamename，CGTW 里叫「职业」：有值的资产进「职业」筛选；
  - RO 的资产列表（多删少补），写 project-asset-rows-ro.json。
写到 server/data/ 下，ProjectAssetLibraryService 按 mtime 热读，不用重启。

由 root 的 cron 每 15 分钟跑一次：
    */15 * * * * /opt/CgTeamWork_v7.0/python/py3/bin/python3.7 /data/wyx_root/tapflow-workbench/tools/cgtw_server_sync.py >> /var/log/shotflow-cgtw-sync.log 2>&1
CGTW 连不上或一条都读不到时不写文件，资产库保留上一份。
"""
import json
import os
import pwd
import sys
import tempfile
from datetime import datetime, timezone

ENV_FILE = '/etc/tli_sc.env'
ROOT = '/data/wyx_root/tapflow-workbench'
DATA_DIR = os.path.join(ROOT, 'server', 'data')
OWNER = 'tapflow'

# 游戏名要和 project-asset-sheet.json 里 sources[].game 一致
TAG_SOURCES = [
    {'game': '火炬', 'db': 'proj_tli_film', 'field': 'm_asset.gamename', 'label': '英雄'},
    {'game': 'RO', 'db': 'proj_ro_film', 'field': 'm_asset.gamename', 'label': '职业'},
]
RO_ROWS = {
    'db': 'proj_ro_film', 'file': 'project-asset-rows-ro.json',
    'asset_root': 'X:\\projects2024\\RO\\Asset', 'label': 'RO2_PV', 'code': 'ro2_pv',
    'atmosphere': 'X:\\projects2024\\RO\\RO2_PV\\00_Production_Guide\\03-影创美术\\气氛图',
}
KIND_ORDER = {'Cha': 0, 'Env': 1, 'Prop': 2}


def load_env():
    with open(ENV_FILE, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def connect():
    sys.path.insert(0, os.environ.get('TLI_SC_CGTW_BASE_PATH', '/opt/CgTeamWork_v7.0/bin/base'))
    from cgtw2 import tw
    t = tw(os.environ['TLI_SC_CGTW_HTTP_IP'], os.environ['TLI_SC_CGTW_ACCOUNT'], os.environ['TLI_SC_CGTW_PASSWORD'])
    if not t.login.is_login():
        raise RuntimeError('CGTW 登录失败')
    return t


def read_assets(t, db, fields):
    ids = t.info.get_id(db, 'm_asset', [], limit='5000')
    return t.info.get(db, 'm_asset', ids, fields) if ids else []


def write_json(name, document):
    """只有内容（除了 updatedAt）变了才写，原子替换，属主改成 tapflow"""
    target = os.path.join(DATA_DIR, name)
    body = {k: v for k, v in document.items() if k != 'updatedAt'}
    try:
        with open(target, encoding='utf-8') as fh:
            old = json.load(fh)
        if {k: v for k, v in old.items() if k != 'updatedAt'} == body:
            return False
    except (OSError, ValueError):
        pass
    os.makedirs(DATA_DIR, exist_ok=True)
    fd, staged = tempfile.mkstemp(dir=DATA_DIR, prefix='.' + name, suffix='.tmp')
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        json.dump(document, fh, ensure_ascii=False, indent=1)
        fh.write('\n')
    user = pwd.getpwnam(OWNER)
    os.chown(staged, user.pw_uid, user.pw_gid)
    os.chmod(staged, 0o644)
    os.replace(staged, target)
    return True


def sync_tags(t, now):
    games = {}
    for source in TAG_SOURCES:
        rows = read_assets(t, source['db'], ['m_asset.entity', source['field']])
        if not rows:
            raise RuntimeError(source['db'] + ' 一个资产都没读到')
        tags = {}
        for row in rows:
            code = str(row.get('m_asset.entity') or '').strip()
            value = str(row.get(source['field']) or '').strip()
            if code and value:
                tags[code] = value
        games[source['game']] = {'db': source['db'], 'field': source['field'], 'label': source['label'], 'tags': tags}
        print('{} {}：{} 个资产有标签'.format(source['game'], source['label'], len(tags)))
    changed = write_json('project-asset-cgtw-tags.json', {'source': 'CGTeamWork m_asset 标签（cgtw_server_sync.py）', 'updatedAt': now, 'games': games})
    print('标签文件', '已更新' if changed else '没有变化')


def sync_ro_rows(t, now):
    keep = []
    for row in read_assets(t, RO_ROWS['db'], ['m_asset.entity', 'm_asset.cn_name', 'm_asset.type']):
        code = str(row.get('m_asset.entity') or '').strip()
        kind = str(row.get('m_asset.type') or '').strip()
        if not code or kind not in KIND_ORDER or 'test' in code.lower():
            continue
        keep.append({'code': code, 'name': str(row.get('m_asset.cn_name') or '').strip() or code, 'kind': kind})
    if not keep:
        raise RuntimeError('RO 资产列表为空')
    keep.sort(key=lambda a: (KIND_ORDER[a['kind']], a['code'].lower()))
    rows = []
    for index, item in enumerate(keep):
        first = index == 0
        rows.append({
            'label': RO_ROWS['label'] if first else '', 'projectCode': RO_ROWS['code'] if first else '',
            'kind': item['kind'], 'name': item['name'], 'code': item['code'], 'gameName': '',
            'assetDir': '{}\\{}\\{}'.format(RO_ROWS['asset_root'], item['kind'], item['code']), 'd2': '', 'd3': '',
            'atmosphere': RO_ROWS['atmosphere'] if first else '',
        })
    changed = write_json(RO_ROWS['file'], {'source': 'CGTeamWork {} m_asset（去掉测试资产）'.format(RO_ROWS['db']), 'updatedAt': now, 'rows': rows})
    print('RO 资产清单 {} 个，{}'.format(len(rows), '已更新' if changed else '没有变化'))


def main():
    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    print('==', now)
    load_env()
    t = connect()
    code = 0
    for step in (sync_tags, sync_ro_rows):
        try:
            step(t, now)
        except Exception as error:  # 一步失败不影响另一步，保留上一份文件
            code = 1
            print('{} 失败：{}'.format(step.__name__, error))
    return code


if __name__ == '__main__':
    sys.exit(main())
