from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

import psycopg
from psycopg.rows import dict_row

from .config import settings


def session_options(idle_in_transaction_timeout_ms: int | None = None, lock_timeout_ms: int | None = None) -> str:
    """libpq `options` string applying per-session GUCs, or "" when none are requested.

    Passed at connect time so the GUCs are in force before the first statement (a `SET` would
    itself have to run inside the transaction it is meant to protect). A value of 0 or None
    leaves the server default in place.
    """
    parts: list[str] = []
    if idle_in_transaction_timeout_ms:
        parts.append(f"-c idle_in_transaction_session_timeout={int(idle_in_transaction_timeout_ms)}")
    if lock_timeout_ms:
        parts.append(f"-c lock_timeout={int(lock_timeout_ms)}")
    return " ".join(parts)


@contextmanager
def connection(
    *,
    autocommit: bool = False,
    idle_in_transaction_timeout_ms: int | None = None,
    lock_timeout_ms: int | None = None,
) -> Iterator[psycopg.Connection]:
    """Open a connection to the application database.

    autocommit=True is for sessions that interleave DB work with slow non-DB work (HTTP fetches in
    the ingestion loop): every statement stands alone, so the session is never left `idle in
    transaction` holding locks while something else is waiting. Such callers wrap multi-statement
    writes in `conn.transaction()` explicitly. The timeouts are backstops, not the fix: see
    `session_options`.
    """
    connect_args = (
        {"conninfo": settings.database_url}
        if settings.database_url
        else {
            "host": settings.db_host,
            "port": settings.db_port,
            "dbname": settings.db_name,
            "user": settings.db_user,
            "password": settings.db_password,
        }
    )
    options = session_options(idle_in_transaction_timeout_ms, lock_timeout_ms)
    if options:
        connect_args["options"] = options
    with psycopg.connect(**connect_args, autocommit=autocommit, row_factory=dict_row) as conn:
        yield conn


@contextmanager
def reference_connection() -> Iterator[psycopg.Connection]:
    """Read-only connection to the finance_reference database (the restored Finance_Dashboard dump).

    Raises RuntimeError when FINANCE_REFERENCE_DATABASE_URL is not configured. The session is set
    read-only so a coding mistake can never write to the reference database.
    """
    if not settings.finance_reference_database_url:
        raise RuntimeError("FINANCE_REFERENCE_DATABASE_URL is not configured")
    with psycopg.connect(settings.finance_reference_database_url, row_factory=dict_row) as conn:
        conn.read_only = True
        yield conn


def database_ready() -> bool:
    try:
        with connection() as conn, conn.cursor() as cursor:
            cursor.execute("SELECT 1")
            return cursor.fetchone() is not None
    except psycopg.Error:
        return False
