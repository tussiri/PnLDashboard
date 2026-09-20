"""Background ingestion worker.

Every WINTEAM_POLL_SECONDS the worker runs a full WinTeam sync (all enabled resources in dependency
order). With WINTEAM_NORMALIZE=true (default) each resource is then normalized into core and the
marts and forecasts are rebuilt; with WINTEAM_NORMALIZE=false only the raw landing runs (used while
the marts cannot yet arbitrate between the API and the finance_reference source). When WinTeam is
disabled it idles. On startup it rebuilds the marts if core facts exist but mart.job_month is empty
(for example after a fresh mart migration). SIGTERM/SIGINT stop the loop after the current resource
finishes.

Resources the tenant is not entitled to (HTTP 403, e.g. job_schedules and ap_payments) fail fast on
every poll; the worker warns the first time a resource reports `entitled: false` and again only when
it becomes entitled, so the log is not flooded every poll.

The sync loop never holds a database transaction across a WinTeam HTTP call (see winteam.py,
"Database sessions"): one slow fetch used to leave a session `idle in transaction` holding locks
on core.*, which stalled the mart rebuild and every reporting read behind it until the worker was
killed.
"""
from __future__ import annotations

import logging
import signal
import time
from typing import Any

from . import marts
from .config import settings
from .winteam import winteam

logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("worker")
running = True
reported_not_entitled: set[str] = set()


def stop(*_: object) -> None:
    global running
    running = False


def rebuild_on_startup() -> None:
    try:
        if marts.marts_empty_but_facts_exist():
            logger.info("mart.job_month is empty but core facts exist; rebuilding marts")
            marts.rebuild_all(initiated_by="worker-startup")
    except Exception:  # noqa: BLE001
        logger.exception("Startup mart rebuild failed")


def sleep_until_next_poll() -> None:
    slept = 0
    while running and slept < settings.poll_seconds:
        step = min(5, settings.poll_seconds - slept)
        time.sleep(step)
        slept += step


def report_outcome(outcome: dict[str, Any]) -> None:
    """Log one line per poll; entitlement failures once per resource until they recover."""
    not_entitled = {run["resource"] for run in outcome.get("runs", []) if run.get("entitled") is False}
    newly = sorted(not_entitled - reported_not_entitled)
    recovered = sorted(reported_not_entitled - not_entitled)
    if newly:
        logger.warning(
            "WinTeam resource(s) not entitled for this tenant (HTTP 403), skipping until entitled: %s", ", ".join(newly)
        )
    if recovered:
        logger.info("WinTeam resource(s) entitled again: %s", ", ".join(recovered))
    reported_not_entitled.difference_update(recovered)
    reported_not_entitled.update(newly)
    failed = [
        run["resource"] for run in outcome.get("runs", [])
        if run.get("status") != "succeeded" and run["resource"] not in not_entitled
    ]
    if failed:
        logger.warning("Scheduled sync finished with failures: %s", ", ".join(failed))


def run() -> None:
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    logger.info(
        "Worker started; WinTeam enabled=%s host=%s resources=%s poll=%ss normalize=%s",
        settings.winteam_enabled, settings.winteam_base_url_host, ",".join(settings.winteam_resources),
        settings.poll_seconds, settings.winteam_normalize,
    )
    rebuild_on_startup()
    while running:
        if settings.winteam_enabled:
            try:
                outcome = winteam.sync_all(normalize=settings.winteam_normalize)
                report_outcome(outcome)
            except Exception:  # noqa: BLE001
                logger.exception("Scheduled sync failed")
        sleep_until_next_poll()
    logger.info("Worker stopped")


if __name__ == "__main__":
    run()
