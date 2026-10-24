/**
 * Local Turso HTTP API emulator (v2/pipeline) backed by bun:sqlite.
 *
 * Implements exactly the subset of Turso's HTTP JSON API that
 * services/ai-backend/app/db/client.py speaks:
 *
 *   POST /v2/pipeline   { requests: [{type:"execute", stmt:{sql, args}}] , baton? }
 *                       { requests: [{type:"close", baton}] }
 *
 *   → 200 { results: [{type:"ok", response:{result:{cols:[{name}], rows:[[cell,…]]}}}],
 *           baton?: string }
 *
 * Value wire format (both directions):
 *   {"type":"null"} | {"type":"integer","value":"1"} | {"type":"float","value":"1.5"}
 *   {"type":"text","value":"…"} | {"type":"blob","base64":"…"}
 *
 * Baton semantics: a pipeline that starts with BEGIN (no baton) opens a
 * dedicated sqlite connection and returns a fresh baton. Subsequent pipelines
 * carrying that baton execute on the same connection until COMMIT/ROLLBACK or
 * a {"type":"close"} request. Idle batons are reaped after 5 minutes.
 *
 * Port: 8288 (fixed — do not use the PORT env var).
 */

import { Database } from "bun:sqlite";

const PORT = 8288;
const DB_PATH = process.env.TURSO_LOCAL_DB ?? "/home/z/my-project/database/turso-local.db";
const BATON_TTL_MS = 5 * 60_000;

// ── wire value encoding ───────────────────────────────────────────────────
type WireValue =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: string }
  | { type: "text"; value: string }
  | { type: "blob"; base64: string };

function encodeIn(arg: any): unknown {
  if (arg === null || arg === undefined) return null;
  const t = arg?.type;
  if (t === "null") return null;
  if (t === "integer") return Number.parseInt(arg.value, 10);
  if (t === "float") return Number.parseFloat(arg.value);
  if (t === "text") return String(arg.value);
  if (t === "blob" || t === "blob_base64") {
    const b64 = arg.base64 ?? arg.value ?? "";
    return b64 ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : new Uint8Array(0);
  }
  // Plain JSON fallback (client always sends typed values, but be lenient).
  return arg;
}

function encodeOut(v: unknown): WireValue {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: String(v) };
  }
  if (v instanceof Uint8Array) return { type: "blob", base64: btoa(String.fromCharCode(...v)) };
  return { type: "text", value: String(v) };
}

// ── storage ───────────────────────────────────────────────────────────────
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

mkdirSync(dirname(DB_PATH), { recursive: true });

const shared = new Database(DB_PATH, { create: true });
shared.exec("PRAGMA journal_mode = WAL;");
shared.exec("PRAGMA busy_timeout = 5000;");
shared.exec("PRAGMA foreign_keys = ON;");

interface Baton {
  conn: Database;
  lastUsed: number;
}
const batons = new Map<string, Baton>();

function reapBatons() {
  const now = Date.now();
  for (const [key, b] of batons) {
    if (now - b.lastUsed > BATON_TTL_MS) {
      try {
        b.conn.exec("ROLLBACK");
      } catch {
        /* already closed */
      }
      b.conn.close();
      batons.delete(key);
    }
  }
}
setInterval(reapBatons, 60_000).unref();

