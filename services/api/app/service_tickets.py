"""FedEx service tickets (escalations) from the account team's tracker workbook (migration 074).

The tracker's first sheet, one row per ticket: Current Status, Assigned to Close, OPCO, Location #, City/State,
Ticket #, Service Provider, Service Issue Type, Escalation Level, Date Received, Date Acknowledged, Date Closed,
Expected Close Date, Notes. Columns are found by header ignoring case, spaces and punctuation. Blank rows and a
repeated header row are skipped. A ticket number loses its "#"; a location naming several ("ATLR & FOPRT") is
matched on the first (location_label keeps the cell). A date typed with a five-digit year ("8/18/20226") reads
as the 202x year it was meant to be. Tickets upsert by number; tickets not in the file are kept.
"""
from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any

KIND = "service_ticket"
COLUMNS = {
    "status": ("currentstatus", "status"),
    "assigned_to": ("assignedtoclose", "assignedto", "owner"),
    "opco": ("opco",),
    "location": ("location", "locationnumber", "locationno"),
    "city_state": ("citystate", "city"),
    "ticket": ("ticket", "ticketnumber", "ticketno"),
    "provider": ("serviceprovider", "provider"),
    "issue_type": ("serviceissuetype", "issuetype"),
    "escalation_level": ("escalationlevel", "escalation"),
    "date_received": ("datereceived", "received"),
    "date_acknowledged": ("dateacknowledged", "acknowledged"),
    "date_closed": ("dateclosed", "closed"),
    "expected_close": ("expectedclosedate", "expectedclose"),
    "notes": ("notescommentsetc", "notes", "comments"),
}


