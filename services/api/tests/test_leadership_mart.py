"""Structural test of the mart.leadership_week rebuild SQL (no database): the INSERT column list and
the final SELECT list stay aligned, and every column exists in migration 030."""
from __future__ import annotations

import re
from pathlib import Path

from app.leadership import REBUILD_SQL

MIGRATIONS = Path(__file__).resolve().parents[3] / "database" / "migrations"
DDL_FILES = ("030_leadership_week.sql", "031_revenue_allocation_cost_basis.sql", "033_allocation_by_account.sql")


def _top_level_items(text: str) -> list[str]:
    items, depth, current = [], 0, ""
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            items.append(current.strip())
            current = ""
        else:
            current += ch
    if current.strip():
        items.append(current.strip())
    return items


def test_insert_and_select_lists_align_with_the_table():
    columns = [c.strip() for c in re.search(r"INSERT INTO mart\.leadership_week \((.*?)\)\s*WITH", REBUILD_SQL, re.S)[1].split(",")]
    final_select = REBUILD_SQL[REBUILD_SQL.rindex("\nSELECT") + len("\nSELECT"):REBUILD_SQL.rindex("FROM relay a")]
    assert len(_top_level_items(final_select)) == len(columns)
    ddl = "\n".join((MIGRATIONS / f).read_text() for f in DDL_FILES)
    for column in columns:
        assert re.search(rf"^\s+(ADD COLUMN IF NOT EXISTS )?{column} ", ddl, re.M), column


def test_takes_the_subcontract_gl_range_as_parameters():
    assert set(re.findall(r"%\((\w+)\)s", REBUILD_SQL)) == {"subcontract_gl_low", "subcontract_gl_high"}


def test_has_no_bare_percent_signs():
    """psycopg reads every % as a placeholder; a '90%' in a SQL comment broke the rebuild once."""
    assert not re.search(r"%(?!\(\w+\)s)", REBUILD_SQL)


def test_feedback_summary_ranks_sites_lowest_first():
    from datetime import date as d

    from app.routers.leadership import feedback_summary

    def line(wo, loc, when, score, comment=None, job="223"):
        return {"wo_number": wo, "location_number": loc, "feedback_date": when, "score": score, "comment": comment,
                "company": "Crane IFS" if job else None, "job_number": job, "site_name": f"FedEx - {loc}" if job else None}
    lines = [line("1", "NIPA", d(2026, 7, 2), 1.0), line("2", "NIPA", d(2026, 8, 2), 5.0, "great"), line("3", "NRBA", d(2026, 8, 3), 1.0, "not cleaning fully"),
             line("4", "ZZZZ", d(2026, 8, 4), None, job=None)]
    s = feedback_summary(lines)
    assert (s["ratings"], s["average"], s["low"], s["sites"], s["unmatched"]) == (4, 2.33, 2, 3, 1)
    assert [r["location_number"] for r in s["by_site"]] == ["NRBA", "NIPA", "ZZZZ"]
    nipa = s["by_site"][1]
    assert (nipa["ratings"], nipa["average"], nipa["low"], nipa["latest_score"], nipa["latest_comment"]) == (2, 3.0, 1, 5.0, "great")


def test_an_open_relay_month_projects_from_the_sites_billed_months():
    """A month billed to the customer takes its payables; an open one is at least the recent billed months'
    average (the contract covers fixed work only, so it understates a pallet site)."""
    relay = REBUILD_SQL[REBUILD_SQL.index("relay AS ("):REBUILD_SQL.index("FROM assembled a")]
    cases = relay.split("END AS relay_monthly")[0]
    assert cases.index("a.relay_week_ar IS NOT NULL") < cases.index("a.relay_trail_ap") < cases.index("0.9 * a.relay_ap_monthly")
    assert "'trailing_3mo_projection'" in relay
    trail = REBUILD_SQL[REBUILD_SQL.index("relay_trail AS ("):REBUILD_SQL.index("ap_sub AS (")]
    assert "t.ar_revenue IS NOT NULL" in trail and "t.month < m.month" in trail


def test_a_closed_month_invoices_its_own_weeks():
    """The week's revenue month is its own (the month of its Thursday) once closed, else the last closed before it."""
    assert "m.month <= date_trunc('month', w.week_start + 3)::date" in REBUILD_SQL


def test_a_week_that_ended_after_the_last_rebuild_is_not_complete():
    """Production rebuilt Oct 2 read the week of Sep 28 - Oct 4 as complete (and $0) on Oct 9."""
    from datetime import date

    from app.routers import leadership

    rows = [{"week_start": date(2026, 9, 21), "week_end": date(2026, 9, 27), "days_with_labor": 7, "pay_report_share": None, "revenue_month": None, "built_on": date(2026, 10, 2)},
            {"week_start": date(2026, 9, 28), "week_end": date(2026, 10, 4), "days_with_labor": 4, "pay_report_share": None, "revenue_month": None, "built_on": date(2026, 10, 2)}]

    class Cursor:
        def execute(self, sql, params=None): pass
        def fetchall(self): return rows

    weeks = leadership.week_rows(Cursor())
    assert [w["in_progress"] for w in weeks] == [False, True] and "built_on" not in weeks[0]
    assert leadership.default_week(weeks) == "2026-09-21"


def test_company_takes_relay_ar_for_subcontracted_relay_sites_like_the_mart():
    """From July 2026 a subcontracted FedEx site's contract revenue is booked to a GL line with no job, so the
    company months take Relay AR for it, as mart.leadership_week does, and gross profit moves with revenue."""
    from app.routers.leadership import COMPANY_SQL

    rule = COMPANY_SQL[COMPANY_SQL.index("base AS ("):COMPANY_SQL.index("AS relay_revenue")]
    assert "IS DISTINCT FROM 'Sarus'" in rule
    assert "NOT coalesce(rc.self_perform, false)" in rule and "coalesce(rm.ar_revenue, 0) > 0" in rule
    assert "coalesce(d.delivery_model, 'subcontracted') = 'subcontracted'" in rule
    assert "coalesce(a.delivery_model, 'subcontracted') = 'subcontracted'" in REBUILD_SQL
    jc = COMPANY_SQL[COMPANY_SQL.index("\njc AS ("):COMPANY_SQL.index("\ntk AS (")]
    assert "CASE WHEN relay_revenue THEN relay_ar ELSE revenue END AS revenue" in jc
    assert "coalesce(gross_profit, 0) + relay_ar - coalesce(revenue, 0)" in jc
    assert set(re.findall(r"%\((\w+)\)s", COMPANY_SQL)) == {"first", "last"}
    assert not re.search(r"%(?!\(\w+\)s)", COMPANY_SQL)
