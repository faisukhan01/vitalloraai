#!/usr/bin/env bash
# VitalLoraAI — sandbox boot script.
#
# The sandbox runs this file automatically on every container start
# (start.sh → sudo -u z bash .zscripts/dev.sh). It brings up the FULL stack so
# a sandbox reset can never again leave the app "dead" for the user:
#
#   1. turso-local   (mini-services :8288) — local Turso HTTP API emulator
#   2. ai-backend    (FastAPI      :8000)  — API + voice WebSocket
#   3. ai-bridge     (Bun          :8100)  — z-ai LLM/STT/TTS sidecar
#   4. web           (Next.js      :3000)  — dashboard (bun run dev)
#
# Every step is idempotent: re-running after a crash only fills the gaps.
set -u
cd /home/z/my-project

LOG_DIR=/home/z/my-project
mkdir -p "$LOG_DIR"

log() { echo "[dev.sh $(date '+%H:%M:%S')] $*"; }

port_up() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1$2" 2>/dev/null; }

# ── 0) Backend secrets (.env.local is gitignored — regenerate after resets) ─
if [ ! -f .env.local ]; then
  JWT=$(command -v python3 >/dev/null && python3 -c "import secrets; print(secrets.token_hex(32))" || openssl rand -hex 32)
  printf 'TURSO_DATABASE_URL=http://127.0.0.1:8288\nTURSO_AUTH_TOKEN=local-dev-token\nJWT_SECRET=%s\nSEED_ADMIN_PASSWORD=Vitalora#Demo2024\nAI_BRIDGE_URL=http://127.0.0.1:8100\n' "$JWT" > .env.local
  log "regenerated .env.local (fresh JWT secret)"
fi

# ── 1) Local database emulator (required by the backend) ────────────────────
if ! port_up 8288 /health; then
  log "starting turso-local on :8288"
  (cd mini-services/turso-local && bun install >/dev/null 2>&1; bun run index.ts >> "$LOG_DIR/turso-local.log" 2>&1 &)
  sleep 1
else
  log "turso-local already up"
fi

# Schema + demo seed (idempotent): after a hard reset the sqlite file may not
# exist — recreate tables from database/migrations and seed the demo org.
bun -e '
const { Database } = require("bun:sqlite");
const fs = require("fs");
const path = "/home/z/my-project/database/turso-local.db";
fs.mkdirSync("/home/z/my-project/database", { recursive: true });
const db = new Database(path);
db.exec("PRAGMA journal_mode = WAL;");
const hasUsers = db.query("SELECT count(*) AS n FROM sqlite_master WHERE type=\"table\" AND name=\"users\"").get()?.n > 0
  && db.query("SELECT count(*) AS n FROM users").get().n > 0;
if (!hasUsers) {
  db.exec("CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (strftime(\x27%Y-%m-%dT%H:%M:%fZ\x27,\x27now\x27)));");
  for (const f of fs.readdirSync("/home/z/my-project/database/migrations").filter(f => f.endsWith(".sql")).sort()) {
    try { db.exec(fs.readFileSync(`/home/z/my-project/database/migrations/${f}`, "utf8")); db.exec(`INSERT OR IGNORE INTO migrations (filename) VALUES (\x27${f}\x27)`); } catch (e) { console.log("migration", f, "skipped:", e.message); }
  }
  console.log("[dev.sh] database schema applied");
}
' >> "$LOG_DIR/turso-local.log" 2>&1 || log "WARN: schema bootstrap failed"

# Demo org seed (idempotent — prints "already seeded" when data exists).
if command -v /home/z/.venv/bin/python >/dev/null 2>&1; then
  (cd services/ai-backend && SEED_ADMIN_PASSWORD='Vitalora#Demo2024' /home/z/.venv/bin/python -m app.db.seed >> "$LOG_DIR/backend.log" 2>&1) \
    && log "seed check ok" || log "WARN: seed step failed (backend may still start)"
fi

# ── 2) AI bridge (LLM/STT/TTS sidecar) ──────────────────────────────────────
if ! port_up 8100 /health; then
  log "starting ai-bridge on :8100"
  (cd services/ai-bridge && bun install >/dev/null 2>&1; bun run index.ts >> "$LOG_DIR/bridge.log" 2>&1 &)
else
  log "ai-bridge already up"
fi

# ── 3) FastAPI backend ──────────────────────────────────────────────────────
if ! port_up 8000 /api/v1/ready; then
  log "starting ai-backend on :8000"
  (cd services/ai-backend && /home/z/.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 >> "$LOG_DIR/backend.log" 2>&1 &)
else
  log "ai-backend already up"
fi

# ── 4) Web dashboard (this call blocks — it IS the dev server) ──────────────
# After a sandbox reset node_modules is wiped; without this guard the boot
# failed with "next: command not found" and the preview stayed dead forever.
if [ ! -x apps/web/node_modules/.bin/next ]; then
  log "web deps missing — running bun install (workspace root)"
  bun install >> "$LOG_DIR/dev.log" 2>&1 || log "WARN: bun install failed"
fi
log "starting web on :3000 (bun run dev)"
exec env API_PROXY_URL=http://127.0.0.1:81 NEXT_PUBLIC_API_PORT=8000 bun run dev
