"""Staffing request routes (docs/api-contract.md "Staffing requests").

Serves the PhotoValidation request lines held in core.fact_staffing_request for one site, with the
week's requested and pending headcount computed by the same rule as mart.job_week (app/staffing.py).
Analyst and admin roles only: the lines carry requested pay rates.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import permissions, staffing
from ..common import jsonable, source_block
from ..config import settings
from ..db import connection

router = APIRouter(prefix="/staffing")


def monday(value: date) -> date:
    return value - timedelta(days=value.weekday())


def parse_week(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return monday(date.fromisoformat(value[:10]))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"week must be an ISO date, got {value!r}") from exc


def line_out(line: dict[str, Any], now: datetime) -> dict[str, Any]:
    out = jsonable(dict(line))
    out["days_open"] = staffing.days_open(line, now)
    return out


@router.get("/jobs/{company}/{job_number}", dependencies=[Depends(permissions.require_permission("data.staffing"))])
def job_requests(company: str, job_number: str, week: str | None = Query(None, description="Any date in the week; default this week")) -> dict[str, Any]:
    """One site's request lines and the week's requested / pending headcount."""
    now = datetime.now(timezone.utc)
    anchor = parse_week(week) or monday(now.date())
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            "SELECT job_key FROM core.dim_job WHERE valid_to IS NULL AND company = %s AND job_number = %s",
            (company, job_number),
        )
        job = cursor.fetchone()
        if job is None:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_number} ({company})")
        lines = staffing.job_lines(cursor, job["job_key"])
        cursor.execute("SELECT EXISTS (SELECT 1 FROM core.fact_staffing_request) AS loaded")
        loaded = bool(cursor.fetchone()["loaded"])
        pulled = staffing.last_pull(cursor)
    demand = staffing.demand_at(lines, staffing.week_moment(anchor, now)) if loaded else {"requested_headcount": None, "pending_requested_headcount": None}
    return {
        "source": source_block(),
        "configured": settings.photovalidation_configured,
        "as_of": jsonable(pulled),
        "week": anchor.isoformat(),
        **demand,
        "lines": [line_out(line, now) for line in lines],
    }
