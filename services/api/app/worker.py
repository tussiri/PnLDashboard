"""Background worker. It never calls WinTeam.

WinTeam is synced on demand only - by an administrator from the Admin view or through
POST /api/v1/integrations/winteam/sync (and /integrations/winteam/sarus/sync). Nothing polls it:
the warehouse keeps every payload it has fetched (raw.winteam_record) and every normalized row, so
the dashboards read our own PostgreSQL and marts, and WinTeam is asked only when someone chooses to
refresh.

What the worker still does: on startup it rebuilds the marts if core facts exist but mart.job_month
is empty (for example after a fresh mart migration), then idles until SIGTERM/SIGINT.
"""
from __future__ import annotations

import logging
import signal
import time

from . import marts
from .config import settings

logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("worker")
running = True


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


def run() -> None:
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    logger.info("Worker started; WinTeam syncs run on demand only (no scheduled polling)")
    rebuild_on_startup()
    while running:
        time.sleep(5)
    logger.info("Worker stopped")


if __name__ == "__main__":
    run()
