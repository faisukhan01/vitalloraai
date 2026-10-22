#!/usr/bin/env bash
# VITALORA AI — ai-bridge integration test (REAL ZAI provider calls).
# Starts the service, hits every endpoint, prints PASS/FAIL + latency, kills it.
#
# Usage: cd services/ai-bridge && bash test-bridge.sh
# Override port: AI_BRIDGE_PORT=8123 bash test-bridge.sh

set -u
cd "$(dirname "$0")"

PORT="${AI_BRIDGE_PORT:-8100}"
BASE="http://127.0.0.1:${PORT}"
PASS=0
FAIL=0
SERVER_PID=""
TMPDIR_TEST="$(mktemp -d)"
trap 'if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi; rm -rf "$TMPDIR_TEST"' EXIT

say()  { printf '%s\n' "$*"; }
pass() { PASS=$((PASS+1)); say "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); say "FAIL: $1"; }

# --- 0. start service -------------------------------------------------------
say "=== ai-bridge test (port ${PORT}) ==="
bun index.ts > "$TMPDIR_TEST/server.log" 2>&1 &
SERVER_PID=$!

HEALTH_OK=0
for _ in $(seq 1 60); do
  if curl -sf -o "$TMPDIR_TEST/health.json" "$BASE/health" 2>/dev/null; then
    HEALTH_OK=1
    break
  fi
  sleep 0.5
done
if [ "$HEALTH_OK" -ne 1 ]; then
  say "FAIL: service did not become healthy within 30s"
  say "--- server.log ---"; cat "$TMPDIR_TEST/server.log"
  exit 1
fi
pass "GET /health came up"
say "health body: $(cat "$TMPDIR_TEST/health.json")"

# --- 1. POST /llm/chat ------------------------------------------------------
CODE_TIME=$(curl -s -o "$TMPDIR_TEST/llm.json" -w "%{http_code} %{time_total}" \
  -X POST -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with exactly: BRIDGE_OK"}]}' \
  "$BASE/llm/chat")
CODE=$(echo "$CODE_TIME" | cut -d' ' -f1); TT=$(echo "$CODE_TIME" | cut -d' ' -f2)
if [ "$CODE" = "200" ]; then
  if python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
c=d.get("content","")
assert "BRIDGE_OK" in c, f"content missing BRIDGE_OK: {c!r}"
assert isinstance(d.get("model"), str) and d["model"], "model missing"
' "$TMPDIR_TEST/llm.json" 2>"$TMPDIR_TEST/llm.err"; then
    pass "POST /llm/chat 200, content contains BRIDGE_OK (${TT}s)"
  else
    fail "POST /llm/chat content check: $(cat "$TMPDIR_TEST/llm.err") body=$(head -c 300 "$TMPDIR_TEST/llm.json")"
  fi
else
  fail "POST /llm/chat expected 200 got $CODE (${TT}s) body=$(head -c 300 "$TMPDIR_TEST/llm.json")"
fi

# --- 2. POST /tts short (single-chunk path) ---------------------------------
CODE_TIME=$(curl -s -o "$TMPDIR_TEST/tts1.json" -w "%{http_code} %{time_total}" \
  -X POST -H "Content-Type: application/json" \
  -d '{"text":"Hello from Vitalora bridge test."}' \
  "$BASE/tts")
CODE=$(echo "$CODE_TIME" | cut -d' ' -f1); TT=$(echo "$CODE_TIME" | cut -d' ' -f2)
if [ "$CODE" = "200" ]; then
  if python3 -c '
import json,sys,base64
d=json.load(open(sys.argv[1]))
a=d.get("audio_base64","")
assert len(a) > 1000, f"audio_base64 too short: {len(a)}"
assert d.get("format") == "wav", f"format: {d.get('format')}"
raw=base64.b64decode(a)
assert raw[:4]==b"RIFF" and raw[8:12]==b"WAVE", "not a WAV container"
' "$TMPDIR_TEST/tts1.json" 2>"$TMPDIR_TEST/tts1.err"; then
    pass "POST /tts short 200, wav audio_base64 > 1000 chars (${TT}s)"
  else
    fail "POST /tts short checks: $(cat "$TMPDIR_TEST/tts1.err")"
  fi
else
  fail "POST /tts short expected 200 got $CODE (${TT}s) body=$(head -c 300 "$TMPDIR_TEST/tts1.json")"
fi

# --- 3. POST /tts 2500 chars (multi-chunk + WAV merge path) -----------------
sleep 1  # let the provider rate window breathe between TTS calls
python3 -c '
import json
text = ("Vitalora is your healthcare voice receptionist. It books appointments, "
        "answers clinic questions, and triages urgent calls. ")
payload = {"text": text * 25}  # ~2500+ chars, forces multi-chunk synthesis
open("'"$TMPDIR_TEST"'/tts2_req.json","w").write(json.dumps(payload))
print("request text chars:", len(payload["text"]))
'
CODE_TIME=$(curl -s -o "$TMPDIR_TEST/tts2.json" -w "%{http_code} %{time_total}" \
  -X POST -H "Content-Type: application/json" \
  --data-binary @"$TMPDIR_TEST/tts2_req.json" \
  "$BASE/tts")
CODE=$(echo "$CODE_TIME" | cut -d' ' -f1); TT=$(echo "$CODE_TIME" | cut -d' ' -f2)
if [ "$CODE" = "200" ]; then
  if python3 -c '
import json,sys,base64,struct
d=json.load(open(sys.argv[1]))
a=d.get("audio_base64","")
assert len(a) > 1000, f"audio_base64 missing/short: {len(a)}"
assert d.get("format") == "wav", f"format: {d.get('format')}"
raw=base64.b64decode(a)
assert raw[:4]==b"RIFF" and raw[8:12]==b"WAVE", "not a WAV container"
data_size=struct.unpack("<I", raw[40:44])[0]
assert len(raw) == 44 + data_size, f"canonical 44-byte header expected: {len(raw)} vs {44+data_size}"
# parse fmt: 24000 Hz 16-bit mono expected from provider
ch=struct.unpack("<H", raw[22:24])[0]; sr=struct.unpack("<I", raw[24:28])[0]; bits=struct.unpack("<H", raw[34:36])[0]
print(f"merged wav: {len(raw)} bytes, {ch}ch {sr}Hz {bits}bit, data={data_size}")
' "$TMPDIR_TEST/tts2.json" 2>"$TMPDIR_TEST/tts2.err"; then
    pass "POST /tts 2500-char multi-chunk 200, single merged WAV (${TT}s)"
  else
    fail "POST /tts multi-chunk checks: $(cat "$TMPDIR_TEST/tts2.err")"
  fi
else
  fail "POST /tts multi-chunk expected 200 got $CODE (${TT}s) body=$(head -c 300 "$TMPDIR_TEST/tts2.json")"
fi

# --- 4. POST /stt invalid base64 (honest failure, no crash) -----------------
sleep 1  # provider rate window
CODE_TIME=$(curl -s -o "$TMPDIR_TEST/stt.json" -w "%{http_code} %{time_total}" \
  -X POST -H "Content-Type: application/json" \
  -d '{"file_base64":"bm90LWF1ZGlvLWF0LWFsbA=="}' \
  "$BASE/stt")
CODE=$(echo "$CODE_TIME" | cut -d' ' -f1); TT=$(echo "$CODE_TIME" | cut -d' ' -f2)
if [ "$CODE" -ge 400 ] && [ "$CODE" -lt 600 ]; then
  pass "POST /stt invalid audio → honest $CODE, no crash (${TT}s) body=$(head -c 200 "$TMPDIR_TEST/stt.json")"
else
  fail "POST /stt invalid audio expected 4xx/5xx got $CODE body=$(head -c 200 "$TMPDIR_TEST/stt.json")"
fi

# --- 4b. service must still be alive after the failure ----------------------
if curl -sf -o /dev/null "$BASE/health"; then
  pass "service still healthy after provider failure"
else
  fail "service crashed after provider failure"
fi

# --- 4c. /embeddings honest stub ---------------------------------------------
CODE=$(curl -s -o "$TMPDIR_TEST/emb.json" -w "%{http_code}" -X POST "$BASE/embeddings")
if [ "$CODE" = "501" ]; then
  pass "POST /embeddings honest 501 stub"
else
  fail "POST /embeddings expected 501 got $CODE"
fi

# --- shutdown ----------------------------------------------------------------
kill "$SERVER_PID" 2>/dev/null
wait "$SERVER_PID" 2>/dev/null
SERVER_PID=""

say ""
say "--- server structured log (no payloads) ---"
cat "$TMPDIR_TEST/server.log"
say ""
say "=== RESULT: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1
