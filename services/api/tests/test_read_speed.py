"""Dashboard reads stay fast and are never blocked by a mart rebuild (no database)."""
from __future__ import annotations

import inspect

from app import leadership, marts, weekly
from app.routers import leadership as leadership_routes


def flat(sql: str) -> str:
    return " ".join(sql.split())


def test_rebuild_empties_the_marts_without_truncate():
    # TRUNCATE holds ACCESS EXCLUSIVE until commit: every read of mart.*, /system/status included,
    # waited out the rebuild and the browser fell back to demo data.
    for fn in (marts.rebuild_tables, weekly.rebuild, leadership.rebuild):
        source = inspect.getsource(fn)
        assert 'execute("TRUNCATE' not in source, fn.__qualname__
        assert 'execute("DELETE FROM mart.' in source, fn.__qualname__
    assert "pg_advisory_xact_lock" in inspect.getsource(marts.rebuild_tables)


def test_run_rate_is_joined_once_not_per_row():
    s = flat(leadership_routes.ROW_SQL)
    assert "LATERAL (" not in s.split("SELECT w.week_start", 1)[1]
    assert "generate_series(" not in s
    assert "LEFT JOIN rr ON rr.job_key = w.job_key AND rr.revenue_month = w.revenue_month" in s
