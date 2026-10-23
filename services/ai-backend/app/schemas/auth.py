"""Authentication request/response schemas."""

from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field, field_validator


class AdminSignup(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)


class OrganizationSignup(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    slug: str | None = Field(default=None, max_length=80)


class RegisterOrgRequest(BaseModel):
    organization: OrganizationSignup
    admin: AdminSignup


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)
    org_slug: str | None = None


class RefreshRequest(BaseModel):
    refresh_token: str | None = None


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=10, max_length=128)

    @field_validator("new_password")
    @classmethod
    def _not_same(cls, v: str, info) -> str:
        if info.data.get("current_password") and v == info.data["current_password"]:
            raise ValueError("New password must be different from the current password.")
        return v


class UserOut(BaseModel):
    id: str
    email: str
    name: str
    role: str
    organization_id: str
    email_verified: bool
    created_at: str


class OrganizationOut(BaseModel):
    id: str
    name: str
    slug: str
    plan: str
    status: str
    created_at: str


class MeResponse(BaseModel):
    user: UserOut
    organization: OrganizationOut
    permissions: list[str]


class AuthTokens(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class LoginResponse(AuthTokens):
    user: UserOut


class RegisterResponse(LoginResponse):
    organization: OrganizationOut


class OrgChoice(BaseModel):
    slug: str
    name: str


class MultiOrgConflict(BaseModel):
    organizations: list[OrgChoice]
