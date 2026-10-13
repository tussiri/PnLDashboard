"""School district calendars (migration 055): which weekdays schools are in session, closed, or open
to staff only, so a district account's weeks show when labor should run lower.

Source: each district publishes one official calendar a year as a PDF (neither Plano ISD nor
Crowley ISD offers a subscribable feed for closures). The nightly sync (app/nightly.py) downloads
each district's calendar link; when the file changed since the last read it is parsed into one row
per weekday of the school year (July 1 to June 30) and those rows replace the year's 'scraped' rows.
Admin can also upload the file by hand, refresh on demand, change the link, and override any day:
an override is a 'manual' row, wins over the scraped row (ops.v_school_day) and survives re-reads.

Parsing (`parse_text`): the calendar's text is read line by line. A date or date range ("Nov. 23-27",
"December 21 – January 1", "Aug. 11, 2026") together with the words around it ("Student/Staff
Holiday", "Student Holiday | Staff Development", "Early Release", "First Day of School") gives one
entry. The first and last day of school bound the year: weekdays between them are school days unless
an entry says otherwise, weekdays outside them are summer unless an entry says otherwise. A calendar
in which no first or last day is found is refused, and the previous rows stay.

A district's read never raises out of `sync`: a failure is kept on ops.school_calendar_source
(last_status 'failed', last_error) and shown on Admin > School calendars, and the nightly run is not
marked failed for it.
"""
from __future__ import annotations

import hashlib
import io
import logging
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx

from .db import connection

logger = logging.getLogger(__name__)

DAY_TYPES = ("school", "early_release", "staff_only", "holiday", "summer")
# Weekday schedule when two entries fall on one day: the one that closes more wins.
RANK = {"holiday": 4, "staff_only": 3, "early_release": 2, "school": 1, "summer": 0}
# Default calendar links; Admin > School calendars can replace them (ops.school_calendar_source.url).
DEFAULT_SOURCES = {
    "plano-isd": "https://www.pisd.edu/cms/lib/TX02215173/Centricity/Domain/4/2026-27_Text_Calendar_ENG.pdf",
    "crowley-isd": "https://www.crowleyisdtx.org/fs/resource-manager/view/b2686d2e-5156-4850-a8ce-305b64abb316",
}
MAX_BYTES = 20 * 1024 * 1024
TIMEOUT_SECONDS = 30

MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
_MONTH = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
# "Nov. 23", "November 23 – 27", "Dec. 21-Jan. 1", "AUG. 11, 2026". A day is never followed by a digit,
# ':' (a time) or another digit group; the year is optional.
DATE_RE = re.compile(
    rf"\b(?P<m1>{_MONTH})\.?\s+(?P<d1>\d{{1,2}})(?!\d|:\d)(?:,?\s+(?P<y1>20\d\d))?"
    rf"(?:\s*(?:-|–|—|to|through)\s*(?:(?P<m2>{_MONTH})\.?\s+)?(?P<d2>\d{{1,2}})(?!\d|:\d)(?:,?\s+(?P<y2>20\d\d))?)?",
    re.IGNORECASE,
)
YEAR_SPAN_RE = re.compile(r"\b(20\d\d)\s*[-–/]\s*(?:20)?(\d\d)\b")

STAFF_WORDS = ("staff development", "professional development", "professional learning", "professional day", "staff workday",
               "staff work day", "teacher workday", "teacher work day", "work day", "workday", "campus day", "convocation",
               "new teacher", "orientation", "training", "staff day")
HOLIDAY_WORDS = ("teacher holiday", "staff holiday", "student/staff", "student & staff", "student and staff", "students and staff",
                 "district closed", "break", "all schools closed", "bad weather", "weather day")


class CalendarError(RuntimeError):
    """A calendar could not be read or made no sense; nothing was saved."""


@dataclass(frozen=True)
class Entry:
    start: date
    end: date
    day_type: str | None  # None for a first or last day marker that does not change the day's type
    label: str
    marker: str | None = None  # 'first' | 'last'


