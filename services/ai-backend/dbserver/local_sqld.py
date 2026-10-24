"""Local Turso-compatible SQL server (development sandbox).

Implements the Hrana/Turso HTTP v2 pipeline protocol (POST /v2/pipeline with
{"requests": [{type: "execute", stmt: {sql, args}}], baton}) on top of Python's
stdlib sqlite3, backed by database/turso-local.db. This is what
app/db/client.py speaks; when the sandbox process reaper kills the previous
dev server this file lets the backend supervisor bring the database back on
its own — the backend treats the local DB as infrastructure it OWNS (same
pattern as the ai-bridge sidecar).

Wire format handled here (subset the client actually uses):
  request   {type: "execute", stmt: {sql, args}} | {type: "close", baton}
  result ok {type: "ok", response: {result: {cols: [{name}], rows: [[cell]],
            affected_row_count, last_insert_rowid}}}
  cell      {type: "null"} | {type: "integer"|"float", value: "1.5"} |
            {type: "blob", base64: "..."} | {type: "text", value: "..."}
  error     {type: "error", error: {message}}
Baton semantics: a baton opens a dedicated sqlite connection inside an open
transaction; COMMIT/ROLLBACK arrive as ordinary statements; "close" ends it
(sqlite rolls back anything uncommitted — matching sqld).

Run:  python dbserver/local_sqld.py   (port via DBSERVER_PORT, default 8288)
"""

from __future__ import annotations

import base64
import json
import os
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

PORT = int(os.environ.get("DBSERVER_PORT", "8288"))
DB_PATH = os.environ.get("DBSERVER_DB", "/home/z/my-project/database/turso-local.db")

_lock = threading.Lock()          # serializes all statement execution
_batons: dict[str, sqlite3.Connection] = {}
_shared: sqlite3.Connection | None = None


def _shared_conn() -> sqlite3.Connection:
    global _shared
    if _shared is None:
        _shared = sqlite3.connect(DB_PATH, timeout=30.0, check_same_thread=False)
        _shared.row_factory = sqlite3.Row
        _shared.isolation_level = None  # autocommit: non-baton writes commit immediately
    return _shared


def _decode_arg(arg: dict[str, Any]) -> Any:
    atype = arg.get("type")
    if atype == "null":
        return None
    if atype == "integer":
        return int(arg.get("value", 0))
    if atype == "float":
        return float(arg.get("value", 0))
    if atype in ("blob", "blob_base64"):
        return base64.b64decode(arg.get("base64", "") or "")
    return str(arg.get("value", ""))


def _encode_cell(value: Any) -> dict[str, Any]:
    if value is None:
        return {"type": "null"}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, float):
        return {"type": "float", "value": repr(value)}
    if isinstance(value, bytes):
        return {"type": "blob", "base64": base64.b64encode(value).decode("ascii")}
    return {"type": "text", "value": str(value)}


def _execute_on(conn: sqlite3.Connection, sql: str, args: list[Any]) -> dict[str, Any]:
    cur = conn.execute(sql, args)
    cols = [{"name": d[0]} for d in cur.description or []]
    rows = [[_encode_cell(c) for c in row] for row in cur.fetchall()]
    result: dict[str, Any] = {
        "cols": cols,
        "rows": rows,
        "affected_row_count": cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0,
        "last_insert_rowid": cur.lastrowid,
    }
    conn.commit()
    return result


def run_pipeline(body: dict[str, Any]) -> dict[str, Any]:
    requests = body.get("requests") or []
    baton_in = body.get("baton")
    results: list[dict[str, Any]] = []
    baton_out = baton_in

    with _lock:
        conn: sqlite3.Connection | None = None
        own_txn = False
        if baton_in:
            conn = _batons.get(baton_in)
            if conn is None:
                # Unknown/expired baton (server restarted mid-transaction):
                # recreate leniently so a crashed server never wedges callers.
                conn = sqlite3.connect(DB_PATH, timeout=30.0, check_same_thread=False)
                conn.isolation_level = None
                conn.execute("BEGIN IMMEDIATE")
                baton_out = baton_in
                _batons[baton_out] = conn
            own_txn = True
        try:
            for req in requests:
                rtype = req.get("type")
                if rtype == "execute":
                    stmt = req.get("stmt") or {}
                    args = [_decode_arg(a) for a in (stmt.get("args") or [])]
                    try:
                        result = _execute_on(conn or _shared_conn(), str(stmt.get("sql", "")), args)
                        results.append({"type": "ok", "response": {"result": result}})
                    except sqlite3.Error as exc:
                        results.append({"type": "error", "error": {"message": str(exc)}})
                elif rtype == "close":
                    b = req.get("baton")
                    target = _batons.pop(b, None) if b else None
                    if target is not None:
                        try:
                            target.rollback()  # uncommitted work is discarded, like sqld
                            target.close()
                        except sqlite3.Error:
                            pass
                    results.append({"type": "ok", "response": {"result": {}}})
                elif rtype == "commit":
                    if conn is not None:
                        try:
                            conn.commit()
                            results.append({"type": "ok", "response": {"result": {}}})
                        except sqlite3.Error as exc:
                            results.append({"type": "error", "error": {"message": str(exc)}})
                    else:
                        results.append({"type": "error", "error": {"message": "commit outside baton"}})
                else:
                    results.append({
                        "type": "error",
                        "error": {"message": f"unsupported request type: {rtype}"},
                    })
        finally:
            if own_txn and conn is not None and baton_out is None:
                conn.close()

    return {"results": results, "baton": baton_out}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # quiet access log
        pass

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802 — stdlib naming
        if self.path.split("?")[0] in ("/", "/health"):
            self._json(200, {"status": "ok", "service": "local-sqld", "db": DB_PATH})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 — stdlib naming
        if self.path.split("?")[0] != "/v2/pipeline":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"error": "invalid json"})
            return
        try:
            self._json(200, run_pipeline(body))
        except Exception as exc:  # noqa: BLE001 — never kill the handler thread
            self._json(500, {"error": str(exc)})


def main() -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    # Open once at boot so a corrupt file fails fast and visibly.
    conn = _shared_conn()
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("SELECT 1")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(json.dumps({
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "level": "info",
        "message": "local-sqld listening",
        "port": PORT,
        "db": DB_PATH,
    }), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
