"""Self-healing supervisor for the LOCAL development database server.

In this sandbox the database is a local Turso-protocol SQL server
(services/ai-backend/dbserver/local_sqld.py) on 127.0.0.1:8288 backed by
database/turso-local.db. Sandbox process reapers periodically kill it, which
took the whole platform down (every endpoint 500s) until it was noticed.
Following the ai-bridge supervisor pattern, the backend now OWNS that
lifecycle too:

- On startup: probe GET /health, spawn the server if it is down.
- Watchdog: re-probe every DB_WATCHDOG_SECS and respawn if it disappeared.

Against the real Turso cloud (https://) this supervisor is a no-op: the probe
still works (cheap), but spawning is skipped because there is nothing local
to own.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
from pathlib import Path

import httpx

from app.core.config import settings
from app.core.logging import log_extra

logger = logging.getLogger("vitalora.dbserver")

_REPO_ROOT = Path(__file__).resolve().parents[4]
_SERVER_SCRIPT = _REPO_ROOT / "services" / "ai-backend" / "dbserver" / "local_sqld.py"
_SERVER_LOG = _REPO_ROOT / "dbserver.log"

_HEALTH_TIMEOUT = 1.5
_BOOT_TIMEOUT_S = 8.0
_WATCHDOG_INTERVAL_S = 15.0

_process: subprocess.Popen[bytes] | None = None
_watchdog_task: asyncio.Task[None] | None = None


def _is_local() -> bool:
    return str(settings.turso_database_url).startswith("http://127.0.0.1") or \
        str(settings.turso_database_url).startswith("http://localhost")


async def db_server_healthy() -> bool:
    try:
        async with httpx.AsyncClient(timeout=_HEALTH_TIMEOUT) as client:
            resp = await client.get(f"{settings.turso_database_url}/health")
            return resp.status_code == 200
    except httpx.HTTPError:
        return False


def _spawn_server() -> bool:
    """Start the local SQL server fully detached; returns False when absent."""
    global _process
    python = shutil.which("python3") or "/usr/bin/python3"
    venv_python = "/home/z/.venv/bin/python"
    import os

    if os.path.exists(venv_python):
        python = venv_python
    if not _SERVER_SCRIPT.is_file():
        log_extra(logger, logging.ERROR, "db server spawn failed: script missing", path=str(_SERVER_SCRIPT))
        return False
    log_file = open(_SERVER_LOG, "ab")  # noqa: SIM115 — lives for the subprocess lifetime
    _process = subprocess.Popen(  # noqa: S603 — fixed argv, no user input
        [python, str(_SERVER_SCRIPT)],
        cwd=str(_REPO_ROOT),
        stdout=log_file,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,  # fully detached: survives backend reloads
    )
    log_extra(logger, logging.INFO, "db server spawned", pid=_process.pid, port=str(settings.turso_database_url))
    return True


async def ensure_db_server() -> bool:
    """Idempotent: make sure the local DB server is reachable, spawn if not."""
    global _process
    if not _is_local():
        return True  # cloud database — nothing local to own
    if await db_server_healthy():
        return True
    if not _spawn_server():
        return False
    deadline = asyncio.get_running_loop().time() + _BOOT_TIMEOUT_S
    while asyncio.get_running_loop().time() < deadline:
        if await db_server_healthy():
            return True
        await asyncio.sleep(0.3)
    log_extra(logger, logging.ERROR, "db server did not become healthy after spawn")
    return False


async def _watchdog_loop() -> None:
    while True:
        try:
            await asyncio.sleep(_WATCHDOG_INTERVAL_S)
            if _process is not None and _process.poll() is not None:
                log_extra(logger, logging.WARNING, "db server process exited", code=_process.returncode)
                globals()["_process"] = None
            if not await db_server_healthy():
                log_extra(logger, logging.WARNING, "db server down — respawning")
                await ensure_db_server()
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001 — the watchdog must never kill the app
            logger.exception("db server watchdog iteration failed")


def start_watchdog() -> None:
    global _watchdog_task
    if _watchdog_task is None or _watchdog_task.done():
        _watchdog_task = asyncio.ensure_future(_watchdog_loop())
        log_extra(logger, logging.INFO, "db server watchdog started", interval_s=_WATCHDOG_INTERVAL_S)