def classify(text: str) -> tuple[str | None, str | None]:
    """(day_type, marker) for a calendar line's words; (None, None) when they say nothing about the day."""
    t = " ".join(text.lower().split())
    marker = None
    if re.search(r"first day (?:of|for) (?:school|classes|class|students|instruction)", t):
        marker = "first"
    elif re.search(r"last day (?:of|for) (?:school|classes|class|students|instruction)", t):
        marker = "last"
    if "early release" in t or "early dismissal" in t:
        return "early_release", marker
    if "student holiday" in t and any(w in t for w in STAFF_WORDS):
        return "staff_only", marker
    if any(w in t for w in HOLIDAY_WORDS):
        return "holiday", marker
    if "student holiday" in t:
        return "staff_only", marker
    if any(w in t for w in STAFF_WORDS):
        return "staff_only", marker
    if "holiday" in t or "closed" in t:
        return "holiday", marker
    if marker:
        return "school", marker
    return None, None


def school_year_of(text: str) -> int | None:
    """The start year of the calendar's school year: '2026-27' or '2026-2027' gives 2026, else the
    earliest four-digit year written next to an August date."""
    for match in YEAR_SPAN_RE.finditer(text):
        start, end = int(match.group(1)), int(match.group(2))
        if end == (start + 1) % 100:
            return start
    years = [int(m.group("y1")) for m in DATE_RE.finditer(text) if m.group("y1") and MONTHS[m.group("m1")[:3].lower()] >= 7]
    return min(years) if years else None


def _month(name: str) -> int:
    return MONTHS[name[:3].lower()]


def _on(month: int, day: int, start_year: int) -> date | None:
    try:
        return date(start_year if month >= 7 else start_year + 1, month, day)
    except ValueError:
        return None


def _clean_label(text: str) -> str:
    text = re.sub(r"\((?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?(?:\s*[-–]\s*(?:mon|tue|tues|wed|thu|thur|thurs|fri)[a-z]*\.?)?\)", "", text, flags=re.I)
    text = re.sub(r"\s+l\s+(?=[A-Z])|\s*\|\s*", "; ", text)  # "Student Holiday l Staff Development" (a PDF's bar read as l)
    text = re.sub(r"\b(?:monday|tuesday|wednesday|thursday|friday)\b,?", "", text, flags=re.I)
    return " ".join(text.strip(" :-–—,;|.\t").split())[:120]


def entries_of(text: str, start_year: int) -> list[Entry]:
    """Every dated line whose words say something about the day. The words are the text before the
    date on the line, else the text after it (calendars write it either way)."""
    out: list[Entry] = []
    for line in text.splitlines():
        matches = list(DATE_RE.finditer(line))
        for i, m in enumerate(matches):
            before = line[matches[i - 1].end() if i else 0:m.start()]
            after = line[m.end():matches[i + 1].start() if i + 1 < len(matches) else len(line)]
            day_type, marker, words = None, None, ""
            for candidate in (before, after):
                day_type, marker = classify(candidate)
                if day_type:
                    words = candidate
                    break
            if not day_type:
                continue
            m1 = _month(m.group("m1"))
            start = _on(m1, int(m.group("d1")), start_year)
            if m.group("d2"):
                end = _on(_month(m.group("m2")) if m.group("m2") else m1, int(m.group("d2")), start_year)
            else:
                end = start
            if start is None or end is None or end < start or (end - start).days > 120:
                continue
            out.append(Entry(start, end, None if marker and day_type == "school" else day_type, _clean_label(words), marker))
    return out


def weekdays(start: date, end: date):
    d = start
    while d <= end:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)


