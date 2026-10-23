"""AI receptionist endpoints (CRUD).

Permission matrix: read -> receptionists:read, write -> receptionists:write.
Validation enforced here (not just schema-level):
- languages must be a subset of the platform's supported languages
- primary_language must be one of the configured languages
- DELETE only allowed while status is 'draft'
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query, status

from app.api.v1._util import json_loads_or_none, pagination, write_audit
from app.core.config import settings
from app.core.deps import Principal, require_permission
from app.core.errors import ConflictError, NotFound, ValidationFailed
from app.core.security import new_id, utc_now_iso
from app.db.client import db
from app.schemas.receptionists import (
    Capabilities,
    EscalationConfig,
    ReceptionistCreate,
    ReceptionistListResponse,
    ReceptionistOut,
    ReceptionistUpdate,
)

router = APIRouter(prefix="/receptionists", tags=["receptionists"])


def _supported() -> list[str]:
    return settings.supported_language_list


def _validate_language_set(languages: list[str], primary: str) -> None:
    supported = _supported()
    unsupported = [lang for lang in languages if lang not in supported]
    if unsupported:
        raise ValidationFailed(
            f"Unsupported language(s): {', '.join(unsupported)}. "
            f"Currently supported: {', '.join(supported)}."
        )
    if primary not in languages:
        raise ValidationFailed("primary_language must be one of the configured languages.")


def _to_out(row: dict) -> ReceptionistOut:
    return ReceptionistOut(
        id=row["id"],
        organization_id=row["organization_id"],
        clinic_id=row["clinic_id"],
        clinic_name=row.get("clinic_name"),
        name=row["name"],
        persona=row["persona"],
        status=row["status"],
        languages=json_loads_or_none(row["languages"]) or [],
        primary_language=row["primary_language"],
        voice_provider=row["voice_provider"],
        voice_id=row["voice_id"],
        speaking_speed=row["speaking_speed"],
        greeting_message=row["greeting_message"],
        system_prompt_extra=row["system_prompt_extra"],
        capabilities=Capabilities(**(json_loads_or_none(row["capabilities"]) or {})),
        escalation=EscalationConfig(**(json_loads_or_none(row["escalation"]) or {})),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def _get_receptionist_or_404(receptionist_id: str, org_id: str) -> dict:
    row = await db.one(
        "SELECT r.*, c.name AS clinic_name FROM receptionists r JOIN clinics c ON c.id = r.clinic_id "
        "WHERE r.id = ? AND r.organization_id = ?",
        (receptionist_id, org_id),
    )
    if row is None:
        raise NotFound("Receptionist not found.")
    return row


async def _get_clinic_or_404(clinic_id: str, org_id: str) -> dict:
    row = await db.one(
        "SELECT id FROM clinics WHERE id = ? AND organization_id = ?",
        (clinic_id, org_id),
    )
    if row is None:
        raise NotFound("Clinic not found.")
    return row


@router.get("", response_model=ReceptionistListResponse)
async def list_receptionists(
    principal: Principal = Depends(require_permission("receptionists:read")),
    clinic_id: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    pg: tuple[int, int] = Depends(pagination),
) -> ReceptionistListResponse:
    page, page_size = pg
    conds = ["r.organization_id = ?"]
    params: list = [principal.organization_id]
    if clinic_id:
        conds.append("r.clinic_id = ?")
        params.append(clinic_id)
    if status_filter:
        if status_filter not in ("draft", "active", "paused"):
            raise ValidationFailed("status must be one of: draft, active, paused.")
        conds.append("r.status = ?")
        params.append(status_filter)
    where = " AND ".join(conds)  # static condition strings only; user data is in params
    total = await db.one(f"SELECT COUNT(*) AS n FROM receptionists r WHERE {where}", tuple(params))
    rows = await db.execute(
        "SELECT r.*, c.name AS clinic_name FROM receptionists r JOIN clinics c ON c.id = r.clinic_id "
        f"WHERE {where} ORDER BY r.created_at ASC, r.id ASC LIMIT ? OFFSET ?",
        tuple(params + [page_size, (page - 1) * page_size]),
    )
    return ReceptionistListResponse(
        items=[_to_out(r) for r in rows], total=total["n"] if total else 0, page=page, page_size=page_size
    )


@router.post("", response_model=ReceptionistOut, status_code=status.HTTP_201_CREATED)
async def create_receptionist(
    payload: ReceptionistCreate,
    principal: Principal = Depends(require_permission("receptionists:write")),
) -> ReceptionistOut:
    clinic = await _get_clinic_or_404(payload.clinic_id, principal.organization_id)
    _validate_language_set(payload.languages, payload.primary_language)
    receptionist_id = new_id()
    now = utc_now_iso()
    await db.write(
        "INSERT INTO receptionists (id, organization_id, clinic_id, name, persona, status, languages, primary_language, "
        "voice_provider, voice_id, speaking_speed, greeting_message, system_prompt_extra, capabilities, escalation, "
        "created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            receptionist_id,
            principal.organization_id,
            clinic["id"],
            payload.name.strip(),
            payload.persona,
            payload.status,
            json.dumps(payload.languages),
            payload.primary_language,
            payload.voice_provider,
            payload.voice_id,
            payload.speaking_speed,
            payload.greeting_message,
            payload.system_prompt_extra,
            payload.capabilities.model_dump_json(),
            payload.escalation.model_dump_json(),
            principal.user_id,
            now,
            now,
        ),
    )
    await write_audit(
        principal,
        "receptionist_created",
        entity_type="receptionist",
        entity_id=receptionist_id,
        details={"name": payload.name.strip(), "clinic_id": clinic["id"], "status": payload.status},
    )
    return ReceptionistOut(
        id=receptionist_id,
        organization_id=principal.organization_id,
        clinic_id=clinic["id"],
        name=payload.name.strip(),
        persona=payload.persona,
        status=payload.status,
        languages=payload.languages,
        primary_language=payload.primary_language,
        voice_provider=payload.voice_provider,
        voice_id=payload.voice_id,
        speaking_speed=payload.speaking_speed,
        greeting_message=payload.greeting_message,
        system_prompt_extra=payload.system_prompt_extra,
        capabilities=payload.capabilities,
        escalation=payload.escalation,
        created_at=now,
        updated_at=now,
    )


@router.get("/{receptionist_id}", response_model=ReceptionistOut)
async def get_receptionist(
    receptionist_id: str,
    principal: Principal = Depends(require_permission("receptionists:read")),
) -> ReceptionistOut:
    return _to_out(await _get_receptionist_or_404(receptionist_id, principal.organization_id))


@router.patch("/{receptionist_id}", response_model=ReceptionistOut)
async def update_receptionist(
    receptionist_id: str,
    payload: ReceptionistUpdate,
    principal: Principal = Depends(require_permission("receptionists:write")),
) -> ReceptionistOut:
    row = await _get_receptionist_or_404(receptionist_id, principal.organization_id)
    provided = payload.model_dump(exclude_unset=True)

    languages = provided.get("languages") or json_loads_or_none(row["languages"]) or []
    primary = provided.get("primary_language") or row["primary_language"]
    if "languages" in provided or "primary_language" in provided:
        _validate_language_set(languages, primary)

    updates: list[str] = []
    params: list = []
    scalar_fields = (
        "name", "persona", "status", "primary_language", "voice_provider", "voice_id",
        "speaking_speed", "greeting_message", "system_prompt_extra",
    )
    for field in scalar_fields:  # static whitelist
        if field in provided:
            value = provided[field]
            updates.append(f"{field} = ?")
            params.append(value.strip() if isinstance(value, str) else value)
    if "languages" in provided and provided["languages"] is not None:
        updates.append("languages = ?")
        params.append(json.dumps(provided["languages"]))
    if "capabilities" in provided and provided["capabilities"] is not None:
        updates.append("capabilities = ?")
        params.append(json.dumps(provided["capabilities"]))
    if "escalation" in provided and provided["escalation"] is not None:
        updates.append("escalation = ?")
        params.append(json.dumps(provided["escalation"]))
    if not updates:
        return _to_out(row)

    now = utc_now_iso()
    updates.append("updated_at = ?")
    params.extend([now, receptionist_id, principal.organization_id])
    await db.write(
        f"UPDATE receptionists SET {', '.join(updates)} WHERE id = ? AND organization_id = ?",
        tuple(params),
    )
    merged = dict(row)
    merged.update(provided)
    merged["updated_at"] = now
    await write_audit(
        principal,
        "receptionist_updated",
        entity_type="receptionist",
        entity_id=receptionist_id,
        details={k: provided[k] for k in provided},
    )
    return _to_out(merged)


@router.delete("/{receptionist_id}")
async def delete_receptionist(
    receptionist_id: str,
    principal: Principal = Depends(require_permission("receptionists:write")),
) -> dict:
    row = await _get_receptionist_or_404(receptionist_id, principal.organization_id)
    if row["status"] != "draft":
        raise ConflictError(
            "Only receptionists in draft status can be deleted. Pause the receptionist instead if it is live."
        )
    await db.write(
        "DELETE FROM receptionists WHERE id = ? AND organization_id = ?",
        (receptionist_id, principal.organization_id),
    )
    await write_audit(
        principal,
        "receptionist_deleted",
        entity_type="receptionist",
        entity_id=receptionist_id,
        details={"name": row["name"]},
    )
    return {"message": "Receptionist deleted."}
