"""变异验证：复制画布要把跨画布资产拉进副本（2026-08-26 线上问题）。

每一条都对应「副本继续缺图」或「比原来更糟」的一种走法。
最要紧的是 C：复制失败还照样改写地址，会把「一部分人 404」变成「所有人 404」。

用法：python tools/_mutate_duplicate_foreign_assets.py
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Union

ROOT = Path(__file__).resolve().parent.parent
ROUTES = ROOT / 'server' / 'canvasRoutes.js'
SUITE = ['tests/duplicate-foreign-assets.test.ts']

Anchor = Union[str, tuple]

MUTATIONS: list[tuple[str, Anchor, Anchor]] = [
    ('A. 只认对象层、不认 node.data 那层 JSON 字符串（线上数据正是那种形状）',
     'serialized = typeof value === \'string\' ? value : JSON.stringify(value)',
     "serialized = typeof value === 'string' ? value : ''"),
    ('B. 把指向自己的也算成跨画布（会把自己的资产又复制一遍）',
     '    if (canvasId === target) continue;',
     '    if (false) continue;'),
    ('C. 复制失败也照样改写地址（把「部分人 404」变成「所有人 404」，比原来更糟）',
     'localized.has(`${canvasId}/${storedName}`) ? `/assets/${target}/${storedName}` : whole',
     '`/assets/${target}/${storedName}`'),
    # 「改写时不动指向自己的地址」没有单独的判断 —— 它由「collect 跳过自己」保证
    # （rewrite 只动 localized 里的，而 localized 永远不含目标画布自己）。
    # 所以那条不需要独立变异，B 已经覆盖。
    ('D. 地址正则认不出带连字符 / 下划线的文件名（cgt-2026… 这种全会漏）',
     'const PROJECT_ASSET_URL_RE = /\\/assets\\/(\\d+)\\/([A-Za-z0-9._-]+)/g;',
     'const PROJECT_ASSET_URL_RE = /\\/assets\\/(\\d+)\\/([A-Za-z0-9.]+)/g;'),
    ('E. 去重失效（同一个文件复制多次）',
     ('    if (seen.has(key)) continue;', '    seen.add(key);', '    refs.push({ canvasId, storedName });'),
     ('    if (false) continue;', '    seen.add(key);', '    refs.push({ canvasId, storedName });')),
    ('F. 缩略图被当成独立一条',
     "    if (storedName.endsWith('_thumb.webp')) continue;",
     '    if (false) continue;'),
    ('G. 改写函数改动输入对象（调用方还拿着原始数据）',
     ('  const walk = (node) => {', '    if (typeof node === \'string\') return rewriteString(node);'),
     ('  const walk = (node) => {', '    if (typeof node === \'string\') return node;')),
    ('H. localized 为空时也走一遍深拷贝（白耗，且掩盖了「什么都没搬」）',
     '  if (!localized || localized.size === 0) return value;',
     '  if (false) return value;'),
    ('I. 源文件不存在时不 continue，继续往下把它算成成功',
     ('        if (!fs.existsSync(srcPath)) {', '          skipped++;', '          continue;', '        }'),
     ('        if (!fs.existsSync(srcPath)) {', '          skipped++;', '        }')),
    ('J. 复制路径保存的是没改写的数据（等于白干）',
     ('    await saveCanvasData(result.insertId, localizeResult.data, {', "      reason: 'duplicate',"),
     ('    await saveCanvasData(result.insertId, duplicatedData, {', "      reason: 'duplicate',")),
    ('K. 建模板路径保存的是没改写的数据',
     ('    await saveCanvasData(result.insertId, localizeResult.data, {', "      reason: 'template_create',"),
     ('    await saveCanvasData(result.insertId, duplicatedData, {', "      reason: 'template_create',")),
    ('L. 复制路径根本不调 localizeForeignAssets',
     ('    const localizeResult = await localizeForeignAssets(duplicatedData, {',
      '      id: result.insertId,',
      '      owner_id: req.user.id,',
      '    });',
      '',
      '    await saveCanvasData(result.insertId, localizeResult.data, {',
      "      reason: 'duplicate',"),
     ('    const localizeResult = { data: duplicatedData };',
      '',
      '    await saveCanvasData(result.insertId, localizeResult.data, {',
      "      reason: 'duplicate',")),
    ('M. 对象存储镜像失败会让整次复制抛出（图明明已经在本地了）',
     'await mirrorStoredAsset(targetCanvasRow.id, storedName, destPath, mimeType).catch(() => {});',
     'await mirrorStoredAsset(targetCanvasRow.id, storedName, destPath, mimeType);'),
]


def read_raw(path: Path) -> str:
    with path.open('r', encoding='utf-8', newline='') as handle:
        return handle.read()


def write_raw(path: Path, text: str) -> None:
    with path.open('w', encoding='utf-8', newline='') as handle:
        handle.write(text)


def render(anchor: Anchor, newline: str) -> str:
    return newline.join(anchor) if isinstance(anchor, tuple) else anchor


def run_suite() -> bool:
    proc = subprocess.run(['npx', 'vitest', 'run', *SUITE], cwd=ROOT, capture_output=True, text=True, shell=True)
    return proc.returncode == 0


def main() -> int:
    original = read_raw(ROUTES)
    newline = '\r\n' if '\r\n' in original else '\n'

    print('baseline ...', end=' ', flush=True)
    if not run_suite():
        print('RED — 基线就不绿，先修基线')
        return 1
    print('green')

    missed: list[str] = []
    skipped: list[str] = []
    try:
        for label, raw_old, raw_new in MUTATIONS:
            old = render(raw_old, newline)
            new = render(raw_new, newline)
            count = original.count(old)
            if count != 1:
                print(f'SKIP    {label}  (锚点命中 {count} 次，改脚本)')
                skipped.append(label)
                continue
            write_raw(ROUTES, original.replace(old, new))
            green = run_suite()
            write_raw(ROUTES, original)
            print(f'{"MISS" if green else "caught"}  {label}')
            if green:
                missed.append(label)
    finally:
        write_raw(ROUTES, original)

    print('\nrestored; verifying ...', end=' ', flush=True)
    print('green' if run_suite() else 'RED (!!)')

    if missed or skipped:
        if missed:
            print(f'\n{len(missed)} 条没被测出来：')
            for label in missed:
                print('  -', label)
        if skipped:
            print(f'\n{len(skipped)} 条锚点失效：')
            for label in skipped:
                print('  -', label)
        return 1
    print(f'\n全部 {len(MUTATIONS)} 条都被测出来了')
    return 0


if __name__ == '__main__':
    sys.exit(main())
