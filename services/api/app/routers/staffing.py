"""Staffing routes (docs/api-contract.md "Staffing requests").

`/staffing/jobs/...` serves the PhotoValidation request lines held in core.fact_staffing_request for one
site, with the week's requested and pending headcount computed by the same rule as mart.job_week
(app/staffing.py), and the week's HrDashboard figures from core.hr_site_staffing_week
(app/sources/hrdashboard.py). It needs data.staffing: the lines carry requested pay rates.

`/staffing/sites` serves only the HrDashboard figures (site counts, no people, no pay) for every site
of one account, for the account's Sites table. It needs tab.sites and the account in the user's scope.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import permissions, staffing
from ..common import jsonable, require_account, source_block
from ..config import settings
from ..db import connection
from ..sources import hrdashboard

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
        hr = hrdashboard.job_week(cursor, job["job_key"], anchor)
    demand = staffing.demand_at(lines, staffing.week_moment(anchor, now)) if loaded else {"requested_headcount": None, "pending_requested_headcount": None}
    return {
        "source": source_block(),
        "configured": settings.photovalidation_configured,
        "as_of": jsonable(pulled),
        "week": anchor.isoformat(),
        **demand,
        "lines": [line_out(line, now) for line in lines],
        "hr": {"configured": hrdashboard.configured(), **(jsonable(dict(hr)) if hr else {})},
    }


@router.get("/sites", dependencies=[Depends(permissions.require_permission("tab.sites"))])
def account_sites(account: str = Query(..., description="An account slug"),
                  week: str | None = Query(None, description="Any date in the week; default this week"),
                  request: Request = None) -> dict[str, Any]:  # type: ignore[assignment]
    """The week's HrDashboard figures for each of the account's jobs, on the drawer's rule
    (hrdashboard.job_week). Every job of the account is listed; one HR has nothing for carries nulls."""
    if request is not None:
        require_account(request, account)
    anchor = parse_week(week) or monday(datetime.now(timezone.utc).date())
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT 1 FROM ops.account WHERE slug = %s", (account,))
        if cursor.fetchone() is None:
            raise HTTPException(status_code=404, detail=f"Unknown account {account!r}")
        cursor.execute(hrdashboard.ACCOUNT_SITES_SQL, {"account": account, "week": anchor})
        sites = [jsonable(dict(r)) for r in cursor.fetchall()]
    return {"account": account, "week": anchor.isoformat(), "configured": hrdashboard.configured(), "sites": sites}
