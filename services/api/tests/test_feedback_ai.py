"""The Claude feedback comment summary (app/feedback_ai.py) against a fake client: no network."""
from __future__ import annotations

import json
from dataclasses import replace
from datetime import date
from types import SimpleNamespace

import pytest

from app import feedback_ai

GOOD = {"sentiment": "mixed", "headline": "Docks left uncleaned at several Ground stations; office cleaning praised.",
        "themes": [{"theme": "Dock and pallet areas", "sentiment": "negative", "mentions": 4, "locations": ["0331", "NRBA"]}]}


class FakeClient:
    def __init__(self, body=GOOD, stop="end_turn"):
        self.calls, self.body, self.stop = [], body, stop
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))

    def create(self, **kw):
        self.calls.append(kw)
        text = SimpleNamespace(type="text", text=json.dumps(self.body))
        return SimpleNamespace(stop_reason=self.stop, content=[text], model=kw["model"])


LINES = [{"feedback_date": date(2026, 8, 3), "location_number": "NRBA", "trade": "JANITORIAL DOCK", "score": 1.0, "comment": "not  cleaning\nfully"},
         {"feedback_date": date(2026, 8, 3), "location_number": "NRBA", "trade": "JANITORIAL OFFICE", "score": 2.0, "comment": "Not cleaning fully"},
         {"feedback_date": date(2026, 7, 2), "location_number": "0331", "trade": None, "score": None, "comment": "Pallets set on the dock for days untouched."}]


def test_input_is_one_line_per_visit_comment_and_the_digest_tracks_it():
    """The same comment on a visit's dock and office work orders is one line with both scores."""
    text = feedback_ai._input(LINES)
    assert text.splitlines() == ["date | location | trade scores | comment",
                                 "2026-08-03 | NRBA | Dock 1, Office 2 | not cleaning fully",
                                 "2026-07-02 | 0331 | - - | Pallets set on the dock for days untouched."]
    assert feedback_ai.digest(text, "m") == feedback_ai.digest(text, "m") != feedback_ai.digest(text + "x", "m")
    assert feedback_ai.digest(text, "m") != feedback_ai.digest(text, "other-model")


def test_summarize_asks_for_structured_json_with_fallbacks():
    client = FakeClient()
    out = feedback_ai.summarize("date | ...", "claude-opus-5-5", client)
    assert out["sentiment"] == "mixed" and out["themes"][0]["locations"] == ["0331", "NRBA"] and out["served_by"] == "claude-opus-5-5"
    call = client.calls[0]
    assert call["fallbacks"] == "default" and call["betas"] == ["server-side-fallback-2026-07-01"]
    assert call["output_config"]["format"]["schema"] == feedback_ai.SCHEMA and call["output_config"]["effort"] == "low"
    assert "thinking" not in call  # Opus 5.5: thinking is always on; effort is the control


def test_refusal_and_truncation_raise_and_themes_are_capped():
    with pytest.raises(RuntimeError, match="declined"):
        feedback_ai.summarize("x", "m", FakeClient(stop="refusal"))
    with pytest.raises(RuntimeError, match="cut off"):
        feedback_ai.summarize("x", "m", FakeClient(stop="max_tokens"))
    many = {**GOOD, "themes": GOOD["themes"] * 8}
    assert len(feedback_ai.summarize("x", "m", FakeClient(body=many))["themes"]) == 5


def test_without_a_key_the_tile_shows_scores_only(monkeypatch):
    monkeypatch.setattr(feedback_ai, "settings", replace(feedback_ai.settings, anthropic_api_key=""))
    assert feedback_ai.configured() is False
    assert feedback_ai.state(object(), "fedex") == {"status": "off"}
