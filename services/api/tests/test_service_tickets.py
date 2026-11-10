"""FedEx service ticket tracker parsing and the ratings-versus-tickets analysis (no database)."""
from __future__ import annotations

from datetime import date, datetime

from app import imports, service_tickets as st

HEAD = ["Current Status", "Assigned to Close: ", "OPCO            ", "Location #", "City/State ", "Ticket #", "Service Provider",
        "Service Issue Type", "Escalation Level ", "Date Received ", "Date Acknowledged ", "Date Closed ", "Expected Close Date", "Notes, Comments,Etc."]


def row(*values):
    return dict(zip(HEAD, values))


def test_detected_as_its_own_kind():
    assert imports.detect_kind("FX Service Tickets.xlsx", HEAD) == "service_ticket"


def test_parses_the_tracker_and_skips_blank_and_header_rows():
    rows = [row("Open", "Matt Hall", "FXG", 61, "Willington, CT", 168017, "Frank T", "SOW Not Performed", "Level 2", datetime(2026, 5, 4), datetime(2026, 5, 4), None, datetime(2026, 11, 20), "5/6, met\n11/4, call missed\n"),
            row(*[None] * 14), row(*HEAD),
            row("Closed / Termed\n", None, "FXE", "ATLR & FOPRT", "Atlanta, GA", "#172044 ", "Crane", "SOW Not Performed ", None, "8/18/20226", None, datetime(2026, 10, 23), None, None)]
    records, errors = st.parse(HEAD, rows)
    assert errors == [] and [r["ticket_number"] for r in records] == ["168017", "172044"]
    a, b = records
    assert a["location_number"] == "61" and a["date_received"] == date(2026, 5, 4) and a["expected_close"] == date(2026, 11, 20)
    assert b["location_number"] == "ATLR" and b["location_label"] == "ATLR & FOPRT" and b["status"] == "Closed / Termed"
    assert b["date_received"] == date(2026, 8, 18) and st.is_open(a["status"]) and not st.is_open(b["status"])
    assert st.latest_note(a["notes"]) == "11/4, call missed"


def test_location_keys_ignore_leading_zeros():
    assert st.location_key("0061") == st.location_key(61) == "61" and st.location_key("bwia") == "BWIA"


def fb(loc, day, score, comment=None):
    return {"location_number": loc, "feedback_date": day, "score": score, "comment": comment, "site_name": f"FedEx - {loc}", "company": "Crane IFS", "job_number": "1"}


def ticket(loc, received, closed=None, number="1"):
    return {"ticket_number": number, "location_number": loc, "date_received": received, "date_closed": closed, "status": "Closed" if closed else "Open"}


def test_low_ratings_run_ahead_of_tickets():
    feedback = []
    for m in range(1, 11):
        feedback += [fb("0100", date(2026, m, 10), 2.0, "bad"), fb("0100", date(2026, m, 20), 2.0)]  # always low
        feedback += [fb("BWIA", date(2026, m, 10), 5.0), fb("BWIA", date(2026, m, 20), 5.0)]  # always high
    tickets = [ticket("100", date(2026, 4, 15), date(2026, 4, 25), "a"), ticket("100", date(2026, 7, 15), date(2026, 7, 25), "b")]
    out = st.analyze(feedback, tickets, date(2026, 11, 10))
    bands = {b["band"]: b for b in out["bands"]}
    assert bands["Under 3.0"]["tickets"] == 3 and bands["Under 3.0"]["rate"] > 0
    assert bands["4.5 to 5.0"]["tickets"] == 0 and bands["4.5 to 5.0"]["observations"] > 0
    assert out["correlation"] is not None and out["correlation"] < 0
    assert out["risk"][0]["location_number"] == "0100" and out["risk"][0]["risk"] == bands["Under 3.0"]["rate"]
    assert out["risk"][0]["latest_low_comment"] == "bad"
    assert {b["ticket_number"] for b in out["before"]} == {"a", "b"} and out["before"][0]["average_before"] == 2.0


def test_a_location_with_an_open_ticket_is_not_ranked():
    feedback = [fb("0100", date(2026, 11, 1), 1.0)]
    out = st.analyze(feedback, [ticket("100", date(2026, 10, 1))], date(2026, 11, 10))
    assert out["risk"] == []
