"""Knowledge base endpoints: documents CRUD, reindex, FTS search.

Chunking: ~800 chars per chunk, ~100 chars overlap, split on paragraph and
sentence boundaries with a hard word-boundary wrap as last resort.
Search: SQLite FTS5 (bm25 ranking) with operator-safe sanitization and a LIKE
fallback when the user query cannot be compiled as an FTS expression.
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, Query, status

from app.api.v1._util import pagination, write_audit
from app.core.deps import Principal, require_permission
from app.core.errors import NotFound, ValidationFailed
from app.core.security import new_id, utc_now_iso
from app.db.client import db
from app.schemas.knowledge import (
    KnowledgeDocCreate,
    KnowledgeDocListResponse,
    KnowledgeDocOut,
    KnowledgeDocUpdate,
    SearchHit,
    SearchResponse,
)

router = APIRouter(prefix="/knowledge", tags=["knowledge"])

_CHUNK_TARGET = 800
_CHUNK_OVERLAP = 100
_PARAGRAPH_RE = re.compile(r"\n\s*\n")
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+|\n+")
_FTS_JUNK_RE = re.compile(r"[\"'()*^:{}\[\]]")
_FTS_OPERATORS = {"AND", "OR", "NOT", "NEAR"}


def _hard_wrap(text: str, target: int) -> list[str]:
    parts: list[str] = []
    current = ""
    for word in text.split():
        if not current:
            current = word
        elif len(current) + 1 + len(word) <= target:
            current = f"{current} {word}"
        else:
            parts.append(current)
            current = word
    if current:
        parts.append(current)
    return parts


def chunk_text(text: str, target: int = _CHUNK_TARGET, overlap: int = _CHUNK_OVERLAP) -> list[str]:
    """Split content into ~target-sized chunks on paragraph/sentence boundaries."""
    text = text.strip()
    if not text:
        return []
    units: list[str] = []
    for para in (p.strip() for p in _PARAGRAPH_RE.split(text)):
        if not para:
            continue
        if len(para) <= target:
            units.append(para)
            continue
        for sent in (s.strip() for s in _SENTENCE_RE.split(para)):
            if not sent:
                continue
            if len(sent) <= target:
                units.append(sent)
            else:
                units.extend(_hard_wrap(sent, target))

    chunks: list[str] = []
    current = ""
    for unit in units:
        if not current:
            current = unit
        elif len(current) + 1 + len(unit) <= target:
            current = f"{current} {unit}"
        else:
            chunks.append(current)
            tail = current[-overlap:].strip() if overlap > 0 and len(current) > overlap else ""
            current = f"{tail} {unit}" if tail and len(tail) + 1 + len(unit) <= target else unit
    if current:
        chunks.append(current)
    return chunks


def _fts_query(q: str) -> str:
    """Make arbitrary user input safe for FTS5 MATCH (quoted phrase terms)."""
    cleaned = _FTS_JUNK_RE.sub(" ", q)
    tokens = [t for t in cleaned.split() if t and t.upper() not in _FTS_OPERATORS]
    return " ".join(f'"{t}"' for t in tokens)


def _to_out(row: dict) -> KnowledgeDocOut:
    return KnowledgeDocOut(
        id=row["id"],
        organization_id=row["organization_id"],
        clinic_id=row["clinic_id"],
        title=row["title"],
        source_type=row["source_type"],
        content_text=row["content_text"],
        status=row["status"],
        chunk_count=row["chunk_count"],
        error=row["error"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def _get_document_or_404(document_id: str, org_id: str) -> dict:
    row = await db.one(
        "SELECT * FROM knowledge_documents WHERE id = ? AND organization_id = ?",
        (document_id, org_id),
    )
    if row is None:
        raise NotFound("Knowledge document not found.")
    return row


async def _get_clinic_or_404(clinic_id: str, org_id: str) -> dict:
    row = await db.one(
        "SELECT id FROM clinics WHERE id = ? AND organization_id = ?",
        (clinic_id, org_id),
    )
    if row is None:
        raise NotFound("Clinic not found.")
    return row


async def _insert_chunks(tx: Any, org_id: str, document_id: str, chunks: list[str]) -> None:
    for index, content in enumerate(chunks):
        await tx.execute(
            "INSERT INTO knowledge_chunks (id, organization_id, document_id, chunk_index, content, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (new_id(), org_id, document_id, index, content, utc_now_iso()),
        )


# ── Documents ────────────────────────────────────────────────────────────────


@router.get("/documents", response_model=KnowledgeDocListResponse)
async def list_documents(
    principal: Principal = Depends(require_permission("knowledge:read")),
    source_type: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    search: str | None = Query(default=None, max_length=120),
    pg: tuple[int, int] = Depends(pagination),
) -> KnowledgeDocListResponse:
    page, page_size = pg
    conds = ["organization_id = ?"]
    params: list = [principal.organization_id]
    if source_type:
        if source_type not in ("manual", "faq", "document", "url"):
            raise ValidationFailed("source_type must be one of: manual, faq, document, url.")
        conds.append("source_type = ?")
        params.append(source_type)
    if status_filter:
        if status_filter not in ("pending", "processing", "indexed", "failed", "inactive"):
            raise ValidationFailed("status must be one of: pending, processing, indexed, failed, inactive.")
        conds.append("status = ?")
        params.append(status_filter)
    if search:
        conds.append("title LIKE ?")
        params.append(f"%{search.strip()}%")
    where = " AND ".join(conds)  # static condition strings only; user data is in params
    total = await db.one(f"SELECT COUNT(*) AS n FROM knowledge_documents WHERE {where}", tuple(params))
    rows = await db.execute(
        f"SELECT * FROM knowledge_documents WHERE {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        tuple(params + [page_size, (page - 1) * page_size]),
    )
    return KnowledgeDocListResponse(
        items=[_to_out(r) for r in rows], total=total["n"] if total else 0, page=page, page_size=page_size
    )


@router.post("/documents", response_model=KnowledgeDocOut, status_code=status.HTTP_201_CREATED)
async def create_document(
    payload: KnowledgeDocCreate,
    principal: Principal = Depends(require_permission("knowledge:write")),
) -> KnowledgeDocOut:
    org_id = principal.organization_id
    if payload.clinic_id:
        await _get_clinic_or_404(payload.clinic_id, org_id)
    document_id = new_id()
    now = utc_now_iso()
    chunks = chunk_text(payload.content_text)
    async with db.transaction() as tx:
        await tx.execute(
            "INSERT INTO knowledge_documents (id, organization_id, clinic_id, title, source_type, content_text, "
            "status, chunk_count, uploaded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'indexed', ?, ?, ?, ?)",
            (
                document_id,
                org_id,
                payload.clinic_id,
                payload.title.strip(),
                payload.source_type,
                payload.content_text,
                len(chunks),
                principal.user_id,
                now,
                now,
            ),
        )
        await _insert_chunks(tx, org_id, document_id, chunks)
    await write_audit(
        principal,
        "knowledge_document_created",
        entity_type="knowledge_document",
        entity_id=document_id,
        details={"title": payload.title.strip(), "chunk_count": len(chunks)},
    )
    return KnowledgeDocOut(
        id=document_id,
        organization_id=org_id,
        clinic_id=payload.clinic_id,
        title=payload.title.strip(),
        source_type=payload.source_type,
        content_text=payload.content_text,
        status="indexed",
        chunk_count=len(chunks),
        error=None,
        created_at=now,
        updated_at=now,
    )


@router.get("/documents/{document_id}", response_model=KnowledgeDocOut)
async def get_document(
    document_id: str,
    principal: Principal = Depends(require_permission("knowledge:read")),
) -> KnowledgeDocOut:
    return _to_out(await _get_document_or_404(document_id, principal.organization_id))


@router.patch("/documents/{document_id}", response_model=KnowledgeDocOut)
async def update_document(
    document_id: str,
    payload: KnowledgeDocUpdate,
    principal: Principal = Depends(require_permission("knowledge:write")),
) -> KnowledgeDocOut:
    org_id = principal.organization_id
    row = await _get_document_or_404(document_id, org_id)
    provided = payload.model_dump(exclude_unset=True)
    if provided.get("clinic_id"):
        await _get_clinic_or_404(provided["clinic_id"], org_id)

    content_changed = "content_text" in provided and provided["content_text"] != row["content_text"]
    if content_changed:
        # Re-chunking recomputes the status; a client-supplied status never wins.
        provided.pop("status", None)
    now = utc_now_iso()
    updates: list[str] = []
    params: list = []
    for field in ("title", "source_type", "clinic_id", "content_text"):  # static whitelist
        if field in provided:
            value = provided[field]
            updates.append(f"{field} = ?")
            params.append(value.strip() if isinstance(value, str) else value)
    if "status" in provided and provided["status"] is not None:
        updates.append("status = ?")
        params.append(provided["status"])
    if content_changed:
        chunks = chunk_text(provided["content_text"] or "")
        updates.extend(["status = 'indexed'", "chunk_count = ?", "error = NULL"])
        async with db.transaction() as tx:
            await tx.execute(
                f"UPDATE knowledge_documents SET {', '.join(updates)}, updated_at = ? WHERE id = ? AND organization_id = ?",
                tuple(params + [len(chunks), now, document_id, org_id]),
            )
            await tx.execute(
                "DELETE FROM knowledge_chunks WHERE document_id = ? AND organization_id = ?",
                (document_id, org_id),
            )
            await _insert_chunks(tx, org_id, document_id, chunks)
        merged = dict(row)
        merged.update(provided)
        merged.update(status="indexed", chunk_count=len(chunks), error=None, updated_at=now)
    else:
        if not updates:
            return _to_out(row)
        updates.append("updated_at = ?")
        params.extend([now, document_id, org_id])
        await db.write(
            f"UPDATE knowledge_documents SET {', '.join(updates)} WHERE id = ? AND organization_id = ?",
            tuple(params),
        )
        merged = dict(row)
        merged.update(provided)
        merged["updated_at"] = now

    await write_audit(
        principal,
        "knowledge_document_updated",
        entity_type="knowledge_document",
        entity_id=document_id,
        details={k: provided[k] for k in provided},
    )
    return _to_out(merged)


@router.delete("/documents/{document_id}")
async def delete_document(
    document_id: str,
    principal: Principal = Depends(require_permission("knowledge:write")),
) -> dict:
    org_id = principal.organization_id
    row = await _get_document_or_404(document_id, org_id)
    async with db.transaction() as tx:
        await tx.execute(
            "DELETE FROM knowledge_chunks WHERE document_id = ? AND organization_id = ?",
            (document_id, org_id),
        )
        await tx.execute(
            "DELETE FROM knowledge_documents WHERE id = ? AND organization_id = ?",
            (document_id, org_id),
        )
    await write_audit(
        principal,
        "knowledge_document_deleted",
        entity_type="knowledge_document",
        entity_id=document_id,
        details={"title": row["title"]},
    )
    return {"message": "Knowledge document deleted."}


@router.post("/documents/{document_id}/reindex", response_model=KnowledgeDocOut)
async def reindex_document(
    document_id: str,
    principal: Principal = Depends(require_permission("knowledge:write")),
) -> KnowledgeDocOut:
    org_id = principal.organization_id
    row = await _get_document_or_404(document_id, org_id)
    chunks = chunk_text(row["content_text"])
    now = utc_now_iso()
    async with db.transaction() as tx:
        await tx.execute(
            "DELETE FROM knowledge_chunks WHERE document_id = ? AND organization_id = ?",
            (document_id, org_id),
        )
        await _insert_chunks(tx, org_id, document_id, chunks)
        await tx.execute(
            "UPDATE knowledge_documents SET status = 'indexed', chunk_count = ?, error = NULL, updated_at = ? "
            "WHERE id = ? AND organization_id = ?",
            (len(chunks), now, document_id, org_id),
        )
    await write_audit(
        principal,
        "knowledge_document_reindexed",
        entity_type="knowledge_document",
        entity_id=document_id,
        details={"chunk_count": len(chunks)},
    )
    merged = dict(row)
    merged.update(status="indexed", chunk_count=len(chunks), error=None, updated_at=now)
    return _to_out(merged)


# ── Search ───────────────────────────────────────────────────────────────────


@router.get("/search", response_model=SearchResponse)
async def search_knowledge(
    principal: Principal = Depends(require_permission("knowledge:read")),
    q: str = Query(..., min_length=1, max_length=300),
    limit: int = Query(default=10, ge=1, le=50),
) -> SearchResponse:
    org_id = principal.organization_id
    query = q.strip()
    match_query = _fts_query(query)
    if not match_query:
        raise ValidationFailed("Enter at least one searchable word.")

    mode = "fts"
    try:
        rows = await db.execute(
            "SELECT kc.id AS chunk_id, kc.document_id, kd.title AS document_title, kc.content, "
            "bm25(knowledge_chunks_fts) AS score "
            "FROM knowledge_chunks_fts "
            "JOIN knowledge_chunks kc ON kc.rowid = knowledge_chunks_fts.rowid "
            "JOIN knowledge_documents kd ON kd.id = kc.document_id "
            "WHERE knowledge_chunks_fts MATCH ? AND kc.organization_id = ? AND kd.organization_id = ? "
            "ORDER BY score ASC LIMIT ?",
            (match_query, org_id, org_id, limit),
        )
    except Exception:  # noqa: BLE001 — user input can defeat the FTS parser in exotic ways; LIKE fallback is safe
        # User input can still defeat the FTS parser in exotic cases; fall back
        # to an honest LIKE search instead of failing.
        mode = "like"
        needle = "%" + query.replace("%", "").replace("_", "") + "%"
        rows = await db.execute(
            "SELECT kc.id AS chunk_id, kc.document_id, kd.title AS document_title, kc.content, 0.0 AS score "
            "FROM knowledge_chunks kc JOIN knowledge_documents kd ON kd.id = kc.document_id "
            "WHERE kc.organization_id = ? AND kd.organization_id = ? AND kc.content LIKE ? "
            "ORDER BY kc.chunk_index ASC LIMIT ?",
            (org_id, org_id, needle, limit),
        )

    return SearchResponse(
        query=query,
        mode=mode,  # type: ignore[arg-type]
        results=[
            SearchHit(
                chunk_id=r["chunk_id"],
                document_id=r["document_id"],
                document_title=r["document_title"],
                content=r["content"],
                score=r["score"],
            )
            for r in rows
        ],
    )
