"""VITALORA AI backend entrypoint.

FastAPI application factory with:
- Structured JSON logging and correlation IDs (X-Request-ID).
- CORS configuration.
- Safe exception handling.
- Liveness (/health) and readiness (/api/v1/ready) probes.
"""

from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_v1_router
from app.core.config import settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging, log_extra, request_id_ctx
from app.db.client import db

logger = logging.getLogger("vitalora")


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    log_extra(logger, logging.INFO, "backend starting", db=settings.turso_database_url.split("//")[1].split("/")[0])
    # Warm the entire DB pool before serving: cold Hrana sessions queue
    # server-side, so the first caller after a process start would otherwise
    # wait seconds on their first turn.
    from app.db.client import db as _db

    await _db.prewarm_pool()
    log_extra(logger, logging.INFO, "db pool warmed", pool_size=5)
    yield
    log_extra(logger, logging.INFO, "backend shutting down")


def create_app() -> FastAPI:
    app = FastAPI(
        title="VITALORA AI API",
        version="0.1.0",
        description="Enterprise multilingual healthcare AI voice receptionist platform.",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID"],
    )

    @app.middleware("http")
    async def correlation_and_timing(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
        token = request_id_ctx.set(request_id)
        start = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            duration_ms = int((time.perf_counter() - start) * 1000)
            log_extra(
                logger, logging.ERROR, "unhandled error",
                method=request.method, path=request.url.path, duration_ms=duration_ms,
            )
            request_id_ctx.reset(token)
            raise
        duration_ms = int((time.perf_counter() - start) * 1000)
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Response-Time"] = f"{duration_ms}ms"
        if request.url.path != "/health":
            log_extra(
                logger, logging.INFO, "request",
                method=request.method, path=request.url.path,
                status=response.status_code, duration_ms=duration_ms,
            )
        request_id_ctx.reset(token)
        return response

    register_exception_handlers(app)

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok", "service": "vitalora-ai-backend", "version": "0.1.0"}

    @app.get("/api/v1/ready")
    async def ready() -> dict:
        # Readiness: config valid (import-time check) + database reachable.
        row = await db.one("SELECT 1 AS ok")
        return {
            "status": "ready" if row and row["ok"] == 1 else "degraded",
            "database": "connected" if row else "unavailable",
        }

    app.include_router(api_v1_router)
    return app


app = create_app()
