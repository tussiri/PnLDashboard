"""WinTeam's Cross Tab Income Statement by job (import kind ``job_income_statement``, migration 057).

The report finance builds the company P&L from: every GL line on every job for a month, including the
payroll taxes, insurance, supplies and operating expenses the Job Cost Analysis export leaves out.
Two layouts are read, CSV or the first XLSX sheet:

* long: one row per job and GL account, with columns for the job (JobNumber / Job), the GL account
  (GLAccountNumber / Account), the amount (Amount / ActualDollars / Actual / Balance) and optionally the
  month (PeriodStartDate, FiscalYear + FiscalPeriod, Period or Month), the company (CompanyName /
  CompanyNumber) and the descriptions;
* cross tab: one row per GL account (first column the account, optionally a description column) and
  one column per job, headed by the job number ("246", "246 - JANRT", "Job 246"). Total columns are
  skipped.

The account cell may carry its description ("40100 - Wages"); the leading digits are the account. A
month not in the rows comes from the file name ("..._2026-09.xlsx", "Sep 2026", "202609"). With no
company column, a file named for Sarus is Sarus and anything else is Crane IFS.

Signs: revenue and costs are stored positive. When the file's revenue GLs add up negative (credit
signs), revenue amounts are negated; when its cost GLs add up negative, cost amounts are negated.
A file replaces the companies and months it covers.
"""
from __future__ import annotations

import re
from datetime import date
from decimal import Decimal
from typing import Any, Iterable

from .native_exports import Rows, _company, _key

