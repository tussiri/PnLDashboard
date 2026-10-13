"""School district calendars (app/school_calendar.py): parsing the districts' published calendars,
override precedence and week summaries. The two texts below follow the 2026-27 calendars of Plano ISD
(a text calendar, "date: words") and Crowley ISD (a list, "words date"), with bell times and grading
periods left in as noise."""
from __future__ import annotations

from datetime import date

import pytest

from app import school_calendar as sc

PLANO = """2026-2027 Plano ISD Academic Calendar
Elementary Schools 7:45 a.m. - 3:10 p.m.
Staff Only Dates
July 28 - 31: New Teachers, Training/Professional Learning
Aug. 4: Campus Day
Aug. 5: District-led Professional Learning
Aug. 10: Campus Day/Work Day
August 11 (Tues): First Day of Classes for Students
September 7 (Mon): Student and Teacher Holiday
October 9: End of 1st Grading Period (43 days)
October 12 - 14 (Mon - Wed): Student and Teacher Holiday
October 15 - 16 (Thurs - Fri): Student Holiday l Staff Development l Work Day
November 3 (Tue): Student Holiday l Staff Development l Work Day
November 23 – 27 (Mon - Fri): Thanksgiving Break (Student and Teacher Holiday)
December 18 (Fri): Last Day of First Semester | EARLY RELEASE
December 21 – January 1: Winter Break (Student and Teacher Holiday)
January 4 (Mon): Student Holiday l Staff Development l Work Day
January 5 (Tues): Classes Resume – Start of Second Semester
January 18 (Mon): Student and Teacher Holiday
February 15 - 16 (Mon - Tues): Student Holiday l Staff Development l Work Day
March 15 – 19 (Mon - Fri): Spring Break (Student and Teacher Holiday)
March 26 (Fri): Student and Teacher Holiday
March 29 (Mon): Student Holiday l Staff Development l Work Day
May 21 (Fri): Last Day of Classes for Students | EARLY RELEASE
TBD: Senior High School Graduations
"""

CROWLEY = """Crowley ISD 2026-2027 District Calendar
FIRST DAY OF SCHOOL - TUESDAY, AUG. 11, 2026
LAST DAY OF SCHOOL - FRIDAY, MAY 21, 2027
Elementary 7:35 a.m.-3:20 p.m.
Grading Periods
1. Aug. 11 - Sept. 17
2. Sept. 21 - Oct. 30
New Professional Orientation July 29-30
Professional Development Aug. 3-6
Convocation/Staff Workday Aug. 7
Staff Workday Aug. 10
Student/Staff Holiday Sept. 7
Student Holiday/Professional Development Sept. 18
Student Holiday/Professional Development Oct. 9
Student/Staff Holiday Oct. 12
Student Holiday/Professional Development Oct. 13
Student Holiday/Professional Development Nov. 9
Student/Staff Holiday Nov. 23-27
Early Release 9-12/Professional Development Dec. 17
Early Release K-12/Professional Development Dec. 18
Student/Staff Holiday Dec. 21-Jan. 1
Student Holiday/Professional Development Jan. 4
Student Holiday/Staff Workday Jan. 5
Student/Staff Holiday Jan. 18
Student Holiday/Professional Development Feb. 12
Student/Staff Holiday Feb. 15
Student Holiday/Professional Development March 12
Student/Staff Holiday March 15-19
Student/Staff Holiday March 26
Early Release K-12/Professional Development May 21
Professional Development May 24-25
District Closed May 31
District Closed June 21
JULY 2026
S M T W T F S
1 2 3 4
"""


def t(parsed, y, m, d):
    return parsed["days"][date(y, m, d)][0]


def test_plano():
    p = sc.parse_text(PLANO)
    assert p["school_year"] == 2026
    assert (p["first_day"], p["last_day"]) == (date(2026, 8, 11), date(2027, 5, 21))
    assert t(p, 2026, 8, 11) == "school"
    assert t(p, 2026, 8, 10) == "staff_only" and t(p, 2026, 7, 28) == "staff_only"
    assert t(p, 2026, 9, 7) == "holiday"
    assert [t(p, 2026, 10, d) for d in (12, 13, 14, 15, 16)] == ["holiday"] * 3 + ["staff_only"] * 2
    assert all(t(p, 2026, 11, d) == "holiday" for d in range(23, 28))
    assert t(p, 2026, 12, 18) == "early_release"
    assert t(p, 2026, 12, 31) == "holiday" and t(p, 2027, 1, 1) == "holiday"
    assert t(p, 2027, 1, 4) == "staff_only" and t(p, 2027, 1, 5) == "school"
    assert t(p, 2027, 5, 21) == "early_release"
    assert t(p, 2027, 6, 1) == "summer" and t(p, 2026, 7, 6) == "summer"
    assert date(2026, 11, 28) not in p["days"]  # weekends are not stored
    assert p["days"][date(2026, 11, 23)][1] == "Thanksgiving Break (Student and Teacher Holiday)"
    assert p["days"][date(2026, 10, 15)][1] == "Student Holiday; Staff Development; Work Day"
    assert p["days"][date(2026, 7, 28)][1] == "New Teachers, Training/Professional Learning"


