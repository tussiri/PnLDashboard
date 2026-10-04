"""Background worker: the nightly sync, the interval schedules, and a mart rebuild when the marts are empty.

* app.nightly (approved 2026-09-23): the full incremental sync off hours (ops.app_setting
  `nightly_sync`, default 02:30 America/Chicago) that also loads the import inbox and rebuilds the marts.
* app.schedule (approved 2026-09-29): a light WinTeam timekeeping sync every
  WINTEAM_SYNC_INTERVAL_MINUTES (default 30, 0 = off) under the on-demand sync's throttles, and the
  PhotoValidation staffing-request pull every PV_SYNC_INTERVAL_MINUTES (default 15, 0 = off).
Administrators can still sync on demand from the Admin view or POST /api/v1/integrations/winteam/sync;
every WinTeam sync holds one advisory lock, so none of them overlap.

The worker also reads the reports mailbox for report exports (app/mail_inbox.py), every
`every_minutes` of ops.app_setting 'mail_inbox' (default 30): that reads Microsoft Graph, not WinTeam.

On startup the worker also rebuilds the marts if core facts exist but mart.job_month is empty (for
example after a fresh mart migration), then checks the schedules once a minute until SIGTERM/SIGINT.
Each check is isolated: a failure is logged and the worker carries on.
"""
from __future__ import annotations

import logging
import signal
import time

from . import mail_inbox, marts, nightly, schedule
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
    for name, check in (("Nightly", nightly.check_and_run), ("WinTeam interval", schedule.run_winteam_light),
                        ("PhotoValidation interval", schedule.run_photovalidation),
                        ("Reports mailbox", mail_inbox.check_and_poll)):
        try:
            check()
        except Exception:  # noqa: BLE001 - a failed check must not stop the worker
            logger.exception("%s schedule check failed", name)


def run() -> None:
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    logger.info("Worker started; WinTeam syncs nightly (ops.app_setting nightly_sync), every %s min (timekeeping; 0 = off) "
                "and on demand; PhotoValidation every %s min (%s)", settings.winteam_sync_interval_minutes,
                settings.pv_sync_interval_minutes, "configured" if settings.photovalidation_configured else "not configured")
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
