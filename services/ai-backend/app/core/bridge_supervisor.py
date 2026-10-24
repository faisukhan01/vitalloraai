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

STALE-CODE GUARD (the "zombie bridge" bug):
A long-lived bridge keeps serving OLD code forever — e.g. after a deploy that
changes the LLM model or STT retry logic, the freshly started backend probed
/health, saw the previous instance healthy and ADOPTED it, so callers kept
talking to the previous brain while the new code sat unused (this exact
failure shipped glm-4.6 while callers were still served by glm-4-plus). The
supervisor therefore fingerprints the bridge source (sha256 of index.ts +
package.json), stamps it into the spawned process env (BRIDGE_FINGERPRINT)
and the bridge echoes it back in /health. Any healthy bridge whose
fingerprint does not match the code on disk is killed and replaced — stale
adoption is now impossible.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import shutil
import signal
import subprocess
from contextlib import suppress
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
_STALE_KILL_TIMEOUT_S = 4.0

# Fingerprinted sources: any change here means "the running bridge must be
# restarted to pick it up".
_FINGERPRINT_FILES = ("index.ts", "package.json")

_process: subprocess.Popen[bytes] | None = None
_adopted = False  # a bridge we did not spawn is healthy — watch but never duplicate
_watchdog_task: asyncio.Task[None] | None = None


def bridge_fingerprint() -> str:
    """SHA256 over the fingerprinted bridge sources (stable, short)."""
    digest = hashlib.sha256()
    for name in _FINGERPRINT_FILES:
        path = _BRIDGE_DIR / name
        try:
            digest.update(path.read_bytes())
        except OSError:
            digest.update(f"missing:{name}".encode())
        digest.update(b"\x00")
    return digest.hexdigest()[:16]


def _bridge_port() -> int:
    """Extract the bridge port from settings.ai_bridge_url (default 8100)."""
    match = re.search(r":(\d+)\s*/?\s*$", str(settings.ai_bridge_url))
    return int(match.group(1)) if match else 8100


async def _health_info() -> dict | None:
    """Fetch /health and return the parsed body, or None when unreachable."""
    try:
        async with httpx.AsyncClient(timeout=_HEALTH_TIMEOUT) as client:
            resp = await client.get(f"{settings.ai_bridge_url}/health")
            if resp.status_code == 200:
                body = resp.json()
                return body if isinstance(body, dict) else {}
    except (httpx.HTTPError, ValueError):
        return None
    return None


async def bridge_healthy() -> bool:
    return await _health_info() is not None


