#!/usr/bin/env python3
"""Read cached tracker data without executing the configured add-on or importing logs."""
import argparse, datetime as dt, json, sqlite3
from pathlib import Path

def main():
    p=argparse.ArgumentParser(); p.add_argument('--read-only',action='store_true',required=True)
    p.add_argument('--database',required=True); p.add_argument('--project',required=True); p.add_argument('--milestone',required=True)
    a=p.parse_args(); file=Path(a.database).expanduser().resolve()
    if not file.is_file(): return dict(available=False,reason='No cached usage database.',read_only=True)
    db=sqlite3.connect(file.as_uri()+'?mode=ro',uri=True,timeout=2); db.row_factory=sqlite3.Row
    try:
        db.execute('PRAGMA query_only=ON')
        balances=[]; current=dt.datetime.now(dt.timezone.utc)
        for row in db.execute('SELECT a.* FROM allowances a JOIN (SELECT provider,bucket,max(observed) t FROM allowances GROUP BY provider,bucket) b ON a.provider=b.provider AND a.bucket=b.bucket AND a.observed=b.t LIMIT 64'):
            item=dict(row); age=max(0,(current-dt.datetime.fromisoformat(row['observed'])).total_seconds())
            expired=bool(row['resets'] and dt.datetime.fromisoformat(row['resets'])<=current)
            item.update(remaining_percent=max(0,100-row['used']),age_seconds=round(age),freshness='expired-window' if expired else 'stale' if age>900 else 'recent')
            balances.append(item)
        rows=db.execute('SELECT event,checkpoint,captured FROM snapshots WHERE project=? AND milestone=? ORDER BY id DESC LIMIT 32',(str(Path(a.project).resolve()),a.milestone)).fetchall()
        return dict(read_only=True,allowances=balances,snapshots=[dict(r) for r in rows],scope='Account-wide allowance; cached milestone markers, not exclusive session tokens.',source='Read-only SQLite; no add-on execution or log import.')
    finally: db.close()

if __name__=='__main__':
    try: print(json.dumps(main()))
    except (OSError,ValueError,sqlite3.Error) as e: print(json.dumps(dict(available=False,read_only=True,reason=str(e))))