def parse_text(text: str, start_year: int | None = None) -> dict[str, Any]:
    """The school year's weekdays from a calendar's text: {school_year, first_day, last_day,
    days: {date: (day_type, label)}}. CalendarError when the year, first day or last day is missing."""
    year = start_year or school_year_of(text)
    if year is None:
        raise CalendarError("No school year found in the calendar (expected a heading such as 2026-27)")
    entries = entries_of(text, year)
    firsts = [e.start for e in entries if e.marker == "first"]
    lasts = [e.end for e in entries if e.marker == "last"]
    if not firsts or not lasts:
        raise CalendarError("The calendar names no first or last day of school; nothing was changed")
    first, last = min(firsts), max(lasts)
    if last <= first:
        raise CalendarError(f"The last day of school ({last}) is not after the first ({first})")
    days: dict[date, tuple[str, str | None]] = {}
    for d in weekdays(date(year, 7, 1), date(year + 1, 6, 30)):
        days[d] = ("school", None) if first <= d <= last else ("summer", None)
    claimed: set[date] = set()
    for e in entries:
        if e.day_type is None:
            continue
        for d in weekdays(e.start, e.end):
            if d in days and (d not in claimed or RANK[e.day_type] > RANK[days[d][0]]):
                days[d] = (e.day_type, e.label or None)
                claimed.add(d)
    for e in entries:  # a first or last day keeps its own words when nothing else claimed the day
        if e.marker and e.day_type in (None, "school"):
            for d in weekdays(e.start, e.end):
                if d in days and days[d][1] is None:
                    days[d] = (days[d][0], e.label or None)
    return {"school_year": year, "first_day": first, "last_day": last, "days": days}


def pdf_text(content: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(content))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def html_text(content: bytes) -> str:
    text = content.decode("utf-8", errors="replace")
    text = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>|</(?:p|div|li|tr|h\d)>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"&nbsp;|&#160;", " ", text).replace("&amp;", "&").replace("&ndash;", "–")


def document_text(content: bytes) -> str:
    """The text of a calendar file: a PDF, an HTML page, or plain text."""
    if content[:5] == b"%PDF-":
        try:
            return pdf_text(content)
        except Exception as exc:  # noqa: BLE001 - an unreadable PDF is a calendar error, not a crash
            raise CalendarError(f"Could not read the PDF ({exc.__class__.__name__})") from exc
    head = content[:2000].lower()
    if b"<html" in head or b"<!doctype html" in head:
        return html_text(content)
    return content.decode("utf-8", errors="replace")


def fetch(url: str) -> bytes:
    try:
        with httpx.Client(follow_redirects=True, timeout=TIMEOUT_SECONDS, headers={"User-Agent": "CraneIFS-Dashboard/1.0"}) as client:
            response = client.get(url)
    except httpx.HTTPError as exc:
        raise CalendarError(f"Could not download the calendar ({exc.__class__.__name__})") from exc
    if response.status_code != 200:
        raise CalendarError(f"The calendar link answered HTTP {response.status_code}")
    if len(response.content) > MAX_BYTES:
        raise CalendarError("The calendar file is larger than 20 MB")
    return response.content


# ── database ─────────────────────────────────────────────────────────────────
def sources(cursor: Any) -> list[dict[str, Any]]:
    """Every school district with a calendar link: the saved row, else the default link."""
    cursor.execute("SELECT slug, name FROM ops.account ORDER BY sort, slug")
    accounts = {r["slug"]: r["name"] for r in cursor.fetchall()}
    cursor.execute("SELECT * FROM ops.school_calendar_source")
    saved = {r["account_slug"]: dict(r) for r in cursor.fetchall()}
    out = []
    for slug in [s for s in accounts if s in saved or s in DEFAULT_SOURCES]:
        row = saved.get(slug) or {"account_slug": slug, "url": None, "enabled": True}
        row = {**row, "url": row.get("url") or DEFAULT_SOURCES.get(slug), "account_name": accounts[slug]}
        out.append(row)
    return out


def source(cursor: Any, slug: str) -> dict[str, Any] | None:
    return next((s for s in sources(cursor) if s["account_slug"] == slug), None)


