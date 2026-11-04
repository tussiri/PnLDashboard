"""FedEx invoices for a date range, from Relay: each FedEx (AR) invoice with the vendor payables behind it.

Reads the Relay snapshot the nightly sync keeps (core.relay_ar_invoice, core.relay_ap_payable,
core.relay_site; app/relay.py, migration 034), so it is as fresh as the last Relay sync (`as_of`).
One row per FedEx invoice, so revenue sums once however many payables it carries; the vendor fields
list every linked payable.

A payable links to an invoice by its AR invoice number, matched the way Relay matches it
(Relay app/services/invoice_numbers.py and leadership.ar_invoice_keys): a dock / office / pallet
leg (164301DOC, 165283PAL) and a resubmission letter (163622OFFa, 164448a) are the same invoice.

Self-perform. A station Relay marks self-perform is Crane's own work, and Martin Building Solutions
is Crane itself: its "payable" is not a cost (the cost is payroll, which Relay does not have). Those
payables are listed and flagged, but kept out of vendor cost and margin.
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from datetime import date
from typing import Any

MAX_DAYS = 731
BASES = ("invoice", "service")

# Relay's work tags, whole words first so ADHOC is not read as ADH + "OC".
_TAGS = "|".join(("JANITORIAL", "HANDYMAN", "SWEEPING", "PALLET", "ADHOC", "DOC", "OFF", "JAN", "PAL", "HAN", "ADH", "SWE"))
_TAGGED = re.compile(rf"^(.+?)(?i:{_TAGS})[a-z]?$")
_LETTERED = re.compile(r"^([0-9]+)[a-z]$")
_CRANE_VENDOR = re.compile(r"\bmartin\s+building\s+solutions?\b", re.I)

AR_SQL = """
SELECT a.relay_id, a.invoice_number, a.customer_number, a.winteam_job_number, a.site_name, a.service_month,
       a.invoice_date, a.revenue_before_tax, a.tax, a.payload->>'invoice_total' AS invoice_total,
       a.payload->>'billing_period_from' AS billing_period_from, a.payload->>'billing_period_to' AS billing_period_to,
       a.portal_state, a.remitted_amount, a.paid_date, j.company, j.job_name
FROM core.relay_ar_invoice a
LEFT JOIN LATERAL (
  SELECT d.company, d.job_name FROM core.dim_job d
  WHERE d.job_number = a.winteam_job_number AND d.valid_to IS NULL AND d.company IS DISTINCT FROM 'Sarus'
  ORDER BY d.company LIMIT 1
) j ON true
WHERE CASE WHEN %(basis)s = 'service'
           THEN a.service_month BETWEEN date_trunc('month', %(date_from)s::date)::date AND %(date_to)s
           ELSE coalesce(a.invoice_date, a.service_month) BETWEEN %(date_from)s AND %(date_to)s END
ORDER BY coalesce(a.invoice_date, a.service_month), a.invoice_number
"""

AP_SQL = """
SELECT relay_id, ar_invoice_number, station, subtype, vendor_number, vendor_name, vendor_invoice_number,
       work_order_number, amount, status, in_winteam, payment_status, paid_amount, paid_date, check_number, self_perform
FROM core.relay_ap_payable
WHERE ar_invoice_number IS NOT NULL
ORDER BY relay_id
"""

SITE_SQL = """
SELECT winteam_job_number, station, self_perform, subcontractor
FROM core.relay_site
ORDER BY relay_id
"""

AS_OF_SQL = """
SELECT max(completed_at) AS as_of FROM ops.integration_sync_run
WHERE integration_name = 'relay' AND resource_name IN ('ar', 'ap') AND status = 'succeeded'
"""


def validate_range(date_from: date, date_to: date) -> None:
    if date_to < date_from:
        raise ValueError("The end date is before the start date")
    if (date_to - date_from).days + 1 > MAX_DAYS:
        raise ValueError(f"Pick at most {MAX_DAYS} days")


def base_of(number: Any) -> str:
    """The WinTeam invoice number behind a portal number (Relay invoice_numbers.base_of)."""
    s = str(number or "").strip()
    m = _TAGGED.match(s)
    if m and any(ch.isdigit() for ch in m.group(1)):
        s = m.group(1)
    m = _LETTERED.match(s)
    return m.group(1) if m else s


def invoice_keys(value: Any) -> list[str]:
    """Every spelling one AR invoice number may carry (Relay leadership.ar_invoice_keys)."""
    raw = str(value or "").strip()
    if not raw:
        return []
    keys = [raw]
    bare = base_of(raw)
    if bare != raw:
        keys.append(bare)
    for k in list(keys):
        rev = re.sub(r"[A-Za-z]$", "", k)
        if rev != k and rev.isdigit() and rev not in keys:
            keys.append(rev)
    return keys


def is_crane(payable: Mapping[str, Any]) -> bool:
    """Crane's own work: a self-perform station, or Martin Building Solutions (Crane itself) as the vendor."""
    return bool(payable.get("self_perform")) or bool(_CRANE_VENDOR.search(str(payable.get("vendor_name") or "")))


def _num(value: Any) -> float | None:
    try:
        return None if value is None or value == "" else round(float(value), 2)
    except (TypeError, ValueError):
        return None


def _iso(value: Any) -> str | None:
    if value is None or value == "":
        return None
    return value.isoformat() if isinstance(value, date) else str(value)[:10]


def _distinct(values: Iterable[Any]) -> list[str]:
    out: list[str] = []
    for v in values:
        text = str(v).strip() if v is not None else ""
        if text and text not in out:
            out.append(text)
    return out


