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
