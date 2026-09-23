"""Validated server-side configuration.

The WinTeam settings follow the documented TEAM/WinTeam ("wtnextgen") GET catalogue in
WinTeamAPI.txt. Resource names are fixed (see `RESOURCE_NAMES`, dependency order); the tenant only
supplies the base URL, the `tenantId` GUID, the optional gateway subscription key, and scoping
inputs such as customer numbers and location ids. Nothing here is ever exposed with a VITE_ prefix
and secret values are never logged or returned by the API.

FINANCE_REFERENCE_DATABASE_URL points at the read-only `finance_reference` database (the restored
Finance_Dashboard dump holding the real WinTeam report exports). Empty means the second source is
not configured. FINANCE_REFERENCE_DATA_DIR optionally overrides where the loader looks for the job
master CSV and the city centroid file (default: the package's `sources/data` directory).
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any
from urllib.parse import urlparse


class ConfigurationError(ValueError):
    """Raised when the environment cannot be turned into a usable configuration."""


# Documented GET resources in dependency order (jobs feed per-job pulls; vendors feed AP names).
RESOURCE_NAMES: tuple[str, ...] = (
    "jobs",
    "vendors",
    "timekeeping",
    "job_schedules",
    "gl_budgets",
    "job_budgets",
    "ap_invoices",
    "ap_invoice_details",
    "ar_invoices",
    "ap_payments",
)

CANADIAN_PROVINCES: frozenset[str] = frozenset(
    {"AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"}
)


def _text(env: Mapping[str, str], name: str, default: str = "") -> str:
    return (env.get(name) or default).strip()


def _boolean(env: Mapping[str, str], name: str, default: bool = False) -> bool:
    raw = _text(env, name, str(default)).lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off", ""}:
        return False
    raise ConfigurationError(f"{name} must be a boolean (true/false), got {raw!r}")


def _integer(env: Mapping[str, str], name: str, default: int, minimum: int = 1, maximum: int | None = None) -> int:
    raw = _text(env, name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer, got {raw!r}") from exc
    if value < minimum:
        raise ConfigurationError(f"{name} must be at least {minimum}")
    if maximum is not None and value > maximum:
        raise ConfigurationError(f"{name} must be at most {maximum}")
    return value


def _json_object(env: Mapping[str, str], name: str) -> dict[str, str]:
    raw = _text(env, name)
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigurationError(f"{name} is not valid JSON") from exc
    if not isinstance(value, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in value.items()):
        raise ConfigurationError(f"{name} must be a JSON object of string header values")
    return value


def parse_csv(raw: str) -> tuple[str, ...]:
    """Split a comma separated list, trimming blanks and preserving order without duplicates."""
    seen: list[str] = []
    for item in raw.split(","):
        value = item.strip()
        if value and value not in seen:
            seen.append(value)
    return tuple(seen)


def parse_resources(raw: str) -> tuple[str, ...]:
    """Validate WINTEAM_RESOURCES and return the names in canonical dependency order."""
    if not raw.strip():
        return RESOURCE_NAMES
    requested = parse_csv(raw.lower())
    unknown = [name for name in requested if name not in RESOURCE_NAMES]
    if unknown:
        raise ConfigurationError(
            f"WINTEAM_RESOURCES contains unknown resource(s) {', '.join(unknown)}; "
            f"valid names are {', '.join(RESOURCE_NAMES)}"
        )
    return tuple(name for name in RESOURCE_NAMES if name in requested)


def _location_ids(raw: str) -> tuple[int, ...]:
    ids: list[int] = []
    for item in parse_csv(raw):
        try:
            ids.append(int(item))
        except ValueError as exc:
            raise ConfigurationError("WINTEAM_LOCATION_IDS must be a comma separated list of integers") from exc
    return tuple(ids)


def _normalize_base_url(base: str, prefix: str) -> str:
    """Append the gateway API prefix (default /wtnextgen) when the configured base URL omits it.

    TEAM publishes the endpoints under https://<gateway>/wtnextgen/...; a base URL configured as the
    bare gateway host answers every documented path with 404 "Resource not found". Set
    WINTEAM_API_PREFIX to "" if a tenant's gateway really serves the endpoints at the root.
    """
    base = (base or "").strip().rstrip("/")
    prefix = (prefix or "").strip()
    if not base or not prefix:
        return base
    prefix = "/" + prefix.strip("/")
    if base.lower().endswith(prefix.lower()):
        return base
    return base + prefix


@dataclass(frozen=True)
class Settings:
    database_url: str | None
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: str

    winteam_enabled: bool
    winteam_base_url: str
    winteam_tenant_id: str
    winteam_subscription_key: str
    winteam_subscription_key_header: str
    winteam_extra_headers: dict[str, str]
    # Second WinTeam database: Sarus. A separate tenant the primary credentials do not reach.
    winteam_sarus_enabled: bool
    winteam_sarus_base_url: str
    winteam_sarus_tenant_id: str
    winteam_sarus_subscription_key: str
    winteam_sarus_extra_headers: dict[str, str]
    winteam_resources: tuple[str, ...]
    winteam_customer_numbers: tuple[str, ...]
    winteam_location_ids: tuple[int, ...]
    winteam_page_size: int
    winteam_backfill_months: int
    winteam_window_days: int
    winteam_lookback_days: int
    winteam_gl_fiscal_years: int
    winteam_schedule_jobs_limit: int
    winteam_gl_jobs_limit: int
    winteam_normalize: bool
    poll_seconds: int
    request_timeout_seconds: int
    max_pages_per_sync: int
    allow_insecure_http: bool
    max_retries: int
    ap_detail_invoice_limit: int
    companycam_api_token: str
    companycam_match_rule: str
    ingestion_idle_in_transaction_timeout_seconds: int
    mart_rebuild_lock_timeout_seconds: int

    finance_reference_database_url: str
    finance_reference_data_dir: str

    ingestion_admin_token: str
    log_level: str

    @classmethod
    def load(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env
        settings = cls(
            database_url=_text(env, "DATABASE_URL") or None,
            db_host=_text(env, "DB_HOST", "localhost"),
            db_port=_integer(env, "DB_PORT", 5432, maximum=65535),
            db_name=_text(env, "DB_NAME", "facilities"),
            db_user=_text(env, "DB_USER", "facilities_app"),
            db_password=env.get("DB_PASSWORD", "facilities_dev"),
            winteam_enabled=_boolean(env, "WINTEAM_ENABLED"),
            winteam_base_url=_normalize_base_url(_text(env, "WINTEAM_BASE_URL"), _text(env, "WINTEAM_API_PREFIX", "/wtnextgen")),
            winteam_tenant_id=_text(env, "WINTEAM_TENANT_ID"),
            winteam_subscription_key=_text(env, "WINTEAM_SUBSCRIPTION_KEY"),
            winteam_subscription_key_header=_text(env, "WINTEAM_SUBSCRIPTION_KEY_HEADER", "Ocp-Apim-Subscription-Key"),
            winteam_extra_headers=_json_object(env, "WINTEAM_HEADERS_JSON"),
            # Sarus is its own WinTeam database. Blank base URL = the same gateway as the primary
            # tenant (routing, not a secret). The key and tenant id never fall back to the primary's:
            # an implicit credential fallback is how one tenant's data ends up under another's.
            winteam_sarus_enabled=_boolean(env, "WINTEAM_SARUS_ENABLED"),
            winteam_sarus_base_url=_normalize_base_url(
                _text(env, "WINTEAM_SARUS_BASE_URL") or _text(env, "WINTEAM_BASE_URL"),
                _text(env, "WINTEAM_API_PREFIX", "/wtnextgen"),
            ),
            winteam_sarus_tenant_id=_text(env, "WINTEAM_SARUS_TENANT_ID"),
            winteam_sarus_subscription_key=_text(env, "WINTEAM_SARUS_SUBSCRIPTION_KEY"),
            winteam_sarus_extra_headers=_json_object(env, "WINTEAM_SARUS_HEADERS_JSON"),
            winteam_resources=parse_resources(_text(env, "WINTEAM_RESOURCES")),
            winteam_customer_numbers=parse_csv(_text(env, "WINTEAM_CUSTOMER_NUMBERS")),
            winteam_location_ids=_location_ids(_text(env, "WINTEAM_LOCATION_IDS")),
            winteam_page_size=_integer(env, "WINTEAM_PAGE_SIZE", 100, maximum=10_000),
            winteam_backfill_months=_integer(env, "WINTEAM_BACKFILL_MONTHS", 18, maximum=120),
            winteam_window_days=_integer(env, "WINTEAM_WINDOW_DAYS", 16, maximum=366),
            winteam_lookback_days=_integer(env, "WINTEAM_LOOKBACK_DAYS", 35, minimum=0, maximum=366),
            winteam_gl_fiscal_years=_integer(env, "WINTEAM_GL_FISCAL_YEARS", 2, maximum=10),
            winteam_schedule_jobs_limit=_integer(env, "WINTEAM_SCHEDULE_JOBS_LIMIT", 0, minimum=0),
            # Cap the per-job GL budget pull (0 = every active job); mirrors WINTEAM_SCHEDULE_JOBS_LIMIT.
            winteam_gl_jobs_limit=_integer(env, "WINTEAM_GL_JOBS_LIMIT", 0, minimum=0),
            # false = land raw payloads only; the worker and the admin sync endpoints skip normalization
            # (used while the marts cannot yet arbitrate between the API and the finance_reference source).
            winteam_normalize=_boolean(env, "WINTEAM_NORMALIZE", True),
            poll_seconds=_integer(env, "WINTEAM_POLL_SECONDS", 300, minimum=30),
            request_timeout_seconds=_integer(env, "WINTEAM_REQUEST_TIMEOUT_SECONDS", 30),
            max_pages_per_sync=_integer(env, "WINTEAM_MAX_PAGES_PER_SYNC", 500),
            allow_insecure_http=_boolean(env, "WINTEAM_ALLOW_INSECURE_HTTP"),
            max_retries=_integer(env, "WINTEAM_MAX_RETRIES", 4, minimum=0, maximum=20),
            # Backstop for the ingestion sessions: the sync loop must never sit `idle in transaction`
            # while it waits on WinTeam, so Postgres kills such a session instead of holding locks
            # against the mart rebuild and every reader behind it. 0 = server default (disabled).
            ingestion_idle_in_transaction_timeout_seconds=_integer(
                env, "WINTEAM_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS", 60, minimum=0, maximum=3600
            ),
            # ap_invoice_details is one GET per AP invoice. Only invoices whose distributions are not
            # already landed are fetched, so the first run backfills and later runs cost roughly the
            # month's new invoices. 0 = no cap.
            ap_detail_invoice_limit=_integer(
                env, "WINTEAM_AP_DETAIL_INVOICE_LIMIT", 0, minimum=0, maximum=100000
            ),
            # CompanyCam site photos. Server-side only - the browser never sees this token and
            # never calls CompanyCam directly. Absent by default, so photos stay off until the
            # production token is added to the server .env. Never give it a VITE_ prefix.
            companycam_api_token=_text(env, "COMPANYCAM_API_TOKEN"),
            # How a CompanyCam project is matched to a WinTeam job. Unset until the production data
            # has been probed: job_number_in_name | address | project_map.
            companycam_match_rule=_text(env, "COMPANYCAM_MATCH_RULE"),
            # The mart rebuild TRUNCATEs and refills mart.*; behind a stuck writer it should fail fast
            # with a diagnosable message rather than queue up. 0 = wait indefinitely (old behaviour).
            mart_rebuild_lock_timeout_seconds=_integer(
                env, "MART_REBUILD_LOCK_TIMEOUT_SECONDS", 30, minimum=0, maximum=3600
            ),
            finance_reference_database_url=_text(env, "FINANCE_REFERENCE_DATABASE_URL"),
            finance_reference_data_dir=_text(env, "FINANCE_REFERENCE_DATA_DIR"),
            ingestion_admin_token=_text(env, "INGESTION_ADMIN_TOKEN"),
            log_level=_text(env, "LOG_LEVEL", "INFO").upper(),
        )
        settings.validate()
        return settings

    # ── derived helpers ──────────────────────────────────────────────────────
    @property
    def winteam_configured(self) -> bool:
        return bool(self.winteam_base_url and self.winteam_tenant_id and self.winteam_resources)

    @property
    def winteam_base_url_host(self) -> str | None:
        return urlparse(self.winteam_base_url).hostname if self.winteam_base_url else None

    @property
    def finance_reference_configured(self) -> bool:
        """True when FINANCE_REFERENCE_DATABASE_URL names the restored Finance_Dashboard database."""
        return bool(self.finance_reference_database_url)

    @property
    def finance_reference_database_host(self) -> str | None:
        """Host of the reference database (never the credentials)."""
        if not self.finance_reference_database_url:
            return None
        parsed = urlparse(self.finance_reference_database_url)
        return parsed.hostname or None

    @property
    def winteam_sarus_configured(self) -> bool:
        return bool(self.winteam_sarus_base_url and self.winteam_sarus_tenant_id)

    def sarus_settings(self, *, enabled: bool | None = None) -> "Settings":
        """These settings pointed at the Sarus database, so the same GET-only client serves it.

        `enabled` overrides WINTEAM_SARUS_ENABLED - used by the credential probe, which must work
        before ingestion is switched on.
        """
        return replace(
            self,
            winteam_enabled=self.winteam_sarus_enabled if enabled is None else enabled,
            winteam_base_url=self.winteam_sarus_base_url,
            winteam_tenant_id=self.winteam_sarus_tenant_id,
            winteam_subscription_key=self.winteam_sarus_subscription_key,
            winteam_extra_headers=dict(self.winteam_sarus_extra_headers),
        )

    def winteam_headers(self) -> dict[str, str]:
        """Headers for every WinTeam call. Never log the returned dict."""
        headers: dict[str, str] = dict(self.winteam_extra_headers)
        headers["tenantId"] = self.winteam_tenant_id
        if self.winteam_subscription_key:
            headers[self.winteam_subscription_key_header] = self.winteam_subscription_key
        headers.setdefault("Accept", "application/json")
        return headers

    def validate(self) -> None:
        if self.winteam_sarus_tenant_id and self.winteam_sarus_tenant_id == self.winteam_tenant_id:
            raise ConfigurationError(
                "WINTEAM_SARUS_TENANT_ID is the primary tenant's id; it must name the Sarus database"
            )
        if self.finance_reference_database_url:
            parsed = urlparse(self.finance_reference_database_url)
            if parsed.scheme not in {"postgresql", "postgres"} or not parsed.hostname:
                raise ConfigurationError("FINANCE_REFERENCE_DATABASE_URL must be a postgresql:// URL (empty = source not configured)")
        if self.winteam_subscription_key and not self.winteam_subscription_key_header:
            raise ConfigurationError("WINTEAM_SUBSCRIPTION_KEY_HEADER must not be empty")
        if self.winteam_base_url:
            parsed = urlparse(self.winteam_base_url)
            allowed = {"http", "https"} if self.allow_insecure_http else {"https"}
            if parsed.scheme not in allowed:
                raise ConfigurationError("WINTEAM_BASE_URL must use HTTPS (set WINTEAM_ALLOW_INSECURE_HTTP=true only for local simulators)")
            if not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ConfigurationError("WINTEAM_BASE_URL must be a clean API origin/base path")
        if not self.winteam_enabled:
            return
        if not self.winteam_base_url:
            raise ConfigurationError("WINTEAM_BASE_URL is required when WINTEAM_ENABLED=true")
        if not self.winteam_tenant_id:
            raise ConfigurationError("WINTEAM_TENANT_ID (the tenantId GUID header) is required when WINTEAM_ENABLED=true")
        if not self.winteam_resources:
            raise ConfigurationError("At least one WinTeam resource must be enabled")


def _load_or_fail() -> Settings:
    try:
        return Settings.load()
    except ConfigurationError as exc:
        raise ConfigurationError(f"Invalid environment: {exc}") from exc


settings = _load_or_fail()
