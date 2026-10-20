"""The contract schedule per job and month (import kind ``contract_billing``, migration 057).

Loaded into core.contract_billing (migration 007) with source 'import'; the latest effective_month on or
before a month is that month's contract amount. Accounts whose invoice_basis is 'contract' invoice each
week from it (the contract for the week's month ÷ the divisor), which is how finance's Crowley ISD
report reads billing that changes month to month. Two layouts, CSV or the first XLSX sheet:

* long: JobNumber, Month (or EffectiveMonth / Period), MonthlyAmount (or Amount / Contract / Revenue),
  optional Company and Notes;
* by month: JobNumber, then one column per month ("Oct 2026", "2026-10", "10/2026") holding that month's
  amount. Empty cells are skipped.

With no company column a file named for Sarus is Sarus, else Crane IFS. A file replaces the rows of the
jobs and months it carries.
"""
from __future__ import annotations

import re
from datetime import date
from decimal import Decimal
from typing import Any

from .job_income_statement import MONTHS, default_company
from .native_exports import Rows, _company, _key

JOB_KEYS = ("jobnumber", "jobno", "job", "wtjob", "winteamjob")
MONTH_KEYS = ("month", "effectivemonth", "period", "servicemonth")
AMOUNT_KEYS = ("monthlyamount", "amount", "contract", "contractamount", "monthlyrevenue", "revenue", "monthlybilling")
SOURCE = "import"


def name_matches(file_name: str) -> bool:
    name = re.sub(r"[^a-z]", "", file_name.lower())
    return "contractbilling" in name or "contractschedule" in name or "monthlyrevenue" in name


def month_of_header(header: Any) -> date | None:
    text = str(header or "").strip().lower()
    match = re.fullmatch(r"(20\d{2})[-/](0?[1-9]|1[0-2])(?:[-/]01)?", text)
    if match:
        return date(int(match[1]), int(match[2]), 1)
    match = re.fullmatch(r"(0?[1-9]|1[0-2])/(20\d{2})", text)
    if match:
        return date(int(match[2]), int(match[1]), 1)
    match = re.fullmatch(r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-\s']*(\d{2}|20\d{2})", text)
    if match:
        year = int(match[2]) if len(match[2]) == 4 else 2000 + int(match[2])
        return date(year, MONTHS[match[1]], 1)
    return None


def parse(file_name: str, headers: list[str], rows: list[dict[str, Any]], aliases: dict[str, str], numbers: dict[str, str],
          parsed: Any) -> None:
    """Append (company, job_number, period, amount, notes) records to `parsed.records`."""
    from .imports import clean_text, parse_number, parse_period

    keys = {_key(h) for h in headers}
    month_columns = [(h, m) for h in headers for m in [month_of_header(h)] if m]
    fallback_company = default_company(file_name)
    if not keys & set(JOB_KEYS):
        parsed.error("no job number column (JobNumber)")
        return
    long = bool(keys & set(MONTH_KEYS)) and bool(keys & set(AMOUNT_KEYS))
    if not long and not month_columns:
        parsed.error("expected Month and MonthlyAmount columns, or one column per month (Oct 2026)")
        return
    for line, raw in enumerate(rows, start=2):
        r = Rows(raw)
        job = clean_text(r.get(*JOB_KEYS))
        if not job:
            continue
        job = job.split(" ")[0]
        company = _company(r, aliases, numbers) or fallback_company
        notes = clean_text(r.get("Notes", "Facility", "Location"))
        try:
            if long:
                amount = parse_number(r.get(*AMOUNT_KEYS))
                if amount is not None:
                    parsed.records.append({"company": company, "job_number": job, "period": parse_period(r.get(*MONTH_KEYS)),
                                           "amount": amount, "notes": notes})
            else:
                for header, month in month_columns:
                    amount = parse_number(raw.get(header))
                    if amount is not None:
                        parsed.records.append({"company": company, "job_number": job, "period": month, "amount": amount, "notes": notes})
        except ValueError as exc:
            parsed.error(f"line {line}: {exc}")


def load(cursor: Any, file_id: int, records: list[dict[str, Any]]) -> None:
    """Upsert (source 'import', job, month); amounts for a job and month repeated in the file are summed
    (a facility schedule may list several buildings under one job)."""
    totals: dict[tuple[str, date], dict[str, Any]] = {}
    for r in records:
        acc = totals.setdefault((r["job_number"], r["period"]), {"company": r["company"], "amount": Decimal(0), "notes": r["notes"]})
        acc["amount"] += r["amount"]
    for (job, month), r in totals.items():
        cursor.execute(
            """
            INSERT INTO core.contract_billing (source, job_number, effective_month, company, monthly_amount, notes, warehouse_loaded_at)
            VALUES (%s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (source, job_number, effective_month) DO UPDATE SET company = EXCLUDED.company,
              monthly_amount = EXCLUDED.monthly_amount, notes = EXCLUDED.notes, warehouse_loaded_at = now()
            """,
            (SOURCE, job, month, r["company"], r["amount"], f"import {file_id}" + (f": {r['notes']}" if r["notes"] else "")),
        )
