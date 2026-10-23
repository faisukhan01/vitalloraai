#!/usr/bin/env bash
# VITALORA AI - run the FastAPI backend with auto-reload (development)
set -euo pipefail
cd "$(dirname "$0")/../services/ai-backend"

PY="${PYTHON:-python3}"
if [ -x /home/z/.venv/bin/python ]; then
  PY=/home/z/.venv/bin/python
fi

# Ensure venv deps exist (idempotent)
"$PY" -m pip show uvicorn >/dev/null 2>&1 || "$PY" -m pip install -r requirements.txt

exec "$PY" -m uvicorn app.main:app --host "${BACKEND_HOST:-0.0.0.0}" --port "${BACKEND_PORT:-8000}" --reload --ws-ping-interval 0
