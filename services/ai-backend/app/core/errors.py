"""Application error taxonomy and safe error responses.

Rule: error responses never leak internals (stack traces, SQL, credentials).
"""

from __future__ import annotations

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.core.logging import request_id_ctx


class AppError(Exception):
    """Base class for expected, user-safe errors."""

    status_code: int = status.HTTP_400_BAD_REQUEST
    error_code: str = "bad_request"

    def __init__(self, message: str, *, details: dict | None = None) -> None:
        self.message = message
        self.details = details or {}
        super().__init__(message)

    def to_response(self) -> JSONResponse:
        return JSONResponse(
            status_code=self.status_code,
            content={
                "error": {"code": self.error_code, "message": self.message, "details": self.details or None},
                "request_id": request_id_ctx.get(),
            },
        )


class AuthError(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    error_code = "unauthenticated"


class PermissionDenied(AppError):
    status_code = status.HTTP_403_FORBIDDEN
    error_code = "forbidden"


class NotFound(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    error_code = "not_found"


class ConflictError(AppError):
    status_code = status.HTTP_409_CONFLICT
    error_code = "conflict"


class ValidationFailed(AppError):
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    error_code = "validation_failed"


class RateLimited(AppError):
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    error_code = "rate_limited"


class ProviderError(AppError):
    status_code = status.HTTP_502_BAD_GATEWAY
    error_code = "provider_error"


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return exc.to_response()

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "error": {
                    "code": "validation_failed",
                    "message": "Request validation failed.",
                    "details": {
                        "fields": [
                            f"{'.'.join(str(p) for p in e.get('loc', []))}: {e.get('msg', '')}"
                            for e in exc.errors()
                        ]
                    },
                },
                "request_id": request_id_ctx.get(),
            },
        )

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        # Logged by middleware; never expose internals to the client.
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error": {"code": "internal_error", "message": "An unexpected error occurred."},
                "request_id": request_id_ctx.get(),
            },
        )
