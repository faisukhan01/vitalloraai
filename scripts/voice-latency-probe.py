"""E2E voice-pipeline latency probe.

Connects to the backend voice WS like the browser does, sends a greeting
request and a text question, and prints per-stage timings for every message.
"""
import asyncio
import base64
import json
import time

import httpx
import websockets

BASE = "http://127.0.0.1:8000"
WS = "ws://127.0.0.1:8000"
EMAIL = "admin@demo.vitalora.ai"
PASSWORD = "Vitalora#Demo2024"


async def probe() -> None:
    async with httpx.AsyncClient(base_url=BASE, timeout=30) as c:
        r = await c.post("/api/v1/auth/login", json={"email": EMAIL, "password": PASSWORD})
        token = r.json()["access_token"]
        recs = (await c.get("/api/v1/receptionists?status=active", headers={"Authorization": f"Bearer {token}"})).json()
        items = recs.get("items") or []
        if not items:
            print("NO_ACTIVE_RECEPTIONIST")
            return
        rec_id = items[0]["id"]
        lang = items[0].get("primary_language") or "en"
        sess = (
            await c.post(
                "/api/v1/voice/sessions",
                headers={"Authorization": f"Bearer {token}"},
                json={"receptionist_id": rec_id, "language": lang},
            )
        ).json()
        session_id = sess["session"]["id"]
        print(f"session={session_id}")

    t0 = time.perf_counter()
    async with websockets.connect(
        f"{WS}/api/v1/voice/ws/{session_id}?token={token}&language={lang}",
        max_size=20 * 1024 * 1024,
        open_timeout=15,
    ) as ws:
        print(f"[{time.perf_counter()-t0:6.2f}s] ws open → sending greet")
        await ws.send(json.dumps({"type": "greet"}))

        async def read_until(marker_types: set[str], timeout_s: float) -> None:
            end = time.perf_counter() + timeout_s
            while time.perf_counter() < end:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=max(0.05, end - time.perf_counter()))
                except TimeoutError:
                    break
                m = json.loads(raw)
                mt = m.get("type")
                ts = time.perf_counter() - t0
                if mt == "audio":
                    n = len(base64.b64decode(m.get("data") or ""))
                    print(f"[{ts:6.2f}s] ← audio ({n} bytes, fmt={m.get('format')})")
                    if "audio" in marker_types:
                        return
                else:
                    print(f"[{ts:6.2f}s] ← {mt} {str({k:v for k,v in m.items() if k not in ('type',)})[:120]}")
                    if mt in marker_types:
                        return

        # 1) greeting
        await read_until({"audio"}, 30)
        # drain a bit more (streamed chunks)
        await read_until({"__never__"}, 2.0)

        # 2) ask a question by text (same LLM+TTS path as voice, minus STT)
        t1 = time.perf_counter()
        print(f"--- asking question at [{t1-t0:6.2f}s]: what are your opening hours?")
        await ws.send(json.dumps({"type": "text", "data": "What are your opening hours tomorrow?"}))
        await read_until({"audio"}, 45)
        await read_until({"__never__"}, 2.5)

        # 3) second turn — warm cache
        t2 = time.perf_counter()
        print(f"--- asking follow-up at [{t2-t0:6.2f}s]: book appointment tomorrow 10am")
        await ws.send(json.dumps({"type": "text", "data": "Can I book an appointment tomorrow at 10 in the morning?"}))
        await read_until({"audio"}, 45)
        await read_until({"__never__"}, 2.5)

    print("PROBE_DONE")


asyncio.run(probe())