def compact(text: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


def is_ticket_sheet(headers: list[Any]) -> bool:
    keys = {compact(h) for h in headers}
    return "ticket" in keys and "serviceissuetype" in keys


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text or None


def parse_day(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = _text(value)
    if not text:
        return None
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{2,5})", text)
    if m:
        year = m[3]
        if len(year) == 5 and year.startswith("202"):
            year = "202" + year[-1]
        elif len(year) == 2:
            year = "20" + year
        try:
            return date(int(year), int(m[1]), int(m[2]))
        except ValueError:
            return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def parse(headers: list[str], rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    keys = {compact(h): h for h in headers}
    cols = {f: next((keys[a] for a in aliases if a in keys), None) for f, aliases in COLUMNS.items()}
    if cols["ticket"] is None or cols["location"] is None:
        return [], ["missing columns: Ticket # and Location #"]
    out: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    for n, row in enumerate(rows, start=2):
        get = lambda f: row.get(cols[f]) if cols[f] else None  # noqa: E731
        raw_ticket = get("ticket")
        if isinstance(raw_ticket, float) and raw_ticket.is_integer():
            raw_ticket = int(raw_ticket)
        ticket = (_text(raw_ticket) or "").lstrip("#").strip()
        if not ticket or compact(ticket) in ("ticket", "ticketnumber"):
            continue
        location_label = _text(get("location"))
        if location_label and isinstance(get("location"), float) and get("location").is_integer():
            location_label = str(int(get("location")))
        if not location_label:
            errors.append(f"row {n}: ticket {ticket} has no location")
            continue
        location = re.split(r"\s*(?:&|/|,|\band\b)\s*", location_label)[0].strip().upper()
        out[ticket] = {
            "ticket_number": ticket, "status": _text(get("status")), "assigned_to": _text(get("assigned_to")), "opco": _text(get("opco")),
            "location_number": location, "location_label": location_label, "city_state": _text(get("city_state")),
            "provider": _text(get("provider")), "issue_type": _text(get("issue_type")), "escalation_level": _text(get("escalation_level")),
            "date_received": parse_day(get("date_received")), "date_acknowledged": parse_day(get("date_acknowledged")),
            "date_closed": parse_day(get("date_closed")), "expected_close": parse_day(get("expected_close")),
            "notes": (str(get("notes")).strip() or None) if get("notes") is not None else None,
        }
    return list(out.values()), errors


FIELDS = ("ticket_number", "status", "assigned_to", "opco", "location_number", "location_label", "city_state", "provider", "issue_type",
          "escalation_level", "date_received", "date_acknowledged", "date_closed", "expected_close", "notes")


def load(cursor: Any, file_id: int, records: list[dict[str, Any]]) -> None:
    cursor.executemany(
        f"""
        INSERT INTO core.fact_service_ticket ({', '.join(FIELDS)}, import_file_id) VALUES ({', '.join(['%s'] * (len(FIELDS) + 1))})
        ON CONFLICT (ticket_number) DO UPDATE SET {', '.join(f'{f} = EXCLUDED.{f}' for f in FIELDS[1:])},
          import_file_id = EXCLUDED.import_file_id, loaded_at = now()
        """,
        [tuple(r[f] for f in FIELDS) + (file_id,) for r in records],
    )


NOTE_LINE = re.compile(r"^\s*(\d{1,2}/\d{1,2})\s*[,:-]")


def latest_note(notes: str | None) -> str | None:
    """The last dated line of the notes ("11/5, Walk through occurred ..."), else the last line."""
    lines = [ln.strip() for ln in (notes or "").splitlines() if ln.strip()]
    dated = [ln for ln in lines if NOTE_LINE.match(ln)]
    return (dated or lines or [None])[-1]


def is_open(status: str | None) -> bool:
    return not (status or "").strip().lower().startswith("closed")


# ------------------------------------------------------------------------------------------- ratings vs tickets
#
# Do star ratings run ahead of service tickets? For every location and the first of every month with a full
# LOOKBACK of ratings before it and a full HORIZON after it (and no ticket open on that day), the ratings in the
# LOOKBACK days before are the signal and a ticket received in the HORIZON days after is the outcome. The ticket
# rate by rating band, and the correlation between the average rating and the outcome, come from those
# location-months. "Risk now" applies the band rates to each location's last LOOKBACK days of ratings, for the
# locations with no open ticket.

LOOKBACK = 60
HORIZON = 60
BANDS = (("Under 3.0", 0.0, 3.0), ("3.0 to 3.9", 3.0, 4.0), ("4.0 to 4.4", 4.0, 4.5), ("4.5 to 5.0", 4.5, 5.01))
NO_RATINGS = "No ratings"


def location_key(value: Any) -> str:
    """As core.feedback_location: upper case without leading zeros ("0061" and 61 are the same station)."""
    text = str(value or "").strip().upper()
    if isinstance(value, float) and value.is_integer():
        text = str(int(value))
    stripped = text.lstrip("0")
    return stripped or text


def band_of(average: float | None) -> str:
    if average is None:
        return NO_RATINGS
    return next(name for name, lo, hi in BANDS if lo <= average < hi)


def _signal(scores: list[tuple[date, float]], start: date, end: date) -> dict[str, Any]:
    window = [s for d, s in scores if start <= d < end]
    n = len(window)
    return {"ratings": n, "average": round(sum(window) / n, 2) if n else None, "low": sum(1 for s in window if s <= 2)}


def _open_on(tickets: list[dict[str, Any]], day: date) -> bool:
    return any(t["date_received"] and t["date_received"] <= day and (t["date_closed"] is None or t["date_closed"] > day) for t in tickets)


def _months(first: date, last: date) -> list[date]:
    out, d = [], date(first.year, first.month, 1)
    while d <= last:
        out.append(d)
        d = date(d.year + (d.month == 12), d.month % 12 + 1, 1)
    return out


def _correlation(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if not sxx or not syy:
        return None
    return round(sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sxx * syy) ** 0.5, 3)


def analyze(feedback: list[dict[str, Any]], tickets: list[dict[str, Any]], today: date) -> dict[str, Any]:
    """feedback: {location_number, feedback_date, score, comment, site_name, company, job_number};
    tickets: {location_number, date_received, date_closed, status, ...}."""
    from datetime import timedelta

    scores: dict[str, list[tuple[date, float]]] = {}
    info: dict[str, dict[str, Any]] = {}
    for f in feedback:
        key = location_key(f["location_number"])
        slot = info.setdefault(key, {"location_number": f["location_number"], "site_name": None, "company": None, "job_number": None,
                                     "latest_low_comment": None, "latest_low_date": None})
        for k in ("site_name", "company", "job_number"):
            slot[k] = slot[k] or f.get(k)
        if f.get("score") is None:
            continue
        d, s = f["feedback_date"], float(f["score"])
        scores.setdefault(key, []).append((d, s))
        if s <= 2 and f.get("comment") and (slot["latest_low_date"] is None or d > slot["latest_low_date"]):
            slot["latest_low_comment"], slot["latest_low_date"] = f["comment"], d
    by_loc: dict[str, list[dict[str, Any]]] = {}
    for t in tickets:
        key = location_key(t["location_number"])
        by_loc.setdefault(key, []).append(t)
        info.setdefault(key, {"location_number": t["location_number"], "site_name": t.get("site_name"), "company": t.get("company"),
                              "job_number": t.get("job_number"), "latest_low_comment": None, "latest_low_date": None})

    all_days = [d for v in scores.values() for d, _ in v]
    bands = {name: {"band": name, "observations": 0, "tickets": 0} for name in [b[0] for b in BANDS] + [NO_RATINGS]}
    low_split = {flag: {"band": label, "observations": 0, "tickets": 0} for flag, label in ((True, "Any 1-2 star rating"), (False, "No 1-2 star rating"))}
    xs: list[float] = []
    ys: list[float] = []
    if all_days:
        first = min(all_days) + timedelta(days=LOOKBACK)
        last = today - timedelta(days=HORIZON)
        for day in _months(first, last) if first <= last else []:
            if day < first:
                continue
            for key in info:
                lt = by_loc.get(key, [])
                if _open_on(lt, day):
                    continue
                sig = _signal(scores.get(key, []), day - timedelta(days=LOOKBACK), day)
                hit = any(t["date_received"] and day < t["date_received"] <= day + timedelta(days=HORIZON) for t in lt)
                b = bands[band_of(sig["average"])]
                b["observations"] += 1
                b["tickets"] += hit
                if sig["ratings"]:
                    ls = low_split[sig["low"] > 0]
                    ls["observations"] += 1
                    ls["tickets"] += hit
                    xs.append(sig["average"])
                    ys.append(1.0 if hit else 0.0)
    for row in [*bands.values(), *low_split.values()]:
        row["rate"] = round(row["tickets"] / row["observations"], 4) if row["observations"] else None
    rate = {name: bands[name]["rate"] for name in bands}

    risk = []
    start = today - timedelta(days=LOOKBACK)
    for key, slot in info.items():
        lt = by_loc.get(key, [])
        if _open_on(lt, today):
            continue
        sig = _signal(scores.get(key, []), start, today + timedelta(days=1))
        if not sig["ratings"]:
            continue
        past = sorted((t["date_received"] for t in lt if t["date_received"]), reverse=True)
        risk.append({**{k: slot[k] for k in ("location_number", "site_name", "company", "job_number", "latest_low_comment", "latest_low_date")},
                     **sig, "band": band_of(sig["average"]), "risk": rate[band_of(sig["average"])],
                     "tickets": len(lt), "last_ticket": past[0].isoformat() if past else None})
    risk.sort(key=lambda r: (-(r["risk"] or 0), -r["low"], r["average"] if r["average"] is not None else 9, r["location_number"]))
    for r in risk:
        r["latest_low_date"] = r["latest_low_date"].isoformat() if r["latest_low_date"] else None

    before = []
    for key, lt in by_loc.items():
        for t in lt:
            if not t["date_received"]:
                continue
            sig = _signal(scores.get(key, []), t["date_received"] - timedelta(days=LOOKBACK), t["date_received"])
            overall = _signal(scores.get(key, []), date.min, date.max)
            before.append({"ticket_number": t["ticket_number"], "location_number": t["location_number"], "date_received": t["date_received"].isoformat(),
                           "ratings_before": sig["ratings"], "average_before": sig["average"], "low_before": sig["low"], "average_overall": overall["average"]})
    hi, lo = rate[BANDS[0][0]], rate[BANDS[-1][0]]
    return {"lookback_days": LOOKBACK, "horizon_days": HORIZON, "bands": list(bands.values()), "low_split": list(low_split.values()),
            "correlation": _correlation(xs, ys), "observations": len(xs), "lift": round(hi / lo, 2) if hi and lo else None,
            "risk": risk, "before": sorted(before, key=lambda b: b["date_received"], reverse=True)}
