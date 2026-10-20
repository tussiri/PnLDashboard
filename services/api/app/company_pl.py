"""The company P&L on Finance's basis (migration 058, docs/company-pl.md).

Source: the WinTeam Cross Tab Income Statement by job (import kind `job_income_statement`), every GL line on
every job for a month, each line in a CATEGORY. Per month:

* a job's gross profit = revenue − direct costs (direct labor, payroll taxes and insurance, subcontractors,
  supplies, other direct); its net before overhead = gross profit − operating expenses on the job.
* corporate overhead = the net cost of the overhead jobs (setting company_pl.overhead_jobs): their costs
  less any revenue posted to them.
* Finance's adjustments (ops.pl_adjustment) apply first: accruals add a line to a job (dropped once
  cleared, reversed in reverse_month when the real invoice posts later), reclasses move an amount from
  one job to another, staff charges move overhead to one group as its direct account staff.
* the overhead rule: each group pays its fixed monthly charge and its direct account staff; what is left
  of the overhead (the pool) is spread over the groups that share it by revenue (pool_basis). A group's
  net after overhead = net before overhead − fixed − staff − pool share. The groups add up to the
  company net profit.
* an account carries its jobs' share of their group's overhead by revenue.

Groups (setting company_pl.groups, first match wins): {key, name, accounts: [slug], delivery_model:
null | self_perform | subcontracted, fixed_monthly, shares_pool, rest: true for the group that takes every
job no other group matched}.

The computation (build) is pure so it is tested without a database; load_* read the warehouse.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Iterable

CATEGORIES = ("revenue", "direct_labor", "payroll_taxes_insurance", "subcontractors", "supplies", "other_direct", "operating_expense")
DIRECT = ("direct_labor", "payroll_taxes_insurance", "subcontractors", "supplies", "other_direct")
KINDS = ("accrual", "reclass", "staff")
POOL_BASES = ("revenue",)
DEFAULT_SETTINGS: dict[str, Any] = {
    "overhead_jobs": ["6325", "63252", "63253"],
    "groups": [
        {"key": "fedex_subs", "name": "New FedEx subs", "accounts": ["fedex"], "delivery_model": "subcontracted", "fixed_monthly": 30000, "shares_pool": False},
        {"key": "education", "name": "Education", "accounts": ["plano-isd", "crowley-isd", "white-settlement-isd", "henderson-isd"],
         "delivery_model": None, "fixed_monthly": 0, "shares_pool": True},
        {"key": "core", "name": "Amazon + other customers", "accounts": [], "rest": True, "delivery_model": None, "fixed_monthly": 0, "shares_pool": True},
    ],
    "pool_basis": "revenue",
    "gl_categories": [],
}


# ---------------------------------------------------------------------------------------------- settings

def settings_of(cursor: Any) -> dict[str, Any]:
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = 'company_pl'")
    row = cursor.fetchone()
    value = row["value"] if row and isinstance(row["value"], dict) else {}
    return validate_settings({**DEFAULT_SETTINGS, **value})


def validate_settings(value: dict[str, Any]) -> dict[str, Any]:
    out = {**DEFAULT_SETTINGS, **{k: v for k, v in value.items() if k in DEFAULT_SETTINGS}}
    jobs = out["overhead_jobs"]
    if not isinstance(jobs, list) or not all(isinstance(j, (str, int)) and str(j).strip() for j in jobs):
        raise ValueError("overhead_jobs must be a list of job numbers")
    out["overhead_jobs"] = [str(j).strip() for j in jobs]
    groups = out["groups"]
    if not isinstance(groups, list) or not groups:
        raise ValueError("groups must be a non-empty list")
    keys: set[str] = set()
    clean = []
    for g in groups:
        if not isinstance(g, dict) or not str(g.get("key") or "").strip() or not str(g.get("name") or "").strip():
            raise ValueError("each group needs a key and a name")
        key = str(g["key"]).strip()
        if key in keys:
            raise ValueError(f"duplicate group key {key!r}")
        keys.add(key)
        model = g.get("delivery_model") or None
        if model not in (None, "self_perform", "subcontracted"):
            raise ValueError(f"group {key}: delivery_model must be self_perform, subcontracted or empty")
        accounts = g.get("accounts") or []
        if not isinstance(accounts, list) or not all(isinstance(a, str) for a in accounts):
            raise ValueError(f"group {key}: accounts must be a list of account slugs")
        try:
            fixed = float(g.get("fixed_monthly") or 0)
        except (TypeError, ValueError):
            raise ValueError(f"group {key}: fixed_monthly must be a number") from None
        if fixed < 0:
            raise ValueError(f"group {key}: fixed_monthly must not be negative")
        clean.append({"key": key, "name": str(g["name"]).strip(), "accounts": accounts, "delivery_model": model,
                      "fixed_monthly": fixed, "shares_pool": bool(g.get("shares_pool")), "rest": bool(g.get("rest"))})
    if sum(1 for g in clean if g["rest"]) != 1:
        raise ValueError("exactly one group must take the rest of the jobs")
    if not any(g["shares_pool"] for g in clean):
        raise ValueError("at least one group must share the overhead pool")
    out["groups"] = clean
    if out["pool_basis"] not in POOL_BASES:
        raise ValueError(f"pool_basis must be one of {', '.join(POOL_BASES)}")
    ranges = out["gl_categories"]
    if not isinstance(ranges, list):
        raise ValueError("gl_categories must be a list of {from, to, category}")
    clean_ranges = []
    for r in ranges:
        if not isinstance(r, dict) or r.get("category") not in CATEGORIES:
            raise ValueError(f"gl_categories: each range needs from, to and a category in {', '.join(CATEGORIES)}")
        lo, hi = str(r.get("from") or "").strip(), str(r.get("to") or r.get("from") or "").strip()
        if not lo.isdigit() or not hi.isdigit() or int(lo) > int(hi):
            raise ValueError("gl_categories: from and to must be GL account numbers, from ≤ to")
        clean_ranges.append({"from": lo, "to": hi, "category": r["category"]})
    out["gl_categories"] = clean_ranges
    return out


# ------------------------------------------------------------------------------------- line classification

_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("subcontractors", ("subcontract",)),
    ("payroll_taxes_insurance", ("payrolltax", "fica", "futa", "suta", "sui", "medicare", "socialsecurity", "unemployment",
                                 "workerscomp", "workmanscomp", "workerscompensation", "healthins", "medicalins", "benefit",
                                 "payrollinsurance", "employeeinsurance", "401k")),
    ("revenue", ("revenue", "sales", "billing", "income")),
    ("direct_labor", ("wage", "salar", "labor", "overtime", "bonus", "vacation", "holidaypay", "sickpay", "pto", "payroll")),
    ("supplies", ("suppl", "material", "chemical", "equipment", "consumable")),
)
SKIP = re.compile(r"^(total|subtotal|grossprofit|grossmargin|netincome|netprofit|netloss|netoperating|operatingincome|"
                  r"incomebefore|ebitda|totalexpense|totalcost)", re.I)
NOT_REVENUE = ("costof", "expense", "netincome")


def compact(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def gl_number(label: str) -> str | None:
    """The leading GL account number of a line label ("40100 - Wages", "4010-00 Wages") if it has one."""
    match = re.match(r"\s*(\d{4,6})(?:[-.](\d{1,3}))?\b", str(label or ""))
    return match[1] if match else None


def classify(label: str, gl_ranges: list[dict[str, str]]) -> str:
    gl = gl_number(label)
    if gl:
        for r in gl_ranges:
            if len(r["from"]) == len(gl) and r["from"] <= gl <= r["to"]:
                return r["category"]
    key = compact(re.sub(r"^\s*[\d.\-]+\s*", "", str(label or "")))
    for category, words in _KEYWORDS:
        if any(w in key for w in words):
            if category == "revenue" and any(w in key for w in NOT_REVENUE):
                continue
            return category
    return "operating_expense"


def is_subtotal(label: str) -> bool:
    return bool(SKIP.match(compact(label)))


# ------------------------------------------------------------------------------------------ cross tab parse

@dataclass
class ParsedLines:
    rows_read: int = 0
    records: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def error(self, message: str) -> None:
        if len(self.errors) < 50:
            self.errors.append(message)


MONTHS = {m: i for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), start=1)}
_JOB = re.compile(r"^\s*(?:job\s*#?\s*)?([A-Za-z]{0,6}[:]?\d{1,7}[A-Za-z]?)\b(?:\s*[-–:]\s*(.*))?$")
LABEL_HEADERS = {"account", "glaccount", "description", "accountdescription", "glaccountdescription", "line", "linename", "lineitem", "accountname"}
LONG = {"job_number": ("jobnumber", "jobno", "job"), "line": ("line", "linename", "description", "accountdescription", "glaccountdescription", "accountname", "account", "glaccount"),
        "amount": ("amount", "total", "actual", "value"), "period": ("period", "month", "periodid", "fiscalperiod"),
        "company": ("company", "companyname"), "job_name": ("jobdescription", "jobname"), "gl_account": ("glaccountnumber", "accountnumber", "glnumber")}


def period_from_text(text: str) -> date | None:
    """A month in free text: "2026-09", "202609", "09/2026", "9/30/2026", "Sep 2026", "September 2026"."""
    t = str(text or "")
    for pattern, build in (
        (r"(20\d{2})[-_ ](\d{1,2})(?:[-_ ]\d{1,2})?\b", lambda m: (int(m[1]), int(m[2]))),
        (r"\b(\d{1,2})/(\d{1,2})/(20\d{2})\b", lambda m: (int(m[3]), int(m[1]))),
        (r"\b(\d{1,2})/(20\d{2})\b", lambda m: (int(m[2]), int(m[1]))),
        (r"\b(20\d{2})(\d{2})\b", lambda m: (int(m[1]), int(m[2]))),
        (r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s_-]*(20\d{2})\b", lambda m: (int(m[2]), MONTHS[m[1].lower()[:3]])),
    ):
        match = re.search(pattern, t, re.I)
        if match:
            year, month = build(match)
            if 1 <= month <= 12:
                return date(year, month, 1)
    return None


def _number(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        return Decimal(str(value))
    text = str(value).strip()
    if not text or text in ("-", "–"):
        return None
    negative = text.startswith("(") and text.endswith(")")
    cleaned = re.sub(r"[,$\s()]", "", text)
    if cleaned.endswith("-"):
        negative, cleaned = True, cleaned[:-1]
    try:
        number = Decimal(cleaned)
    except Exception:
        return None
    return -number if negative else number


def read_grid(file_name: str, content: bytes) -> list[list[Any]]:
    """Every row of a CSV or the first sheet of an XLSX, title rows included."""
    if file_name.lower().endswith((".xlsx", ".xlsm")):
        from openpyxl import load_workbook

        sheet = load_workbook(io.BytesIO(content), read_only=True, data_only=True).worksheets[0]
        return [list(r) for r in sheet.iter_rows(values_only=True)]
    import csv

    return [list(r) for r in csv.reader(io.StringIO(content.decode("utf-8-sig", errors="replace")))]


def _job_cell(value: Any) -> tuple[str, str | None] | None:
    if value is None or isinstance(value, (int, float)) and not isinstance(value, bool) and not float(value).is_integer():
        return None
    text = str(int(value)) if isinstance(value, float) else str(value).strip()
    if not text or compact(text) in ("total", "totals", "grandtotal", "alljobs"):
        return None
    match = _JOB.match(text)
    if not match:
        return None
    return match[1], (match[2] or "").strip() or None


def parse(file_name: str, content: bytes, gl_ranges: list[dict[str, str]], company_names: Iterable[str] = (),
          period: date | None = None) -> ParsedLines:
    """Lines of a Cross Tab Income Statement by job, wide (a label column, then one column per job) or long
    (job, line, amount columns). The month comes from a Period column, else a title row, else the file name,
    else `period`. Subtotal rows (Total ..., Gross Profit, Net Income) are skipped. When the report shows
    revenue as negative (GL credits), every amount is flipped so revenue reads positive and costs positive."""
    out = ParsedLines()
    try:
        grid = read_grid(file_name, content)
    except Exception as exc:  # unreadable workbook / encoding
        out.error(f"could not read the file: {exc.__class__.__name__}")
        return out
    grid = [r for r in grid if any(v not in (None, "") for v in r)]
    if not grid:
        out.error("no rows")
        return out
    names = {compact(n): n for n in company_names if n}
    title_month, title_company, header_at = None, "", None
    for i, row in enumerate(grid[:15]):
        cells = [str(v).strip() for v in row if v not in (None, "")]
        jobs = sum(1 for v in row[1:] if _job_cell(v))
        keys = {compact(v) for v in row if v not in (None, "")}
        if (jobs >= 2 and (keys & LABEL_HEADERS or _job_cell(row[0]) is None)) or {"jobnumber", "amount"} <= keys or ("job" in keys and "amount" in keys):
            header_at = i
            break
        text = " ".join(cells)
        title_month = title_month or period_from_text(text)
        for key, name in names.items():
            if key and key in compact(text):
                title_company = title_company or name
    if header_at is None:
        out.error("no header row: expected a label column and one column per job, or job, line and amount columns")
        return out
    header = grid[header_at]
    month = title_month or period_from_text(file_name) or period
    keys = [compact(h) for h in header]
    long_cols = {f: next((i for i, k in enumerate(keys) if k in aliases), None) for f, aliases in LONG.items()}
    body = grid[header_at + 1:]
    raw: list[dict[str, Any]] = []
    if long_cols["job_number"] is not None and long_cols["amount"] is not None and long_cols["line"] is not None:
        for n, row in enumerate(body, start=header_at + 2):
            out.rows_read += 1
            cell = lambda f: row[long_cols[f]] if long_cols[f] is not None and long_cols[f] < len(row) else None  # noqa: E731
            label = str(cell("line") or "").strip()
            job = _job_cell(cell("job_number"))
            amount = _number(cell("amount"))
            if not label or job is None or amount is None or is_subtotal(label):
                continue
            row_month = month
            if long_cols["period"] is not None and cell("period") not in (None, ""):
                p = cell("period")
                row_month = p.replace(day=1) if isinstance(p, date) else (p.date().replace(day=1) if isinstance(p, datetime) else period_from_text(str(p)))
                if row_month is None:
                    out.error(f"row {n}: not a month: {p!r}")
                    continue
            gl = str(cell("gl_account") or "").strip() or gl_number(label)
            raw.append({"month": row_month, "company": str(cell("company") or title_company or "").strip(), "job_number": job[0],
                        "job_name": str(cell("job_name") or "").strip() or job[1], "label": label if not gl or label.startswith(gl) else f"{gl} {label}",
                        "amount": amount})
    else:
        label_col = next((i for i, k in enumerate(keys) if k in LABEL_HEADERS), 0)
        job_cols = [(i, _job_cell(h)) for i, h in enumerate(header) if i != label_col and _job_cell(h)]
        if not job_cols:
            out.error("no job columns in the header row")
            return out
        for row in body:
            out.rows_read += 1
            label = str(row[label_col] if label_col < len(row) and row[label_col] is not None else "").strip()
            if not label or is_subtotal(label):
                continue
            for i, (job, name) in job_cols:
                amount = _number(row[i]) if i < len(row) else None
                if amount:
                    raw.append({"month": month, "company": title_company, "job_number": job, "job_name": name, "label": label, "amount": amount})
    if not raw:
        out.error("no amounts")
        return out
    if any(r["month"] is None for r in raw):
        out.error("no month: add a Period column, a title row with the period, or the month in the file name (e.g. job_income_statement_2026-09.xlsx)")
        return out
    revenue = sum((r["amount"] for r in raw if classify(r["label"], gl_ranges) == "revenue"), Decimal(0))
    flip = revenue < 0
    totals: dict[tuple[date, str, str, str], dict[str, Any]] = {}
    for r in raw:
        line = compact(r["label"])[:120]
        key = (r["month"], r["company"], r["job_number"], line)
        slot = totals.setdefault(key, {"month": r["month"], "company": r["company"], "job_number": r["job_number"], "job_name": r["job_name"],
                                       "line": line, "label": r["label"][:200], "gl_account": gl_number(r["label"]),
                                       "category": classify(r["label"], gl_ranges), "amount": Decimal(0)})
        slot["amount"] += -r["amount"] if flip else r["amount"]
    out.records = list(totals.values())
    return out


def load_lines(cursor: Any, file_id: int, records: list[dict[str, Any]]) -> None:
    """Replace the (month, company) the file covers; a company-less file replaces that month's company-less rows."""
    for month, company in {(r["month"], r["company"]) for r in records}:
        cursor.execute("DELETE FROM core.fact_job_income_statement_month WHERE month = %s AND company = %s", (month, company))
    cursor.executemany(
        """
        INSERT INTO core.fact_job_income_statement_month (month, company, job_number, job_name, line, label, gl_account, category, amount, import_file_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        [(r["month"], r["company"], r["job_number"], r["job_name"], r["line"], r["label"], r["gl_account"], r["category"], r["amount"], file_id)
         for r in records],
    )


# ------------------------------------------------------------------------------------------- contracts

CONTRACT_COLS = {"company": ("company", "companyname"), "job_number": ("jobnumber", "jobno", "job"),
                 "effective_from": ("effectivefrom", "effective", "effectivedate", "startdate", "start", "month", "period"),
                 "monthly_amount": ("monthlyamount", "monthlycontract", "contractamount", "contract", "amount", "monthly")}


def parse_contracts(headers: list[str], rows: list[dict[str, Any]]) -> ParsedLines:
    from .imports import parse_date  # noqa: PLC0415 (imports imports this module)

    out = ParsedLines(rows_read=len(rows))
    keys = {compact(h): h for h in headers}
    cols = {f: next((keys[a] for a in aliases if a in keys), None) for f, aliases in CONTRACT_COLS.items()}
    missing = [f for f in ("job_number", "effective_from", "monthly_amount") if cols[f] is None]
    if missing:
        out.error(f"missing columns: {', '.join(missing)}")
        return out
    for n, row in enumerate(rows, start=2):
        job = _job_cell(row.get(cols["job_number"]))
        amount = _number(row.get(cols["monthly_amount"]))
        raw_date = row.get(cols["effective_from"])
        try:
            start = period_from_text(str(raw_date)) if isinstance(raw_date, str) and re.fullmatch(r"\s*\d{4}-\d{1,2}\s*", raw_date) else parse_date(raw_date)
        except ValueError as exc:
            out.error(f"row {n}: {exc}")
            continue
        if job is None or amount is None or amount < 0 or start is None:
            out.error(f"row {n}: needs a job number, an effective date and a monthly amount ≥ 0")
            continue
        out.records.append({"company": str(row.get(cols["company"]) or "").strip() if cols["company"] else "", "job_number": job[0],
                            "effective_from": start, "period": start, "monthly_amount": amount})
    return out


def load_contracts(cursor: Any, records: list[dict[str, Any]], actor: str | None) -> None:
    cursor.executemany(
        """
        INSERT INTO ops.job_contract (company, job_number, effective_from, monthly_amount, updated_by) VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (company, job_number, effective_from) DO UPDATE SET monthly_amount = EXCLUDED.monthly_amount, updated_at = now(),
          updated_by = EXCLUDED.updated_by
        """,
        [(r["company"], r["job_number"], r["effective_from"], r["monthly_amount"], actor) for r in records],
    )


# ---------------------------------------------------------------------------------------------- compute

def _zero() -> dict[str, float]:
    return {c: 0.0 for c in CATEGORIES}


def _pl(lines: dict[str, float]) -> dict[str, float]:
    direct = sum(lines[c] for c in DIRECT)
    gp = lines["revenue"] - direct
    return {**{c: round(lines[c], 2) for c in CATEGORIES}, "direct_costs": round(direct, 2), "gross_profit": round(gp, 2),
            "before_overhead": round(gp - lines["operating_expense"], 2)}


def group_of(meta: dict[str, Any] | None, groups: list[dict[str, Any]]) -> str:
    account = (meta or {}).get("account")
    model = (meta or {}).get("delivery_model")
    for g in groups:
        if g["rest"]:
            continue
        if account in g["accounts"] and (g["delivery_model"] is None or g["delivery_model"] == model):
            return g["key"]
    return next(g["key"] for g in groups if g["rest"])


def adjusted_lines(month: date, lines: list[dict[str, Any]], adjustments: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """The month's job lines with accruals, reversals and reclasses applied, and the adjustments that applied."""
    out = [dict(r) for r in lines]
    applied = []
    for a in adjustments:
        amount = float(a["amount"])
        if a["kind"] == "accrual":
            if a.get("cleared_at"):
                continue
            if a["month"] == month:
                out.append({"company": a.get("to_company") or "", "job_number": a["to_job"], "category": a["category"], "amount": amount, "adjustment_id": a["adjustment_id"]})
                applied.append({**a, "effect": amount})
            elif a.get("reverse_month") == month:
                out.append({"company": a.get("to_company") or "", "job_number": a["to_job"], "category": a["category"], "amount": -amount, "adjustment_id": a["adjustment_id"]})
                applied.append({**a, "effect": -amount})
        elif a["kind"] == "reclass" and a["month"] == month:
            out.append({"company": a.get("from_company") or "", "job_number": a["from_job"], "category": a["category"], "amount": -amount, "adjustment_id": a["adjustment_id"]})
            out.append({"company": a.get("to_company") or "", "job_number": a["to_job"], "category": a["category"], "amount": amount, "adjustment_id": a["adjustment_id"]})
            applied.append({**a, "effect": 0.0})
        elif a["kind"] == "staff" and a["month"] == month:
            applied.append({**a, "effect": 0.0})
    return out, applied


def build_month(month: date, lines: list[dict[str, Any]], job_meta: dict[tuple[str, str], dict[str, Any]], adjustments: list[dict[str, Any]],
                cfg: dict[str, Any], account_names: dict[str, str] | None = None) -> dict[str, Any]:
    """One month of the company P&L. `lines`: {company, job_number, category, amount}; `job_meta`:
    (company, job_number) -> {account, delivery_model, job_name} (a ('', job) key matches any company)."""
    groups = cfg["groups"]
    overhead_jobs = set(cfg["overhead_jobs"])
    lines, applied = adjusted_lines(month, lines, adjustments)

    def meta_of(company: str, job: str) -> dict[str, Any] | None:
        return job_meta.get((company, job)) or job_meta.get(("", job))

    company_all, operating, overhead = _zero(), _zero(), _zero()
    by_group = {g["key"]: _zero() for g in groups}
    by_account: dict[str, dict[str, float]] = {}
    job_group: dict[tuple[str, str], str] = {}
    job_lines: dict[tuple[str, str], dict[str, float]] = {}
    for r in lines:
        cat, amount, job = r["category"], float(r["amount"]), str(r["job_number"])
        company_all[cat] += amount
        bare = job.split(":")[-1]
        if job in overhead_jobs or bare in overhead_jobs:
            overhead[cat] += amount
            continue
        operating[cat] += amount
        key = (r.get("company") or "", job)
        meta = meta_of(*key)
        g = job_group.setdefault(key, group_of(meta, groups))
        by_group[g][cat] += amount
        slot = job_lines.setdefault(key, _zero())
        slot[cat] += amount
        account = (meta or {}).get("account") or "other"
        by_account.setdefault(account, _zero())[cat] += amount

    overhead_cost = sum(overhead[c] for c in CATEGORIES if c != "revenue") - overhead["revenue"]
    staff = {g["key"]: 0.0 for g in groups}
    for a in applied:
        if a["kind"] == "staff" and a["group_key"] in staff:
            staff[a["group_key"]] += float(a["amount"])
    fixed = {g["key"]: g["fixed_monthly"] for g in groups}
    pool = overhead_cost - sum(fixed.values()) - sum(staff.values())
    sharing = [g["key"] for g in groups if g["shares_pool"]]
    share_base = sum(max(by_group[k]["revenue"], 0.0) for k in sharing)
    groups_out = []
    load: dict[str, float] = {}
    for g in groups:
        k = g["key"]
        p = _pl(by_group[k])
        pool_share = pool * max(by_group[k]["revenue"], 0.0) / share_base if k in sharing and share_base else 0.0
        load[k] = fixed[k] + staff[k] + pool_share
        groups_out.append({"key": k, "name": g["name"], **p, "fixed_charge": round(fixed[k], 2), "direct_staff": round(staff[k], 2),
                           "pool_charge": round(pool_share, 2), "pool_share": round(pool_share / pool, 4) if pool and k in sharing else None,
                           "overhead": round(load[k], 2), "after_overhead": round(p["before_overhead"] - load[k], 2),
                           "margin": round((p["before_overhead"] - load[k]) / p["revenue"], 4) if p["revenue"] else None})
    # An account carries its jobs' share of their group's overhead by revenue.
    account_load: dict[str, float] = {}
    for key, jl in job_lines.items():
        g = job_group[key]
        g_rev = by_group[g]["revenue"]
        if g_rev > 0 and jl["revenue"] > 0:
            account = (meta_of(*key) or {}).get("account") or "other"
            account_load[account] = account_load.get(account, 0.0) + load[g] * jl["revenue"] / g_rev
    accounts_out = {}
    for slug, al in by_account.items():
        p = _pl(al)
        oh = account_load.get(slug, 0.0)
        accounts_out[slug] = {"name": (account_names or {}).get(slug, "Other" if slug == "other" else slug), **p, "overhead": round(oh, 2),
                              "after_overhead": round(p["before_overhead"] - oh, 2)}
    op = _pl(operating)
    net = op["before_overhead"] - overhead_cost
    return {
        "month": month.isoformat(),
        "company": {"revenue": round(company_all["revenue"], 2), "operating_revenue": op["revenue"], **{c: op[c] for c in DIRECT},
                    "direct_costs": op["direct_costs"], "gross_profit": op["gross_profit"], "operating_expense": op["operating_expense"],
                    "before_overhead": op["before_overhead"], "overhead": round(overhead_cost, 2), "net_profit": round(net, 2),
                    "gross_margin": round(op["gross_profit"] / op["revenue"], 4) if op["revenue"] else None,
                    "net_margin": round(net / company_all["revenue"], 4) if company_all["revenue"] else None,
                    "overhead_pct": round(overhead_cost / op["revenue"], 4) if op["revenue"] else None},
        "overhead": {"cost": round(overhead_cost, 2), "revenue_on_overhead_jobs": round(overhead["revenue"], 2),
                     "fixed": round(sum(fixed.values()), 2), "direct_staff": round(sum(staff.values()), 2), "pool": round(pool, 2)},
        "groups": groups_out,
        "accounts": accounts_out,
        "adjustments": [{"adjustment_id": a["adjustment_id"], "kind": a["kind"], "category": a["category"], "amount": float(a["amount"]),
                         "effect": a["effect"], "description": a["description"], "reversal": a["kind"] == "accrual" and a["month"] != month}
                        for a in applied],
    }


# ------------------------------------------------------------------------------------------ warehouse IO

ADJ_COLUMNS = ("adjustment_id", "month", "kind", "category", "amount", "from_company", "from_job", "to_company", "to_job", "group_key",
               "description", "reverse_month", "cleared_at", "cleared_by", "created_at", "created_by", "updated_at", "updated_by")


def load_adjustments(cursor: Any, first: date | None = None, last: date | None = None) -> list[dict[str, Any]]:
    where, params = "", {}
    if first and last:
        where, params = "WHERE month BETWEEN %(first)s AND %(last)s OR reverse_month BETWEEN %(first)s AND %(last)s", {"first": first, "last": last}
    cursor.execute(f"SELECT {', '.join(ADJ_COLUMNS)} FROM ops.pl_adjustment {where} ORDER BY month, adjustment_id", params)
    return [dict(r) for r in cursor.fetchall()]


def job_meta(cursor: Any) -> dict[tuple[str, str], dict[str, Any]]:
    """(company, job) -> {account, delivery_model}: the account mapping (featured accounts; other jobs are
    'other') and the job's latest delivery model. Also a ('', job) entry for files without a company."""
    cursor.execute(
        """
        WITH latest AS (
          SELECT DISTINCT ON (company, job_number) company, job_number, delivery_model
          FROM mart.leadership_week WHERE week_start >= current_date - 120 ORDER BY company, job_number, week_start DESC
        )
        SELECT aj.company, aj.job_number, CASE WHEN a.featured AND aj.role IS DISTINCT FROM 'non_billed' THEN aj.account_slug END AS account,
               l.delivery_model
        FROM ops.account_job aj LEFT JOIN ops.account a ON a.slug = aj.account_slug
        LEFT JOIN latest l ON l.company = aj.company AND l.job_number = aj.job_number
        """
    )
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for r in cursor.fetchall():
        meta = {"account": r["account"], "delivery_model": r["delivery_model"]}
        out[(r["company"], r["job_number"])] = meta
        out.setdefault(("", r["job_number"]), meta)
    return out


def report(cursor: Any, months: int = 12) -> dict[str, Any]:
    """The last `months` months that have Cross Tab lines, each built with build_month."""
    cfg = settings_of(cursor)
    cursor.execute("SELECT DISTINCT month FROM core.fact_job_income_statement_month ORDER BY month DESC LIMIT %s", (months,))
    keys = sorted(r["month"] for r in cursor.fetchall())
    if not keys:
        return {"settings": cfg, "months": [], "loaded": []}
    cursor.execute("SELECT month, company, job_number, category, sum(amount) AS amount FROM core.fact_job_income_statement_month "
                   "WHERE month = ANY(%s) GROUP BY month, company, job_number, category", (keys,))
    by_month: dict[date, list[dict[str, Any]]] = {}
    for r in cursor.fetchall():
        by_month.setdefault(r["month"], []).append({"company": r["company"], "job_number": r["job_number"], "category": r["category"], "amount": float(r["amount"])})
    cursor.execute("SELECT slug, name FROM ops.account")
    names = {r["slug"]: r["name"] for r in cursor.fetchall()}
    meta = job_meta(cursor)
    adjustments = load_adjustments(cursor, keys[0], keys[-1])
    cursor.execute("SELECT month, max(f.loaded_at) AS loaded_at, array_agg(DISTINCT s.company) AS companies "
                   "FROM core.fact_job_income_statement_month s LEFT JOIN ops.import_file f USING (import_file_id) "
                   "WHERE month = ANY(%s) GROUP BY month ORDER BY month", (keys,))
    loaded = [{"month": r["month"].isoformat(), "loaded_at": r["loaded_at"].isoformat() if r["loaded_at"] else None,
               "companies": [c for c in (r["companies"] or []) if c]} for r in cursor.fetchall()]
    return {"settings": cfg, "months": [build_month(m, by_month.get(m, []), meta, adjustments, cfg, names) for m in keys], "loaded": loaded}


def _month(value: Any) -> date | None:
    if value in (None, ""):
        return None
    if isinstance(value, date):
        return value.replace(day=1)
    try:
        return date.fromisoformat(f"{str(value)[:7]}-01")
    except ValueError:
        raise ValueError("months must be YYYY-MM") from None


def validate_adjustment(body: dict[str, Any], groups: list[dict[str, Any]]) -> dict[str, Any]:
    kind = body.get("kind")
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    category = body.get("category") or ("operating_expense" if kind == "staff" else None)
    if category not in CATEGORIES:
        raise ValueError(f"category must be one of {', '.join(CATEGORIES)}")
    try:
        amount = float(body.get("amount"))
    except (TypeError, ValueError):
        raise ValueError("amount must be a number") from None
    description = str(body.get("description") or "").strip()
    if not description:
        raise ValueError("description is required")
    month = _month(body.get("month"))
    if month is None:
        raise ValueError("month is required")
    out = {"month": month, "kind": kind, "category": category, "amount": amount, "description": description[:500],
           "from_company": (body.get("from_company") or "").strip() or None, "from_job": (str(body.get("from_job") or "")).strip() or None,
           "to_company": (body.get("to_company") or "").strip() or None, "to_job": (str(body.get("to_job") or "")).strip() or None,
           "group_key": (body.get("group_key") or "").strip() or None, "reverse_month": _month(body.get("reverse_month"))}
    if kind == "accrual" and not out["to_job"]:
        raise ValueError("an accrual needs the job it posts to")
    if kind == "reclass" and not (out["from_job"] and out["to_job"]):
        raise ValueError("a reclass needs the job it moves from and the job it moves to")
    if kind == "reclass" and amount <= 0:
        raise ValueError("a reclass amount must be positive")
    if kind == "staff":
        if out["group_key"] not in {g["key"] for g in groups}:
            raise ValueError("a staff charge needs one of the P&L groups")
        out["category"] = "operating_expense"
    if out["reverse_month"] is not None and (kind != "accrual" or out["reverse_month"] <= month):
        raise ValueError("only an accrual reverses, in a later month")
    return out


# ----------------------------------------------------------------------------- missing sub invoice accruals

SHORT_SHARE = 0.9


def next_month(month: date) -> date:
    return date(month.year + (month.month == 12), month.month % 12 + 1, 1)


def prior_month(month: date) -> date:
    return date(month.year - (month.month == 1), (month.month - 2) % 12 + 1, 1)


def suggestions_from(now: dict[tuple[str, str], dict[str, Any]], before: dict[tuple[str, str], dict[str, Any]],
                     candidates: dict[tuple[str, str], dict[str, Any]], open_accruals: set[str]) -> list[dict[str, Any]]:
    """Subcontracted sites billed in the month whose subcontractor cost on the GL is under SHORT_SHARE of the
    month before: the sub invoice has not posted. Suggested at the prior month's cost less what has posted
    (Finance's month-end accrual). A site with an open subcontractor accrual for the month is left out.
    `now` / `before`: (company, job) -> {revenue, subcontractors}; `candidates`: (company, job) -> {job_name,
    relay_ar, relay_ap, relay_not_in_winteam}."""
    out = []
    for key, c in candidates.items():
        if key[1] in open_accruals:
            continue
        cur, last = now.get(key, {}), before.get(key, {})
        billed = max(float(cur.get("revenue") or 0), float(c.get("relay_ar") or 0))
        sub_now, sub_before = float(cur.get("subcontractors") or 0), float(last.get("subcontractors") or 0)
        if billed <= 0 or sub_before <= 0 or sub_now >= SHORT_SHARE * sub_before:
            continue
        out.append({"company": key[0], "job_number": key[1], "job_name": c.get("job_name"), "revenue": round(billed, 2),
                    "subcontractors": round(sub_now, 2), "prior_subcontractors": round(sub_before, 2),
                    "relay_ap": c.get("relay_ap"), "relay_not_in_winteam": c.get("relay_not_in_winteam"),
                    "amount": round(sub_before - sub_now, 2)})
    return sorted(out, key=lambda x: -x["amount"])


def _gl_month(cursor: Any, month: date) -> dict[tuple[str, str], dict[str, float]]:
    """Revenue and subcontractor cost per (company, job) on the GL for a month: the Cross Tab when that month
    is loaded, else the Job Cost Analysis. Adjustments are not applied (the GL as posted)."""
    cursor.execute("SELECT 1 FROM core.fact_job_income_statement_month WHERE month = %s LIMIT 1", (month,))
    if cursor.fetchone():
        cursor.execute("SELECT company, job_number, sum(amount) FILTER (WHERE category = 'revenue') AS revenue, "
                       "sum(amount) FILTER (WHERE category = 'subcontractors') AS subcontractors "
                       "FROM core.fact_job_income_statement_month WHERE month = %s GROUP BY company, job_number", (month,))
    else:
        cursor.execute("SELECT company, job_number, revenue, subcontractors FROM mart.v_job_cost_month_effective WHERE month = %s", (month,))
    out: dict[tuple[str, str], dict[str, float]] = {}
    for r in cursor.fetchall():
        slot = out.setdefault((r["company"] or "", r["job_number"]), {"revenue": 0.0, "subcontractors": 0.0})
        slot["revenue"] += float(r["revenue"] or 0)
        slot["subcontractors"] += float(r["subcontractors"] or 0)
    return out


def suggest_accruals(cursor: Any, month: date) -> list[dict[str, Any]]:
    """Accruals Finance books at month end for sub invoices not posted, for the subcontracted Relay (FedEx)
    sites. Relay's AP for the month says whether the invoice is in Relay but not yet in WinTeam."""
    now, before = _gl_month(cursor, month), _gl_month(cursor, prior_month(month))
    cursor.execute(
        """
        SELECT j.company, rc.job_number, max(j.job_name) AS job_name, max(rm.ar_revenue) AS relay_ar, max(rm.ap_amount) AS relay_ap,
               max(rm.payables_not_in_winteam) AS relay_not_in_winteam
        FROM mart.v_relay_job_contract rc
        JOIN core.dim_job j ON j.job_number = rc.job_number AND j.valid_to IS NULL AND j.company IS DISTINCT FROM 'Sarus'
        LEFT JOIN mart.v_relay_job_month rm ON rm.job_number = rc.job_number AND rm.month = %s
        WHERE NOT coalesce(rc.self_perform, false)
        GROUP BY j.company, rc.job_number
        """,
        (month,),
    )
    candidates = {}
    for r in cursor.fetchall():
        key = (r["company"], r["job_number"])
        candidates[key] = {"job_name": r["job_name"], **{k: (float(r[k]) if r[k] is not None else None) for k in ("relay_ar", "relay_ap", "relay_not_in_winteam")}}
        # A Cross Tab loaded without a company keys its jobs by '' alone.
        for gl in (now, before):
            if key not in gl and ("", key[1]) in gl:
                gl[key] = gl[("", key[1])]
    open_accruals = {a["to_job"] for a in load_adjustments(cursor, month, month)
                     if a["kind"] == "accrual" and a["category"] == "subcontractors" and a["month"] == month and not a.get("cleared_at")}
    return suggestions_from(now, before, candidates, open_accruals)
