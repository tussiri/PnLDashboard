"""Interval schedules the worker runs beside the nightly sync (approved 2026-09-29).

1. Light WinTeam sync, every WINTEAM_SYNC_INTERVAL_MINUTES (default 30; 0 = off): the same
   `sync_all` the Admin button calls, restricted to LIGHT_RESOURCES and never forced, so every
   throttle of the on-demand sync still applies - timekeeping re-reads WINTEAM_LOOKBACK_DAYS (3)
   before its last sync; jobs are re-read at most once per 20 hours (DAILY_RESOURCES); vendors,
   budgets, AR and AP are left to the nightly run. The primary database and, when
   WINTEAM_SARUS_ENABLED, Sarus are synced, then the marts are rebuilt once (as the Admin sync does)
   when anything was normalized. A database is due when its last timekeeping sync - scheduled,
   nightly or from Admin - started at least one interval ago.
2. PhotoValidation staffing requests, every PV_SYNC_INTERVAL_MINUTES (default 15; 0 = off), when
   PHOTOVALIDATION_API_URL and PHOTOVALIDATION_API_TOKEN are set. A pull refreshes the requested
   headcount on mart.job_week itself; it does not rebuild the marts.

Overlap: every WinTeam sync (this schedule, the nightly run and the Admin routes) holds the session
advisory lock WINTEAM_SYNC_LOCK for its duration; one that cannot take it is skipped (worker) or
answered 409 (Admin). The PhotoValidation pull has its own lock. A lock session is autocommit and
idle while it waits, so it holds no row or table locks.
"""
from __future__ import annotations

import logging
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

from .config import settings
from .db import connection

logger = logging.getLogger("schedule")

WINTEAM_SYNC_LOCK = 7_211_001
PV_SYNC_LOCK = 7_211_002
LIGHT_RESOURCES = ("jobs", "timekeeping")
TIMEKEEPING = "timekeeping"


class SyncBusy(RuntimeError):
    """Another sync holds the lock."""


def interval_due(interval_minutes: int, last_started: datetime | None, now: datetime | None = None) -> bool:
    """True when the schedule is on (interval > 0) and the last run started at least one interval ago."""
    if interval_minutes <= 0:
        return False
    if last_started is None:
        return True
    return (now or datetime.now(timezone.utc)) - last_started >= timedelta(minutes=interval_minutes)


def light_resources(enabled: Sequence[str]) -> list[str]:
    """LIGHT_RESOURCES the connector has enabled, in catalogue order; empty when timekeeping is off."""
    chosen = [name for name in LIGHT_RESOURCES if name in enabled]
    return chosen if TIMEKEEPING in chosen else []


def sync_mode(ingesting: bool = True) -> dict[str, Any]:
    """The integration status fields: `sync` 'scheduled' with `poll_seconds` while the interval is on
    for a database configured for ingestion, else 'on_demand' with None."""
    minutes = settings.winteam_sync_interval_minutes if ingesting else 0
    return {"sync": "scheduled" if minutes > 0 else "on_demand", "poll_seconds": minutes * 60 if minutes > 0 else None}


@contextmanager
def advisory_lock(key: int) -> Iterator[bool]:
    """Try the session advisory lock `key`; yields whether it was taken and releases it on exit."""
    with connection(autocommit=True) as conn:
        with conn.cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_lock(%s) AS got", (key,))
            got = bool(cursor.fetchone()["got"])
        try:
            yield got
        finally:
            if got:
                with conn.cursor() as cursor:
                    cursor.execute("SELECT pg_advisory_unlock(%s)", (key,))


@contextmanager
def winteam_sync_guard() -> Iterator[None]:
    """For the Admin sync routes: raises SyncBusy while another WinTeam sync runs."""
    with advisory_lock(WINTEAM_SYNC_LOCK) as got:
        if not got:
            raise SyncBusy("A WinTeam sync is already running; try again when it finishes")
        yield


