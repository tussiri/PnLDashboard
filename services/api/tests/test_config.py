"""Configuration parsing and validation (no database, no network)."""
from __future__ import annotations

import pytest

from app.config import RESOURCE_NAMES, ConfigurationError, Settings, parse_csv, parse_resources

ENABLED = {
    "WINTEAM_ENABLED": "true",
    "WINTEAM_BASE_URL": "https://api.example.test/wtnextgen/",
    "WINTEAM_TENANT_ID": "11111111-2222-3333-4444-555555555555",
}


def test_defaults_when_disabled() -> None:
    settings = Settings.load({})
    assert settings.winteam_enabled is False
    assert settings.winteam_resources == RESOURCE_NAMES
    assert settings.winteam_page_size == 100
    assert settings.winteam_backfill_months == 18
    assert settings.winteam_window_days == 16
    assert settings.winteam_lookback_days == 35
    assert settings.winteam_gl_fiscal_years == 2
    assert settings.winteam_schedule_jobs_limit == 0
    assert settings.max_retries == 4
    assert settings.winteam_subscription_key_header == "Ocp-Apim-Subscription-Key"
    assert settings.winteam_configured is False
    assert settings.winteam_base_url_host is None


def test_enabled_requires_base_url_and_tenant() -> None:
    with pytest.raises(ConfigurationError, match="WINTEAM_BASE_URL"):
        Settings.load({"WINTEAM_ENABLED": "true"})
    with pytest.raises(ConfigurationError, match="WINTEAM_TENANT_ID"):
        Settings.load({"WINTEAM_ENABLED": "true", "WINTEAM_BASE_URL": "https://api.example.test/wtnextgen"})


def test_enabled_happy_path_strips_trailing_slash() -> None:
    settings = Settings.load(ENABLED)
    assert settings.winteam_base_url == "https://api.example.test/wtnextgen"
    assert settings.winteam_base_url_host == "api.example.test"
    assert settings.winteam_configured is True


def test_http_base_url_requires_insecure_flag() -> None:
    env = {**ENABLED, "WINTEAM_BASE_URL": "http://localhost:8089/wtnextgen"}
    with pytest.raises(ConfigurationError, match="HTTPS"):
        Settings.load(env)
    settings = Settings.load({**env, "WINTEAM_ALLOW_INSECURE_HTTP": "true"})
    assert settings.winteam_base_url_host == "localhost"


def test_base_url_must_be_clean() -> None:
    with pytest.raises(ConfigurationError, match="clean"):
        Settings.load({**ENABLED, "WINTEAM_BASE_URL": "https://user:pw@api.example.test/wtnextgen"})


def test_unknown_resource_is_rejected() -> None:
    with pytest.raises(ConfigurationError, match="invoices"):
        Settings.load({"WINTEAM_RESOURCES": "jobs,invoices"})


def test_resources_are_returned_in_dependency_order() -> None:
    assert parse_resources("ar_invoices, JOBS ,timekeeping") == ("jobs", "timekeeping", "ar_invoices")
    assert parse_resources("") == RESOURCE_NAMES
    assert parse_resources("jobs,jobs") == ("jobs",)


def test_enabled_requires_at_least_one_resource() -> None:
    settings = Settings.load({**ENABLED, "WINTEAM_RESOURCES": ""})
    assert settings.winteam_resources == RESOURCE_NAMES


def test_headers_include_tenant_and_optional_subscription_key() -> None:
    settings = Settings.load(ENABLED)
    headers = settings.winteam_headers()
    assert headers["tenantId"] == ENABLED["WINTEAM_TENANT_ID"]
    assert "Ocp-Apim-Subscription-Key" not in headers

    settings = Settings.load(
        {
            **ENABLED,
            "WINTEAM_SUBSCRIPTION_KEY": "secret-key",
            "WINTEAM_SUBSCRIPTION_KEY_HEADER": "X-Gateway-Key",
            "WINTEAM_HEADERS_JSON": '{"X-Extra": "1"}',
        }
    )
    headers = settings.winteam_headers()
    assert headers["X-Gateway-Key"] == "secret-key"
    assert headers["X-Extra"] == "1"
    assert headers["tenantId"] == ENABLED["WINTEAM_TENANT_ID"]


