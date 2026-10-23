"""FastAPI dependencies: authentication, authorization, rate limiting."""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from fastapi import Depends, Request

from app.core.errors import AuthError, PermissionDenied, RateLimited
from app.core.permissions import role_has_permission
from app.core.security import decode_token


@dataclass(frozen=True)
class Principal:
    user_id: str
    organization_id: str
    role: str
    email: str
    name: str

    def has(self, permission: str) -> bool:
        return role_has_permission(self.role, permission)


@dataclass
class RateLimitState:
    hits: dict[str, list[float]] = field(default_factory=dict)


_rate_state = RateLimitState()


async def get_principal(request: Request) -> Principal:
    """Resolve the authenticated principal from the Authorization header.

    Cross-origin (production) browsers send the access token as a Bearer header;
    the refresh token stays in an httpOnly cookie. WebSocket endpoints use the
    query-parameter variant (`principal_from_token`).
    """
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise AuthError("Authentication required. Sign in to continue.")
    token = header[7:].strip()
    return _principal_from_access_token(token)


def _principal_from_access_token(token: str) -> Principal:
    claims = decode_token(token, expected_type="access")
    return Principal(
        user_id=str(claims["sub"]),
        organization_id=str(claims["org"]),
        role=str(claims.get("role", "staff")),
        email=str(claims.get("email", "")),
        name=str(claims.get("name", "")),
    )


def principal_from_token(token: str) -> Principal:
    return _principal_from_access_token(token)


async def get_optional_principal(request: Request) -> Principal | None:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return None
    try:
        return _principal_from_access_token(header[7:].strip())
    except AuthError:
        return None


def require_permission(permission: str):
    """Dependency factory: enforce a permission for the current principal."""

    async def _checker(principal: Principal = Depends(get_principal)) -> Principal:
        if not principal.has(permission):
            raise PermissionDenied(
                f"Your role ({principal.role}) does not allow this action.",
                details={"required_permission": permission},
            )
        return principal

    return _checker


def rate_limit(*, requests: int, per_seconds: int, key_by_ip: bool = True):
    """In-memory sliding-window rate limiter (single-process).

    NOTE (documented limitation): per-process only. For multi-instance
    deployments use a shared store (e.g. Redis) — see docs/architecture.md.
    """

    async def _limiter(request: Request) -> None:
        key = request.client.host if request.client and key_by_ip else "global"
        path_key = f"{key}:{request.url.path}"
        now = time.monotonic()
        window = _rate_state.hits.setdefault(path_key, [])
        # Drop expired hits
        while window and now - window[0] > per_seconds:
            window.pop(0)
        if len(window) >= requests:
            raise RateLimited(f"Too many requests. Try again in {per_seconds} seconds.")
        window.append(now)

    return _limiter
