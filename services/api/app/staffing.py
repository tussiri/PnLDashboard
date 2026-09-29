"""PhotoValidation staffing requests in the warehouse: job resolution, weekly demand, and reads.

Rows arrive in core.fact_staffing_request from app/sources/photovalidation.py (migration 041).

Weekly attribution
------------------
mart.job_week.requested_headcount / pending_requested_headcount hold the demand open at the END of
each week (at now() for the week in progress), rebuilt from the line timestamps rather than stamped
on the week a pull happened to run. So the week in progress always equals the spec's definition
(active = approved | posted, pending = submitted, as of now), past weeks keep the demand that was
open then, and a mart rebuild reproduces the same numbers. A line is:

* pending from submitted_at until it was decided (decided_at), or closed without a decision
  (closed_at: cancelled while submitted). A line that reached approval without any timestamp is
  never pending.
* active from its approval (decided_at, else posted_at, else submitted_at) until filled_at or
  closed_at, when it was approved: status approved, posted or filled, or cancelled after a decision
  (decided_at set). Rejected lines are never active.

Both sums use headcount_needed. `line_intervals` / `state_at` / `demand_at` are the pure mirror of
DEMAND_SQL and serve GET /staffing/jobs/{company}/{job_number}.
"""
from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)

ACTIVE_STATUSES = ("approved", "posted")
PENDING_STATUSES = ("submitted",)
OPEN_STATUSES = PENDING_STATUSES + ACTIVE_STATUSES
APPROVED_STATUSES = ("approved", "posted", "filled")
LINES_LIMIT = 200

# 'Crane' lines resolve through the primary tenant's map (never onto a Sarus row; the namespaced
# 'Crane:<n>' row covers a collision), 'Sarus' lines through mart.v_sarus_job_map.
RESOLVE_JOB_KEYS_SQL = """
WITH resolved AS (
  SELECT r.line_id,
         CASE r.winteam_company
           WHEN 'Crane' THEN coalesce(
             (SELECT a.job_key FROM mart.v_api_job_map a
               WHERE a.raw_job_number = r.winteam_job_number AND a.company IS DISTINCT FROM 'Sarus' LIMIT 1),
             (SELECT d.job_key FROM core.dim_job d
               WHERE d.valid_to IS NULL AND d.job_number = 'Crane:' || r.winteam_job_number LIMIT 1))
           WHEN 'Sarus' THEN
             (SELECT s.job_key FROM mart.v_sarus_job_map s WHERE s.raw_job_number = r.winteam_job_number LIMIT 1)
         END AS job_key
  FROM core.fact_staffing_request r
)
UPDATE core.fact_staffing_request r
SET job_key = x.job_key
FROM resolved x
WHERE r.line_id = x.line_id AND r.job_key IS DISTINCT FROM x.job_key
"""

DEMAND_SQL = """
WITH feed AS (SELECT EXISTS (SELECT 1 FROM core.fact_staffing_request) AS loaded),
lines AS (
  SELECT job_key, headcount_needed,
         submitted_at AS pending_from,
         coalesce(decided_at, closed_at, filled_at, posted_at,
                  CASE WHEN status <> 'submitted' THEN submitted_at END) AS pending_to,
         CASE WHEN status IN ('approved', 'posted', 'filled') OR (status = 'cancelled' AND decided_at IS NOT NULL)
              THEN coalesce(decided_at, posted_at, submitted_at) END AS active_from,
         coalesce(filled_at, closed_at) AS active_to
  FROM core.fact_staffing_request
  WHERE job_key IS NOT NULL AND headcount_needed > 0 AND submitted_at IS NOT NULL
),
demand AS (
  SELECT w.job_key, w.week_start,
         sum(l.headcount_needed) FILTER (WHERE l.active_from <= s.at AND (l.active_to IS NULL OR l.active_to > s.at)) AS active,
         sum(l.headcount_needed) FILTER (WHERE l.pending_from <= s.at AND (l.pending_to IS NULL OR l.pending_to > s.at)) AS pending
  FROM mart.job_week w
  JOIN lines l ON l.job_key = w.job_key
  CROSS JOIN LATERAL (SELECT least((w.week_start + 7)::timestamp AT TIME ZONE 'UTC', now()) AS at) s
  GROUP BY w.job_key, w.week_start
),
target AS (
  SELECT w.job_key, w.week_start,
         CASE WHEN f.loaded THEN coalesce(d.active, 0) END AS requested,
         CASE WHEN f.loaded THEN coalesce(d.pending, 0) END AS pending
  FROM mart.job_week w
  CROSS JOIN feed f
  LEFT JOIN demand d ON d.job_key = w.job_key AND d.week_start = w.week_start
)
UPDATE mart.job_week w
SET requested_headcount = t.requested, pending_requested_headcount = t.pending
FROM target t
WHERE w.job_key = t.job_key AND w.week_start = t.week_start
  AND (w.requested_headcount IS DISTINCT FROM t.requested OR w.pending_requested_headcount IS DISTINCT FROM t.pending)
"""

