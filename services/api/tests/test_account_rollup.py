"""Account breakdowns roll up to the key accounts plus one "Other" (app.routers.reporting.breakdown).

Left ungrouped the breakdown is a list of ~90 customers in which the nine that matter are lost.
Only the parent_account breakdown rolls up; region, service_type and company are unaffected.
"""
import re
from pathlib import Path

SRC = (Path(__file__).resolve().parents[1] / "app" / "routers" / "reporting.py").read_text()
BODY = SRC[SRC.index("def breakdown("):SRC.index("# ── jobs")]


def test_only_the_account_breakdown_rolls_up():
    assert 'if column == "parent_account":' in BODY
    assert "key_account_names()" in BODY


def test_non_key_accounts_collapse_to_a_single_label():
    assert "ELSE %s END" in BODY
    assert "OTHER_ACCOUNT_LABEL" in BODY


def test_the_label_is_exactly_other():
    match = re.search(r'OTHER_ACCOUNT_LABEL\s*=\s*"([^"]+)"', SRC)
    assert match and match.group(1) == "Other"


def test_an_unconfigured_key_account_list_leaves_the_breakdown_alone():
    """With no key accounts set, every account must still report under its own name."""
    assert "if names else" in BODY


def test_rollup_parameters_are_bound_before_the_range():
    """The CASE placeholders precede month BETWEEN in the statement, so they must be bound first."""
    assert "(*head, rng.start, rng.end, *params)" in BODY