def build(invoices: Iterable[Mapping[str, Any]], payables: Iterable[Mapping[str, Any]],
          sites: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """One row per FedEx invoice with its linked payables, and totals."""
    invoices = list(invoices)
    by_key: dict[str, int] = {}
    for i, inv in enumerate(invoices):
        for k in invoice_keys(inv.get("invoice_number")):
            by_key.setdefault(k, i)
    linked: dict[int, list[Mapping[str, Any]]] = {}
    for p in payables:
        hit = next((by_key[k] for k in invoice_keys(p.get("ar_invoice_number")) if k in by_key), None)
        if hit is not None:
            linked.setdefault(hit, []).append(p)
    job_sites: dict[str, list[Mapping[str, Any]]] = {}
    for s in sites:
        if s.get("winteam_job_number"):
            job_sites.setdefault(str(s["winteam_job_number"]), []).append(s)

    rows: list[dict[str, Any]] = []
    for i, inv in enumerate(invoices):
        legs = linked.get(i, [])
        stations = job_sites.get(str(inv.get("winteam_job_number") or ""), [])
        subs = [p for p in legs if not is_crane(p)]
        crane = [p for p in legs if is_crane(p)]
        self_perform = bool(crane) or (not subs and any(s.get("self_perform") for s in stations))
        revenue = _num(inv.get("revenue_before_tax")) or 0.0
        cost = round(sum(_num(p.get("amount")) or 0.0 for p in subs), 2) if subs else None
        margin = round(revenue - cost, 2) if cost is not None else None
        paid = [p for p in subs if p.get("paid_date") or _num(p.get("paid_amount"))]
        rows.append({
            "invoice_number": inv.get("invoice_number"),
            "invoice_date": _iso(inv.get("invoice_date")),
            "service_month": _iso(inv.get("service_month")),
            "billing_period_from": _iso(inv.get("billing_period_from")),
            "billing_period_to": _iso(inv.get("billing_period_to")),
            "customer_number": inv.get("customer_number"),
            "company": inv.get("company"),
            "job_number": inv.get("winteam_job_number"),
            "site_name": inv.get("site_name") or inv.get("job_name"),
            "stations": ", ".join(_distinct([*(p.get("station") for p in legs), *(s.get("station") for s in stations)])) or None,
            "delivery": "Self-perform" if self_perform else ("Subcontracted" if subs or stations else None),
            "revenue": revenue,
            "tax": _num(inv.get("tax")),
            "invoice_total": _num(inv.get("invoice_total")) if _num(inv.get("invoice_total")) is not None else round(revenue + (_num(inv.get("tax")) or 0.0), 2),
            "portal_state": inv.get("portal_state"),
            "remitted": _num(inv.get("remitted_amount")),
            "paid_date": _iso(inv.get("paid_date")),
            "vendors": "; ".join(_distinct(p.get("vendor_name") for p in legs))
                       or ("; ".join(_distinct(s.get("subcontractor") for s in stations if not s.get("self_perform"))) or None),
            "vendor_numbers": ", ".join(_distinct(p.get("vendor_number") for p in legs)) or None,
            "vendor_invoices": ", ".join(_distinct(p.get("vendor_invoice_number") for p in legs)) or None,
            "work_orders": ", ".join(_distinct(p.get("work_order_number") for p in legs)) or None,
            "payables": len(legs),
            "crane_payables": len(crane),
            "vendor_cost": cost,
            "margin": margin,
            "margin_pct": round(margin / revenue, 4) if margin is not None and revenue else None,
            "vendor_payment": "; ".join(_distinct(p.get("payment_status") for p in subs)) or None,
            "vendor_paid": round(sum(_num(p.get("paid_amount")) or 0.0 for p in paid), 2) if paid else None,
            "vendor_paid_date": max((_iso(p.get("paid_date")) for p in paid if p.get("paid_date")), default=None),
            "check_numbers": ", ".join(_distinct(p.get("check_number") for p in subs)) or None,
            "not_in_winteam": sum(1 for p in subs if not p.get("in_winteam")),
        })

    with_cost = [r for r in rows if r["vendor_cost"] is not None]
    revenue_with_cost = sum(r["revenue"] for r in with_cost)
    cost_total = round(sum(r["vendor_cost"] for r in with_cost), 2)
    return {
        "rows": rows,
        "totals": {
            "invoices": len(rows),
            "revenue": round(sum(r["revenue"] for r in rows), 2),
            "invoice_total": round(sum(r["invoice_total"] or 0 for r in rows), 2),
            "vendor_cost": cost_total,
            "margin": round(revenue_with_cost - cost_total, 2) if with_cost else None,
            "margin_pct": round((revenue_with_cost - cost_total) / revenue_with_cost, 4) if revenue_with_cost else None,
            "vendors": len(_distinct(v.strip() for r in rows for v in (r["vendors"] or "").split(";"))),
            "sites": len({r["job_number"] for r in rows if r["job_number"]}),
            "without_payable": sum(1 for r in rows if not r["payables"] and r["delivery"] != "Self-perform"),
            "crane_payables": sum(r["crane_payables"] for r in rows),
        },
    }


def report(cursor: Any, date_from: date, date_to: date, basis: str) -> dict[str, Any]:
    params = {"date_from": date_from, "date_to": date_to, "basis": basis}
    cursor.execute(AR_SQL, params)
    invoices = [dict(r) for r in cursor.fetchall()]
    cursor.execute(AP_SQL)
    payables = [dict(r) for r in cursor.fetchall()]
    cursor.execute(SITE_SQL)
    sites = [dict(r) for r in cursor.fetchall()]
    cursor.execute(AS_OF_SQL)
    row = cursor.fetchone()
    as_of = row["as_of"] if row else None
    return {"date_from": date_from.isoformat(), "date_to": date_to.isoformat(), "basis": basis,
            "as_of": as_of.isoformat() if as_of else None, **build(invoices, payables, sites)}