def _record(cursor: Any, slug: str, **values: Any) -> None:
    columns = ["account_slug", *values]
    cursor.execute(
        f"""
        INSERT INTO ops.school_calendar_source ({', '.join(columns)}) VALUES ({', '.join(['%s'] * len(columns))})
        ON CONFLICT (account_slug) DO UPDATE SET {', '.join(f'{c} = EXCLUDED.{c}' for c in values)}
        """,
        (slug, *values.values()),
    )


def save_scraped(cursor: Any, slug: str, parsed: dict[str, Any]) -> int:
    """Replace the school year's scraped rows; manual rows are left alone. Returns rows written."""
    year = parsed["school_year"]
    cursor.execute("DELETE FROM ops.school_day WHERE account_slug = %s AND source = 'scraped' AND day BETWEEN %s AND %s",
                   (slug, date(year, 7, 1), date(year + 1, 6, 30)))
    rows = [(slug, d, t, label) for d, (t, label) in sorted(parsed["days"].items())]
    cursor.executemany("INSERT INTO ops.school_day (account_slug, day, source, day_type, label, updated_by) VALUES (%s, %s, 'scraped', %s, %s, 'calendar')", rows)
    return len(rows)


def load(slug: str, content: bytes, *, force: bool = False, actor: str = "calendar") -> dict[str, Any]:
    """Parse a calendar file for a district and save it (unless unchanged and not forced)."""
    digest = hashlib.sha256(content).hexdigest()
    now = datetime.now(timezone.utc)
    with connection() as conn, conn.cursor() as cursor:
        current = source(cursor, slug) or {}
        if not force and current.get("content_sha256") == digest and current.get("last_status") in ("loaded", "unchanged"):
            _record(cursor, slug, last_checked_at=now, last_status="unchanged", last_error=None)
            conn.commit()
            return {"account": slug, "status": "unchanged", "school_year": current.get("school_year"), "days": current.get("days_found")}
        try:
            parsed = parse_text(document_text(content))
        except CalendarError as exc:
            _record(cursor, slug, last_checked_at=now, last_status="failed", last_error=str(exc))
            conn.commit()
            raise
        written = save_scraped(cursor, slug, parsed)
        _record(cursor, slug, content_sha256=digest, school_year=parsed["school_year"], days_found=written,
                last_checked_at=now, last_changed_at=now, last_status="loaded", last_error=None, updated_by=actor)
        conn.commit()
    off = sum(1 for t, _ in parsed["days"].values() if t in ("holiday", "staff_only"))
    return {"account": slug, "status": "loaded", "school_year": parsed["school_year"], "days": written,
            "first_day": parsed["first_day"].isoformat(), "last_day": parsed["last_day"].isoformat(), "days_off": off}


def refresh(slug: str, *, force: bool = False) -> dict[str, Any]:
    """Download one district's calendar link and load it. CalendarError on any failure (recorded)."""
    with connection() as conn, conn.cursor() as cursor:
        src = source(cursor, slug)
    if src is None or not src.get("url"):
        raise CalendarError(f"No calendar link for {slug}")
    try:
        content = fetch(src["url"])
    except CalendarError as exc:
        with connection() as conn, conn.cursor() as cursor:
            _record(cursor, slug, last_checked_at=datetime.now(timezone.utc), last_status="failed", last_error=str(exc))
            conn.commit()
        raise
    return load(slug, content, force=force)


def sync() -> dict[str, Any]:
    """Nightly: every enabled district once. Never raises; failures are recorded per district."""
    with connection() as conn, conn.cursor() as cursor:
        enabled = [s["account_slug"] for s in sources(cursor) if s.get("enabled", True) and s.get("url")]
    results, failed = [], []
    for slug in enabled:
        try:
            results.append(refresh(slug))
        except Exception as exc:  # noqa: BLE001 - one district must not stop the others
            logger.warning("School calendar %s: %s", slug, exc)
            failed.append(slug)
    return {"results": results, "failed": failed}


def save_source(cursor: Any, slug: str, url: str | None, enabled: bool, actor: str) -> None:
    _record(cursor, slug, url=url, enabled=enabled, updated_at=datetime.now(timezone.utc), updated_by=actor)


