"""Pure tests for the leadership account configuration (no database): the shipped seed validates,
seed validation names the offending account and job, and automatic segment resolution falls back."""
from __future__ import annotations

import copy

import pytest

from app.accounts import load_seed_file, resolve_segment, seed_path, validate_seed


def test_shipped_seed_is_valid_and_lists_the_featured_accounts():
    seed = load_seed_file()
    assert [a["name"] for a in seed["accounts"]] == [
        "Amazon", "FedEx", "Plano ISD", "White Settlement ISD", "Henderson ISD", "Crowley ISD", "Aldi", "Whole Foods", "Apple / Retail"]
    plano = next(a for a in seed["accounts"] if a["slug"] == "plano-isd")
    roles = {j["job_number"]: j["role"] for j in plano["jobs"]}
    assert roles["800"] == "catch_all" and roles["896"] == "non_billed"
    assert sum(1 for r in roles.values() if r == "site") == 84
    assert seed_path().name == "seed.json"


def test_validation_rejects_a_job_in_two_accounts():
    seed = load_seed_file()
    bad = copy.deepcopy(seed)
    bad["accounts"][1]["jobs"].append({"company": "Crane Southwest", "job_number": "801", "segment": "FedEx", "role": "site"})
    with pytest.raises(ValueError, match="801 .*fedex and plano-isd"):
        validate_seed(bad)


def test_validation_rejects_unknown_segment_and_role():
    seed = load_seed_file()
    bad = copy.deepcopy(seed)
    bad["accounts"][2]["jobs"][1]["segment"] = "Kindergarten"
    with pytest.raises(ValueError, match="Kindergarten"):
        validate_seed(bad)
    bad = copy.deepcopy(seed)
    bad["accounts"][2]["jobs"][1]["role"] = "overhead"
    with pytest.raises(ValueError, match="overhead"):
        validate_seed(bad)


@pytest.mark.parametrize("source,company,sub,expected", [
    ("company", "Crane West", None, "Crane West"),
    ("company", "Crane Northeast", None, "Crane IFS"),
    ("sub_account", "Crane IFS", "FedEx Ground (FXG)", "FedEx Ground (FXG)"),
    ("sub_account", "Crane IFS", None, "Crane IFS"),
    ("explicit", "Crane West", "x", "Crane IFS"),
])
def test_resolve_segment_falls_back_to_the_account_fallback(source, company, sub, expected):
    segments = ["Crane IFS", "Crane West", "FedEx Ground (FXG)"]
    assert resolve_segment(source, company=company, sub_account=sub, segments=segments, fallback="Crane IFS") == expected


def test_amazon_seed_matches_the_weekly_report():
    """The Amazon P&L report (v6_56) carries 14 Crane sites; project, management and closed jobs are held out."""
    amazon = next(a for a in load_seed_file()["accounts"] if a["slug"] == "amazon")
    sites = {(j["company"], j["job_number"]) for j in amazon["jobs"]}
    assert len(sites) == 14 and ("Crane West", "500") in sites and ("Sarus", "300") in sites
    excluded = {(j["company"], j["job_number"]) for j in amazon["exclude_jobs"]}
    assert ("Crane IFS", "506") in excluded and ("Crane West", "502") in excluded and not sites & excluded
    bad = copy.deepcopy(load_seed_file())
    bad["accounts"][0]["exclude_jobs"].append({"company": "Crane West", "job_number": "500"})
    with pytest.raises(ValueError, match="500 .*excluded"):
        validate_seed(bad)


def test_seed_jobs_replace_automatic_mappings_but_never_an_administrators():
    from app.accounts import apply_seed_jobs

    class Cursor:
        def __init__(self, admin_rows):
            self.admin_rows, self.sql = admin_rows, []
        def execute(self, sql, params=None):
            self.sql.append((" ".join(sql.split()), params))
            self.last = (sql, params)
        def fetchone(self):
            sql, params = self.last
            return {"x": 1} if "assigned_by <> 'auto'" in sql and tuple(params) in self.admin_rows else None
        @property
        def rowcount(self):
            return 1

    seed = {"accounts": [{"slug": "amazon", "jobs": [{"company": "Crane West", "job_number": "500", "segment": "Crane West"}],
                          "exclude_jobs": [{"company": "Crane IFS", "job_number": "506"}, {"company": "Crane IFS", "job_number": "520"}]}]}
    cur = Cursor(admin_rows={("Crane IFS", "520")})
    counts = apply_seed_jobs(cur, seed)
    upsert = next(s for s, _ in cur.sql if s.startswith("INSERT INTO ops.account_job "))
    assert "WHERE ops.account_job.assigned_by = 'auto'" in upsert  # an admin's mapping is left alone
    deletes = [p for s, p in cur.sql if s.startswith("DELETE FROM ops.account_job WHERE")]
    assert deletes == [("Crane IFS", "506")]  # 520 was placed by an administrator: kept
    assert counts == {"jobs": 1, "excluded": 1}
