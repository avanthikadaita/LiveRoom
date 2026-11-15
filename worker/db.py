"""Neon access for the worker. The database is the contract: the worker only writes here."""
from __future__ import annotations

import logging
import os
import socket
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .config import get_settings

log = logging.getLogger("worker.db")
WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"


def connect(url: str | None = None, autocommit: bool = True, schema: str | None = None) -> psycopg.Connection:
    url = url or get_settings().database_url
    if not url:
        raise RuntimeError("DATABASE_URL_DIRECT is not set (worker/.env)")
    # prepare_threshold=None: safe behind poolers (pgbouncer) and the local PGlite stand-in
    conn = psycopg.connect(url, autocommit=autocommit, row_factory=dict_row,
                           connect_timeout=15, prepare_threshold=None)
    schema = schema or os.getenv("DB_SCHEMA")
    if schema:                      # tests run in their own schema so they never touch real rows
        if not schema.replace("_", "").isalnum():
            raise ValueError("bad schema name")
        conn.execute(f"create schema if not exists {schema}")
        conn.execute(f"set search_path to {schema}, public")
    return conn


class DB:
    """One lazily (re)connected autocommit connection. Reconnects after Neon idles out."""

    def __init__(self, url: str | None = None, schema: str | None = None):
        self.url = url
        self.schema = schema
        self._conn: psycopg.Connection | None = None

    @property
    def conn(self) -> psycopg.Connection:
        if self._conn is None or self._conn.closed or self._conn.broken:
            self._conn = connect(self.url, schema=self.schema)
        return self._conn

    def _retry(self, fn):
        try:
            return fn()
        except (psycopg.OperationalError, psycopg.InterfaceError) as e:
            log.warning("db connection lost (%s), reconnecting once", e)
            try:
                if self._conn is not None:
                    self._conn.close()
            except Exception:
                pass
            self._conn = None
            return fn()

    def q(self, sql: str, params: Any = None) -> list[dict]:
        def run():
            cur = self.conn.execute(sql, params)
            return cur.fetchall() if cur.description else []
        return self._retry(run)

    def one(self, sql: str, params: Any = None) -> dict | None:
        rows = self.q(sql, params)
        return rows[0] if rows else None

    def x(self, sql: str, params: Any = None) -> int:
        return self._retry(lambda: self.conn.execute(sql, params).rowcount)

    @contextmanager
    def tx(self) -> Iterator[psycopg.Connection]:
        with self.conn.transaction():
            yield self.conn

    def close(self) -> None:
        if self._conn is not None and not self._conn.closed:
            self._conn.close()

    # ---- shared helpers -------------------------------------------------
    def event(self, listing_id: int, from_status: str | None, to_status: str | None, note: str | None = None) -> None:
        self.x("insert into asset_events (listing_id, from_status, to_status, note) values (%s,%s,%s,%s)",
               (listing_id, from_status, to_status, (note or "")[:500] or None))

    def error(self, where: str, message: str, listing_id: int | None = None, code: str | None = None,
              detail: dict | None = None) -> None:
        """Nothing fails silently (spec 14): log + error_log row. Never raises."""
        log.error("%s listing=%s code=%s %s", where, listing_id, code, message)
        try:
            self.x("insert into error_log (where_, listing_id, code, message, detail) values (%s,%s,%s,%s,%s)",
                   (where, listing_id, code, str(message)[:2000], Jsonb(detail) if detail else None))
        except Exception as e:  # the log itself must never break a stage
            log.error("could not write error_log: %s", e)

    # ---- job queue (spec section 4) --------------------------------------
    def claim(self, from_status: str, to_status: str, *, lock_minutes: int = 10, max_attempts: int = 3,
              count_attempt: bool = True, extra_where: str = "") -> dict | None:
        """Atomically move one asset from_status -> to_status and lock it (skip locked)."""
        inc = 1 if count_attempt else 0
        row = self.one(
            f"""
            update assets set status = %(to)s::asset_status, locked_by = %(me)s, locked_at = now(),
                   attempts = attempts + %(inc)s, updated_at = now()
            where listing_id = (
              select a.listing_id from assets a join listings l on l.id = a.listing_id
              where a.status = %(from)s::asset_status
                and (a.locked_at is null or a.locked_at < now() - make_interval(mins => %(lock)s))
                and (a.next_attempt_at is null or a.next_attempt_at <= now())
                {extra_where}
              order by (l.source = 'FitCheck') desc, l.demo_pin desc, a.updated_at
              limit 1 for update of a skip locked)
            returning *
            """,
            {"to": to_status, "from": from_status, "me": WORKER_ID, "lock": lock_minutes, "inc": inc},
        )
        if row and from_status != to_status:
            self.event(row["listing_id"], from_status, to_status, None)
        return row

    def reclaim_stale(self, working_status: str, back_to: str, lock_minutes: int = 10) -> int:
        """A worker died mid-item: put items stuck in a working status back in the queue."""
        rows = self.q(
            """update assets set status = %s::asset_status, locked_by = null, locked_at = null, updated_at = now()
               where status = %s::asset_status and locked_at < now() - make_interval(mins => %s)
               returning listing_id""",
            (back_to, working_status, lock_minutes))
        for r in rows:
            self.event(r["listing_id"], working_status, back_to, "stale lock reclaimed")
        return len(rows)

    def advance(self, listing_id: int, from_status: str, to_status: str, note: str | None = None, **cols: Any) -> None:
        sets = ["status = %(to)s::asset_status", "locked_by = null", "locked_at = null", "updated_at = now()",
                "next_attempt_at = null"]
        params: dict[str, Any] = {"to": to_status, "id": listing_id}
        for k, v in cols.items():
            sets.append(f"{k} = %({k})s")
            params[k] = Jsonb(v) if isinstance(v, (dict, list)) else v
        self.x(f"update assets set {', '.join(sets)} where listing_id = %(id)s", params)
        self.event(listing_id, from_status, to_status, note)

    def fail(self, listing_id: int, from_status: str, where: str, message: str, *, retry_to: str | None = None,
             max_attempts: int = 3, code: str | None = None, permanent: bool = False) -> str:
        """Failure path: retry with backoff up to max_attempts total, then dead-letter as 'failed'."""
        row = self.one("select attempts from assets where listing_id = %s", (listing_id,))
        attempts = row["attempts"] if row else max_attempts
        self.error(where, message, listing_id=listing_id, code=code)
        if retry_to and not permanent and attempts < max_attempts:
            delay = 30 * (2 ** max(0, attempts - 1))  # 30s, 60s, 120s
            self.x("""update assets set status = %s::asset_status, last_error = %s, locked_by = null, locked_at = null,
                      next_attempt_at = now() + make_interval(secs => %s), updated_at = now() where listing_id = %s""",
                   (retry_to, str(message)[:1000], delay, listing_id))
            self.event(listing_id, from_status, retry_to, f"retry {attempts}/{max_attempts}: {message}"[:500])
            return retry_to
        self.x("""update assets set status = 'failed', last_error = %s, locked_by = null, locked_at = null,
                  updated_at = now() where listing_id = %s""", (str(message)[:1000], listing_id))
        self.event(listing_id, from_status, "failed", str(message)[:500])
        return "failed"

    def release_locks(self) -> int:
        """Graceful shutdown: give back anything this worker still holds."""
        return self.x("update assets set locked_by = null, locked_at = null where locked_by = %s", (WORKER_ID,))


def vec(values: list[float] | None) -> str | None:
    """pgvector literal."""
    if values is None:
        return None
    return "[" + ",".join(f"{float(v):.6f}" for v in values) + "]"


def jsonb(v: Any) -> Jsonb:
    return Jsonb(v)