def test_headers_json_must_be_object_of_strings() -> None:
    with pytest.raises(ConfigurationError, match="WINTEAM_HEADERS_JSON"):
        Settings.load({"WINTEAM_HEADERS_JSON": "[1]"})
    with pytest.raises(ConfigurationError, match="WINTEAM_HEADERS_JSON"):
        Settings.load({"WINTEAM_HEADERS_JSON": "{not json"})


def test_csv_lists() -> None:
    assert parse_csv(" 342, 17 ,, 342 ") == ("342", "17")
    settings = Settings.load({"WINTEAM_CUSTOMER_NUMBERS": "342, 17", "WINTEAM_LOCATION_IDS": "1, 2"})
    assert settings.winteam_customer_numbers == ("342", "17")
    assert settings.winteam_location_ids == (1, 2)
    with pytest.raises(ConfigurationError, match="WINTEAM_LOCATION_IDS"):
        Settings.load({"WINTEAM_LOCATION_IDS": "north"})


def test_bad_numbers_and_booleans_have_clear_messages() -> None:
    with pytest.raises(ConfigurationError, match="WINTEAM_PAGE_SIZE"):
        Settings.load({"WINTEAM_PAGE_SIZE": "lots"})
    with pytest.raises(ConfigurationError, match="at least 30"):
        Settings.load({"WINTEAM_POLL_SECONDS": "5"})
    with pytest.raises(ConfigurationError, match="WINTEAM_ENABLED"):
        Settings.load({"WINTEAM_ENABLED": "maybe"})


# ── Sarus: the second WinTeam database ───────────────────────────────────────
SARUS = {**ENABLED, "WINTEAM_SUBSCRIPTION_KEY": "crane-key",
         "WINTEAM_SARUS_TENANT_ID": "99999999-8888-7777-6666-555555555555",
         "WINTEAM_SARUS_SUBSCRIPTION_KEY": "sarus-key"}


def test_sarus_is_off_and_unconfigured_by_default() -> None:
    settings = Settings.load(ENABLED)
    assert settings.winteam_sarus_enabled is False
    assert settings.winteam_sarus_configured is False


def test_sarus_settings_swap_only_the_tenant_identity() -> None:
    """The same client, paging, retries and timeouts - pointed at the other database."""
    settings = Settings.load(SARUS)
    sarus = settings.sarus_settings(enabled=True)
    assert sarus.winteam_tenant_id == "99999999-8888-7777-6666-555555555555"
    assert sarus.winteam_subscription_key == "sarus-key"
    assert sarus.winteam_headers()["tenantId"] == "99999999-8888-7777-6666-555555555555"
    assert sarus.winteam_enabled is True
    assert sarus.winteam_resources == settings.winteam_resources
    assert sarus.request_timeout_seconds == settings.request_timeout_seconds
    # The primary settings object is untouched.
    assert settings.winteam_tenant_id == "11111111-2222-3333-4444-555555555555"


def test_a_blank_sarus_base_url_uses_the_primary_gateway() -> None:
    settings = Settings.load(SARUS)
    assert settings.winteam_sarus_base_url == settings.winteam_base_url


def test_the_sarus_key_never_falls_back_to_the_primary_key() -> None:
    """An implicit credential fallback is how one tenant's data lands under another's."""
    env = {k: v for k, v in SARUS.items() if k != "WINTEAM_SARUS_SUBSCRIPTION_KEY"}
    settings = Settings.load(env)
    assert settings.winteam_sarus_subscription_key == ""
    assert "Ocp-Apim-Subscription-Key" not in settings.sarus_settings().winteam_headers()


def test_pointing_sarus_at_the_primary_tenant_is_refused() -> None:
    """Same tenant id twice would ingest every Crane record a second time."""
    with pytest.raises(ConfigurationError, match="WINTEAM_SARUS_TENANT_ID"):
        Settings.load({**SARUS, "WINTEAM_SARUS_TENANT_ID": ENABLED["WINTEAM_TENANT_ID"]})