LINE_COLUMNS = """
  line_id, request_id, request_code, site_name, role, shift, shift_start, shift_end, headcount_needed, current_filled,
  reason, employment_type, hours_per_week, pay_rate, needed_by, status, hire_job_id, reported_headcount,
  submitted_at, decided_at, posted_at, filled_at, closed_at, updated_at
"""


def resolve_job_keys(cursor: Any) -> int:
    """Point every line at its current core.dim_job row (NULL when unmapped); returns rows changed."""
    cursor.execute(RESOLVE_JOB_KEYS_SQL)
    return max(cursor.rowcount, 0)


def apply_to_job_week(cursor: Any) -> int:
    """Refresh mart.job_week requested / pending headcount on the caller's transaction; returns rows changed."""
    cursor.execute(DEMAND_SQL)
    return max(cursor.rowcount, 0)


def refresh(cursor: Any) -> dict[str, int]:
    """Job resolution, then the weekly demand: after a pull, and at the end of every mart rebuild."""
    resolved = resolve_job_keys(cursor)
    weeks = apply_to_job_week(cursor)
    return {"job_keys_changed": resolved, "job_week_rows_changed": weeks}


# ── pure mirror of DEMAND_SQL ────────────────────────────────────────────────
def line_intervals(line: Mapping[str, Any]) -> tuple[datetime | None, datetime | None, datetime | None, datetime | None]:
    """(pending_from, pending_to, active_from, active_to); a None bound is open-ended, a None start never begins."""
    status = line.get("status")
    submitted = line.get("submitted_at")
    decided = line.get("decided_at")
    posted = line.get("posted_at")
    filled = line.get("filled_at")
    closed = line.get("closed_at")
    pending_to = next((v for v in (decided, closed, filled, posted) if v is not None), None)
    if pending_to is None and status != "submitted":
        pending_to = submitted
    approved = status in APPROVED_STATUSES or (status == "cancelled" and decided is not None)
    active_from = next((v for v in (decided, posted, submitted) if v is not None), None) if approved else None
    active_to = filled if filled is not None else closed
    return submitted, pending_to, active_from, active_to


def _inside(start: datetime | None, end: datetime | None, at: datetime) -> bool:
    return start is not None and start <= at and (end is None or end > at)


def state_at(line: Mapping[str, Any], at: datetime) -> str | None:
    """'active', 'pending' or None for one line at a moment."""
    if not line.get("headcount_needed") or line.get("submitted_at") is None:
        return None
    pending_from, pending_to, active_from, active_to = line_intervals(line)
    if _inside(active_from, active_to, at):
        return "active"
    if _inside(pending_from, pending_to, at):
        return "pending"
    return None


def week_moment(week_start: date, now: datetime | None = None) -> datetime:
    """The moment a week's demand is read at: the end of the week (Monday 00:00 UTC after it), or now for the week in progress."""
    end = datetime.combine(week_start + timedelta(days=7), time.min, tzinfo=timezone.utc)
    current = now or datetime.now(timezone.utc)
    return min(end, current)


def demand_at(lines: Iterable[Mapping[str, Any]], at: datetime) -> dict[str, int]:
    """{requested_headcount, pending_requested_headcount} over the lines at a moment."""
    out = {"requested_headcount": 0, "pending_requested_headcount": 0}
    for line in lines:
        state = state_at(line, at)
        if state == "active":
            out["requested_headcount"] += int(line["headcount_needed"])
        elif state == "pending":
            out["pending_requested_headcount"] += int(line["headcount_needed"])
    return out


def days_open(line: Mapping[str, Any], now: datetime | None = None) -> int | None:
    """Whole days from submission to fill or close (to now while the line is open)."""
    submitted = line.get("submitted_at")
    if submitted is None:
        return None
    end = line.get("filled_at") or line.get("closed_at") or (now or datetime.now(timezone.utc))
    return max(0, (end - submitted).days)


# ── reads ────────────────────────────────────────────────────────────────────
def job_lines(cursor: Any, job_key: int, limit: int = LINES_LIMIT) -> list[dict[str, Any]]:
    """A job's request lines: open lines first, then newest submission first."""
    cursor.execute(
        f"""
        SELECT {LINE_COLUMNS}
        FROM core.fact_staffing_request
        WHERE job_key = %s
        ORDER BY (status IN ('submitted', 'approved', 'posted')) DESC, submitted_at DESC NULLS LAST, line_id
        LIMIT %s
        """,
        (job_key, limit),
    )
    return [dict(r) for r in cursor.fetchall()]


def last_pull(cursor: Any) -> datetime | None:
    cursor.execute(
        "SELECT max(completed_at) AS at FROM ops.integration_sync_run WHERE integration_name = 'photovalidation' AND status = 'succeeded'"
    )
    row = cursor.fetchone()
    return row["at"] if row else None
