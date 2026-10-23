"""Async data access over Turso/libSQL.

`libsql_experimental` is a synchronous client, so all calls run in a worker
thread via asyncio.to_thread. A small connection pool with per-connection
locks keeps concurrent requests safe; transactions hold their connection
for the whole transaction, giving real BEGIN/COMMIT/ROLLBACK semantics.

Every query in this codebase MUST be parameterized (? placeholders) — no
string interpolation of user data, ever (spec §9).
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any

import libsql_experimental as libsql

from app.core.config import settings
from app.core.errors import ConflictError
from app.core.security import utc_now_iso

logger = logging.getLogger(__name__)

POOL_SIZE = 5


class PooledConnection:
    def __init__(self) -> None:
        self.conn = libsql.connect(
            settings.turso_database_url,
            auth_token=settings.turso_auth_token,
        )
        self.lock = asyncio.Lock()

    def _fresh_connection(self) -> None:
        """Replace the underlying libsql connection (used on stale streams)."""
        try:
            self.conn.close()
        except Exception:  # pragma: no cover - close is best-effort
            pass
        self.conn = libsql.connect(
            settings.turso_database_url,
            auth_token=settings.turso_auth_token,
        )

    @staticmethod
    def _is_stale_stream(exc: Exception) -> bool:
        """Turso expires long-idle Hrana streams; detect and reconnect."""
        text = str(exc)
        return "stream not found" in text or "session not found" in text

    def _exec(self, sql: str, params: tuple) -> tuple[list[str], list[tuple]]:
        try:
            cur = self.conn.execute(sql, params)
        except (ValueError, Exception) as exc:
            if not self._is_stale_stream(exc):
                raise
            # Turso reaped the idle stream — reconnect once and retry.
            logger.info("stale Turso stream detected; reconnecting pooled connection")
            self._fresh_connection()
            cur = self.conn.execute(sql, params)
        cols = [d[0] for d in cur.description] if cur.description else []
        rows = cur.fetchall() if cur.description else []
        return cols, [tuple(r) for r in (rows or [])]

    def _commit(self) -> None:
        try:
            self.conn.commit()
        except (ValueError, Exception) as exc:
            if not self._is_stale_stream(exc):
                raise
            logger.info("stale Turso stream on commit; connection will be recycled")
            self._fresh_connection()

    async def execute(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        async with self.lock:
            cols, rows = await asyncio.to_thread(self._exec, sql, params)
            return [dict(zip(cols, row, strict=False)) for row in rows]

    async def execute_one(self, sql: str, params: tuple = ()) -> dict[str, Any] | None:
        rows = await self.execute(sql, params)
        return rows[0] if rows else None

    async def execute_write(self, sql: str, params: tuple = ()) -> None:
        async with self.lock:
            await asyncio.to_thread(self._exec, sql, params)
            await asyncio.to_thread(self._commit)


class Database:
    def __init__(self) -> None:
        self._pool: list[PooledConnection] = []
        self._pool_lock = asyncio.Lock()

    async def _acquire(self) -> PooledConnection:
        async with self._pool_lock:
            if len(self._pool) < POOL_SIZE:
                conn = PooledConnection()
                self._pool.append(conn)
                return conn
        # Round-robin over existing pool: pick the lock with fewest waiters.
        return min(self._pool, key=lambda c: c.lock.locked())

    async def execute(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        conn = await self._acquire()
        return await conn.execute(sql, params)

    async def one(self, sql: str, params: tuple = ()) -> dict[str, Any] | None:
        conn = await self._acquire()
        return await conn.execute_one(sql, params)

    async def write(self, sql: str, params: tuple = ()) -> None:
        conn = await self._acquire()
        await conn.execute_write(sql, params)

    @asynccontextmanager
    async def transaction(self):
        """Async context manager providing a dedicated connection.

        Usage:
            async with db.transaction() as tx:
                await tx.execute("INSERT ...", (...))
                await tx.one("SELECT ...", (...))
            # commits on success, rolls back on exception

        Note: the yielded transaction view bypasses the per-connection lock
        because the transaction context already owns it (asyncio.Lock is not
        reentrant — re-acquiring it inside the transaction would deadlock).
        """
        async with self._pool_lock:
            conn = self._pool.pop(0) if self._pool else PooledConnection()
        tx = _TransactionView(conn)
        try:
            async with conn.lock:
                await asyncio.to_thread(conn.conn.execute, "BEGIN IMMEDIATE", ())
                try:
                    yield tx
                    await asyncio.to_thread(conn.conn.commit)
                except BaseException:
                    try:
                        await asyncio.to_thread(conn.conn.rollback)
                    except Exception:
                        logger.warning("rollback failed after transaction error (connection discarded)")
                        raise
                    raise
        finally:
            async with self._pool_lock:
                self._pool.append(conn)


db = Database()


class _TransactionView:
    """Lock-free statement executor used inside db.transaction().

    The owning transaction context already holds the connection lock, so this
    view dispatches statements directly to the underlying connection.
    """

    def __init__(self, conn: PooledConnection) -> None:
        self._conn = conn

    async def execute(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        cols, rows = await asyncio.to_thread(self._conn._exec, sql, params)
        return [dict(zip(cols, row, strict=False)) for row in rows]

    async def one(self, sql: str, params: tuple = ()) -> dict[str, Any] | None:
        rows = await self.execute(sql, params)
        return rows[0] if rows else None


class UniqueViolation(ConflictError):
    def __init__(self, message: str = "The resource already exists.", details: dict | None = None) -> None:
        super().__init__(message, details=details)


async def check_unique_violation(coro, message: str):  # helper for agents
    """Run a write and translate IntegrityError into a 409 ConflictError."""
    try:
        await coro
    except ConflictError:
        raise
    except Exception as exc:
        if "UNIQUE constraint failed" in str(exc):
            raise UniqueViolation(message) from exc
        raise


def now_iso() -> str:
    return utc_now_iso()
