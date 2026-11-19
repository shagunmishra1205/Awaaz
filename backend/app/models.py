import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .config import settings
from .database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _expiry() -> datetime:
    return _now() + timedelta(hours=settings.session_ttl_hours)


class SavedSession(Base):
    """Progress saved by the user, only when they choose to. Deleted after the TTL."""

    __tablename__ = "saved_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    form_json: Mapped[str] = mapped_column(Text)
    answers_json: Mapped[str] = mapped_column(Text)
    idx: Mapped[int] = mapped_column(default=0)
    lang: Mapped[str] = mapped_column(String(2), default="en")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_expiry)
