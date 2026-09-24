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


def test_relay_lines_merge_without_duplicates():
    from app.routers.leadership import merge_relay_lines

    winteam = [{"vendor_number": 1140, "invoice_number": "163040", "invoice_date": "2026-08-31", "amount": 6959.19}]
    relay_lines = [
        {"vendor_number": "1140", "invoice_number": "163040", "invoice_date": "2026-08-02", "amount": 6959.19},
        {"vendor_number": "1140", "invoice_number": "165001", "invoice_date": "2026-09-20", "amount": 7010.00},
    ]
    merged = merge_relay_lines(winteam, relay_lines)
    assert [(l["invoice_number"], l["source"]) for l in merged] == [("165001", "relay"), ("163040", "winteam")]


def test_relay_payable_filed_under_another_number_is_not_repeated():
    from app.routers.leadership import merge_relay_lines

    winteam = [{"vendor_number": 1140, "invoice_number": "INV-7701", "invoice_date": "2026-08-31", "amount": 7010.00, "job_number": "479"}]
    relay_lines = [
        # Relay says it is in WinTeam; WinTeam holds it as INV-7701: same job, vendor, amount, 20 days apart.
        {"vendor_number": "1140", "invoice_number": "FXG4790001", "invoice_date": "2026-08-11", "amount": 7010.00, "in_winteam": True, "job_number": "479"},
        # Next month's identical fixed amount, not yet in WinTeam: kept.
        {"vendor_number": "1140", "invoice_number": "7788", "invoice_date": "2026-09-20", "amount": 7010.00, "in_winteam": False, "job_number": "479"},
        # Same number with different punctuation: already posted.
        {"vendor_number": "1140", "invoice_number": "inv 7701", "invoice_date": "2026-08-02", "amount": 7010.00, "in_winteam": False, "job_number": "479"},
    ]
    merged = merge_relay_lines(winteam, relay_lines)
    assert [(l["invoice_number"], l["source"]) for l in merged] == [("7788", "relay"), ("INV-7701", "winteam")]