def last_started(integration: str, resource: str | None = None) -> datetime | None:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT max(started_at) AS at FROM ops.integration_sync_run
            WHERE integration_name = %s AND (%s::text IS NULL OR resource_name = %s)
            """,
            (integration, resource, resource),
        )
        row = cursor.fetchone()
    return row["at"] if row else None


def winteam_targets() -> list[tuple[str, Any]]:
    """(label, connector) for each WinTeam database configured for ingestion."""
    from .winteam import sarus_ingestion, winteam

    targets: list[tuple[str, Any]] = []
    if settings.winteam_enabled and settings.winteam_configured:
        targets.append(("winteam", winteam))
    if settings.winteam_sarus_enabled and settings.winteam_sarus_configured:
        targets.append(("sarus", sarus_ingestion()))
    return targets


def run_winteam_light(now: datetime | None = None) -> dict[str, Any] | None:
    """One light sync of every due database, then one mart rebuild; None when nothing is due. Never raises."""
    minutes = settings.winteam_sync_interval_minutes
    if minutes <= 0:
        return None
    due = []
    for label, connector in winteam_targets():
        resources = light_resources(connector.config.winteam_resources)
        if resources and interval_due(minutes, last_started(connector.tenant.integration, TIMEKEEPING), now):
            due.append((label, connector, resources))
    if not due:
        return None
    from . import marts

    summary: dict[str, Any] = {"status": "succeeded", "databases": {}, "errors": [], "marts": None}
    with advisory_lock(WINTEAM_SYNC_LOCK) as got:
        if not got:
            logger.info("Scheduled WinTeam sync skipped: another WinTeam sync is running")
            return {"status": "busy"}
        rebuild = False
        for label, connector, resources in due:
            try:
                result = connector.sync_all(resources=resources, rebuild=False)
            except Exception as exc:  # noqa: BLE001 - one database failing must not stop the other
                logger.exception("Scheduled WinTeam sync of %s failed", label)
                summary["errors"].append(f"{label}: {str(exc)[:300]}")
                continue
            runs = result.get("runs") or []
            summary["databases"][label] = {r["resource"]: r["status"] for r in runs}
            summary["errors"].extend(f"{label} {r['resource']}: {r.get('error')}" for r in runs if r.get("status") == "failed" and r.get("entitled") is not False)
            rebuild = rebuild or (bool(result.get("normalized")) and any(r.get("status") != "skipped" for r in runs))
        if rebuild:
            try:
                summary["marts"] = marts.rebuild_all(initiated_by="winteam-interval").get("seconds")
            except Exception as exc:  # noqa: BLE001
                logger.exception("Mart rebuild after the scheduled WinTeam sync failed")
                summary["errors"].append(f"marts: {str(exc)[:300]}")
    if summary["errors"]:
        summary["status"] = "failed"
    logger.info("Scheduled WinTeam sync %s: %s; marts rebuilt in %ss%s", summary["status"], summary["databases"], summary["marts"],
                f"; errors: {summary['errors']}" if summary["errors"] else "")
    return summary


def run_photovalidation(now: datetime | None = None) -> dict[str, Any] | None:
    """One PhotoValidation pull when due; None when off, unconfigured or not due. Never raises."""
    from .sources import photovalidation

    minutes = settings.pv_sync_interval_minutes
    if minutes <= 0 or not photovalidation.configured():
        return None
    if not interval_due(minutes, last_started(photovalidation.INTEGRATION), now):
        return None
    with advisory_lock(PV_SYNC_LOCK) as got:
        if not got:
            logger.info("Scheduled PhotoValidation pull skipped: another pull is running")
            return {"status": "busy"}
        try:
            return photovalidation.sync()
        except Exception as exc:  # noqa: BLE001
            logger.exception("Scheduled PhotoValidation pull failed")
            return {"status": "failed", "error": str(exc)[:300]}
