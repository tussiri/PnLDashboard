"""The migration runner waits for a database that is still starting (no database needed)."""
from __future__ import annotations

from contextlib import contextmanager

import psycopg
import pytest

from app import migrate


def fake_connection(fail_times: int):
    calls = {"n": 0}

    @contextmanager
    def connection():
        calls["n"] += 1
        if calls["n"] <= fail_times:
            raise psycopg.OperationalError("connection refused")

        class Cursor:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def execute(self, *a): return None

        class Conn:
            def cursor(self): return Cursor()
        yield Conn()
    return connection, calls


def test_retries_until_the_database_accepts(monkeypatch):
    connection, calls = fake_connection(fail_times=2)
    monkeypatch.setattr(migrate, "connection", connection)
    monkeypatch.setattr(migrate.time, "sleep", lambda s: None)
    migrate.wait_for_database(deadline_seconds=60, interval=1)
    assert calls["n"] == 3


def test_gives_up_after_the_deadline(monkeypatch):
    connection, _ = fake_connection(fail_times=10**6)
    monkeypatch.setattr(migrate, "connection", connection)
    monkeypatch.setattr(migrate.time, "sleep", lambda s: None)
    with pytest.raises(psycopg.OperationalError):
        migrate.wait_for_database(deadline_seconds=0, interval=1)