def test_crowley():
    p = sc.parse_text(CROWLEY)
    assert p["school_year"] == 2026
    assert (p["first_day"], p["last_day"]) == (date(2026, 8, 11), date(2027, 5, 21))
    assert t(p, 2026, 9, 17) == "school"  # a grading period range is not a closure
    assert t(p, 2026, 9, 18) == "staff_only"
    assert t(p, 2026, 10, 12) == "holiday" and t(p, 2026, 10, 13) == "staff_only"
    assert t(p, 2026, 12, 17) == "early_release"
    assert t(p, 2027, 1, 5) == "staff_only"
    assert t(p, 2027, 5, 21) == "early_release"
    assert t(p, 2027, 5, 24) == "staff_only" and t(p, 2027, 5, 31) == "holiday" and t(p, 2027, 6, 21) == "holiday"
    assert t(p, 2027, 6, 1) == "summer"
    in_year = [k for d, (k, _) in p["days"].items() if p["first_day"] <= d <= p["last_day"]]
    assert in_year.count("holiday") == 1 + 1 + 5 + 10 + 1 + 1 + 5 + 1  # Sept 7, Oct 12, Thanksgiving, winter, Jan 18, Feb 15, spring, Mar 26


def test_refuses_a_calendar_without_bounds():
    with pytest.raises(sc.CalendarError):
        sc.parse_text("2026-27\nStudent/Staff Holiday Sept. 7\n")
    with pytest.raises(sc.CalendarError):
        sc.parse_text("Student/Staff Holiday Sept. 7\n")


def test_times_and_bare_numbers_are_not_dates():
    assert sc.entries_of("Elementary 7:35 a.m.-3:20 p.m.\nJULY 2026\n1 2 3 4", 2026) == []
    assert sc.entries_of("Mar 3:15 dismissal holiday", 2026) == []


def test_classify():
    assert sc.classify("Student Holiday/Professional Development") == ("staff_only", None)
    assert sc.classify("Student/Staff Holiday") == ("holiday", None)
    assert sc.classify("Early Release K-12/Professional Development") == ("early_release", None)
    assert sc.classify("FIRST DAY OF SCHOOL - TUESDAY,") == ("school", "first")
    assert sc.classify("End of 1st Grading Period") == (None, None)


def test_manual_wins_and_shows_what_it_overrides():
    rows = {"scraped": {"day_type": "school", "label": None, "updated_by": "calendar"},
            "manual": {"day_type": "holiday", "label": "Bad weather closure", "updated_by": "tuma"}}
    day = sc.effective_day(date(2027, 2, 3), rows)
    assert day == {"date": "2027-02-03", "day_type": "holiday", "label": "Bad weather closure", "source": "manual",
                   "scraped": {"day_type": "school", "label": None}, "updated_by": "tuma"}
    only = sc.effective_day(date(2027, 2, 4), {"scraped": rows["scraped"]})
    assert only["source"] == "scraped" and only["scraped"] is None


def test_weeks():
    p = sc.parse_text(PLANO)
    rows = [{"date": d.isoformat(), "day_type": k, "label": label} for d, (k, label) in sorted(p["days"].items())]
    by = {w["week_start"]: w for w in sc.weeks(rows)}
    thanksgiving = by["2026-11-23"]
    assert thanksgiving["holiday"] == 5 and thanksgiving["school"] == 0
    assert thanksgiving["labels"] == ["Thanksgiving Break (Student and Teacher Holiday)"]
    oct12 = by["2026-10-12"]
    assert (oct12["holiday"], oct12["staff_only"], oct12["school"]) == (3, 2, 0)
    assert by["2026-11-02"]["school"] == 4 and by["2026-11-02"]["staff_only"] == 1


def test_validate_days():
    assert sc.validate_days([{"date": "2027-02-03", "day_type": "holiday", "label": " Ice "}]) == [
        {"date": date(2027, 2, 3), "day_type": "holiday", "label": "Ice"}]
    for bad in ([], [{"date": "2027-02-06", "day_type": "holiday"}], [{"date": "2027-02-03", "day_type": "closed"}],
                [{"date": "x", "day_type": "school"}]):
        with pytest.raises(ValueError):
            sc.validate_days(bad)


def test_document_text_reads_html_and_text():
    assert "Student/Staff Holiday Sept. 7" in sc.document_text(b"<html><body><p>Student/Staff Holiday Sept. 7</p></body></html>")
    assert sc.document_text(b"plain") == "plain"
    with pytest.raises(sc.CalendarError):
        sc.document_text(b"%PDF-1.4 not really a pdf")
