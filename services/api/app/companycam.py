"""CompanyCam connector: site photos, read-only.

Credentials are server-side only. The browser never sees the token and never calls CompanyCam
directly; it asks this API, which proxies. Nothing here may use a VITE_ prefix.

Deliberately unconfigured by default. `COMPANYCAM_API_TOKEN` is absent from this repo and from the
local stack, so every call reports `configured: false` and the map panel says photos are not wired
rather than erroring. Add the production token to the server `.env` to switch it on.

The match between a CompanyCam project and a WinTeam job is NOT decided here. The shape of the real
project data has not been seen yet, so `probe()` exists to look at it with production credentials
before a rule is committed - guessing a match and silently attaching the wrong site's photos to a
financial panel is exactly the failure this platform has spent its effort removing.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from .config import settings

logger = logging.getLogger("companycam")

API_BASE = "https://api.companycam.com/v2"
TIMEOUT_SECONDS = 15


class CompanyCamError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def configured() -> bool:
    return bool(settings.companycam_api_token)


def status() -> dict[str, Any]:
    """What the UI needs to decide whether to offer photos at all. Never returns the token."""
    return {
        "configured": configured(),
        "base_url": API_BASE,
        "match_rule": settings.companycam_match_rule or None,
        "note": (
            "Photos are off until COMPANYCAM_API_TOKEN is set in the server .env. "
            "The project-to-job match rule is unset until the production data has been probed."
        ) if not configured() else None,
    }


def _client() -> httpx.Client:
    if not configured():
        raise CompanyCamError("COMPANYCAM_API_TOKEN is not configured", status_code=None)
    return httpx.Client(
        base_url=API_BASE,
        headers={
            "Authorization": f"Bearer {settings.companycam_api_token}",
            "Accept": "application/json",
        },
        timeout=TIMEOUT_SECONDS,
        follow_redirects=False,
    )


def _get(path: str, params: dict[str, Any] | None = None) -> Any:
    with _client() as client:
        response = client.get(path, params=params or {})
    if response.status_code == 204:
        return None
    if response.status_code >= 400:
        raise CompanyCamError(
            f"CompanyCam returned HTTP {response.status_code}", status_code=response.status_code
        )
    return response.json()


def probe(limit: int = 5) -> dict[str, Any]:
    """Fetch a few projects and report the SHAPE, so a match rule can be chosen from evidence.

    Returns the field names present and a small redacted sample - enough to see whether projects
    carry an address, coordinates, or a name holding the WinTeam job number - without dumping a
    customer's full photo library into a log or a browser.
    """
    payload = _get("/projects", {"per_page": max(1, min(limit, 25))})
    projects = payload if isinstance(payload, list) else (payload or {}).get("projects") or []
    fields: set[str] = set()
    sample: list[dict[str, Any]] = []
    for project in projects[:limit]:
        if not isinstance(project, dict):
            continue
        fields.update(project.keys())
        sample.append({
            "id": project.get("id"),
            "name": project.get("name"),
            "address": project.get("address"),
            "coordinates": project.get("coordinates"),
            "status": project.get("status"),
            "photo_count": project.get("photo_count"),
        })
    return {
        "configured": True,
        "projects_returned": len(projects),
        "fields_present": sorted(fields),
        "sample": sample,
        "next_step": (
            "Pick a match rule from these fields and set COMPANYCAM_MATCH_RULE "
            "(job_number_in_name | address | project_map)."
        ),
    }


def photos_for_project(project_id: str, limit: int = 12) -> list[dict[str, Any]]:
    """Recent photos for one project, reduced to what a map panel renders."""
    payload = _get(f"/projects/{project_id}/photos", {"per_page": max(1, min(limit, 50))})
    photos = payload if isinstance(payload, list) else (payload or {}).get("photos") or []
    out: list[dict[str, Any]] = []
    for photo in photos[:limit]:
        if not isinstance(photo, dict):
            continue
        uris = {u.get("type"): u.get("uri") for u in (photo.get("uris") or []) if isinstance(u, dict)}
        out.append({
            "id": photo.get("id"),
            "captured_at": photo.get("captured_at"),
            "thumbnail": uris.get("thumbnail") or uris.get("web"),
            "web": uris.get("web") or uris.get("original"),
            "creator_name": photo.get("creator_name"),
        })
    return out