REVENUE_RANGE = (30000, 39999)
MONTHS = {m: i + 1 for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"))}

JOB_KEYS = ("jobnumber", "jobno", "job")
ACCOUNT_KEYS = ("glaccountnumber", "glaccount", "accountnumber", "account", "glno", "gl")
AMOUNT_KEYS = ("amount", "actualdollars", "actual", "balance", "netamount", "total", "dollars")
DESCRIPTION_KEYS = ("gldescription", "accountdescription", "description", "glaccountdescription", "accountname")
TOTAL_WORDS = ("total", "grandtotal", "alljobs")


def name_matches(file_name: str) -> bool:
    name = re.sub(r"[^a-z]", "", file_name.lower())
    return any(w in name for w in ("crosstab", "incomestatementbyjob", "jobincomestatement", "jobincome"))


def layout_of(headers: Iterable[Any]) -> str | None:
    keys = [_key(h) for h in headers]
    has = lambda options: any(k in options for k in keys)  # noqa: E731
    if has(JOB_KEYS) and has(ACCOUNT_KEYS) and has(AMOUNT_KEYS):
        return "long"
    if keys and keys[0] in ACCOUNT_KEYS + DESCRIPTION_KEYS and sum(1 for h in headers if job_of_header(h)) >= 1:
        return "cross_tab"
    return None


def job_of_header(header: Any) -> str | None:
    """'246', '246 - JANRT', 'Job 246', '63252' -> the job number; descriptions and totals -> None."""
    text = str(header or "").strip()
    if not text or _key(text) in TOTAL_WORDS:
        return None
    match = re.match(r"^(?:job\s*#?\s*)?([A-Za-z]{0,4}\d[\w.]*)(?:\s*[-–:]\s*.*)?$", text, re.IGNORECASE)
    if not match:
        return None
    job = match[1]
    return None if _key(job) in ACCOUNT_KEYS + DESCRIPTION_KEYS + AMOUNT_KEYS else job


def account_of(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        return int(value)
    match = re.match(r"^\s*(\d{4,6})", str(value))
    return int(match[1]) if match else None


def period_from_name(file_name: str) -> date | None:
    name = file_name.lower()
    match = re.search(r"(20\d{2})[-_. ]?(0[1-9]|1[0-2])(?!\d)", name)
    if match:
        return date(int(match[1]), int(match[2]), 1)
    match = re.search(r"(?<!\d)(0?[1-9]|1[0-2])[-_. ](20\d{2})", name)
    if match:
        return date(int(match[2]), int(match[1]), 1)
    match = re.search(r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_. ]*(20\d{2})", name)
    if match:
        return date(int(match[2]), MONTHS[match[1]], 1)
    return None


def default_company(file_name: str) -> str:
    return "Sarus" if "sarus" in file_name.lower() else "Crane IFS"


def _row_period(r: Rows, fallback: date | None) -> date | None:
    from .imports import parse_period

    period = r.get("PeriodStartDate", "Period", "Month", "FiscalMonth")
    if period is None:
        year, month = r.get("FiscalYear"), r.get("FiscalPeriod")
        if year is not None and month is not None:
            period = f"{int(Decimal(str(year)))}-{int(Decimal(str(month))):02d}"
    return parse_period(period) if period is not None else fallback


def parse(file_name: str, headers: list[str], rows: list[dict[str, Any]], aliases: dict[str, str], numbers: dict[str, str],
          parsed: Any) -> None:
    """Append one record per company, job, month and GL account to `parsed.records`
    (company, job_number, job_name, period, gl_account, gl_description, amount)."""
    from .imports import clean_text, parse_number

    layout = layout_of(headers)
    fallback_period = period_from_name(file_name)
    fallback_company = default_company(file_name)
    merged: dict[tuple[str, str, date, int], dict[str, Any]] = {}

    def add(company: str, job: str, job_name: str | None, period: date, account: int, description: str | None, amount: Decimal) -> None:
        rec = merged.setdefault((company, job, period, account), {
            "company": company, "job_number": job, "job_name": job_name, "period": period, "gl_account": account,
            "gl_description": description, "amount": Decimal(0)})
        rec["amount"] += amount

    if layout == "long":
        for line, raw in enumerate(rows, start=2):
            r = Rows(raw)
            try:
                account = account_of(r.get(*ACCOUNT_KEYS))
                job = clean_text(r.get(*JOB_KEYS))
                if account is None or account < REVENUE_RANGE[0] or not job or _key(job) in TOTAL_WORDS:
                    continue  # subtotals, headings and balance sheet accounts
                period = _row_period(r, fallback_period)
                if period is None:
                    raise ValueError("no month: add a Period column or put the month in the file name (…_2026-09.xlsx)")
                amount = parse_number(r.get(*AMOUNT_KEYS)) or Decimal(0)
                company = _company(r, aliases, numbers) or fallback_company
            except ValueError as exc:
                parsed.error(f"line {line}: {exc}")
                continue
            add(company, job.split(" ")[0], clean_text(r.get("JobDescription", "JobName")), period, account,
                clean_text(r.get(*DESCRIPTION_KEYS)), amount)
    elif layout == "cross_tab":
        if fallback_period is None:
            parsed.error("no month: put the month in the file name (…_2026-09.xlsx)")
            return
        job_columns = [(h, job_of_header(h)) for h in headers[1:]]
        job_columns = [(h, j) for h, j in job_columns if j]
        description_column = next((h for h in headers[1:] if _key(h) in DESCRIPTION_KEYS), None)
        for line, raw in enumerate(rows, start=2):
            account = account_of(raw.get(headers[0]))
            if account is None:
                continue
            description = clean_text(raw.get(description_column)) if description_column else None
            if description is None:
                text = str(raw.get(headers[0]) or "")
                description = clean_text(re.sub(r"^\s*\d+\s*[-–:]?\s*", "", text)) or None
            for header, job in job_columns:
                try:
                    amount = parse_number(raw.get(header))
                except ValueError as exc:
                    parsed.error(f"line {line}, job {job}: {exc}")
                    continue
                if amount:
                    add(fallback_company, job, None, fallback_period, account, description, amount)
    else:
        parsed.error("not a Cross Tab Income Statement: expected job, GL account and amount columns, "
                     "or GL accounts down the first column and one column per job")
        return

    records = list(merged.values())
    revenue = sum((r["amount"] for r in records if REVENUE_RANGE[0] <= r["gl_account"] <= REVENUE_RANGE[1]), Decimal(0))
    cost = sum((r["amount"] for r in records if r["gl_account"] >= 40000), Decimal(0))
    for r in records:
        is_revenue = REVENUE_RANGE[0] <= r["gl_account"] <= REVENUE_RANGE[1]
        if (is_revenue and revenue < 0) or (not is_revenue and r["gl_account"] >= 40000 and cost < 0):
            r["amount"] = -r["amount"]
    parsed.records.extend(r for r in records if r["gl_account"] >= REVENUE_RANGE[0])


def load(cursor: Any, file_id: int, records: list[dict[str, Any]]) -> None:
    """Replace the (company, month) pairs the file covers."""
    for company, month in {(r["company"], r["period"]) for r in records}:
        cursor.execute("DELETE FROM core.fact_job_income_statement_month WHERE company = %s AND month = %s", (company, month))
    cursor.executemany(
        """
        INSERT INTO core.fact_job_income_statement_month (company, job_number, month, gl_account, gl_description, job_name, amount, import_file_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """,
        [(r["company"], r["job_number"], r["period"], r["gl_account"], r["gl_description"], r["job_name"], r["amount"], file_id)
         for r in records],
    )
