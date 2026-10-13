"""Shared fixtures: roles (app/roles.py) live in memory for every test, never in a database."""
from __future__ import annotations

from dataclasses import replace

import pytest

from app import refresh_pause, roles


class MemoryRoleStore:
    def __init__(self):
        self.rows: dict[str, dict] = {}

    def all(self):
        return [dict(r) for r in self.rows.values()]

    def upsert(self, slug, name, permissions_, actor, *, create_only):
        taken = any(r["name"].lower() == name.lower() and s != slug for s, r in self.rows.items())
        if (create_only and slug in self.rows) or taken:
            return False
        self.rows[slug] = {"slug": slug, "name": name, "permissions": dict(permissions_)}
        return True

    def delete(self, slug):
        return self.rows.pop(slug, None) is not None


@pytest.fixture(autouse=True)
def role_store():
    store = MemoryRoleStore()
    roles.set_store(store)
    yield store
    roles.set_store(roles.PostgresRoleStore())


@pytest.fixture(autouse=True)
def no_refresh_pause(monkeypatch):
    """The suite must not depend on the wall clock: the weekly refresh pause is off unless a test sets it."""
    monkeypatch.setattr(refresh_pause, "settings", replace(refresh_pause.settings, refresh_pause_windows=()))