function newBaton(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

// ── statement execution ───────────────────────────────────────────────────
interface ExecResult {
  type: "ok" | "error";
  response?: { result: { cols: { name: string }[]; rows: WireValue[][] } };
  error?: { message: string };
}

function runExecute(conn: Database, sql: string, args: any[]): ExecResult {
  try {
    const trimmed = sql.trim().toUpperCase();
    // Statement-level control flow that Turso accepts as plain executes.
    if (trimmed === "BEGIN" || trimmed.startsWith("BEGIN ")) {
      // Caller is starting a baton transaction — handled by the pipeline
      // router (it owns baton creation). Execute on the conn anyway so the
      // dedicated connection opens its transaction.
      conn.exec(sql);
      return { type: "ok", response: { result: { cols: [], rows: [] } } };
    }
    if (trimmed === "COMMIT" || trimmed === "ROLLBACK" || trimmed.startsWith("COMMIT ") || trimmed.startsWith("ROLLBACK ")) {
      conn.exec(sql);
      return { type: "ok", response: { result: { cols: [], rows: [] } } };
    }

    const stmt = conn.prepare(sql);
    const params = args.map(encodeIn);
    const isRead = /^(SELECT|WITH|PRAGMA|EXPLAIN)/.test(trimmed);

    if (isRead) {
      const rows = stmt.all(...params) as Record<string, unknown>[];
      const cols = stmt.columnNames;
      const out = rows.map((r) => cols.map((c) => encodeOut(r[c])));
      return { type: "ok", response: { result: { cols: cols.map((name) => ({ name })), rows: out } } };
    }

    stmt.run(...params);
    const cols = stmt.columnNames;
    const rows: WireValue[][] = [];
    if (cols.length > 0) {
      const changed = conn.query("SELECT changes() AS n").get() as { n: number } | undefined;
      rows.push(cols.map((c) => (c === "changes" || c === "n" ? encodeOut(changed?.n ?? 0) : { type: "null" })));
    }
    return { type: "ok", response: { result: { cols: cols.map((name) => ({ name })), rows } } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { type: "error", error: { message: msg } };
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", db: DB_PATH });
    }

    if (url.pathname !== "/v2/pipeline" || req.method !== "POST") {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    let body: {
      requests?: { type?: string; stmt?: { sql?: string; args?: any[] }; baton?: string }[];
      baton?: string;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }

    const requests = body.requests ?? [];
    const results: ExecResult[] = [];
    let outBaton: string | undefined = body.baton;
    let closeBaton = false;

    // Resolve the connection for this pipeline.
    let batonKey = body.baton;
    let conn: Database;

    if (batonKey && batons.has(batonKey)) {
      conn = batons.get(batonKey)!.conn;
      batons.get(batonKey)!.lastUsed = Date.now();
    } else if (batonKey) {
      // Unknown/expired baton — Turso returns an error; be lenient and start fresh.
      batonKey = undefined;
      conn = shared;
    } else {
      conn = shared;
    }

    for (const reqOne of requests) {
      if (reqOne.type === "close") {
        closeBaton = true;
        results.push({ type: "ok", response: { result: { cols: [], rows: [] } } });
        continue;
      }
      const sql = reqOne.stmt?.sql ?? "";
      const args = reqOne.stmt?.args ?? [];
      const trimmed = sql.trim().toUpperCase();

      // A bare BEGIN on a baton-less pipeline opens a baton transaction.
      if (!batonKey && (trimmed === "BEGIN" || trimmed.startsWith("BEGIN "))) {
        batonKey = newBaton();
        const dedicated = new Database(DB_PATH, { create: true });
        dedicated.exec("PRAGMA busy_timeout = 5000;");
        dedicated.exec("PRAGMA foreign_keys = ON;");
        batons.set(batonKey, { conn: dedicated, lastUsed: Date.now() });
        outBaton = batonKey;
        conn = dedicated;
      }

      results.push(runExecute(conn, sql, args));

      // Auto-retire the baton after COMMIT/ROLLBACK (Turso closes it too).
      if (batonKey && (trimmed === "COMMIT" || trimmed.startsWith("COMMIT ") || trimmed === "ROLLBACK" || trimmed.startsWith("ROLLBACK "))) {
        closeBaton = true;
      }
    }

    if (batonKey) outBaton = batonKey;

    if (closeBaton && batonKey) {
      const b = batons.get(batonKey);
      if (b) {
        try {
          b.conn.close();
        } catch {
          /* already closed */
        }
        batons.delete(batonKey);
      }
      if (outBaton === batonKey) outBaton = undefined;
    }

    return Response.json({ results, baton: outBaton });
  },
});

console.log(`[turso-local] listening on :${PORT} — db: ${DB_PATH}`);
