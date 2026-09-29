"""The nightly sync (approved 2026-09-23): once a day, off hours, incremental.

Steps, each isolated so one failure does not stop the others:
  1. load every file in the import inbox (Pay Report / Job Cost exports, app/imports.py)
  2. WinTeam primary database: the same incremental sync as the Admin button (3-day lookback, masters
     and AR skipped when synced within 20 hours, unretrievable records remembered, 403 resources
     skipped) without its own mart rebuild
  3. Sarus, when WINTEAM_SARUS_ENABLED
  4. Relay's FedEx feeds, when RELAY_BASE_URL and RELAY_EXPORT_TOKEN are set (app/relay.py)
  5. one mart rebuild (marts, weekly leadership mart, account assignment, forecasts)

Schedule: ops.app_setting `nightly_sync` = {"enabled", "hour", "minute", "timezone", "window_hours",
"import_inbox", "winteam", "sarus"}. A run starts only inside the window after the run time, so a
worker that was down overnight skips that night rather than syncing during the working day. The worker checks `due` once a minute; a run is recorded in
ops.integration_sync_run (integration 'nightly'), which is how a day's run is not repeated after a
restart. Nothing here runs more than once a day. The light interval sync (app/schedule.py) and the
Admin routes share its advisory lock: while one of them runs, the nightly run waits for the next tick.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .config import settings
from .db import connection

logger = logging.getLogger("nightly")

DEFAULT_SCHEDULE: dict[str, Any] = {"enabled": True, "hour": 2, "minute": 30, "timezone": "America/Chicago", "window_hours": 3,
                                    "import_inbox": True, "winteam": True, "sarus": True, "relay": True}
INTEGRATION = "nightly"


def schedule_setting(cursor: Any) -> dict[str, Any]:
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = 'nightly_sync'")
    row = cursor.fetchone()
    value = row["value"] if row and isinstance(row["value"], dict) else {}
    return {**DEFAULT_SCHEDULE, **value}


def local_now(schedule: dict[str, Any], now: datetime | None = None) -> datetime:
    return (now or datetime.now(timezone.utc)).astimezone(ZoneInfo(str(schedule.get("timezone") or "America/Chicago")))


def due(schedule: dict[str, Any], last_run_local_date: date | None, now: datetime | None = None) -> bool:
    """True when the schedule is enabled, the local time is inside [run time, run time + window_hours)
    and no run has started today (local date). A night the worker missed is skipped, not caught up
    during the working day."""
    if not schedule.get("enabled"):
        return False
    local = local_now(schedule, now)
    run_at = local.replace(hour=int(schedule.get("hour", 2)), minute=int(schedule.get("minute", 30)), second=0, microsecond=0)
    window_end = run_at + timedelta(hours=float(schedule.get("window_hours", 3)))
    return run_at <= local < window_end and last_run_local_date != local.date()


def last_run_local_date(cursor: Any, schedule: dict[str, Any]) -> date | None:
    cursor.execute("SELECT max(started_at) AS at FROM ops.integration_sync_run WHERE integration_name = %s", (INTEGRATION,))
    row = cursor.fetchone()
    return local_now(schedule, row["at"]).date() if row and row["at"] else None


def _start(run_id: str, started: datetime) -> None:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            "INSERT INTO ops.integration_sync_run (id, integration_name, resource_name, status, started_at) VALUES (%s, %s, 'nightly', 'running', %s)",
            (run_id, INTEGRATION, started),
        )
        conn.commit()


def run_nightly(schedule: dict[str, Any] | None = None) -> dict[str, Any]:
    """Run every enabled step once; returns a summary. Never raises."""
    from . import imports, marts, relay
    from .winteam import sarus_ingestion, winteam

    if schedule is None:
        with connection() as conn, conn.cursor() as cursor:
            schedule = schedule_setting(cursor)
    started = datetime.now(timezone.utc)
    run_id = str(uuid.uuid4())
    summary: dict[str, Any] = {"steps": {}, "errors": [], "fetched": 0, "inserted": 0}
    _start(run_id, started)

    def step(name: str, fn: Any) -> None:
        try:
            result = fn()
            summary["steps"][name] = "ok"
            for r in (result or {}).get("runs", []) if isinstance(result, dict) else []:
                summary["fetched"] += r.get("fetched") or 0
                summary["inserted"] += r.get("inserted") or 0
        except Exception as exc:  # noqa: BLE001 - one step's failure must not stop the others
            logger.exception("Nightly step %s failed", name)
            summary["steps"][name] = "failed"
            summary["errors"].append(f"{name}: {str(exc)[:300]}")

    if schedule.get("import_inbox"):
        def scan() -> dict[str, Any]:
            with connection() as conn:
                files = imports.scan_inbox(conn, Path(settings.import_inbox_dir))
            summary["imports"] = [{"file": f.get("file_name"), "status": f.get("status")} for f in files]
            return {}
        step("import_inbox", scan)
    if schedule.get("winteam") and settings.winteam_enabled and settings.winteam_configured:
        step("winteam", lambda: winteam.sync_all(rebuild=False))
    if schedule.get("sarus") and settings.winteam_sarus_enabled and settings.winteam_sarus_configured:
        step("sarus", lambda: sarus_ingestion().sync_all(rebuild=False))
    if schedule.get("relay") and relay.configured():
        def pull_relay() -> dict[str, Any]:
            result = relay.sync()
            if result["failed"]:
                raise relay.RelayError(f"Relay feeds failed: {', '.join(result['failed'])}")
            return {}
        step("relay", pull_relay)
    step("marts", lambda: marts.rebuild_all(initiated_by="nightly"))

    # ops.integration_sync_run allows running | succeeded | failed: any failed step marks the run
    # failed, and error_message names the steps, so the views flag the data as possibly incomplete.
    status = "succeeded" if not summary["errors"] else "failed"
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            "UPDATE ops.integration_sync_run SET status = %s, completed_at = now(), records_fetched = %s, records_inserted = %s, error_message = %s WHERE id = %s",
            (status, summary["fetched"], summary["inserted"], json.dumps(summary["errors"]) if summary["errors"] else None, run_id),
        )
        conn.commit()
    logger.info("Nightly sync %s: %s", status, summary["steps"])
    return {"run_id": run_id, "status": status, **summary}


def check_and_run() -> dict[str, Any] | None:
    """Worker tick: run the nightly sync when it is due; None otherwise."""
    with connection() as conn, conn.cursor() as cursor:
        schedule = schedule_setting(cursor)
        last = last_run_local_date(cursor, schedule)
    if not due(schedule, last):
        return None
    from .schedule import WINTEAM_SYNC_LOCK, advisory_lock

    with advisory_lock(WINTEAM_SYNC_LOCK) as got:
        if not got:
            logger.info("Nightly sync waiting: another WinTeam sync is running")
            return None
        return run_nightly(schedule)
