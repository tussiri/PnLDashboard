"""The labor hours report (docs/api-contract.md "Labor hours report"). Permission report.labor-hours; see main.py."""
from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from .. import labor_hours
from ..common import allowed_accounts
from ..db import connection

router = APIRouter(prefix="/labor-hours")


@router.get("")
def labor_hours_report(request: Request,
                       date_from: date | None = Query(None, description="First work date; default the last complete week"),
                       date_to: date | None = Query(None, description="Last work date")) -> dict[str, Any]:
    default_from, default_to = labor_hours.default_range(date.today())
    start, end = date_from or default_from, date_to or default_to
    try:
        labor_hours.validate_range(start, end)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    with connection() as conn, conn.cursor() as cursor:
        return labor_hours.report(cursor, start, end, allowed_accounts(request))
