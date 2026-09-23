"""The WinTeam databases the connector reads, and how their rows are kept apart in the warehouse.

Crane and Sarus are separate WinTeam databases. Their job, vendor, employee and invoice numbers
overlap (job 300 is FXE Pittsburgh in Crane and Amazon BDL3/7 in Sarus; vendor 1064 is a different
vendor in each), so nothing may be keyed by a WinTeam number alone. Each tenant therefore has its own:

* raw resource names  - Sarus payloads land as 'sarus/<resource>' in raw.winteam_record, so
                        raw.v_winteam_current (DISTINCT ON resource_name, source_record_id) never
                        lets one database's record supersede the other's;
* core `source`       - 'winteam_api' (primary) or 'winteam_sarus'. Every upsert is guarded by its own
                        source, and the precedence views (migration 026) give each source its own
                        window over the export rows of its own company only;
* winteam_id prefix   - 'api:' or 'api:sarus:', so the UNIQUE (winteam_id) keys cannot collide;
* sync bookkeeping    - ops.integration_sync_run / ops.source_watermark integration_name
                        'winteam' or 'winteam_sarus'.

The Sarus tenant does not maintain core.dim_job: its jobs are the Sarus rows the export load already
created (bare numbers, company 'Sarus'), and its facts resolve through mart.v_sarus_job_map.
"""
from __future__ import annotations

from dataclasses import dataclass

from .sources import rules


@dataclass(frozen=True)
class Tenant:
    key: str
    integration: str
    source: str
    id_prefix: str
    resource_prefix: str
    # Company label forced onto every row (None = resolved from companyNumber / the job).
    company: str | None = None
    # Vendor number namespace: Sarus vendor numbers are offset in the warehouse (rules.SARUS_VENDOR_OFFSET).
    vendor_namespace: str | None = None

    def raw_resource(self, name: str) -> str:
        return f"{self.resource_prefix}{name}"


PRIMARY = Tenant(key="primary", integration="winteam", source="winteam_api", id_prefix="api:", resource_prefix="")
SARUS = Tenant(
    key="sarus",
    integration="winteam_sarus",
    source="winteam_sarus",
    id_prefix="api:sarus:",
    resource_prefix="sarus/",
    company=rules.NAMESPACE_SARUS,
    vendor_namespace=rules.NAMESPACE_SARUS,
)

# What is read from the Sarus database. jobs lands raw only (it lists the job numbers the per-job
# budget pull walks); the export already owns the Sarus job dimension.
SARUS_RESOURCE_NAMES = ("jobs", "vendors", "timekeeping", "job_budgets", "ap_invoices", "ap_invoice_details", "ar_invoices")

API_SOURCES = (PRIMARY.source, SARUS.source)
