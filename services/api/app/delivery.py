"""Delivery model from punches (migration 066).

The export's CFO-curated `is_self_perform` flag (docs/finance-reference-source.md) is the only other source of
core.dim_job.delivery_model, and the WinTeam API has no delivery field, so a site Crane staffs itself stayed
'subcontracted' as long as the export said so (LGB3, BDL3/7 in Sarus). Hours are the evidence: a site with its
own punches is self-performed.

Setting delivery_from_hours = {"weeks": 8, "min_hours": 40}. A current job with at least `min_hours` punched in
the last `weeks` weeks (any timekeeping source, as mart.v_timekeeping_effective resolves them) becomes
'self_perform'. A job without punches keeps its label, so the real subcontractors stay as they are. `weeks` 0
turns the rule off. Applied at the start of every mart rebuild, before the marts read the label, so it also
reapplies after a reference reload restores the export's flags.
"""
from __future__ import annotations

from typing import Any

SETTING = "delivery_from_hours"
DEFAULT = {"weeks": 8, "min_hours": 40}

SQL = """
UPDATE core.dim_job j SET delivery_model = 'self_perform', warehouse_updated_at = now()
FROM (
  SELECT t.job_key FROM mart.v_timekeeping_effective t
  WHERE t.work_date > current_date - %(days)s AND t.work_date <= current_date
  GROUP BY t.job_key HAVING sum(t.hours) >= %(min_hours)s
) w
WHERE j.job_key = w.job_key AND j.valid_to IS NULL AND j.delivery_model IS DISTINCT FROM 'self_perform'
RETURNING j.company, j.job_number, j.job_name
"""


def config(value: Any) -> tuple[int, float]:
    """(weeks, min_hours) from the setting; the defaults where it is missing or malformed."""
    value = value if isinstance(value, dict) else {}
    try:
        weeks = int(value.get("weeks", DEFAULT["weeks"]))
    except (TypeError, ValueError):
        weeks = DEFAULT["weeks"]
    try:
        min_hours = float(value.get("min_hours", DEFAULT["min_hours"]))
    except (TypeError, ValueError):
        min_hours = DEFAULT["min_hours"]
    return max(0, weeks), max(0.0, min_hours)


def apply(cursor: Any) -> list[dict[str, Any]]:
    """Mark worked sites self-performed; returns the jobs that changed."""
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = %s", (SETTING,))
    row = cursor.fetchone()
    weeks, min_hours = config(row["value"] if row else None)
    if weeks == 0:
        return []
    cursor.execute(SQL, {"days": weeks * 7, "min_hours": min_hours})
    return list(cursor.fetchall())
