"""Shared fixtures.

Database tests run in their own schema (FitCheck_test_*) on TEST_DATABASE_URL, or on
DATABASE_URL_DIRECT when that is not set: point TEST_DATABASE_URL at a Neon test branch, or at the
local PGlite stand-in (`node scripts/localpg/server.mjs`). They are skipped when no database answers.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from worker.config import get_settings


class Clock:
    """Mock clock for limits tests."""

    def __init__(self, start: datetime | None = None):
        self.now = start or datetime(2026, 11, 14, 20, 0, 30, tzinfo=timezone.utc)   # 12:00:30 Pacific
        self.slept: list[float] = []

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **kw) -> None:
        self.now += timedelta(**kw)

    def sleep(self, sec: float) -> None:
        self.slept.append(sec)
        self.now += timedelta(seconds=sec)


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture(scope="session")
def db_url() -> str:
    url = os.getenv("TEST_DATABASE_URL") or get_settings().database_url
    if not url:
        pytest.skip("no TEST_DATABASE_URL / DATABASE_URL_DIRECT configured")
    try:
        from worker.db import connect
        connect(url).close()
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"database not reachable: {e}")
    return url


@pytest.fixture
def db(db_url):
    """A migrated, empty schema that is dropped after the test."""
    from scripts.migrate import apply
    from worker.db import DB

    schema = f"FitCheck_test_{uuid.uuid4().hex[:8]}"
    apply(db_url, quiet=True, schema=schema)
    d = DB(db_url, schema=schema)
    try:
        yield d
    finally:
        try:
            d.x(f"drop schema {schema} cascade")
        finally:
            d.close()
