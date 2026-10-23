"""Password hashing (argon2id) and JWT issuance/verification."""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt as pyjwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from app.core.config import settings
from app.core.errors import AuthError

_hasher = PasswordHasher()  # argon2id defaults are sane and memory-hard


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError, ValueError):
        return False


def validate_password_strength(password: str) -> str | None:
    """Return a human-readable reason if the password is weak, else None."""
    if len(password) < 10:
        return "Password must be at least 10 characters long."
    if not any(c.isalpha() for c in password) or not any(c.isdigit() for c in password):
        return "Password must contain both letters and numbers."
    return None


def _create_token(
    *,
    subject: str,
    org_id: str,
    role: str,
    token_type: str,
    expires_delta: timedelta,
) -> tuple[str, str]:
    jti = uuid.uuid4().hex
    now = datetime.now(UTC)
    claims = {
        "sub": subject,
        "org": org_id,
        "role": role,
        "typ": token_type,
        "iat": int(now.timestamp()),
        "exp": int((now + expires_delta).timestamp()),
        "jti": jti,
    }
    encoded = pyjwt.encode(claims, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    return encoded, jti


def create_access_token(*, user_id: str, org_id: str, role: str) -> str:
    token, _ = _create_token(
        subject=user_id,
        org_id=org_id,
        role=role,
        token_type="access",
        expires_delta=timedelta(minutes=settings.access_token_expire_minutes),
    )
    return token


def create_refresh_token(*, user_id: str, org_id: str, role: str) -> tuple[str, str, datetime]:
    """Returns (token, jti_hash_for_storage, expires_at)."""
    token, _ = _create_token(
        subject=user_id,
        org_id=org_id,
        role=role,
        token_type="refresh",
        expires_delta=timedelta(days=settings.refresh_token_expire_days),
    )
    expires_at = datetime.now(UTC) + timedelta(days=settings.refresh_token_expire_days)
    return token, hash_token(token), expires_at


def decode_token(token: str, expected_type: str) -> dict:
    try:
        claims = pyjwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            options={"require": ["exp", "sub", "typ"]},
        )
    except pyjwt.ExpiredSignatureError as e:
        raise AuthError("Your session has expired. Please sign in again.") from e
    except pyjwt.InvalidTokenError as e:
        raise AuthError("Invalid authentication token.") from e
    if claims.get("typ") != expected_type:
        raise AuthError("Invalid token type for this operation.")
    return claims


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_id() -> str:
    return str(uuid.uuid4())


def new_caller_ref() -> str:
    """Non-PII reference for a conversation participant, safe to store/display."""
    return f"caller_{secrets.token_hex(4)}"


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
