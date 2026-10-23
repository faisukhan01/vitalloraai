"""Structured JSON logging with correlation IDs.

Sensitive values (tokens, passwords, audio payloads) must never be logged.
Helpers here redact common secret-looking keys defensively.
"""

from __future__ import annotations

import json
import logging
import sys
from contextvars import ContextVar

request_id_ctx: ContextVar[str] = ContextVar("request_id", default="-")
session_id_ctx: ContextVar[str] = ContextVar("session_id", default="-")

_REDACT_KEYS = {"password", "token", "access_token", "refresh_token", "authorization", "secret", "audio"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": request_id_ctx.get(),
        }
        if session_id_ctx.get() != "-":
            payload["session_id"] = session_id_ctx.get()
        extra = getattr(record, "extra_data", None)
        if isinstance(extra, dict):
            payload.update({k: ("[redacted]" if str(k).lower() in _REDACT_KEYS else v) for k, v in extra.items()})
        if record.exc_info and record.exc_info[0] is not None:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging() -> None:
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for h in list(root.handlers):
        root.removeHandler(h)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root.addHandler(handler)
    # Quiet noisy third-party loggers
    for name in ("httpx", "httpcore", "websockets", "uvicorn.error", "uvicorn.access"):
        logging.getLogger(name).setLevel(logging.WARNING)


def log_extra(logger: logging.Logger, level: int, message: str, **data: object) -> None:
    """Log with structured extra data: log_extra(logger, logging.INFO, 'msg', org_id=...)"""
    logger.log(level, message, extra={"extra_data": data})
