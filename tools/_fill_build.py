import re, subprocess
from pathlib import Path
local = Path(r'C:/Users/wuyixiang/Documents/TapLeBron')
remote_root = '/data/wyx_root/tapflow-workbench'
host = 'xindong-server'
def ssh(cmd, timeout=180):
    return subprocess.run(['ssh','-o','BatchMode=yes',host,cmd], capture_output=True, text=True, timeout=timeout, encoding='utf-8', errors='replace')
for attempt in range(30):
    result = ssh('cd ' + remote_root + ' && npm run build')
    text = (result.stdout or '') + '\n' + (result.stderr or '')
    if result.returncode == 0:
        print('BUILD_OK')
        print(text[-400:])
        break
    rel = None
    m = re.search(r'Could not load (/data/wyx_root/tapflow-workbench/\S+)', text)
    if m:
        rel = m.group(1)[len(remote_root)+1:]
    else:
        m2 = re.search(r'Could not resolve "([^"]+)" from "([^"]+)"', text)
        if m2:
            rel = str((Path(m2.group(2)).parent / m2.group(1)).as_posix())
    print('FAIL', attempt, rel)
    if not rel:
        print(text[-1200:])
        break
    uniq = []
    for ext in ['', '.ts', '.tsx', '.js', '.mjs', '.css']:
        candidate = local / (rel + ext)
        if candidate.is_file() and candidate not in uniq:
            uniq.append(candidate)
        name = Path(rel).name + ext
        for hit in local.joinpath('src').rglob(name):
            if hit.is_file() and hit not in uniq:
                uniq.append(hit)
    if not uniq:
        print('NO_LOCAL')
        print(text[-800:])
        break
    src_file = uniq[0]
    dest = remote_root + '/' + str(src_file.relative_to(local)).replace('\\','/')
    print('COPY', src_file.name, dest)
    parent = dest.rsplit('/',1)[0]
    ssh('mkdir -p ' + parent)
    cp = subprocess.run(['scp','-o','BatchMode=yes',str(src_file), host+':'+dest], capture_output=True, text=True)
    print('scp', cp.returncode)
    ssh('chown tapflow:tapflow ' + dest)
else:
    print('TOO_MANY')