import sqlite3
from pathlib import Path
root = Path(r'C:/Users/wuyixiang/cgteamwork/db')
for db in sorted(root.glob('*.db')):
    if db.name.endswith('_queue.db'):
        continue
    con = sqlite3.connect(f'file:{db.as_posix()}?mode=ro', uri=True)
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    print(db.name, 'tables', len(tables))
    for t in tables[:30]:
        print(' ', t)
    con.close()
