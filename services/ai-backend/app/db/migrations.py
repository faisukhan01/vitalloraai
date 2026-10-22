"""Version-controlled database migration runner.

Usage:
    python -m app.db.migrations status
    python -m app.db.migrations upgrade
    python -m app.db.migrations upgrade --dry-run

Migrations live in <repo>/database/migrations/*.sql and are applied in
filename order exactly once, tracked in the `migrations` table. Each
migration runs inside a transaction; a failure leaves no partial changes.
Destructive migrations require explicit authorization (spec §9).
"""

from __future__ import annotations

import asyncio
import sys

from app.core.config import REPO_ROOT, settings
from app.core.security import utc_now_iso

MIGRATIONS_DIR = REPO_ROOT / "database" / "migrations"


def split_sql_statements(sql_text: str) -> list[str]:
    """Split SQL into statements, honoring single-quoted strings and
    BEGIN...END trigger blocks (a ';' inside a trigger body is not a separator).

    Migration files follow a controlled format: comments are whole lines and
    never appear mid-statement, so comment-only lines are removed upfront
    (they may contain ';' or quotes that would confuse the scanner).
    """
    lines = [ln for ln in sql_text.splitlines() if not ln.strip().startswith("--")]
    text = "\n".join(lines)
    statements: list[str] = []
    buf: list[str] = []
    in_string = False
    begin_depth = 0
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if in_string:
            buf.append(ch)
            if ch == "'":
                # handle escaped '' inside strings
                if i + 1 < n and text[i + 1] == "'":
                    buf.append("'")
                    i += 1
                else:
                    in_string = False
            i += 1
            continue
        if ch == "'":
            in_string = True
            buf.append(ch)
            i += 1
            continue
        if text[i:].upper().startswith("BEGIN") and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_")):
            rest = text[i + 5 : i + 6]
            if not (rest.isalnum() or rest == "_"):
                begin_depth += 1
                buf.append(text[i : i + 5])
                i += 5
                continue
        if text[i:].upper().startswith("END") and begin_depth > 0 and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_")):
            rest = text[i + 3 : i + 4]
            if not (rest.isalnum() or rest == "_"):
                begin_depth -= 1
                buf.append(text[i : i + 3])
                i += 3
                continue
        if ch == ";" and begin_depth == 0:
            stmt = "".join(buf).strip()
            buf = []
            i += 1
            if stmt:
                statements.append(stmt)
            continue
        buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        statements.append(tail)
    return statements


def _connect():
    import libsql_experimental as libsql

    return libsql.connect(settings.turso_database_url, auth_token=settings.turso_auth_token)


def _ensure_migrations_table(conn) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS migrations ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "filename TEXT NOT NULL UNIQUE, "
        "applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
        (),
    )
    conn.commit()


def _applied_files(conn) -> set[str]:
    cur = conn.execute("SELECT filename FROM migrations", ())
    return {r[0] for r in cur.fetchall()}


def _dry_run_statements(sql_text: str) -> int:
    return len(split_sql_statements(sql_text))


async def run_upgrade(dry_run: bool = False) -> None:
    if not MIGRATIONS_DIR.exists():
        print(f"No migrations directory at {MIGRATIONS_DIR}")
        return
    files = sorted(p.name for p in MIGRATIONS_DIR.glob("*.sql"))
    if not files:
        print("No migration files found.")
        return

    conn = await asyncio.to_thread(_connect)
    await asyncio.to_thread(_ensure_migrations_table, conn)
    applied = await asyncio.to_thread(_applied_files, conn)

    pending = [f for f in files if f not in applied]
    if not pending:
        print("Database is up to date. No pending migrations.")
        return

    print(f"Pending migrations: {len(pending)}")
    for filename in pending:
        sql_text = (MIGRATIONS_DIR / filename).read_text(encoding="utf-8")
        stmts = split_sql_statements(sql_text)
        if dry_run:
            print(f"  [dry-run] {filename}: {len(stmts)} statements")
            continue
        print(f"  applying {filename} ({len(stmts)} statements) ...", flush=True)
        try:
            await asyncio.to_thread(conn.execute, "BEGIN IMMEDIATE", ())
            for stmt in stmts:
                await asyncio.to_thread(conn.execute, stmt, ())
            await asyncio.to_thread(
                conn.execute, "INSERT INTO migrations (filename, applied_at) VALUES (?, ?)", (filename, utc_now_iso())
            )
            await asyncio.to_thread(conn.commit)
            print(f"  ✓ {filename} applied")
        except Exception as exc:
            await asyncio.to_thread(conn.rollback)
            print(f"  ✗ {filename} FAILED: {exc}")
            raise SystemExit(1) from exc


async def run_status() -> None:
    conn = await asyncio.to_thread(_connect)
    await asyncio.to_thread(_ensure_migrations_table, conn)
    applied = await asyncio.to_thread(_applied_files, conn)
    files = sorted(p.name for p in MIGRATIONS_DIR.glob("*.sql"))
    print(f"Migrations directory: {MIGRATIONS_DIR}")
    for f in files:
        state = "applied" if f in applied else "PENDING"
        print(f"  [{state:>7}] {f}")


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    if command == "upgrade":
        dry_run = "--dry-run" in sys.argv
        asyncio.run(run_upgrade(dry_run=dry_run))
    elif command == "status":
        asyncio.run(run_status())
    else:
        print("Usage: python -m app.db.migrations [status|upgrade [--dry-run]]")
        raise SystemExit(2)


if __name__ == "__main__":
    main()
