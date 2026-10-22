"""Knowledge base document and search schemas."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class KnowledgeDocCreate(BaseModel):
    title: str = Field(min_length=2, max_length=200)
    source_type: Literal["manual", "faq", "document", "url"] = "manual"
    content_text: str = Field(default="", max_length=200_000)
    clinic_id: str | None = Field(default=None, max_length=64)


class KnowledgeDocUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=2, max_length=200)
    source_type: Literal["manual", "faq", "document", "url"] | None = None
    content_text: str | None = Field(default=None, max_length=200_000)
    clinic_id: str | None = Field(default=None, max_length=64)
    # Client-settable lifecycle states only; pending/processing/failed are
    # owned by the ingestion pipeline and never accepted from clients.
    status: Literal["indexed", "inactive"] | None = None


class KnowledgeDocOut(BaseModel):
    id: str
    organization_id: str
    clinic_id: str | None
    title: str
    source_type: str
    content_text: str
    status: str
    chunk_count: int
    error: str | None
    created_at: str
    updated_at: str


class KnowledgeDocListResponse(BaseModel):
    items: list[KnowledgeDocOut]
    total: int
    page: int
    page_size: int


class SearchHit(BaseModel):
    chunk_id: str
    document_id: str
    document_title: str
    content: str
    score: float


class SearchResponse(BaseModel):
    query: str
    mode: Literal["fts", "like"] = "fts"
    results: list[SearchHit]
