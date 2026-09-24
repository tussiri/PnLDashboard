"""Pure tests of the read-time parent-billing split (no database)."""
from __future__ import annotations

from app.routers.leadership import allocate_parent_billing


def row(job, role, revenue=0.0, bh=0.0, hours_rm=0.0, hours=10.0, account="crowley-isd", allocation="budget_hours", week="2026-09-14"):
    return {"account_slug": account, "week_start": week, "company": "Crane Southwest", "job_number": job, "role": role,
            "revenue_month_amount": revenue, "prior_revenue": revenue, "revenue_allocated": 0, "hours": hours,
            "_allocation": allocation, "_rm_budget_hours": bh, "_rm_hours": hours_rm}


def test_spreads_by_budget_hours_and_preserves_the_total():
    rows = allocate_parent_billing([row("112", "catch_all", 159235.40), row("114", "site", bh=100), row("115", "site", bh=300)])
    assert [r["revenue_month_amount"] for r in rows] == [0, 39808.85, 119426.55]
    assert rows[0]["revenue_allocated"] == -159235.40 and rows[1]["revenue_allocated"] == 39808.85
    assert sum(r["revenue_month_amount"] for r in rows) == 159235.40
    assert rows[2]["prior_revenue"] == 119426.55
    assert all(not any(k.startswith("_") for k in r) for r in rows)


def test_falls_back_to_actual_hours_without_budget():
    rows = allocate_parent_billing([row("910", "catch_all", 373252.0), row("911", "site", hours_rm=100), row("918", "site", hours_rm=300)])
    assert [r["revenue_month_amount"] for r in rows] == [0, 93313.0, 279939.0]
    assert {r["allocation_weight"] for r in rows} == {"actual_hours"}


def test_leaves_accounts_whose_sites_bill_themselves_alone():
    rows = allocate_parent_billing([row("800", "catch_all", 1000.0), row("801", "site", revenue=12642.0, bh=45.8), row("802", "site", bh=65)])
    assert [r["revenue_month_amount"] for r in rows] == [1000.0, 12642.0, 0]


def test_applies_only_to_opted_in_accounts():
    rows = allocate_parent_billing([row("910", "catch_all", 500.0, allocation="none"), row("911", "site", bh=10, allocation="none")])
    assert [r["revenue_month_amount"] for r in rows] == [500.0, 0]
