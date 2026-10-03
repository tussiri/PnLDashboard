"""The Claude summary of customer feedback comments behind the Home feedback tile (migration 045).

Scores and counts come from SQL (routers/leadership.py); Claude reads only the comments of the
WINDOW_DAYS days up to the account's newest rating (not up to today, so the comments read, and the
summary, change only when an import brings new or changed ratings, never as days pass) and returns an overall sentiment, a one-line headline and up to five themes with the
locations they came from, as structured JSON. The result is cached in ops.feedback_summary under a
digest of the comments it read, so Claude is called again only when the comments change, never per
page view. A stale or missing summary is rebuilt in a background thread while the tile shows the last
one (or none).

Server-side only: ANTHROPIC_API_KEY never reaches the browser. Without it the tile shows scores only.
Requests opt into server-side refusal fallbacks ("default").
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
from datetime import date, timedelta
from typing import Any

from .config import settings
from .db import connection

logger = logging.getLogger(__name__)

WINDOW_DAYS = 90
SCOPE = f"comments_{WINDOW_DAYS}d"
MAX_COMMENTS = 400
SENTIMENTS = ("positive", "mixed", "negative")

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "sentiment": {"type": "string", "enum": list(SENTIMENTS)},
        "headline": {"type": "string"},
        "themes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "theme": {"type": "string"},
                    "sentiment": {"type": "string", "enum": list(SENTIMENTS)},
                    "mentions": {"type": "integer"},
                    "locations": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["theme", "sentiment", "mentions", "locations"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["sentiment", "headline", "themes"],
    "additionalProperties": False,
}

SYSTEM = (
    "You summarize customer feedback on janitorial service at FedEx stations for Crane IFS operations "
    "leaders. Each line is one comment from one station visit: date, location, the star score (1 to 5) "
    "of each trade rated that visit, and the customer's comment. Return the overall sentiment of the comments, a headline of at most 20 words "
    "stating what customers are saying, and at most five themes ordered by how many comments raise "
    "them, each with a label of at most six words, its sentiment, the number of comments that raise "
    "it and the location codes they came from. Use only what the comments say; do not invent causes, "
    "sites or numbers. Plain words, no emoji."
)

_running: set[tuple[str, str]] = set()
_lock = threading.Lock()


def configured() -> bool:
    return bool(settings.anthropic_api_key)


def _trade(trade: Any) -> str:
    t = str(trade or "").upper().removeprefix("JANITORIAL").strip()
    return t.capitalize() if t else "-"


def _input(lines: list[dict[str, Any]]) -> str:
    """One line per distinct comment of a visit (location and date): FedEx rates each trade as its own work order
    and often repeats one comment on each, so the trades and their scores are joined and the comment appears once."""
    visits: dict[tuple[Any, ...], dict[str, Any]] = {}
    for l in lines:
        comment = " ".join(str(l["comment"]).split())
        v = visits.setdefault((l["feedback_date"], l["location_number"], comment.lower()), {"line": l, "comment": comment, "scores": []})
        v["scores"].append(f"{_trade(l['trade'])} {'-' if l['score'] is None else int(l['score'])}")
    rows = [f"{v['line']['feedback_date']} | {v['line']['location_number']} | {', '.join(sorted(v['scores']))} | {v['comment']}" for v in visits.values()]
    return "date | location | trade scores | comment\n" + "\n".join(rows)


ACCOUNT_FILTER = "(account_slug = %(account)s OR (account_slug IS NULL AND %(account)s = 'fedex'))"


def comments_for(cursor: Any, account: str) -> list[dict[str, Any]]:
    """The comments of the WINDOW_DAYS days up to the account's newest rating (fixed between imports)."""
    cursor.execute(f"SELECT max(feedback_date) AS latest FROM mart.v_service_feedback WHERE {ACCOUNT_FILTER}", {"account": account})
    latest = cursor.fetchone()["latest"]
    if latest is None:
        return []
    cursor.execute(
        f"""
        SELECT feedback_date, location_number, trade, score, comment, wo_number FROM mart.v_service_feedback
        WHERE feedback_date > %(since)s AND comment IS NOT NULL AND btrim(comment) <> '' AND {ACCOUNT_FILTER}
        ORDER BY feedback_date DESC, wo_number LIMIT %(limit)s
        """,
        {"since": latest - timedelta(days=WINDOW_DAYS), "account": account, "limit": MAX_COMMENTS},
    )
    return [dict(r) for r in cursor.fetchall()]


