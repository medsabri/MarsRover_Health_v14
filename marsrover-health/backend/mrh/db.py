"""Accès SQLite : connexion, migrations versionnées, utilitaires d'écriture tracée."""
from __future__ import annotations

import datetime as dt
import glob
import json
import os
import sqlite3
import threading

from .config import BASE, DB_PATH

_lock = threading.RLock()  # SQLite : un écrivain à la fois (serveur multi-thread)


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def connect(path: str | None = None) -> sqlite3.Connection:
    con = sqlite3.connect(path or DB_PATH, check_same_thread=False, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    return con


def migrate(con: sqlite3.Connection) -> list[str]:
    """Applique les fichiers migrations/NNN_*.sql non encore appliqués (idempotent, données préservées)."""
    con.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
    done = {r[0] for r in con.execute("SELECT name FROM schema_migrations")}
    applied = []
    for f in sorted(glob.glob(os.path.join(BASE, "migrations", "*.sql"))):
        name = os.path.basename(f)
        if name in done:
            continue
        with open(f, encoding="utf-8") as fh:
            con.executescript(fh.read())
        con.execute("INSERT INTO schema_migrations VALUES (?, ?)", (name, now()))
        applied.append(name)
    con.commit()
    return applied


def j(x) -> str:
    """JSON compact (NaN → null)."""
    def clean(v):
        if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
            return None
        if isinstance(v, dict):
            return {k: clean(w) for k, w in v.items()}
        if isinstance(v, (list, tuple)):
            return [clean(w) for w in v]
        if hasattr(v, "item"):
            return clean(v.item())
        return v
    return json.dumps(clean(x), ensure_ascii=False, separators=(",", ":"))


def insert_many(con, table: str, rows: list[dict]) -> int:
    if not rows:
        return 0
    cols = list(rows[0].keys())
    sql = f"INSERT INTO {table} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})"
    with _lock:
        con.executemany(sql, [tuple(r[c] for c in cols) for r in rows])
    return len(rows)


def log(con, action: str, detail=None, actor: str = "system"):
    with _lock:
        con.execute("INSERT INTO audit_log (at, actor, action, detail) VALUES (?,?,?,?)", (now(), actor, action, j(detail) if detail is not None else None))
        con.commit()


def rows(con, sql: str, params=()) -> list[dict]:
    return [dict(r) for r in con.execute(sql, params)]
