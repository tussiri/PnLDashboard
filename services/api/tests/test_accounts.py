"""Pure tests for the leadership account configuration (no database): the shipped seed validates,
seed validation names the offending account and job, and automatic segment resolution falls back."""
from __future__ import annotations

import copy

import pytest

from app.accounts import load_seed_file, resolve_segment, seed_path, validate_seed


def test_shipped_seed_is_valid_and_lists_the_featured_accounts():
    seed = load_seed_file()
    assert [a["name"] for a in seed["accounts"]] == [
        "Amazon", "FedEx", "Plano ISD", "White Settlement ISD", "Henderson ISD", "Aldi", "Whole Foods", "Apple / Retail"]
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