def validate_days(rows: Any) -> list[dict[str, Any]]:
    """Admin overrides: [{date: YYYY-MM-DD (a weekday), day_type, label?}]. ValueError otherwise."""
    if not isinstance(rows, list) or not rows:
        raise ValueError("days must be a non-empty list")
    out, seen = [], set()
    for n, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            raise ValueError(f"day {n} must be an object")
        try:
            day = date.fromisoformat(str(row.get("date", ""))[:10])
        except ValueError:
            raise ValueError(f"day {n}: date must be YYYY-MM-DD") from None
        if day.weekday() >= 5:
            raise ValueError(f"day {n}: {day} is a weekend")
        if day in seen:
            raise ValueError(f"day {n}: {day} appears twice")
        seen.add(day)
        if row.get("day_type") not in DAY_TYPES:
            raise ValueError(f"day {n}: day_type must be one of {', '.join(DAY_TYPES)}")
        label = row.get("label")
        out.append({"date": day, "day_type": row["day_type"], "label": str(label).strip()[:120] or None if label else None})
    return out


def save_manual(cursor: Any, slug: str, rows: list[dict[str, Any]], actor: str) -> None:
    for r in rows:
        cursor.execute(
            """
            INSERT INTO ops.school_day (account_slug, day, source, day_type, label, updated_by) VALUES (%s, %s, 'manual', %s, %s, %s)
            ON CONFLICT (account_slug, day, source) DO UPDATE SET day_type = EXCLUDED.day_type, label = EXCLUDED.label,
              updated_at = now(), updated_by = EXCLUDED.updated_by
            """,
            (slug, r["date"], r["day_type"], r["label"], actor),
        )


def delete_manual(cursor: Any, slug: str, day: date) -> int:
    cursor.execute("DELETE FROM ops.school_day WHERE account_slug = %s AND day = %s AND source = 'manual'", (slug, day))
    return cursor.rowcount


def school_year_bounds(today: date | None = None) -> tuple[date, date]:
    """July 1 to June 30 of the school year `today` falls in."""
    t = today or date.today()
    start = t.year if t.month >= 7 else t.year - 1
    return date(start, 7, 1), date(start + 1, 6, 30)


def days(cursor: Any, slug: str, start: date, end: date) -> list[dict[str, Any]]:
    """The calendar in effect, each day with the scraped value it overrides when overridden."""
    cursor.execute(
        """
        SELECT day, source, day_type, label, updated_by, updated_at FROM ops.school_day
        WHERE account_slug = %s AND day BETWEEN %s AND %s ORDER BY day, source
        """,
        (slug, start, end),
    )
    by_day: dict[date, dict[str, dict[str, Any]]] = {}
    for r in cursor.fetchall():
        by_day.setdefault(r["day"], {})[r["source"]] = r
    return [effective_day(d, rows) for d, rows in sorted(by_day.items())]


def effective_day(day: date, rows: dict[str, dict[str, Any]]) -> dict[str, Any]:
    manual, scraped = rows.get("manual"), rows.get("scraped")
    use = manual or scraped
    assert use is not None
    return {
        "date": day.isoformat(), "day_type": use["day_type"], "label": use["label"], "source": "manual" if manual else "scraped",
        "scraped": {"day_type": scraped["day_type"], "label": scraped["label"]} if manual and scraped else None,
        "updated_by": manual["updated_by"] if manual else None,
    }


def weeks(day_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Monday-start weeks: weekdays of each type and the labels of the days not in session."""
    out: dict[str, dict[str, Any]] = {}
    for r in day_rows:
        d = date.fromisoformat(r["date"])
        key = (d - timedelta(days=d.weekday())).isoformat()
        week = out.setdefault(key, {"week_start": key, **{t: 0 for t in DAY_TYPES}, "labels": []})
        week[r["day_type"]] += 1
        if r["day_type"] not in ("school", "summer") and r["label"] and r["label"] not in week["labels"]:
            week["labels"].append(r["label"])
    return list(out.values())
