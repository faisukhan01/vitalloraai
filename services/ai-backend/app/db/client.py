"""Async data access over Turso's HTTP API (v2/pipeline).

The previous client used `libsql_experimental` (Hrana over HTTP/2 from a
worker thread). That client has no internal request timeout: when Turso reaps
an idle Hrana stream the next call HANGS for tens of seconds while holding
the worker GIL — freezing the whole event loop (WebSocket pings die, provider
calls stall, users wait). It also queued bursts of cold session setups
server-side for 6-12s.

This client speaks Turso's HTTP JSON API directly with httpx:
- every call is an independent HTTPS request with hard connect/read timeouts —
  a dead connection surfaces as a clean error in <5s, never a hang,
- no GIL exposure: pure asyncio end to end,
- no persistent streams to go stale, no warm-up/recycling machinery,
- multi-statement batches and baton-based transactions are supported.

Every query in this codebase MUST be parameterized (? placeholders) — no
string interpolation of user data, ever (spec §9).
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time as _time
from contextlib import asynccontextmanager, suppress
from typing import Any

import httpx

from app.core.config import settings
from app.core.errors import ConflictError
from app.core.security import utc_now_iso

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT_S = 5.0
READ_TIMEOUT_S = 20.0
POOL_TIMEOUT_S = 5.0

# Read calls are safe to retry once (idempotent); writes are NOT retried
# automatically because a timed-out write may have committed server-side.
_RETRYABLE_CONNECT_ERRORS = (httpx.ConnectError, httpx.ConnectTimeout)


def _https_url(libsql_url: str) -> str:
    if libsql_url.startswith("libsql://"):
        return "https://" + libsql_url[len("libsql://"):]
    return libsql_url


def _encode_arg(value: Any) -> dict[str, Any]:
    # Turso HTTP API carries every non-null value as a JSON string.
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "integer", "value": "1" if value else "0"}
    if isinstance(value, (int, float)):
        return {"type": "integer" if isinstance(value, int) else "float", "value": str(value)}
    if isinstance(value, bytes):
        return {"type": "blob", "base64": base64.b64encode(value).decode("ascii")}
    return {"type": "text", "value": str(value)}


def _decode_value(wire: Any) -> Any:
    if wire is None:
        return None
    if isinstance(wire, (str, int, float, bool)):
        return wire
    vtype = wire.get("type")
    value = wire.get("value")
    if vtype == "null":
        return None
    if vtype == "integer":
        return int(value)
    if vtype == "float":
        return float(value)
    if vtype == "blob" or vtype == "blob_base64":
        raw = wire.get("base64", value or "")
        return base64.b64decode(raw) if raw else b""
    return value


class _PipelineError(RuntimeError):
    pass


class Database:
    """Turso HTTP API client with the same surface as the old libsql pool."""

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(
            base_url=_https_url(settings.turso_database_url),
            headers={"Authorization": f"Bearer {settings.turso_auth_token}"},
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10, keepalive_expiry=10.0),
        )
        self._txn_seq = 0

    # ── low-level pipeline ────────────────────────────────────────────────
    async def _pipeline(
        self,
        stmts: list[tuple[str, tuple]],
        baton: str | None = None,
        *,
        retry: bool = True,
    ) -> tuple[list[list[dict[str, Any]]], str | None]:
        """Run statements (optionally inside a baton context); return row sets."""
        requests: list[dict[str, Any]] = []
        for sql, params in stmts:
            requests.append({
                "type": "execute",
                "stmt": {"sql": sql, "args": [_encode_arg(p) for p in params]},
            })
        body: dict[str, Any] = {"requests": requests}
        if baton:
            body["baton"] = baton
        timeout = httpx.Timeout(READ_TIMEOUT_S, connect=CONNECT_TIMEOUT_S, pool=POOL_TIMEOUT_S)
        t0 = _time.perf_counter()
        retried_after_timeout = False
        try:
            resp = await self._client.post("/v2/pipeline", json=body, timeout=timeout)
        except _RETRYABLE_CONNECT_ERRORS:
            if not retry:
                raise
            # Connection never established — nothing was executed, safe to retry.
            resp = await self._client.post("/v2/pipeline", json=body, timeout=timeout)
        except httpx.TimeoutException:
            if not retry or baton:
                raise
            # Timed out mid-flight. Reads are idempotent; writes use uuid PKs, so
            # a retry that hits a UNIQUE constraint means the first try landed.
            retried_after_timeout = True
            try:
                resp = await self._client.post("/v2/pipeline", json=body, timeout=timeout)
            except Exception as retry_exc:
                raise _PipelineError(f"Turso retry failed: {retry_exc}") from retry_exc
        ms = int((_time.perf_counter() - t0) * 1000)
        if resp.status_code != 200:
            raise _PipelineError(f"Turso HTTP {resp.status_code}: {resp.text[:200]}")
        data = resp.json()
        results = data.get("results") or []
        rows_out: list[list[dict[str, Any]]] = []
        for res in results:
            if res.get("type") == "error":
                msg = str(res.get("error", {}).get("message", "Turso pipeline error"))
                if "UNIQUE constraint" in msg and retried_after_timeout:
                    # The timed-out first attempt had actually committed.
                    logger.info("pipeline retry hit UNIQUE constraint; first attempt had landed")
                    rows_out.append([])
                    continue
                raise _PipelineError(msg)
            result = res.get("response", {}).get("result")
            if result is None:
                rows_out.append([])
                continue
            cols = [c.get("name", f"col{i}") for i, c in enumerate(result.get("cols") or [])]
            rows = [
                {name: _decode_value(cell) for name, cell in zip(cols, row, strict=False)}
                for row in (result.get("rows") or [])
            ]
            rows_out.append(rows)
        logger.debug("pipeline ok: %d stmts %dms", len(stmts), ms)
        return rows_out, data.get("baton")

    # ── public surface (same as the old pool client) ─────────────────────
    async def execute(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        rows, _ = await self._pipeline([(sql, params)])
        return rows[0] if rows else []

    async def one(self, sql: str, params: tuple = ()) -> dict[str, Any] | None:
        rows = await self.execute(sql, params)
        return rows[0] if rows else None

    async def write(self, sql: str, params: tuple = ()) -> None:
        # retry=True is safe here: every write uses a uuid PK, so a timed-out
        # attempt that actually committed surfaces as UNIQUE on the retry and
        # is treated as success by _pipeline.
        await self._pipeline([(sql, params)])

    @asynccontextmanager
    async def transaction(self):
        """Async context manager: baton-based interactive transaction.

        Usage:
            async with db.transaction() as tx:
                await tx.execute("INSERT ...", (...))
                await tx.one("SELECT ...", (...))

        Statements interleave over one server-side transaction via the baton;
        COMMIT/ROLLBACK and the baton close are handled here.
        """
        self._txn_seq += 1
        tx = _TransactionView(self)
        try:
            await tx._begin()
            yield tx
            await tx._commit()
        except BaseException:
            with suppress(Exception):
                await tx._rollback()
            raise
        finally:
            with suppress(Exception):
                await tx._close()

    # Warm-up helpers kept for API compatibility (no persistent pool anymore).
    async def prewarm_pool(self) -> None:
        with suppress(Exception):
            await self.one("SELECT 1")

    async def prewarm_idle(self) -> None:
        return None


db = Database()


class _TransactionView:
    """Lock-free baton-bound statement executor used inside db.transaction()."""

    def __init__(self, database: Database) -> None:
        self._db = database
        self._baton: str | None = None

    async def _run(self, stmts: list[tuple[str, tuple]]) -> list[list[dict[str, Any]]]:
        rows, baton = await self._db._pipeline(stmts, baton=self._baton, retry=False)
        self._baton = baton
        return rows

    async def _begin(self) -> None:
        await self._run([("BEGIN IMMEDIATE", ())])

    async def _commit(self) -> None:
        await self._run([("COMMIT", ())])

    async def _rollback(self) -> None:
        await self._run([("ROLLBACK", ())])

    async def _close(self) -> None:
        if self._baton:
            await self._db._client.post(
                "/v2/pipeline",
                json={"requests": [{"type": "close", "baton": self._baton}]},
                timeout=httpx.Timeout(READ_TIMEOUT_S, connect=CONNECT_TIMEOUT_S, pool=POOL_TIMEOUT_S),
            )
            self._baton = None

    async def execute(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        rows = await self._run([(sql, params)])
        return rows[0] if rows else []

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
