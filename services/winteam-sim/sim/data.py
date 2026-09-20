"""Deterministic synthetic WinTeam portfolio.

Everything here is generated from a seeded ``random.Random`` plus the
configured ``today`` so two processes with the same configuration produce
byte-identical responses. Nothing in this module knows about HTTP.
"""

from __future__ import annotations

import bisect
import hashlib
import math
import os
import random
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Iterable

DEFAULT_TENANT_ID = "11111111-1111-4111-8111-111111111111"

# --------------------------------------------------------------------------- #
# Formatting helpers (WinTeam emits dates at noon UTC, e.g. 2022-10-01T12:00:00Z)
# --------------------------------------------------------------------------- #


def fmt_date(d: date) -> str:
    return f"{d.isoformat()}T12:00:00Z"


def fmt_time(d: date, minutes: int) -> str:
    dd = d + timedelta(days=minutes // 1440)
    m = minutes % 1440
    return f"{dd.isoformat()}T{m // 60:02d}:{m % 60:02d}:00Z"


def num(x: float) -> int | float:
    """Emit whole numbers as ints (``8`` not ``8.0``), otherwise 2 decimals."""
    r = round(float(x), 2)
    return int(r) if r.is_integer() else r


def month_start(d: date) -> date:
    return d.replace(day=1)


def month_end(d: date) -> date:
    nxt = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    return nxt - timedelta(days=1)


def add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    return date(d.year + y, m + 1, 1)


def week_start(d: date) -> date:
    """Sunday-start week (WinTeam overtime weeks run Sun-Sat)."""
    return d - timedelta(days=(d.weekday() + 1) % 7)


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class SimConfig:
    seed: int = 7
    jobs: int = 48
    months: int = 24
    tenant_id: str = DEFAULT_TENANT_ID
    today: date = field(default_factory=date.today)
    subscription_key: str | None = None
    rate_limit_every: int = 0

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "SimConfig":
        env = dict(os.environ if env is None else env)

        def _int(name: str, default: int) -> int:
            raw = env.get(name, "").strip()
            return int(raw) if raw else default

        today_raw = env.get("SIM_TODAY", "").strip()
        today = date.fromisoformat(today_raw) if today_raw else date.today()
        key = env.get("SIM_SUBSCRIPTION_KEY", "").strip() or None
        return cls(
            seed=_int("SIM_SEED", 7),
            jobs=max(1, _int("SIM_JOBS", 48)),
            months=max(1, _int("SIM_MONTHS", 24)),
            tenant_id=env.get("SIM_TENANT_ID", "").strip() or DEFAULT_TENANT_ID,
            today=today,
            subscription_key=key,
            rate_limit_every=max(0, _int("SIM_RATE_LIMIT_EVERY", 0)),
        )


# --------------------------------------------------------------------------- #
# Reference data
# --------------------------------------------------------------------------- #

# city, state, country, lat, lon, region, postal code
CITIES: list[tuple[str, str, str, float, float, str, str]] = [
    ("Columbus", "OH", "US", 39.9612, -82.9988, "Midwest", "43219"),
    ("Indianapolis", "IN", "US", 39.7684, -86.1581, "Midwest", "46241"),
    ("Chicago", "IL", "US", 41.8781, -87.6298, "Midwest", "60638"),
    ("Minneapolis", "MN", "US", 44.9778, -93.2650, "Midwest", "55401"),
    ("Kansas City", "MO", "US", 39.0997, -94.5786, "Midwest", "64120"),
    ("Omaha", "NE", "US", 41.2565, -95.9345, "Midwest", "68117"),
    ("Milwaukee", "WI", "US", 43.0389, -87.9065, "Midwest", "53214"),
    ("Detroit", "MI", "US", 42.3314, -83.0458, "Midwest", "48210"),
    ("Dallas", "TX", "US", 32.7767, -96.7970, "Southwest", "75247"),
    ("Houston", "TX", "US", 29.7604, -95.3698, "Southwest", "77032"),
    ("Phoenix", "AZ", "US", 33.4484, -112.0740, "Southwest", "85043"),
    ("Oklahoma City", "OK", "US", 35.4676, -97.5164, "Southwest", "73127"),
    ("Atlanta", "GA", "US", 33.7490, -84.3880, "Southeast", "30336"),
    ("Charlotte", "NC", "US", 35.2271, -80.8431, "Southeast", "28273"),
    ("Nashville", "TN", "US", 36.1627, -86.7816, "Southeast", "37210"),
    ("Orlando", "FL", "US", 28.5383, -81.3792, "Southeast", "32824"),
    ("Richmond", "VA", "US", 37.5407, -77.4360, "Southeast", "23230"),
    ("Newark", "NJ", "US", 40.7357, -74.1724, "Northeast", "07114"),
    ("Boston", "MA", "US", 42.3601, -71.0589, "Northeast", "02128"),
    ("Philadelphia", "PA", "US", 39.9526, -75.1652, "Northeast", "19153"),
    ("Hartford", "CT", "US", 41.7658, -72.6734, "Northeast", "06114"),
    ("Albany", "NY", "US", 42.6526, -73.7562, "Northeast", "12205"),
    ("Denver", "CO", "US", 39.7392, -104.9903, "West", "80239"),
    ("Salt Lake City", "UT", "US", 40.7608, -111.8910, "West", "84104"),
    ("Reno", "NV", "US", 39.5296, -119.8138, "West", "89502"),
    ("Sacramento", "CA", "US", 38.5816, -121.4944, "West", "95828"),
    ("Portland", "OR", "US", 45.5152, -122.6784, "West", "97218"),
    ("Seattle", "WA", "US", 47.6062, -122.3321, "West", "98108"),
    ("Toronto", "ON", "CA", 43.6532, -79.3832, "Canada", "M5V 2T6"),
    ("Vancouver", "BC", "CA", 49.2827, -123.1207, "Canada", "V6B 1A1"),
    ("Calgary", "AB", "CA", 51.0447, -114.0719, "Canada", "T2P 1J9"),
    ("Montreal", "QC", "CA", 45.5019, -73.5674, "Canada", "H3B 2Y5"),
]
US_CITY_INDEXES = [i for i, c in enumerate(CITIES) if c[2] == "US"]
CA_CITY_INDEXES = [i for i, c in enumerate(CITIES) if c[2] == "CA"]

REGION_TIER_VALUE = {"Northeast": 10, "Southeast": 20, "Midwest": 30, "Southwest": 40, "West": 50, "Canada": 60}
SERVICE_TIER_VALUE = {"Janitorial": 1, "Industrial Services": 2, "Healthcare EVS": 3, "Education": 4}
VERTICALS = {
    "Logistics": 1,
    "Healthcare": 2,
    "K-12 Education": 3,
    "Commercial Office": 4,
    "Manufacturing": 5,
    "Retail": 6,
    "Financial Services": 7,
    "Higher Education": 8,
}
STATE_IDS = {s: i + 1 for i, s in enumerate(sorted({c[1] for c in CITIES}))}
# Sales tax on janitorial services: mostly untaxed; TX/OH tax it, Canada charges GST/HST.
SALES_TAX = {"TX": 0.0825, "OH": 0.0725, "ON": 0.13, "BC": 0.05, "AB": 0.05, "QC": 0.14975}
TERMS_ID = {"Net 30": 1, "Due Upon Receipt": 2, "Net 45": 3}

STREETS = [
    "Commerce Pkwy", "Industrial Blvd", "Airport Rd", "Corporate Dr", "Innovation Way", "Market St",
    "Harbor View Ave", "Ridge Rd", "Lakeshore Dr", "Main St", "Meridian Ave", "Technology Ct",
    "Distribution Way", "Executive Plaza", "University Ave", "Park Center Dr", "Gateway Blvd",
]
FIRST_NAMES = [
    "Maria", "James", "Aisha", "Carlos", "Linda", "Marcus", "Priya", "Dmitri", "Elena", "Kwame", "Sofia",
    "Daniel", "Grace", "Luis", "Hannah", "Omar", "Rosa", "Tyler", "Nadia", "Victor", "Amara", "Jerome",
    "Yuki", "Patrick", "Fatima", "Andre", "Beatriz", "Samuel", "Ingrid", "Tomas", "Leah", "Rashid",
]
LAST_NAMES = [
    "Nguyen", "Okafor", "Hernandez", "Schmidt", "Patel", "Johnson", "Silva", "Kowalski", "Abdi", "Reyes",
    "Brooks", "Tanaka", "Moreau", "Delgado", "Osei", "Ivanova", "Campbell", "Haddad", "Larsen", "Mendes",
    "Whitfield", "Castillo", "Fischer", "Adeyemi", "Byrne", "Romero", "Sato", "Quinn", "Diallo", "Petrova",
]

SALES_REPS = [("Jason Reed", 1), ("Monica Alvarez", 2), ("Derek Holloway", 3), ("Tamsin Wright", 4)]

# Account templates: 48 sites at the default scale. Sites are re-allocated
# proportionally when SIM_JOBS differs.
ACCOUNTS: list[dict[str, Any]] = [
    dict(name="Ridgeline Logistics", service="Industrial Services", vertical="Logistics", sites=8,
         kinds=["Fulfillment Center", "Sortation Center", "Delivery Station", "Returns Center"],
         terms="Net 45", pay_days=48, billing="biweekly", subcontract=False, po=True, rep=0, canada=False),
    dict(name="Mercy Lakes Health System", service="Healthcare EVS", vertical="Healthcare", sites=6,
         kinds=["Medical Center", "Outpatient Pavilion", "Surgery Center", "Cancer Institute",
                "Rehabilitation Hospital", "Women's Hospital"],
         terms="Net 30", pay_days=34, billing="monthly", subcontract=False, po=True, rep=1, canada=False,
         same_metro=True),
    dict(name="Prairie View ISD", service="Education", vertical="K-12 Education", sites=6,
         kinds=["Elementary School", "Middle School", "High School", "Administration Building",
                "Athletics Complex", "Early Learning Center"],
         terms="Net 30", pay_days=41, billing="monthly", subcontract=False, po=True, rep=2, canada=False,
         same_metro=True),
    dict(name="Cornerstone Office REIT", service="Janitorial", vertical="Commercial Office", sites=6,
         kinds=["Tower", "Plaza", "Center", "Square"],
         terms="Net 30", pay_days=28, billing="monthly", subcontract=False, po=False, rep=3, canada=False),
    dict(name="Maple Crest Properties", service="Janitorial", vertical="Commercial Office", sites=4,
         kinds=["Place", "Centre", "Tower", "Exchange"],
         terms="Net 30", pay_days=31, billing="monthly", subcontract=False, po=False, rep=3, canada=True),
    dict(name="Summit Peak Manufacturing", service="Industrial Services", vertical="Manufacturing", sites=4,
         kinds=["Assembly Plant", "Stamping Plant", "Components Plant", "Parts Depot"],
         terms="Net 45", pay_days=50, billing="monthly", subcontract=True, po=True, rep=0, canada=False),
    dict(name="Northgate Retail Group", service="Janitorial", vertical="Retail", sites=5,
         kinds=["Store", "Supercenter", "Outlet", "Marketplace"],
         terms="Due Upon Receipt", pay_days=20, billing="monthly", subcontract=False, po=False, rep=1,
         canada=False),
    dict(name="Beacon Financial Center", service="Janitorial", vertical="Financial Services", sites=1,
         kinds=["Headquarters"],
         terms="Net 30", pay_days=27, billing="monthly", subcontract=False, po=False, rep=3, canada=False),
    dict(name="Harborview Community College", service="Education", vertical="Higher Education", sites=3,
         kinds=["Main Campus", "North Campus", "Technology Campus"],
         terms="Net 30", pay_days=38, billing="monthly", subcontract=True, po=True, rep=2, canada=False,
         same_metro=True),
    dict(name="Lakeshore Medical Clinics", service="Healthcare EVS", vertical="Healthcare", sites=5,
         kinds=["Family Clinic", "Urgent Care", "Imaging Center", "Pediatrics Clinic", "Dialysis Center"],
         terms="Net 30", pay_days=95, billing="monthly", subcontract=False, po=False, rep=1, canada=False,
         slow_payer=True),
]

VENDOR_TEMPLATES: list[tuple[str, int, str]] = [
    # name, vendorTypeId (1 supplies, 2 subcontractor, 3 equipment, 4 utilities, 5 services), category
    ("Brightline Janitorial Supply", 1, "supplies"),
    ("Keystone Paper & Chemical", 1, "supplies"),
    ("Northwind Sanitation Products", 1, "supplies"),
    ("Cascade Facility Supply Co.", 1, "supplies"),
    ("Metro Consumables Direct", 1, "supplies"),
    ("Great Lakes Cleaning Chemicals", 1, "supplies"),
    ("Apex Floor Care LLC", 2, "subcontractor"),
    ("Summit Window Services", 2, "subcontractor"),
    ("Ironclad Pressure Washing", 2, "subcontractor"),
    ("Evergreen Carpet Restoration", 2, "subcontractor"),
    ("Precision Industrial Scrubbing", 2, "subcontractor"),
    ("Tennant Equipment Leasing", 3, "equipment"),
    ("Midwest Floor Machine Repair", 3, "equipment"),
    ("Atlas Lift & Ladder Rental", 3, "equipment"),
    ("ProVac Parts Warehouse", 3, "equipment"),
    ("Continental Energy Partners", 4, "utilities"),
    ("Cityline Water & Sewer", 4, "utilities"),
    ("TelNorth Business Internet", 4, "utilities"),
    ("Metro Waste Services", 4, "utilities"),
    ("Uniform Advantage Rentals", 5, "services"),
    ("SafeStep Training Institute", 5, "services"),
    ("Fleetwise Vehicle Leasing", 5, "services"),
    ("Northstar Background Screening", 5, "services"),
    ("Harbor Insurance Brokers", 5, "services"),
    ("Maple Leaf Facility Supply Ltd.", 1, "supplies"),
]


# --------------------------------------------------------------------------- #
# Model records
# --------------------------------------------------------------------------- #


@dataclass
class Post:
    post_detail_id: int
    schedule_details_id: int
    description: str
    hours: float
    weekdays: bool
    weekend: bool
    start_min: int
    lunch: float


@dataclass
class Employee:
    number: str
    rate: float


@dataclass
class Job:
    idx: int
    job_number: str
    job_id: str
    description: str
    account_idx: int
    is_parent: bool
    parent_job_number: str | None
    city_idx: int
    start: date
    end: date | None  # None = active
    posts: list[Post]
    employees: list[Employee]
    drift: float
    bill_multiplier: float
    high_overtime: bool
    subcontract_monthly: float
    location_id: int
    company_number: int
    record: dict[str, Any]

    @property
    def active(self) -> bool:
        return self.end is None

    def active_on(self, d: date) -> bool:
        return d >= self.start and (self.end is None or d <= self.end)

    def weekly_planned_hours(self) -> float:
        return sum(p.hours * ((5 if p.weekdays else 0) + (2 if p.weekend else 0)) for p in self.posts)

    def avg_rate(self) -> float:
        return sum(e.rate for e in self.employees) / len(self.employees) if self.employees else 0.0


@dataclass
class Account:
    idx: int
    name: str
    customer_number: str
    template: dict[str, Any]
    parent_job_number: str | None = None
    job_numbers: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# Dataset
# --------------------------------------------------------------------------- #


class Dataset:
    """All generated data, built once at startup."""

    # timekeeping tuple layout
    TK_ID, TK_EMP, TK_JOB, TK_ORD, TK_HOURS, TK_CAT, TK_IN, TK_LUNCH, TK_RATE = range(9)

    def __init__(self, config: SimConfig) -> None:
        self.config = config
        self.today = config.today
        self.yesterday = config.today - timedelta(days=1)
        self.history_start = add_months(month_start(self.yesterday), -(config.months - 1))
        self.rng = random.Random(config.seed)
        self.accounts: list[Account] = []
        self.jobs: list[Job] = []
        self._job_index: dict[str, Job] = {}
        self.tk: list[tuple] = []
        self._tk_ordinals: list[int] = []
        self._period_hours: dict[tuple[int, int, int, int], float] = {}
        self.gl_budgets: dict[int, list[dict[str, Any]]] = {}
        self.ar_invoices: list[dict[str, Any]] = []
        self.vendors: list[dict[str, Any]] = []
        self._vendor_meta: list[dict[str, Any]] = []
        self.ap_invoices: list[dict[str, Any]] = []
        self.ap_payments: list[dict[str, Any]] = []
        self._build()

    # ------------------------------------------------------------------ build
    def _build(self) -> None:
        self._build_accounts_and_jobs()
        self._build_timekeeping()
        self._build_gl_budgets()
        self._build_ar_invoices()
        self._build_vendors()
        self._build_ap()

    def _uuid(self) -> str:
        return str(uuid.UUID(int=self.rng.getrandbits(128), version=4))

    def _person(self) -> str:
        return f"{self.rng.choice(FIRST_NAMES)} {self.rng.choice(LAST_NAMES)}"

    def _phone(self, city_idx: int) -> str:
        area = 200 + (city_idx * 37) % 780
        return f"{area}555{self.rng.randint(1000, 9999):04d}"

    # ---- accounts & jobs ------------------------------------------------- #
    def _allocate_sites(self) -> list[int]:
        weights = [a["sites"] for a in ACCOUNTS]
        total = sum(weights)
        n = self.config.jobs
        if n <= len(ACCOUNTS):
            return [1 if i < n else 0 for i in range(len(ACCOUNTS))]
        alloc = [max(1, round(w * n / total)) for w in weights]
        # Fix rounding so the sum matches exactly, adjusting the largest accounts first.
        order = sorted(range(len(ACCOUNTS)), key=lambda i: -weights[i])
        k = 0
        while sum(alloc) != n:
            i = order[k % len(order)]
            if sum(alloc) < n:
                alloc[i] += 1
            elif alloc[i] > 1:
                alloc[i] -= 1
            k += 1
        return alloc

    def _build_accounts_and_jobs(self) -> None:
        rng = self.rng
        alloc = self._allocate_sites()
        next_job_number = 10001
        post_id = 100
        sched_id = 5000
        emp_number = 1001
        site_jobs: list[Job] = []
        parents: list[Job] = []

        # Decide the special jobs up front (indexes among site jobs).
        # Special jobs are drawn only from multi-site accounts so no account
        # loses its entire history to an inactive or brand-new site.
        total_sites = sum(alloc)
        offsets = [sum(alloc[:i]) for i in range(len(alloc))]
        specials = [offsets[a] + k for a, n in enumerate(alloc) if n >= 2 for k in range(n)]
        rng.shuffle(specials)
        recent_new = set(specials[:2]) if total_sites >= 6 else set()
        inactive = set(specials[2:4]) if total_sites >= 8 else set()
        high_ot = set(specials[4:8]) if total_sites >= 12 else set(specials[4:5]) if total_sites >= 8 else set()

        site_counter = 0
        for a_idx, tmpl in enumerate(ACCOUNTS):
            n_sites = alloc[a_idx]
            if n_sites == 0:
                continue
            account = Account(idx=a_idx, name=tmpl["name"], customer_number=str(1001 + a_idx), template=tmpl)
            self.accounts.append(account)
            multi = n_sites >= 2
            city_pool = CA_CITY_INDEXES if tmpl["canada"] else US_CITY_INDEXES
            metro = rng.choice(city_pool) if tmpl.get("same_metro") else None
            parent_number = f"{account.customer_number}P" if multi else None
            account.parent_job_number = parent_number
            child_jobs: list[Job] = []
            for s in range(n_sites):
                city_idx = metro if metro is not None else (
                    city_pool[s % len(city_pool)] if tmpl["canada"] else rng.choice(city_pool))
                kind = tmpl["kinds"][s % len(tmpl["kinds"])]
                city = CITIES[city_idx]
                if tmpl.get("same_metro"):
                    desc = f"{tmpl['name']} - {kind}"
                    if n_sites > len(tmpl["kinds"]):
                        desc += f" {s + 1}"
                else:
                    desc = f"{tmpl['name']} - {city[0]} {kind}"
                job_number = str(next_job_number)
                next_job_number += 1
                if rng.random() < 0.15:
                    job_number += rng.choice("ABC")

                # activity window
                if site_counter in recent_new:
                    start = self.today - timedelta(days=rng.randint(60, 120))
                else:
                    start = date(2019, 1, 1) + timedelta(days=rng.randint(0, (date(2025, 6, 30) - date(2019, 1, 1)).days))
                end = None
                if site_counter in inactive:
                    end = self.today - timedelta(days=rng.randint(200, 280))
                    start = min(start, end - timedelta(days=400))

                # posts
                n_posts = rng.choice([2, 3, 4, 4, 5, 5, 6, 6, 7, 8, 10, 12])
                if tmpl["service"] == "Industrial Services":
                    n_posts = max(n_posts, 5)
                is_high_ot = site_counter in high_ot
                posts: list[Post] = []
                weekend_posts = round(n_posts * rng.uniform(0.2, 0.4))
                for p in range(n_posts):
                    if is_high_ot:
                        hours = rng.choice([9, 9.5, 10])
                    else:
                        hours = rng.choice([4, 5, 6, 8, 8, 8, 8.5])
                    shift = rng.choice(["Day", "Day", "Evening", "Night"])
                    start_min = {"Day": rng.choice([360, 420, 480, 540]), "Evening": rng.choice([1020, 1080, 1140]),
                                 "Night": rng.choice([1320, 1380])}[shift]
                    role = {"Janitorial": ["Porter", "Custodian", "Restroom Cleaner", "Utility Cleaner"],
                            "Industrial Services": ["Industrial Cleaner", "Sweeper Operator", "Utility Cleaner", "Lead"],
                            "Healthcare EVS": ["EVS Technician", "Floor Technician", "EVS Lead", "Discharge Cleaner"],
                            "Education": ["Custodian", "Lead Custodian", "Floor Technician", "Groundskeeper"]}[tmpl["service"]]
                    posts.append(Post(
                        post_detail_id=post_id, schedule_details_id=sched_id,
                        description=f"{shift} {rng.choice(role)}", hours=hours,
                        weekdays=True, weekend=p < weekend_posts, start_min=start_min,
                        lunch=0.5 if hours >= 8 else 0,
                    ))
                    post_id += 1
                    sched_id += 1

                # employees
                factor = rng.uniform(0.8, 0.95) if is_high_ot else rng.uniform(1.4, 1.9)
                n_emp = max(3, min(25, round(n_posts * factor)))
                employees = [Employee(number=str(emp_number + i), rate=round(rng.uniform(15, 28), 2)) for i in range(n_emp)]
                emp_number += n_emp

                job = Job(
                    idx=-1, job_number=job_number, job_id=self._uuid(), description=desc, account_idx=a_idx,
                    is_parent=False, parent_job_number=parent_number, city_idx=city_idx, start=start, end=end,
                    posts=posts, employees=employees, drift=rng.uniform(0.88, 1.12),
                    bill_multiplier=rng.uniform(1.45, 1.75), high_overtime=is_high_ot,
                    subcontract_monthly=round(rng.uniform(1800, 6500), 2) if tmpl["subcontract"] else 0.0,
                    location_id=city_idx + 1, company_number=2 if tmpl["canada"] else 1, record={},
                )
                child_jobs.append(job)
                account.job_numbers.append(job_number)
                site_counter += 1

            if multi:
                hq_city = child_jobs[0].city_idx
                parent = Job(
                    idx=-1, job_number=parent_number or "", job_id=self._uuid(), description=tmpl["name"],
                    account_idx=a_idx, is_parent=True, parent_job_number=None, city_idx=hq_city,
                    start=min(j.start for j in child_jobs), end=None, posts=[], employees=[], drift=1.0,
                    bill_multiplier=1.0, high_overtime=False, subcontract_monthly=0.0,
                    location_id=hq_city + 1, company_number=2 if tmpl["canada"] else 1, record={},
                )
                parents.append(parent)
            site_jobs.extend(child_jobs)

        # Parent records first (they sort ahead by job number anyway), then sites.
        ordered = parents + site_jobs
        for i, job in enumerate(ordered):
            job.idx = i
            job.record = self._job_record(job)
            self.jobs.append(job)
            self._job_index[job.job_number.lower()] = job
            self._job_index[job.job_id.lower()] = job

    def _job_record(self, job: Job) -> dict[str, Any]:
        rng = self.rng
        city, state, country, lat, lon, region, postal = CITIES[job.city_idx]
        tmpl = ACCOUNTS[job.account_idx]
        street = f"{rng.randint(100, 9899)} {rng.choice(STREETS)}"
        suite = None if job.is_parent or rng.random() < 0.6 else f"Suite {rng.randint(100, 900)}"
        lat_s = f"{lat + rng.uniform(-0.06, 0.06):.6f}"
        lon_s = f"{lon + rng.uniform(-0.06, 0.06):.6f}"
        region_value = REGION_TIER_VALUE[region]
        manager_n = list(REGION_TIER_VALUE).index(region) + 1
        tiers = [
            {"tierID": 1, "tierValue": region_value, "tierValueDescription": f"{region} Region"},
            {"tierID": 2, "tierValue": job.city_idx + 1, "tierValueDescription": f"{city} {state}"},
            {"tierID": 3, "tierValue": SERVICE_TIER_VALUE[tmpl["service"]], "tierValueDescription": tmpl["service"]},
            {"tierID": 4, "tierValue": manager_n, "tierValueDescription": f"Area {manager_n} Manager"},
            {"tierID": 5, "tierValue": 0, "tierValueDescription": "None"},
            {"tierID": 6, "tierValue": VERTICALS[tmpl["vertical"]], "tierValueDescription": tmpl["vertical"]},
        ] + [{"tierID": t, "tierValue": 0, "tierValueDescription": "None"} for t in range(7, 13)]
        sqft = rng.randint(12, 480) * 1000
        base = "https://api.myteamsoftware.com/wtnextgen/jobs/v2/api/jobs"
        notes = ("Parent account record for consolidated billing. No labor is posted here."
                 if job.is_parent else
                 rng.choice([
                     "Badge access through loading dock; supplies closet on L1.",
                     "Contract renews annually on the start-date anniversary.",
                     "Customer requires green-certified chemicals only.",
                     "Night crew must sign the security log at the front desk.",
                     "Quarterly floor care scheduled with the site manager.",
                 ]))
        return {
            "links": [
                {"rel": "gl-budgets", "href": f"{base}/{job.job_number}/budgets", "method": "GET"},
                {"rel": "gl-budget-details", "href": f"{base}/{job.job_number}/gl-budgets", "method": "GET"},
            ],
            "jobJoinedDescription": f"{job.job_number} {job.description}",
            "locationId": job.location_id,
            "companyNumber": job.company_number,
            "lighthouseApplication": None,
            "hoursRuleId": 50,
            "jobAttention": None if job.is_parent else self._person(),
            "dateToStart": fmt_date(job.start),
            "typeId": 1 if job.is_parent else 6,
            "phone1": self._phone(job.city_idx),
            "phone1Description": "Site Contact" if not job.is_parent else "Accounts Payable",
            "phone2": None,
            "phone2Description": None,
            "phone3": None,
            "phone3Description": None,
            "supervisorId": 7 + (job.idx % 9),
            "taxesInsuranceId": 1,
            "salesTaxStateId": STATE_IDS[state],
            "jobPayrollTaxStateId": STATE_IDS[state],
            "hoursCategoryID": 9,
            "notes": notes,
            "address": {
                "jobAddress1": street, "jobAddress2": suite, "jobCity": city, "jobState": state, "jobZip": postal,
            },
            "taxAddress": {
                "address1": street, "address2": suite, "city": city, "state": state, "zip": postal,
                "latitude": lat_s, "longitude": lon_s, "locationCode": None,
            },
            "jobTiers": tiers,
            "customFields": [
                {"fieldNumber": 1, "value": str(sqft)},
                {"fieldNumber": 2, "value": "1" if tmpl["billing"] == "monthly" else "2"},
            ],
            "jobNumber": job.job_number,
            "parentJobNumber": job.parent_job_number,
            "jobId": job.job_id,
            "jobDescription": job.description,
        }

    # ---- timekeeping ----------------------------------------------------- #
    def _build_timekeeping(self) -> None:
        rng = self.rng
        rows: list[list] = []
        period_hours = self._period_hours
        for job in self.jobs:
            if job.is_parent:
                continue
            d0 = max(job.start, self.history_start)
            d1 = self.yesterday if job.end is None else min(job.end, self.yesterday)
            if d0 > d1:
                continue
            n_emp = len(job.employees)
            week_hours: dict[str, float] = {}
            current_week: date | None = None
            d = d0
            while d <= d1:
                ws = week_start(d)
                if ws != current_week:
                    current_week = ws
                    week_hours = {}
                is_weekend = d.weekday() >= 5
                for p_idx, post in enumerate(job.posts):
                    if is_weekend and not post.weekend:
                        continue
                    if not is_weekend and not post.weekdays:
                        continue
                    if rng.random() < 0.04:  # missed / unfilled shift
                        continue
                    emp = job.employees[p_idx % n_emp] if rng.random() < 0.9 else job.employees[rng.randrange(n_emp)]
                    hours = post.hours * job.drift * rng.uniform(0.92, 1.08)
                    hours = max(4.0, min(10.0, round(hours * 4) / 4))
                    in_min = post.start_min + rng.choice([-10, -5, 0, 0, 0, 5, 10, 15])
                    prev = week_hours.get(emp.number, 0.0)
                    week_hours[emp.number] = prev + hours
                    key = (job.idx, d.year, d.month, 1 if d.day <= 15 else 2)
                    period_hours[key] = period_hours.get(key, 0.0) + hours
                    if prev >= 40:
                        parts = [(hours, 2)]
                    elif prev + hours > 40:
                        parts = [(40 - prev, 1), (prev + hours - 40, 2)]
                    else:
                        parts = [(hours, 1)]
                    offset = 0
                    for part_hours, cat in parts:
                        lunch = post.lunch if (cat == 1 and part_hours >= 8) or (len(parts) == 1 and post.lunch) else 0
                        rows.append([0, emp.number, job.idx, d.toordinal(), part_hours, cat, in_min + offset, lunch, emp.rate])
                        offset += int(part_hours * 60 + lunch * 60)
                d += timedelta(days=1)
        rows.sort(key=lambda r: (r[3], r[2], r[6], r[5]))
        base_id = 1_000_001
        self.tk = []
        self._tk_ordinals = []
        for i, r in enumerate(rows):
            r[0] = base_id + i
            self.tk.append(tuple(r))
            self._tk_ordinals.append(r[3])

    def tk_to_dict(self, r: tuple) -> dict[str, Any]:
        d = date.fromordinal(r[self.TK_ORD])
        job = self.jobs[r[self.TK_JOB]]
        total_min = int(r[self.TK_HOURS] * 60 + r[self.TK_LUNCH] * 60)
        return {
            "timekeepingId": r[self.TK_ID],
            "employeeNumber": r[self.TK_EMP],
            "jobNumber": job.job_number,
            "workDate": fmt_date(d),
            "hours": num(r[self.TK_HOURS]),
            "categoryDetailId": r[self.TK_CAT],
            "inTime": fmt_time(d, r[self.TK_IN]),
            "outTime": fmt_time(d, r[self.TK_IN] + total_min),
            "lunch": num(r[self.TK_LUNCH]),
            "rate": num(r[self.TK_RATE]),
            "workTicketNumber": None,
        }

    def timekeeping_between(self, d0: date, d1: date) -> list[tuple]:
        lo = bisect.bisect_left(self._tk_ordinals, d0.toordinal())
        hi = bisect.bisect_right(self._tk_ordinals, d1.toordinal())
        return self.tk[lo:hi]

    def period_hours(self, job: Job, y: int, m: int, half: int | None = None) -> float:
        if half is None:
            return self._period_hours.get((job.idx, y, m, 1), 0.0) + self._period_hours.get((job.idx, y, m, 2), 0.0)
        return self._period_hours.get((job.idx, y, m, half), 0.0)

    # ---- schedules (generated lazily, deterministic) --------------------- #
    def schedule_end(self, job: Job) -> date:
        horizon = self.today + timedelta(days=42)
        return horizon if job.end is None else min(job.end, horizon)

    def schedules(self, job: Job, d0: date, d1: date) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if job.is_parent:
            return out
        start = max(job.start, d0)
        end = min(self.schedule_end(job), d1)
        if start > end:
            return out
        n_posts = len(job.posts)
        n_emp = len(job.employees)
        base = 10_000_000 + job.idx * 400_000
        d = start
        while d <= end:
            is_weekend = d.weekday() >= 5
            day_offset = (d - job.start).days
            for p_idx, post in enumerate(job.posts):
                if (is_weekend and not post.weekend) or (not is_weekend and not post.weekdays):
                    continue
                # ~10% open shifts (no employee assigned), stable per (day, post)
                h = (day_offset * 31 + p_idx * 7 + job.idx) % 10
                emp = None if h == 0 else job.employees[p_idx % n_emp].number
                out.append({
                    "id": base + day_offset * n_posts + p_idx,
                    "scheduleDetailsID": post.schedule_details_id,
                    "jobNumber": job.job_number,
                    "employeeNumber": emp,
                    "jobPostDetailID": post.post_detail_id,
                    "workDate": fmt_date(d),
                    "inTime": fmt_time(d, post.start_min),
                    "outTime": fmt_time(d, post.start_min + int((post.hours + post.lunch) * 60)),
                    "hours": num(post.hours),
                    "lunch": num(post.lunch),
                })
            d += timedelta(days=1)
        return out

    def schedule_count(self) -> int:
        total = 0
        for job in self.jobs:
            if job.is_parent or not job.posts:
                continue
            end = self.schedule_end(job)
            d = max(job.start, self.history_start)
            if end < d:
                continue
            wd = sum(1 for p in job.posts if p.weekdays)
            we = sum(1 for p in job.posts if p.weekend)
            while d <= end:
                total += we if d.weekday() >= 5 else wd
                d += timedelta(days=1)
        return total

    # ---- GL budgets ------------------------------------------------------ #
    def _build_gl_budgets(self) -> None:
        rng = self.rng
        years = list(range(min(self.history_start.year, self.today.year - 1), self.today.year + 1))
        gl_budget_id = 1600
        detail_id = 5000
        for job in self.jobs:
            if job.is_parent:
                continue
            monthly_hours = job.weekly_planned_hours() * 52 / 12
            monthly_labor = monthly_hours * job.avg_rate()
            monthly_revenue = monthly_labor * job.bill_multiplier + job.subcontract_monthly * 1.25
            monthly_supplies = monthly_revenue * rng.uniform(0.035, 0.07)
            entries: list[dict[str, Any]] = []
            for fy in years:
                if job.start > date(fy, 12, 31) or (job.end is not None and job.end < date(fy, 1, 1)):
                    continue
                year_var = rng.uniform(-0.15, 0.15)
                accounts = [(3010, "Service Income", monthly_revenue, 1, 1),
                            (4010, "Direct Labor", monthly_labor, 1, 1),
                            (4200, "Supplies", monthly_supplies, 1, 0)]
                if job.subcontract_monthly:
                    accounts.append((4400, "Subcontractors", job.subcontract_monthly, 1, 1))
                details = []
                for acct, desc, base, fs, jca in accounts:
                    periods = []
                    for m in range(1, 13):
                        ms, me = date(fy, m, 1), month_end(date(fy, m, 1))
                        active = me >= job.start and (job.end is None or ms <= job.end)
                        if not active:
                            periods.append(0)
                            continue
                        v = base * (1 + year_var) * rng.uniform(0.95, 1.05)
                        periods.append(num(v))
                    row = {"id": detail_id, "glAccountNumber": acct, "glAccountDescription": desc,
                           "financialStatement": fs, "jobCostAnalysis": jca,
                           "budgetTotal": num(sum(periods))}
                    row.update({f"period{i + 1}": p for i, p in enumerate(periods)})
                    details.append(row)
                    detail_id += 1
                entries.append({"jobNumber": job.job_number, "fiscalYear": fy, "glBudgetId": gl_budget_id,
                                "glBudgetDetails": details})
                gl_budget_id += 1
            self.gl_budgets[job.idx] = entries

    def gl_budgets_for(self, job: Job, fiscal_year: int | None, financial_statement: bool,
                       job_cost_analysis: bool) -> list[dict[str, Any]]:
        fy = fiscal_year if fiscal_year is not None else self.today.year
        out = []
        for entry in self.gl_budgets.get(job.idx, []):
            if entry["fiscalYear"] != fy:
                continue
            details = [d for d in entry["glBudgetDetails"]
                       if (financial_statement and d["financialStatement"] == 1)
                       or (job_cost_analysis and d["jobCostAnalysis"] == 1)]
            out.append({**entry, "glBudgetDetails": details})
        return out

    # ---- AR invoices ----------------------------------------------------- #
    def _build_ar_invoices(self) -> None:
        rng = self.rng
        drafts: list[dict[str, Any]] = []
        for job in self.jobs:
            if job.is_parent:
                continue
            account = next(a for a in self.accounts if a.idx == job.account_idx)
            tmpl = account.template
            state = CITIES[job.city_idx][1]
            tax_rate = SALES_TAX.get(state, 0.0)
            bill_rate = job.avg_rate() * job.bill_multiplier
            rep_name, rep_id = SALES_REPS[tmpl["rep"]]
            m = self.history_start
            while m <= self.yesterday:
                me = month_end(m)
                periods = [(m, me, None)] if tmpl["billing"] == "monthly" else [
                    (m, m.replace(day=15), 1), (m.replace(day=16), me, 2)]
                for pf, pt, half in periods:
                    pf2 = max(pf, job.start)
                    pt2 = pt if job.end is None else min(pt, job.end)
                    if pf2 > pt2:
                        continue
                    hours = self.period_hours(job, m.year, m.month, half)
                    if hours <= 0:
                        continue
                    inv_date = pt + timedelta(days=rng.randint(2, 5))
                    if inv_date > self.today:
                        continue
                    revenue = hours * bill_rate
                    if job.subcontract_monthly and half != 1:
                        revenue += job.subcontract_monthly * 1.25
                    revenue = round(revenue, 2)
                    tax = round(revenue * tax_rate, 2)
                    total = round(revenue + tax, 2)
                    pay_days = tmpl["pay_days"] + rng.randint(-7, 10)
                    paid_on = inv_date + timedelta(days=max(1, pay_days))
                    amount_paid, last_paid, status = 0.0, None, ""
                    if paid_on <= self.today:
                        amount_paid, last_paid = total, paid_on
                        if rng.random() < 0.02:  # short pay / dispute
                            amount_paid = round(total * rng.uniform(0.85, 0.97), 2)
                    elif tmpl.get("slow_payer") and inv_date + timedelta(days=45) <= self.today:
                        amount_paid = round(total * 0.5, 2)
                        last_paid = inv_date + timedelta(days=45)
                    due = inv_date + timedelta(days={"Net 30": 30, "Net 45": 45, "Due Upon Receipt": 0}[tmpl["terms"]])
                    if amount_paid < total and self.today > due:
                        status = "Past Due"
                    po = f"PO-{pf.year}-{(job.idx * 13 + pf.month) % 900 + 100:04d}" if tmpl["po"] else None
                    label = "Bi-weekly" if half else "Monthly"
                    service_label = {"Janitorial": "janitorial", "Industrial Services": "industrial cleaning",
                                     "Healthcare EVS": "EVS", "Education": "custodial"}[tmpl["service"]]
                    drafts.append({
                        "_date": inv_date, "_job": job.idx,
                        "invoiceDate": fmt_date(inv_date), "postingDate": fmt_date(inv_date),
                        "billingPeriodFrom": fmt_date(pf2), "billingPeriodTo": fmt_date(pt2),
                        "notes": f"{label} {service_label} services - {pf.strftime('%b %Y')}",
                        "terms": tmpl["terms"], "termsId": TERMS_ID[tmpl["terms"]],
                        "salesRep": rep_name, "salesRepId": rep_id, "poNumber": po,
                        "reason": None, "reasonId": None, "jobNumber": job.job_number,
                        "tax": num(tax), "amountPaid": num(amount_paid), "revenueTotal": num(revenue),
                        "lastDatePaid": fmt_date(last_paid) if last_paid else None,
                        "collectionStatus": status, "invoiceTotal": num(total),
                        "invoiceBeingCredited": None, "customerNumber": account.customer_number,
                    })
                m = add_months(m, 1)
        drafts.sort(key=lambda r: (r["_date"], r["_job"]))
        next_number = 100001
        for r in drafts:
            r["invoiceNumber"] = next_number
            next_number += 1
        # One credit memo against an invoice from roughly three months ago.
        cutoff = self.today - timedelta(days=90)
        candidates = [r for r in drafts if r["_date"] <= cutoff and r["revenueTotal"] > 0]
        if candidates:
            orig = candidates[-1]
            credit_amount = round(-abs(float(orig["revenueTotal"])) * 0.05, 2)
            credit_date = orig["_date"] + timedelta(days=12)
            drafts.append({
                "_date": credit_date, "_job": orig["_job"],
                "invoiceDate": fmt_date(credit_date), "postingDate": fmt_date(credit_date),
                "billingPeriodFrom": orig["billingPeriodFrom"], "billingPeriodTo": orig["billingPeriodTo"],
                "notes": f"Credit for missed service on invoice {orig['invoiceNumber']}",
                "terms": orig["terms"], "termsId": orig["termsId"],
                "salesRep": orig["salesRep"], "salesRepId": orig["salesRepId"], "poNumber": orig["poNumber"],
                "reason": "Missed Service", "reasonId": 1, "jobNumber": orig["jobNumber"],
                "tax": 0, "amountPaid": num(credit_amount), "revenueTotal": num(credit_amount),
                "lastDatePaid": fmt_date(credit_date), "collectionStatus": "",
                "invoiceTotal": num(credit_amount), "invoiceBeingCredited": orig["invoiceNumber"],
                "customerNumber": orig["customerNumber"], "invoiceNumber": next_number,
            })
        order = ["invoiceNumber", "invoiceDate", "postingDate", "billingPeriodFrom", "billingPeriodTo", "notes",
                 "terms", "termsId", "salesRep", "salesRepId", "poNumber", "reason", "reasonId", "jobNumber",
                 "tax", "amountPaid", "revenueTotal", "lastDatePaid", "collectionStatus", "invoiceTotal",
                 "invoiceBeingCredited", "customerNumber"]
        drafts.sort(key=lambda r: r["invoiceNumber"])
        self.ar_invoices = [{k: r[k] for k in order} for r in drafts]

    # ---- vendors --------------------------------------------------------- #
    def _build_vendors(self) -> None:
        rng = self.rng
        for i, (name, type_id, category) in enumerate(VENDOR_TEMPLATES):
            canada = name.endswith("Ltd.")
            city_idx = rng.choice(CA_CITY_INDEXES if canada else US_CITY_INDEXES)
            city, state, _, _, _, _, postal = CITIES[city_idx]
            vendor_number = 1000 + i
            parent = 1000 + rng.randrange(i) if (i > 0 and rng.random() < 0.1) else None
            contacts = []
            for _ in range(rng.choice([1, 1, 2])):
                fn, ln = rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)
                domain = name.split()[0].lower().strip(".,") + ".example.com"
                contacts.append({
                    "displayName": f"{fn} {ln}", "firstName": fn, "lastName": ln,
                    "email": f"{fn.lower()}.{ln.lower()}@{domain}",
                    "businessPhone": self._phone(city_idx), "roleId": rng.choice([0, 0, 1]),
                })
            self.vendors.append({
                "vendorNumber": vendor_number,
                "vendorTypeId": type_id,
                "vendorName": name,
                "vendorStatus": True,
                "address": {
                    "address1": f"{rng.randint(100, 9899)} {rng.choice(STREETS)}",
                    "address2": None if rng.random() < 0.7 else f"Unit {rng.randint(1, 40)}",
                    "city": city, "state": state, "zip": postal,
                },
                "phone": self._phone(city_idx),
                "fax": None,
                "parentVendorNumber": parent,
                "accountNumber": f"NS-{rng.randint(10000, 99999)}",
                "taxID": None,
                "customFields": None,
                "contactsInformation": contacts,
            })
            self._vendor_meta.append({
                "number": vendor_number, "name": name, "category": category, "canada": canada,
                "pay_lag": rng.randint(30, 45), "method": rng.choice([4, 4, 4, 1, 1, 5]),
                "combined": category == "utilities",
                "terms_days": 45 if category == "subcontractor" else 30,
            })

    # ---- AP invoices and payments --------------------------------------- #
    def _build_ap(self) -> None:
        rng = self.rng
        site_jobs = [j for j in self.jobs if not j.is_parent]
        supply_vendors = [v for v in self._vendor_meta if v["category"] == "supplies"]
        sub_vendors = [v for v in self._vendor_meta if v["category"] == "subcontractor"]
        total_supplies = sum(
            (j.weekly_planned_hours() * 52 / 12) * j.avg_rate() * j.bill_multiplier * 0.05 for j in site_jobs if j.active)
        drafts: list[dict[str, Any]] = []

        def add(vendor: dict[str, Any], inv_date: date, amount: float, memo: str, number: str,
                po: str | None = None) -> None:
            if inv_date > self.today:
                return
            posting = inv_date + timedelta(days=rng.randint(0, 3))
            drafts.append({
                "_date": inv_date, "_vendor": vendor,
                "invoiceNumber": number, "vendorNumber": vendor["number"],
                "companyNumber": 2 if vendor["canada"] else 1,
                "invoiceDate": fmt_date(inv_date), "postingDate": fmt_date(posting),
                "dueDate": fmt_date(inv_date + timedelta(days=vendor["terms_days"])),
                "invoiceAmount": num(amount), "poNumber": po, "notes": None,
                "payUseTax": False, "useTaxAmount": None, "useTaxCode": None,
                "paymentPlanId": 1, "paymentMethodId": vendor["method"],
                "creditCardVendorNumber": None, "memoLine1": memo, "memoLine2": None,
                "permanentHold": False, "includeOn1099": vendor["category"] == "subcontractor",
            })

        m = self.history_start
        seq = 1
        while m <= self.today:
            for v in self._vendor_meta:
                cat = v["category"]
                stamp = m.strftime("%y%m")
                if cat == "supplies":
                    share = total_supplies / max(1, len(supply_vendors))
                    for k in range(rng.choice([1, 2, 2, 3])):
                        inv_date = m + timedelta(days=rng.randint(0, 27))
                        add(v, inv_date, share / 2 * rng.uniform(0.6, 1.4),
                            f"Consumables - {rng.choice(['Region', 'Branch'])} {rng.randint(1, 6)}",
                            f"INV-{stamp}-{seq:05d}", po=f"PO-{stamp}-{rng.randint(100, 999)}")
                        seq += 1
                elif cat == "subcontractor":
                    for job in site_jobs:
                        if not job.subcontract_monthly or not job.active_on(m):
                            continue
                        if sub_vendors[job.idx % len(sub_vendors)] is not v:
                            continue
                        inv_date = month_end(m) - timedelta(days=rng.randint(0, 3))
                        add(v, inv_date, job.subcontract_monthly * rng.uniform(0.97, 1.03),
                            f"Floor care - {job.job_number}", f"SUB-{stamp}-{job.job_number}")
                elif cat == "equipment":
                    if rng.random() < 0.35:
                        inv_date = m + timedelta(days=rng.randint(0, 27))
                        add(v, inv_date, rng.uniform(900, 7500), "Equipment lease / repair",
                            f"EQ-{stamp}-{seq:05d}")
                        seq += 1
                elif cat == "utilities":
                    inv_date = m + timedelta(days=rng.randint(3, 12))
                    add(v, inv_date, rng.uniform(400, 2600), f"Monthly service - {m.strftime('%b %Y')}",
                        f"UT-{stamp}-{v['number']}")
                else:  # services
                    inv_date = m + timedelta(days=rng.randint(0, 20))
                    add(v, inv_date, rng.uniform(600, 5200), f"Monthly-{m.strftime('%m%d%y')}",
                        f"Monthly-{m.strftime('%m%d%y')}-{v['number']}")
            m = add_months(m, 1)

        drafts.sort(key=lambda r: (r["_date"], r["vendorNumber"], r["invoiceNumber"]))
        order = ["invoiceNumber", "vendorNumber", "companyNumber", "invoiceDate", "postingDate", "dueDate",
                 "invoiceAmount", "poNumber", "notes", "payUseTax", "useTaxAmount", "useTaxCode",
                 "paymentPlanId", "paymentMethodId", "creditCardVendorNumber", "memoLine1", "memoLine2",
                 "permanentHold", "includeOn1099"]
        self.ap_invoices = [{k: r[k] for k in order} for r in drafts]

        # Payments: most invoices are paid 30-45 days later; a few are never paid.
        pay_drafts: list[dict[str, Any]] = []
        combined: dict[tuple[int, int, int], dict[str, Any]] = {}
        for r in drafts:
            v = r["_vendor"]
            if rng.random() < 0.05:
                continue
            pay_date = r["_date"] + timedelta(days=v["pay_lag"] + rng.randint(-4, 6))
            if pay_date > self.today:
                continue
            if v["combined"]:
                key = (v["number"], pay_date.year, pay_date.month)
                if key in combined:
                    combined[key]["amount"] += float(r["invoiceAmount"])
                    combined[key]["date"] = max(combined[key]["date"], pay_date)
                    continue
                combined[key] = {"vendor": v, "date": pay_date, "amount": float(r["invoiceAmount"])}
                pay_drafts.append(combined[key])
            else:
                pay_drafts.append({"vendor": v, "date": pay_date, "amount": float(r["invoiceAmount"])})
        pay_drafts.sort(key=lambda p: (p["date"], p["vendor"]["number"]))
        methods = {1: "Check", 4: "EFT", 5: "Debit"}
        check_number = 40001
        for i, p in enumerate(pay_drafts):
            v = p["vendor"]
            method = v["method"]
            if method == 1:
                check = check_number
                check_number += 1
            else:
                check = -1 if method == 4 else -2
            self.ap_payments.append({
                "paymentId": 1 + i,
                "paymentMethodId": method,
                "paymentMethodDescription": methods[method],
                "checkNumber": check,
                "checkDate": fmt_date(p["date"]),
                "paymentDateAdded": fmt_date(p["date"]),
                "amount": num(p["amount"]),
                "companyNumber": 2 if v["canada"] else 1,
                "companyName": "Northstar Facilities Services Canada ULC" if v["canada"] else "Northstar Facilities Services",
                "glCashAccount": 1054,
                "payeeTypeId": 0,
                "payeeTypeDescription": "Standard",
                "vendorNumber": v["number"],
                "vendorName": v["name"],
                "otherVendorId": None,
                "otherVendorName": None,
                "applyToExpenses": True,
                "isSystemGenerated": method == 4,
                "externalSystemId": self._uuid() if method == 4 else None,
            })

    # ---- lookups --------------------------------------------------------- #
    def job_by_key(self, key: str) -> Job | None:
        return self._job_index.get(key.strip().lower())

    def job_records(self) -> list[dict[str, Any]]:
        return [j.record for j in self.jobs]

    # ---- summary --------------------------------------------------------- #
    def summary(self) -> dict[str, Any]:
        overtime_rows = sum(1 for r in self.tk if r[self.TK_CAT] == 2)
        employees = sum(len(j.employees) for j in self.jobs)
        return {
            "simulator": "winteam-sim (NOT WinTeam)",
            "tenantId": self.config.tenant_id,
            "seed": self.config.seed,
            "today": self.today.isoformat(),
            "history": {"from": self.history_start.isoformat(), "to": self.yesterday.isoformat(),
                        "months": self.config.months},
            "counts": {
                "jobs": len(self.jobs),
                "siteJobs": sum(1 for j in self.jobs if not j.is_parent),
                "parentJobs": sum(1 for j in self.jobs if j.is_parent),
                "inactiveJobs": sum(1 for j in self.jobs if j.end is not None),
                "employees": employees,
                "timekeeping": len(self.tk),
                "timekeepingOvertime": overtime_rows,
                "schedules": self.schedule_count(),
                "glBudgets": sum(len(v) for v in self.gl_budgets.values()),
                "arInvoices": len(self.ar_invoices),
                "vendors": len(self.vendors),
                "apInvoices": len(self.ap_invoices),
                "apPayments": len(self.ap_payments),
            },
            "customerNumbers": [a.customer_number for a in self.accounts],
            "accounts": [
                {"customerNumber": a.customer_number, "name": a.name, "parentJobNumber": a.parent_job_number,
                 "jobNumbers": a.job_numbers, "terms": a.template["terms"], "billing": a.template["billing"],
                 "slowPayer": bool(a.template.get("slow_payer"))}
                for a in self.accounts
            ],
            "highOvertimeJobs": [j.job_number for j in self.jobs if j.high_overtime],
            "recentJobs": [j.job_number for j in self.jobs if not j.is_parent and j.start >= self.today - timedelta(days=130)],
            "inactiveJobs": [j.job_number for j in self.jobs if j.end is not None],
            "suggestedEnv": {
                "WINTEAM_ENABLED": "true",
                "WINTEAM_BASE_URL": "http://winteam-sim:8081",
                "WINTEAM_ALLOW_INSECURE_HTTP": "true",
                "WINTEAM_TENANT_ID": self.config.tenant_id,
                "WINTEAM_CUSTOMER_NUMBERS": ",".join(a.customer_number for a in self.accounts),
            },
        }

    def fingerprint(self) -> str:
        """Stable digest of the whole dataset (used by determinism tests)."""
        import json

        h = hashlib.sha256()
        h.update(json.dumps(self.job_records(), sort_keys=True).encode())
        for r in self.tk:
            h.update(repr(r).encode())
        h.update(json.dumps(self.gl_budgets, sort_keys=True).encode())
        h.update(json.dumps(self.ar_invoices, sort_keys=True).encode())
        h.update(json.dumps(self.vendors, sort_keys=True).encode())
        h.update(json.dumps(self.ap_invoices, sort_keys=True).encode())
        h.update(json.dumps(self.ap_payments, sort_keys=True).encode())
        for job in self.jobs:
            h.update(json.dumps(self.schedules(job, self.history_start, self.today), sort_keys=True).encode())
        return h.hexdigest()