def digest(text: str, model: str) -> str:
    return hashlib.sha256(f"{model}\n{SYSTEM}\n{text}".encode()).hexdigest()


def summarize(text: str, model: str, client: Any = None) -> dict[str, Any]:
    """One Claude call: the comments in, the structured summary out. Raises on a refusal or bad output."""
    import anthropic

    client = client or anthropic.Anthropic(api_key=settings.anthropic_api_key, timeout=120.0, max_retries=2)
    response = client.beta.messages.create(
        model=model,
        max_tokens=4000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=SYSTEM,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": text}],
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to summarize these comments")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("The summary was cut off")
    body = next((b.text for b in response.content if b.type == "text"), None)
    if not body:
        raise RuntimeError("The summary came back empty")
    out = json.loads(body)
    out["themes"] = out.get("themes", [])[:5]
    return {**out, "served_by": response.model}


def cached(cursor: Any, account: str) -> dict[str, Any] | None:
    cursor.execute("SELECT input_hash, summary, model, comments, error, generated_at FROM ops.feedback_summary WHERE account = %s AND scope = %s",
                   (account, SCOPE))
    row = cursor.fetchone()
    return dict(row) if row else None


def _store(account: str, input_hash: str, summary: dict[str, Any] | None, model: str, comments: int, error: str | None) -> None:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO ops.feedback_summary (account, scope, input_hash, summary, model, comments, error, generated_at)
            VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s, now())
            ON CONFLICT (account, scope) DO UPDATE SET input_hash = EXCLUDED.input_hash,
              summary = coalesce(EXCLUDED.summary, ops.feedback_summary.summary), model = EXCLUDED.model,
              comments = EXCLUDED.comments, error = EXCLUDED.error, generated_at = now()
            """,
            (account, SCOPE, input_hash, json.dumps(summary) if summary is not None else None, model, comments, error),
        )
        conn.commit()


def refresh(account: str, text: str, input_hash: str, comments: int) -> None:
    """Rebuild one account's summary (runs in a background thread). A failure keeps the last summary."""
    model = settings.feedback_summary_model
    try:
        summary = summarize(text, model)
        _store(account, input_hash, summary, model, comments, None)
    except Exception as exc:  # noqa: BLE001 - recorded on the row and shown as "failed"; never breaks the page
        logger.warning("Feedback summary for %s failed: %s", account, exc)
        _store(account, input_hash, None, model, comments, str(exc)[:500])
    finally:
        with _lock:
            _running.discard((account, SCOPE))


def warm() -> list[str]:
    """After a feedback import: start rebuilding the summary of every account with ratings whose comments
    changed, so it is ready before anyone opens the page. Returns the accounts checked."""
    if not configured():
        return []
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT DISTINCT coalesce(account_slug, 'fedex') AS account FROM mart.v_service_feedback")
        accounts = [r["account"] for r in cursor.fetchall()]
        for account in accounts:
            state(cursor, account)  # starts a background rebuild only when the comments changed
    return accounts


def state(cursor: Any, account: str) -> dict[str, Any]:
    """The tile's summary block: status off | none | pending | ready | failed, and the cached summary.
    Starts a rebuild when the comments changed since the cached one."""
    if not configured():
        return {"status": "off"}
    lines = comments_for(cursor, account)
    if not lines:
        return {"status": "none", "window_days": WINDOW_DAYS}
    text = _input(lines)
    distinct = text.count("\n")
    input_hash = digest(text, settings.feedback_summary_model)
    row = cached(cursor, account)
    stale = row is None or row["input_hash"] != input_hash
    key = (account, SCOPE)
    with _lock:
        running = key in _running
        if stale and not running:
            _running.add(key)
            threading.Thread(target=refresh, args=(account, text, input_hash, distinct), daemon=True,
                             name=f"feedback-summary-{account}").start()
            running = True
    summary = row["summary"] if row else None
    status = "pending" if running and summary is None else "failed" if row and row["error"] and summary is None else "ready" if summary else "pending"
    return {"status": status, "stale": stale, "window_days": WINDOW_DAYS, "summary": summary, "comments": distinct,
            "model": row["model"] if row else None, "generated_at": row["generated_at"].isoformat() if row else None,
            "error": row["error"] if row and row["error"] else None}
