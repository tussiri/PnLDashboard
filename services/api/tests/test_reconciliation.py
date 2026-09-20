"""Source-to-published reconciliation (app.reconcile).

These guard the two claims the dashboard rests on: normalization copies WinTeam exactly, and no
invoiced AR is ever published as zero revenue. The second is the defect that hid $9.7M.
"""
from app.reconcile import build_report


def month(m, raw_n, core_n, raw_v, core_v):
    return {"month": m, "raw_invoices": raw_n, "core_invoices": core_n,
            "raw_revenue": raw_v, "core_revenue": core_v, "variance": core_v - raw_v}


CLEAN = [month("2026-07-01", 482, 482, 9_420_976.56, 9_420_976.56),
         month("2026-08-01", 617, 617, 9_347_329.68, 9_347_329.68)]


def test_an_exact_chain_with_nothing_suppressed_is_healthy():
    r = build_report(CLEAN, [])
    assert r["ingestion_exact"] is True
    assert r["suppressed_ar_total"] == 0
    assert r["healthy"] is True
    assert all(row["exact"] for row in r["ar_chain"])


def test_a_value_variance_between_raw_and_core_fails_ingestion():
    """Normalization copies; it does not judge. A cent of drift is a defect."""
    rows = [month("2026-08-01", 617, 617, 9_347_329.68, 9_347_329.67)]
    r = build_report(rows, [])
    assert r["ingestion_exact"] is False and r["healthy"] is False
    assert r["ar_chain"][0]["exact"] is False


def test_a_count_variance_fails_even_when_the_totals_match():
    """A dropped invoice offset by a duplicate nets to zero; the counts still disagree."""
    rows = [month("2026-08-01", 617, 616, 9_347_329.68, 9_347_329.68)]
    r = build_report(rows, [])
    assert r["ingestion_exact"] is False and r["healthy"] is False


def test_invoiced_ar_published_as_zero_is_never_healthy():
    """The 2026-09-20 defect: 334 job-months carrying $9.7M of invoiced AR published at $0."""
    suppressed = [{"month": "2026-07-01", "job_months": 238, "ar_published_as_zero": 4_343_031.0},
                  {"month": "2026-08-01", "job_months": 96, "ar_published_as_zero": 5_392_849.0}]
    r = build_report(CLEAN, suppressed)
    assert r["ingestion_exact"] is True          # ingestion was never the problem
    assert r["suppressed_ar_total"] == 9_735_880.0
    assert r["healthy"] is False                 # but the published figures are still wrong
    assert [s["job_months"] for s in r["suppressed_ar"]] == [238, 96]


def test_an_empty_warehouse_reports_healthy_rather_than_crashing():
    r = build_report([], [])
    assert r["healthy"] is True and r["ar_chain"] == []


def test_nulls_from_the_database_do_not_break_the_verdict():
    rows = [{"month": "2026-08-01", "raw_invoices": 0, "core_invoices": 0,
             "raw_revenue": None, "core_revenue": None, "variance": None}]
    r = build_report(rows, [{"month": "2026-08-01", "job_months": 0, "ar_published_as_zero": None}])
    assert r["ingestion_exact"] is True and r["suppressed_ar_total"] == 0


def test_revenue_published_without_any_cost_is_never_healthy():
    """The mirror of suppressed AR. Clearing the zeroed revenue in Aug 2026 left 243 job-months
    publishing $3.23M with no labor basis at all, so portfolio margin read better than reality."""
    uncosted = [{"month": "2026-08-01", "job_months": 243, "revenue_without_cost": 3_233_898.0}]
    r = build_report(CLEAN, [], uncosted)
    assert r["ingestion_exact"] is True
    assert r["suppressed_ar_total"] == 0          # revenue side is now whole
    assert r["uncosted_revenue_total"] == 3_233_898.0
    assert r["healthy"] is False                  # but the cost side is not


def test_both_sides_must_be_covered_for_a_month_to_be_reportable():
    r = build_report(CLEAN,
                     [{"month": "2026-07-01", "job_months": 1, "ar_published_as_zero": 100.0}],
                     [{"month": "2026-08-01", "job_months": 1, "revenue_without_cost": 50.0}])
    assert r["healthy"] is False
    assert r["suppressed_ar_total"] == 100.0 and r["uncosted_revenue_total"] == 50.0


def test_uncosted_defaults_to_empty_for_callers_that_omit_it():
    r = build_report(CLEAN, [])
    assert r["uncosted_revenue"] == [] and r["uncosted_revenue_total"] == 0
