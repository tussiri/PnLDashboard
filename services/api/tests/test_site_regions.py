"""Site and account regions (no database): the reads carry the region in effect, blanks clear an override."""
from __future__ import annotations

from app import month
from app.routers import leadership


def flat(sql: str) -> str:
    return " ".join(sql.split())


def test_weekly_and_month_rows_take_the_override_else_winteam():
    for sql in (leadership.ROW_SQL, month.MONTH_SQL):
        s = flat(sql)
        assert "coalesce(sr.region, nullif(btrim(j.region_name), '')) AS region" in s
        assert "coalesce(sr.subregion, nullif(btrim(j.state_province), '')) AS subregion" in s
        assert "LEFT JOIN ops.site_region sr ON sr.company = " in s


def test_blank_means_no_override():
    assert leadership._blank_to_none("  ") is None
    assert leadership._blank_to_none(None) is None
    assert leadership._blank_to_none(" Midwest ") == "Midwest"
    assert leadership.SiteRegionIn(region="", subregion=None).region == ""