def _pid_listening_on(port: int) -> int | None:
    """Find the PID listening on `port` via ss(8); used to evict stale bridges
    that predate the fingerprint field (they do not report a PID)."""
    try:
        out = subprocess.run(  # noqa: S603 — fixed argv
            ["ss", "-tlnp"], capture_output=True, text=True, timeout=5,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        if f":{port}" not in line:
            continue
        match = re.search(r"pid=(\d+)", line)
        if match:
            return int(match.group(1))
    return None


async def _terminate_stale_bridge(info: dict | None, port: int) -> None:
    """Best-effort SIGTERM → SIGKILL of the stale bridge process."""
    pid: int | None = None
    if isinstance(info, dict):
        raw = info.get("pid")
        if isinstance(raw, int) and raw > 0:
            pid = raw
    if pid is None:
        pid = _pid_listening_on(port)
    if pid is None:
        logger.warning("stale bridge detected but no owning PID found on port %s", port)
        return
    try:
        os.kill(pid, signal.SIGTERM)
        log_extra(logger, logging.WARNING, "stale bridge killed (code changed)", pid=pid, port=port)
    except ProcessLookupError:
        return
    except OSError as exc:
        logger.warning("could not signal stale bridge pid=%s: %s", pid, exc)
        return
    # Wait for the port to free up; escalate to SIGKILL if it lingers.
    deadline = asyncio.get_running_loop().time() + _STALE_KILL_TIMEOUT_S
    while asyncio.get_running_loop().time() < deadline:
        try:
            os.kill(pid, 0)
        except OSError:
            return  # gone
        await asyncio.sleep(0.2)
    with suppress(ProcessLookupError):
        os.kill(pid, signal.SIGKILL)
        log_extra(logger, logging.WARNING, "stale bridge force-killed", pid=pid, port=port)


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
    env = {**os.environ, "BRIDGE_FINGERPRINT": bridge_fingerprint()}
    log_file = open(_BRIDGE_LOG, "ab")  # noqa: SIM115 — lives for the subprocess lifetime
    _process = subprocess.Popen(  # noqa: S603 — fixed argv, no user input
        [bun, "index.ts"],
        cwd=str(_BRIDGE_DIR),
        stdout=log_file,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,  # fully detached: survives backend reloads
        env=env,
    )
    _adopted = False
    log_extra(
        logger, logging.INFO, "bridge spawned",
        pid=_process.pid, port=settings.ai_bridge_url, fingerprint=bridge_fingerprint(),
    )
    return True


async def _wait_until_healthy(timeout_s: float) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout_s
    while asyncio.get_running_loop().time() < deadline:
        if await bridge_healthy():
            return True
        await asyncio.sleep(0.4)
    return False


async def _ensure_fresh_bridge() -> bool:
    """Spawn the bridge and wait for it to come up (assumes port is free)."""
    if not _spawn_bridge():
        return False
    healthy = await _wait_until_healthy(_BOOT_TIMEOUT_S)
    if not healthy:
        log_extra(logger, logging.ERROR, "bridge did not become healthy after spawn")
    return healthy


async def _bridge_is_current() -> bool:
    """True when a healthy bridge is running the CURRENT code fingerprint.

    Returns False in either failure mode:
    - bridge down (no /health response), or
    - bridge up but stale (missing/mismatched fingerprint → old code).
    """
    info = await _health_info()
    if info is None:
        return False
    running = info.get("fingerprint")
    if running != bridge_fingerprint():
        log_extra(
            logger, logging.WARNING, "stale bridge code detected",
            running_fingerprint=running, expected_fingerprint=bridge_fingerprint(),
        )
        await _terminate_stale_bridge(info, _bridge_port())
        return False
    return True


async def ensure_bridge() -> bool:
    """Idempotent: bring the bridge up exactly once, adopt only CURRENT code."""
    global _adopted
    if await _bridge_is_current():
        _adopted = True
        return True
    return await _ensure_fresh_bridge()


async def _watchdog_loop() -> None:
    global _process, _adopted
    while True:
        try:
            await asyncio.sleep(_WATCHDOG_INTERVAL_S)
            exited = _process is not None and _process.poll() is not None
            if exited:
                code = _process.returncode
                log_extra(logger, logging.WARNING, "bridge process exited", code=code)
                _process = None

            if _process is not None:
                # We own a live bridge: replace it whenever the code on disk
                # changed (fingerprint mismatch). This is what makes code
                # deploys reach callers without a manual restart.
                info = await _health_info()
                if info is not None and info.get("fingerprint") != bridge_fingerprint():
                    log_extra(logger, logging.WARNING, "bridge code changed — restarting owned bridge")
                    await _terminate_stale_bridge(info, _bridge_port())
                    _process = None
                    await _ensure_fresh_bridge()
                # /health unreachable this tick (transient): leave the process
                # alone — the next tick or `exited` handles a real death.
                continue

            # No owned process: adopt the running bridge ONLY if it runs the
            # current code, otherwise (down or stale) spawn a fresh one.
            if await _bridge_is_current():
                _adopted = True
            else:
                _adopted = False
                await _ensure_fresh_bridge()
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001 — the watchdog must never kill the app
            logger.exception("bridge watchdog iteration failed")


def start_watchdog() -> None:
    global _watchdog_task
    if _watchdog_task is None or _watchdog_task.done():
        _watchdog_task = asyncio.ensure_future(_watchdog_loop())
        log_extra(logger, logging.INFO, "bridge watchdog started", interval_s=_WATCHDOG_INTERVAL_S)
