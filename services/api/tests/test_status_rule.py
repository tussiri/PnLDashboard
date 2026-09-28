"""The site status rule (app.routers.reporting.evaluate / status_from).

A margin is a ratio, and a ratio with a broken denominator is not a finding. 371 of 526 sites read
Critical because incomplete months produced margins like -6,785 %; a badge that fires on 70 % of
the portfolio is noise. Those rows keep every other test and disclose the withheld one.
"""
from app.routers.reporting import evaluate, status_from

TARGET = 0.25


def row(**kw):
    base = {"revenue": 100_000.0, "gross_profit": 30_000.0, "labor_cost": 0.0,
            "budget_labor": None, "hours": 0.0, "overtime_hours": 0.0,
            "days_outstanding_weighted": None}
    base.update(kw)
    return base


def kinds(alerts):
    return {a["type"] for a in alerts}


def test_healthy_site_raises_nothing():
    assert status_from(evaluate(row(), TARGET)) == "Healthy"


def test_a_genuinely_bad_margin_still_goes_critical():
    """-150 % is a real, reportable disaster and must not be swallowed by the new guard."""
    alerts = evaluate(row(gross_profit=-150_000.0), TARGET)
    assert "margin" in kinds(alerts)
    assert status_from(alerts) == "Critical"


def test_broken_denominator_does_not_fire_a_margin_alert():
    """$4.9K billed against $338K of labor: -6,785 %, an incomplete period rather than a site."""
    alerts = evaluate(row(revenue=4_900.0, gross_profit=-333_100.0, labor_cost=338_000.0), TARGET)
    assert "margin" not in kinds(alerts)
    assert "margin_not_meaningful" in kinds(alerts)


def test_a_withheld_margin_leaves_the_site_healthy_not_critical():
    alerts = evaluate(row(revenue=4_900.0, gross_profit=-333_100.0), TARGET)
    assert status_from(alerts) == "Healthy"


def test_other_alerts_still_fire_on_a_site_whose_margin_is_withheld():
    """Only the margin test is withheld; overtime and AR still judge the site."""
    alerts = evaluate(row(revenue=4_900.0, gross_profit=-333_100.0, hours=100.0, overtime_hours=20.0), TARGET)
    assert "overtime" in kinds(alerts)
    assert status_from(alerts) == "Critical"


def test_info_alerts_never_set_a_status():
    assert status_from([{"type": "x", "severity": "info", "detail": "", "metric_value": 0, "threshold": 0}]) == "Healthy"


def test_no_revenue_raises_no_margin_alert_at_all():
    alerts = evaluate(row(revenue=0.0, gross_profit=-5_000.0), TARGET)
    assert "margin" not in kinds(alerts) and "margin_not_meaningful" not in kinds(alerts)


def test_a_costless_site_has_no_reportable_margin():
    """100 % margin means no cost landed, not an excellent site; it must not read as Healthy-best."""
    alerts = evaluate(row(revenue=50_000.0, gross_profit=50_000.0), TARGET)
    assert "margin" not in kinds(alerts)
    assert "margin_not_meaningful" in kinds(alerts)


def test_a_very_good_but_real_margin_is_still_reported():
    """90 % is extraordinary but reportable; the guard must not swallow genuine performance."""
    alerts = evaluate(row(revenue=50_000.0, gross_profit=45_000.0), TARGET)
    assert "margin_not_meaningful" not in kinds(alerts)
    assert status_from(alerts) == "Healthy"
