"""API v1 router aggregation."""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1 import (
    analytics,
    appointments,
    audit,
    auth,
    callbacks,
    calls,
    clinics,
    knowledge,
    providers,
    receptionists,
    services,
    voice,
)

api_v1_router = APIRouter(prefix="/api/v1")
for _module in (
    auth,
    clinics,
    providers,
    services,
    receptionists,
    appointments,
    knowledge,
    calls,
    analytics,
    audit,
    callbacks,
    voice,
):
    api_v1_router.include_router(_module.router)
