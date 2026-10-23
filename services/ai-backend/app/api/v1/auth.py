"""Authentication & session endpoints.

Reference implementation for the rest of the API:
- All queries parameterized and organization-scoped.
- Audit events on sensitive actions.
- Refresh-token rotation with server-side revocation.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, Request, Response, status

from app.core.config import settings
from app.core.deps import Principal, get_principal, rate_limit
from app.core.errors import AuthError, ConflictError, ValidationFailed
from app.core.logging import log_extra
from app.core.permissions import permissions_for_role
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    hash_token,
    new_id,
    utc_now_iso,
    validate_password_strength,
    verify_password,
)
from app.db.client import db
from app.schemas.auth import (
    AuthTokens,
    ChangePasswordRequest,
    LoginRequest,
    LoginResponse,
    MeResponse,
    OrganizationOut,
    OrgChoice,
    RefreshRequest,
    RegisterOrgRequest,
    RegisterResponse,
    UserOut,
)

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "vitalora_refresh"


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:80] or "org"


def _cookie_params(request: Request) -> dict:
    """Cookie flags adapt to the request context.

    Preview panels frequently embed the app in a cross-site iframe served over
    HTTPS; browsers reject SameSite=Lax cookies in that context, which breaks
    session restore after sign-in. Over HTTPS we emit SameSite=None; Secure —
    accepted in iframes and in normal top-level browsing alike. Plain HTTP
    (local development) keeps the configured Lax default.
    """
    forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    is_https = forwarded_proto == "https" or request.url.scheme == "https"
    if is_https or settings.cookie_samesite == "none":
        return {"secure": True, "samesite": "none"}
    return {"secure": settings.cookie_secure, "samesite": settings.cookie_samesite}


async def _issue_session(
    response: Response,
    *,
    request: Request,
    user_id: str,
    org_id: str,
    role: str,
    user_agent: str | None,
    audit_action: str,
) -> AuthTokens:
    access = create_access_token(user_id=user_id, org_id=org_id, role=role)
    refresh, refresh_hash, expires_at = create_refresh_token(user_id=user_id, org_id=org_id, role=role)
    await db.write(
        "INSERT INTO refresh_sessions (id, user_id, token_hash, user_agent, expires_at, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (new_id(), user_id, refresh_hash, (user_agent or "")[:250], expires_at.isoformat(), utc_now_iso()),
    )
    response.set_cookie(
        key=REFRESH_COOKIE,
        value=refresh,
        httponly=True,
        max_age=settings.refresh_token_expire_days * 24 * 3600,
        path="/",
        **_cookie_params(request),
    )
    await db.write(
        "INSERT INTO audit_events (id, organization_id, actor_user_id, actor_type, actor_display, action, ip_hash, created_at) "
        "VALUES (?, ?, ?, 'user', ?, ?, ?, ?)",
        (
            new_id(),
            org_id,
            user_id,
            "user",
            audit_action,
            hash_token(str(user_agent or ""))[:16],
            utc_now_iso(),
        ),
    )
    return AuthTokens(access_token=access, expires_in=settings.access_token_expire_minutes * 60)


@router.post(
    "/register-org",
    response_model=RegisterResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit(requests=5, per_seconds=3600))],
)
async def register_organization(payload: RegisterOrgRequest, request: Request, response: Response) -> RegisterResponse:
    """Create an organization with its owner account (self-serve onboarding)."""
    weak_reason = validate_password_strength(payload.admin.password)
    if weak_reason:
        raise ValidationFailed(weak_reason)

    slug = _slugify(payload.organization.slug or payload.organization.name)
    existing = await db.one("SELECT id FROM organizations WHERE slug = ?", (slug,))
    if existing:
        raise ConflictError("An organization with this identifier already exists. Choose another name or slug.")

    existing_email = await db.one(
        "SELECT id FROM users WHERE email = ? AND organization_id IN (SELECT id FROM organizations WHERE slug = ?)",
        (payload.admin.email.lower(), slug),
    )
    if existing_email:
        raise ConflictError("An account with this email already exists for this organization.")

    org_id, user_id = new_id(), new_id()
    now = utc_now_iso()
    async with db.transaction() as tx:
        await tx.execute(
            "INSERT INTO organizations (id, name, slug, plan, status, created_at, updated_at) VALUES (?, ?, ?, 'trial', 'active', ?, ?)",
            (org_id, payload.organization.name.strip(), slug, now, now),
        )
        await tx.execute(
            "INSERT INTO users (id, organization_id, email, password_hash, name, role, status, email_verified, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, 'owner', 'active', 0, ?, ?)",
            (user_id, org_id, payload.admin.email.lower(), hash_password(payload.admin.password), payload.admin.name.strip(), now, now),
        )

    tokens = await _issue_session(
        response,
        request=request,
        user_id=user_id,
        org_id=org_id,
        role="owner",
        user_agent=request.headers.get("user-agent"),
        audit_action="organization_registered",
    )
    user = await db.one("SELECT * FROM users WHERE id = ?", (user_id,))
    org = await db.one("SELECT * FROM organizations WHERE id = ?", (org_id,))
    log_extra(
        __import__("logging").getLogger(__name__), 20, "organization registered", org_id=org_id, slug=slug
    )
    return RegisterResponse(
        **tokens.model_dump(),
        user=UserOut(
            id=user_id,
            email=user["email"],
            name=user["name"],
            role=user["role"],
            organization_id=org_id,
            email_verified=False,
            created_at=user["created_at"],
        ),
        organization=OrganizationOut(
            id=org_id, name=org["name"], slug=org["slug"], plan=org["plan"], status=org["status"], created_at=org["created_at"]
        ),
    )


@router.post("/login", response_model=LoginResponse, dependencies=[Depends(rate_limit(requests=10, per_seconds=60))])
async def login(payload: LoginRequest, request: Request, response: Response) -> LoginResponse:
    """Sign in. If the email exists in multiple organizations, supply org_slug."""
    rows = await db.execute(
        "SELECT u.*, o.slug AS org_slug, o.name AS org_name, o.status AS org_status "
        "FROM users u JOIN organizations o ON o.id = u.organization_id "
        "WHERE u.email = ? AND u.status = 'active'",
        (payload.email.lower(),),
    )
    matches = [r for r in rows if r["org_status"] == "active"]
    if payload.org_slug:
        matches = [r for r in matches if r["org_slug"] == payload.org_slug]

    if not matches:
        if rows:
            raise ConflictError(
                "This email is used in multiple organizations. Specify your organization.",
                details={"organizations": [OrgChoice(slug=r["org_slug"], name=r["org_name"]).model_dump() for r in rows]},
            )
        await db.write(
            "INSERT INTO audit_events (id, organization_id, actor_type, actor_display, action, created_at) "
            "VALUES (?, 'system', 'system', 'login_failed', ?)",
            (new_id(), utc_now_iso()),
        )
        raise AuthError("Invalid email or password.")
    if len(matches) > 1:
        raise ConflictError(
            "This email is used in multiple organizations. Specify your organization.",
            details={"organizations": [OrgChoice(slug=r["org_slug"], name=r["org_name"]).model_dump() for r in matches]},
        )

    user = matches[0]
    if not verify_password(payload.password, user["password_hash"]):
        raise AuthError("Invalid email or password.")

    await db.write("UPDATE users SET last_login_at = ? WHERE id = ?", (utc_now_iso(), user["id"]))
    tokens = await _issue_session(
        response,
        request=request,
        user_id=user["id"],
        org_id=user["organization_id"],
        role=user["role"],
        user_agent=request.headers.get("user-agent"),
        audit_action="login",
    )
    return LoginResponse(
        **tokens.model_dump(),
        user=UserOut(
            id=user["id"],
            email=user["email"],
            name=user["name"],
            role=user["role"],
            organization_id=user["organization_id"],
            email_verified=bool(user["email_verified"]),
            created_at=user["created_at"],
        ),
    )


@router.post("/refresh", response_model=AuthTokens, dependencies=[Depends(rate_limit(requests=30, per_seconds=60))])
async def refresh_session(request: Request, response: Response, payload: RefreshRequest | None = None) -> AuthTokens:
    """Rotate the refresh token and issue a new access token."""
    token = payload.refresh_token if payload and payload.refresh_token else request.cookies.get(REFRESH_COOKIE)
    if not token:
        raise AuthError("No refresh token provided.")
    claims = decode_token(token, expected_type="refresh")
    session = await db.one(
        "SELECT * FROM refresh_sessions WHERE token_hash = ? AND revoked_at IS NULL",
        (hash_token(token),),
    )
    if not session:
        raise AuthError("Session revoked or unknown. Sign in again.")
    now = utc_now_iso()
    if session["expires_at"] <= now:
        raise AuthError("Session expired. Sign in again.")

    user = await db.one("SELECT * FROM users WHERE id = ? AND status = 'active'", (str(claims["sub"]),))
    if not user:
        raise AuthError("Account is no longer active.")

    await db.write("UPDATE refresh_sessions SET revoked_at = ? WHERE id = ?", (now, session["id"]))
    access = create_access_token(user_id=user["id"], org_id=user["organization_id"], role=user["role"])
    new_refresh, new_hash, expires_at = create_refresh_token(
        user_id=user["id"], org_id=user["organization_id"], role=user["role"]
    )
    await db.write(
        "INSERT INTO refresh_sessions (id, user_id, token_hash, user_agent, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (new_id(), user["id"], new_hash, session["user_agent"], expires_at.isoformat(), now),
    )
    response.set_cookie(
        key=REFRESH_COOKIE,
        value=new_refresh,
        httponly=True,
        max_age=settings.refresh_token_expire_days * 24 * 3600,
        path="/",
        **_cookie_params(request),
    )
    return AuthTokens(access_token=access, expires_in=settings.access_token_expire_minutes * 60)


@router.post("/logout")
async def logout(request: Request, response: Response, payload: RefreshRequest | None = None) -> dict:
    token = payload.refresh_token if payload and payload.refresh_token else request.cookies.get(REFRESH_COOKIE)
    if token:
        await db.write(
            "UPDATE refresh_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
            (utc_now_iso(), hash_token(token)),
        )
    response.delete_cookie(REFRESH_COOKIE, path="/")
    return {"message": "Signed out."}


@router.get("/me", response_model=MeResponse)
async def me(principal: Principal = Depends(get_principal)) -> MeResponse:
    user = await db.one("SELECT * FROM users WHERE id = ? AND organization_id = ?", (principal.user_id, principal.organization_id))
    if not user:
        raise AuthError("Account not found in this organization.")
    org = await db.one("SELECT * FROM organizations WHERE id = ?", (principal.organization_id,))
    return MeResponse(
        user=UserOut(
            id=user["id"],
            email=user["email"],
            name=user["name"],
            role=user["role"],
            organization_id=user["organization_id"],
            email_verified=bool(user["email_verified"]),
            created_at=user["created_at"],
        ),
        organization=OrganizationOut(
            id=org["id"], name=org["name"], slug=org["slug"], plan=org["plan"], status=org["status"], created_at=org["created_at"]
        ),
        permissions=permissions_for_role(user["role"]),
    )


@router.post("/change-password")
async def change_password(
    payload: ChangePasswordRequest, response: Response, principal: Principal = Depends(get_principal)
) -> dict:
    user = await db.one("SELECT * FROM users WHERE id = ?", (principal.user_id,))
    if not user or not verify_password(payload.current_password, user["password_hash"]):
        raise AuthError("Current password is incorrect.")
    weak_reason = validate_password_strength(payload.new_password)
    if weak_reason:
        raise ValidationFailed(weak_reason)
    now = utc_now_iso()
    async with db.transaction() as tx:
        await tx.execute("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", (hash_password(payload.new_password), now, principal.user_id))
        await tx.execute(
            "UPDATE refresh_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", (now, principal.user_id)
        )
    response.delete_cookie(REFRESH_COOKIE, path="/")
    await db.write(
        "INSERT INTO audit_events (id, organization_id, actor_user_id, actor_type, actor_display, action, created_at) "
        "VALUES (?, ?, ?, 'user', 'user', 'password_changed', ?)",
        (new_id(), principal.organization_id, principal.user_id, now),
    )
    return {"message": "Password updated. Please sign in again."}


@router.post("/password-reset/request")
async def request_password_reset() -> dict:
    """Password reset requires an outbound email provider, which is not
    configured in this environment. We return an honest 501 instead of
    pretending an email was sent (spec §21)."""
    raise ValidationFailed(
        "Password reset by email is not configured in this environment. "
        "An administrator can reset passwords from Organization Settings once email delivery is connected.",
    )


@router.post("/password-reset/confirm")
async def confirm_password_reset() -> dict:
    raise ValidationFailed(
        "Password reset by email is not configured in this environment. "
        "An administrator can reset passwords from Organization Settings once email delivery is connected.",
    )
