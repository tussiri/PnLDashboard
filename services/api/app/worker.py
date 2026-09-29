"""Background worker: the nightly sync, and a mart rebuild when the marts are empty.

WinTeam is called on a schedule once a day only, by app.nightly (approved 2026-09-23): an
incremental sync off hours (ops.app_setting `nightly_sync`, default 02:30 America/Chicago) that
also loads the export files in the import inbox and rebuilds the marts once. Administrators can
still sync on demand from the Admin view or POST /api/v1/integrations/winteam/sync. Nothing polls
WinTeam more often than that.

The worker also reads the records mailbox for report exports (app/mail_inbox.py), every
`every_minutes` of ops.app_setting 'mail_inbox' (default 30): that reads Microsoft Graph, not WinTeam.

On startup the worker also rebuilds the marts if core facts exist but mart.job_month is empty (for
example after a fresh mart migration), then checks both schedules once a minute until SIGTERM/SIGINT.
"""
from __future__ import annotations

import logging
import signal
import time

from . import mail_inbox, marts, nightly
from .config import settings

logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("worker")
running = True
CHECK_EVERY_SECONDS = 60


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


def tick() -> None:
    try:
        nightly.check_and_run()
    except Exception:  # noqa: BLE001 - a failed check must not stop the worker
        logger.exception("Nightly schedule check failed")
    try:
        mail_inbox.check_and_poll()
    except Exception:  # noqa: BLE001
        logger.exception("Records mailbox check failed")


def run() -> None:
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    logger.info("Worker started; WinTeam syncs nightly (ops.app_setting nightly_sync) and on demand")
    rebuild_on_startup()
    last_check = 0.0
    while running:
        if time.monotonic() - last_check >= CHECK_EVERY_SECONDS:
            last_check = time.monotonic()
            tick()
        time.sleep(5)
    logger.info("Worker stopped")


if __name__ == "__main__":
    run()
