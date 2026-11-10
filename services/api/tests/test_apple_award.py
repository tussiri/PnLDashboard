"""The store award import, subregions from addresses and the current-month invoice (no database)."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

from app import award, month
from app.routers import leadership

MIGRATION = Path(__file__).resolve().parents[3] / "database" / "migrations" / "071_apple_award_regions.sql"
HEADER = ["Store #", "Store Name", "State/Province", "Postal Code", "Cost per Hour (Bill Rate)", "Hours per day", "Hours per Month", "Revenue per Month", "Tax"]


def test_reads_every_award_sheet_and_keeps_a_stores_first_row():
    index = [["Apple Tentative Award"], [], ["Tab", "Model", "Stores"]]
    all_stores = [HEADER, ["R550", "Valley Plaza", "California", 93304, 27.82, 10, 303.1, 8432.24, 0],
                  ["R087", "Aventura", "Florida", 33180, 21.4, 9, 346.4, 7412.96, 518.9], [None] * 9]
    provider = [["Self Perform"], HEADER, ["R550", "Valley Plaza", "California", 93304, 30, 10, 1, 1, 0], ["Total", None, None, None, None, None, None, 99, None]]
    stores, errors, read = award.parse([index, all_stores, provider])
    assert [s["store"] for s in stores] == ["R550", "R087"]
    assert stores[0] == {"store": "R550", "name": "Valley Plaza", "monthly_amount": Decimal("8432.24"), "nte_hours": Decimal("303.1"),
                         "bill_rate": Decimal("27.82"), "effective_from": None}
    assert errors == [] and read == 4


def test_needs_a_store_and_a_monthly_revenue_column():
    assert award._columns(HEADER) is not None
    assert award._columns(["Store #", "Hours per Month"]) is None
    _, errors, _ = award.parse([[HEADER, ["R001", "x", "CA", 1, 20, 1, 1, None, 0]]])
    assert errors == ["R001: no revenue per month"]


def test_matches_stores_to_winteam_jobs_by_the_code_in_the_name():
    stores = [{"store": "R550", "monthly_amount": Decimal("8432.24"), "nte_hours": Decimal("303.1"), "bill_rate": Decimal("27.82"), "effective_from": None},
              {"store": "R999", "monthly_amount": Decimal("1"), "nte_hours": None, "bill_rate": None, "effective_from": date(2026, 12, 1)}]
    jobs = [{"company": "Crane IFS", "job_number": 6550, "job_name": "Apple - R550 - Valley Plaza", "date_to_start": datetime(2026, 11, 1)},
            {"company": "Crane IFS", "job_number": 501, "job_name": "Amazon - LGB3", "date_to_start": None}]
    records, missing = award.match(stores, jobs, date(2026, 11, 10))
    assert missing == ["R999"]
    assert records == [{"company": "Crane IFS", "job_number": "6550", "effective_from": date(2026, 11, 1), "period": date(2026, 11, 1),
                        "monthly_amount": Decimal("8432.24"), "nte_hours": Decimal("303.1"), "bill_rate": Decimal("27.82"), "store": "R550"}]
    # Without a start date or an Effective From column, the award starts in the upload's month.
    records, _ = award.match(stores[:1], [{**jobs[0], "date_to_start": None}], date(2026, 11, 10))
    assert records[0]["effective_from"] == date(2026, 11, 1)


def test_reads_use_the_subregion_rule_and_segment_in_effect():
    s = " ".join(leadership.ROW_SQL.split())
    assert "ops.segment_in_effect(aj.account_slug, aj.role, aj.segment, ops.site_subregion(" in s
    assert "AS contract_nte_hours" in s and "cm.ar AS _current_ar" in s
    assert "ops.segment_in_effect(aj.account_slug, aj.role, aj.segment, v.subregion) AS segment" in " ".join(month.ACCOUNTS_SQL.split())


def test_apple_california_splits_at_zip_93600():
    sql = MIGRATION.read_text()
    assert "('CA', '90000', '93599', 'SoCal', 1), ('CA', '93600', '96199', 'NorCal', 2)" in sql
    assert "('FL', NULL, NULL, 'Florida', 3), ('GA', NULL, NULL, 'Georgia', 4)" in sql
    assert "invoice_basis = 'contract', revenue_divisor = 4.33" in sql


def row(job, role, revenue, ar=None, account="crowley-isd", week="2026-11-02"):
    return {"account_slug": account, "week_start": week, "job_number": job, "role": role, "revenue_month_amount": revenue, "_current_ar": ar}


def test_parent_billed_current_month_is_spread_by_revenue_month_billing():
    rows = leadership.spread_current_month([row("910", "catch_all", 14852.38, 392423.0), row("911", "site", 8885.78),
                                            row("918", "site", 25575.0), row("948", "site", 0)])
    shares = [r["current_month_invoice"] for r in rows]
    assert shares[3] is None
    assert round(sum(s for s in shares if s), 2) == 392423.0
    assert shares[1] == round(392423.0 * 8885.78 / (14852.38 + 8885.78 + 25575.0), 2)
    assert all("_current_ar" not in r for r in rows)


def test_sites_with_their_own_current_month_keep_it():
    rows = leadership.spread_current_month([row("1", "site", 100, 50.0), row("2", "site", 100, None), row("3", None, 10, 7.0, account=None)])
    assert [r["current_month_invoice"] for r in rows] == [50.0, None, 7.0]
