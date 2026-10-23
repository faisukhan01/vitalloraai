"""Self-healing supervisor for the ai-bridge sidecar.

The AI bridge (services/ai-bridge, Bun + z-ai-web-dev-sdk on :8100) is the
sole path to the speech and language providers. If it dies, the receptionist
cannot hear (STT), think (LLM) or speak (TTS) — the call is dead. Sandbox
process reapers and idle kills make that a real, recurring failure mode, so
the backend now OWNS the sidecar lifecycle:

- On startup: probe /health, spawn the bridge if it is down, wait for health.
- While running: a lightweight watchdog re-probes every BRIDGE_WATCHDOG_SECS
  and respawns it if it ever disappears (crash, OOM, external kill).
- On shutdown: the bridge is deliberately left running (it is fully detached,
  start_new_session) so an in-flight caller is never dropped; the next boot
  adopts the healthy instance instead of spawning a duplicate.
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

logger = logging.getLogger("vitalora.bridge")

# Repo root is 4 parents up from this file (app/core/bridge_supervisor.py),
# same depth as app/core/config.py.
_REPO_ROOT = Path(__file__).resolve().parents[4]
_BRIDGE_DIR = _REPO_ROOT / "services" / "ai-bridge"
_BRIDGE_LOG = _REPO_ROOT / "bridge.log"

_HEALTH_TIMEOUT = 1.5
_BOOT_TIMEOUT_S = 10.0
_WATCHDOG_INTERVAL_S = 20.0

_process: subprocess.Popen[bytes] | None = None
_adopted = False  # a bridge we did not spawn is healthy — watch but never duplicate
_watchdog_task: asyncio.Task[None] | None = None


async def bridge_healthy() -> bool:
    try:
        async with httpx.AsyncClient(timeout=_HEALTH_TIMEOUT) as client:
            resp = await client.get(f"{settings.ai_bridge_url}/health")
            return resp.status_code == 200
    except httpx.HTTPError:
        return False


def _spawn_bridge() -> bool:
    """Start `bun index.ts` fully detached; returns False when bun is absent."""
    global _process, _adopted
    bun = shutil.which("bun")
    if bun is None:
        log_extra(logger, logging.ERROR, "bridge spawn failed: bun not on PATH")
        return False
    if not _BRIDGE_DIR.is_dir():
        log_extra(logger, logging.ERROR, "bridge spawn failed: directory missing", path=str(_BRIDGE_DIR))
        return False
    log_file = open(_BRIDGE_LOG, "ab")  # noqa: SIM115 — lives for the subprocess lifetime
    _process = subprocess.Popen(  # noqa: S603 — fixed argv, no user input
        [bun, "index.ts"],
        cwd=str(_BRIDGE_DIR),
        stdout=log_file,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,  # fully detached: survives backend reloads
    )
    _adopted = False
    log_extra(logger, logging.INFO, "bridge spawned", pid=_process.pid, port=settings.ai_bridge_url)
    return True


async def _wait_until_healthy(timeout_s: float) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout_s
    while asyncio.get_running_loop().time() < deadline:
        if await bridge_healthy():
            return True
        await asyncio.sleep(0.4)
    return False


async def ensure_bridge() -> bool:
    """Idempotent: bring the bridge up exactly once, adopt it if already up."""
    global _adopted
    if await bridge_healthy():
        _adopted = True
        return True
    if not _spawn_bridge():
        return False
    healthy = await _wait_until_healthy(_BOOT_TIMEOUT_S)
    if not healthy:
        log_extra(logger, logging.ERROR, "bridge did not become healthy after spawn")
    return healthy


async def _watchdog_loop() -> None:
    while True:
        try:
            await asyncio.sleep(_WATCHDOG_INTERVAL_S)
            exited = _process is not None and _process.poll() is not None
            if exited:
                code = _process.returncode
                log_extra(logger, logging.WARNING, "bridge process exited", code=code)
                globals()["_process"] = None
            if _process is None and not _adopted and not await bridge_healthy():
                log_extra(logger, logging.WARNING, "bridge down — respawning")
                await ensure_bridge()
            elif _process is None and _adopted and not await bridge_healthy():
                # The adopted bridge died; take over ownership from now on.
                globals()["_adopted"] = False
                log_extra(logger, logging.WARNING, "adopted bridge lost — respawning")
                await ensure_bridge()
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001 — the watchdog must never kill the app
            logger.exception("bridge watchdog iteration failed")


def start_watchdog() -> None:
    global _watchdog_task
    if _watchdog_task is None or _watchdog_task.done():
        _watchdog_task = asyncio.ensure_future(_watchdog_loop())
        log_extra(logger, logging.INFO, "bridge watchdog started", interval_s=_WATCHDOG_INTERVAL_S)
