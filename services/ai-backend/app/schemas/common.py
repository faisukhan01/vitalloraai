"""Shared API schemas."""

from __future__ import annotations

from pydantic import BaseModel, Field


class MessageResponse(BaseModel):
    message: str
    details: dict | None = None


class Page(BaseModel):
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=25, ge=1, le=100)

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size
