#!/usr/bin/env python3
"""Verify sources/geo/city_centroids.json against the WinTeam job master export.

Checks:
  1. every distinct (JobCity, JobState) pair in the export has an entry,
  2. every entry's lat/lng falls inside the state's plausible bounding box,
  3. every entry has a recognised precision value,
and prints counts by precision. Exit status is non-zero when a check fails.
"""
from __future__ import annotations

import csv
import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
CSV_PATH = HERE.parent / "winteam_exports" / "Crane_job_master_report.csv"
JSON_PATH = HERE / "city_centroids.json"
PRECISIONS = {"city_center", "approximate_area"}

# Generous state bounding boxes (lat_min, lat_max, lng_min, lng_max) in decimal degrees.
STATE_BOUNDS: dict[str, tuple[float, float, float, float]] = {
    "AL": (30.1, 35.1, -88.5, -84.8),
    "AR": (33.0, 36.6, -94.7, -89.6),
    "AZ": (31.3, 37.1, -115.0, -109.0),
    "CA": (32.5, 42.1, -124.5, -114.1),
    "CO": (36.9, 41.1, -109.1, -102.0),
    "CT": (40.9, 42.1, -73.8, -71.7),
    "DE": (38.4, 39.9, -75.8, -75.0),
    "FL": (24.4, 31.1, -87.7, -79.9),
    "GA": (30.3, 35.1, -85.7, -80.7),
    "IA": (40.3, 43.6, -96.7, -90.1),
    "IL": (36.9, 42.6, -91.6, -87.4),
    "IN": (37.7, 41.8, -88.2, -84.7),
    "KS": (36.9, 40.1, -102.1, -94.5),
    "KY": (36.4, 39.2, -89.6, -81.9),
    "LA": (28.9, 33.1, -94.1, -88.7),
    "MA": (41.2, 42.9, -73.6, -69.9),
    "MD": (37.9, 39.8, -79.5, -74.9),
    "MI": (41.6, 48.4, -90.5, -82.1),
    "MN": (43.4, 49.5, -97.3, -89.4),
    "MO": (35.9, 40.7, -95.8, -89.0),
    "MS": (30.1, 35.1, -91.7, -88.0),
    "NC": (33.7, 36.7, -84.4, -75.4),
    "NE": (39.9, 43.1, -104.1, -95.2),
    "NJ": (38.9, 41.4, -75.6, -73.8),
    "NM": (31.3, 37.1, -109.1, -103.0),
    "NV": (35.0, 42.1, -120.1, -114.0),
    "NY": (40.4, 45.1, -79.8, -71.7),
    "OH": (38.3, 42.1, -84.9, -80.4),
    "OK": (33.5, 37.1, -103.1, -94.3),
    "OR": (41.9, 46.3, -124.6, -116.4),
    "PA": (39.6, 42.4, -80.6, -74.6),
    "SC": (32.0, 35.3, -83.4, -78.4),
    "TN": (34.9, 36.7, -90.4, -81.6),
    "TX": (25.7, 36.6, -106.7, -93.4),
    "UT": (36.9, 42.1, -114.1, -109.0),
    "VA": (36.4, 39.6, -83.7, -75.1),
    "WA": (45.4, 49.1, -124.9, -116.8),
    "WI": (42.4, 47.2, -92.9, -86.7),
    "WV": (37.1, 40.7, -82.7, -77.6),
}


def key_for(city: str, state: str) -> str:
    return f"{city.strip()}|{state.strip().upper()}"


def csv_pairs(path: Path) -> Counter[str]:
    pairs: Counter[str] = Counter()
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            city = (row.get("JobCity") or "").strip()
            state = (row.get("JobState") or "").strip().upper()
            if city or state:
                pairs[key_for(city, state)] += 1
    return pairs


def main() -> int:
    pairs = csv_pairs(CSV_PATH)
    centroids: dict[str, dict] = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    problems: list[str] = []

    missing = sorted(k for k in pairs if k not in centroids)
    for key in missing:
        problems.append(f"missing entry for {key} ({pairs[key]} jobs)")

    extra = sorted(k for k in centroids if k not in pairs)
    for key in extra:
        print(f"note: {key} is in the table but not in the export")

    by_precision: Counter[str] = Counter()
    for key, entry in centroids.items():
        state = key.rsplit("|", 1)[-1]
        lat, lng, precision = entry.get("lat"), entry.get("lng"), entry.get("precision")
        if precision not in PRECISIONS:
            problems.append(f"{key}: unknown precision {precision!r}")
        by_precision[str(precision)] += 1
        if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
            problems.append(f"{key}: lat/lng must be numbers")
            continue
        bounds = STATE_BOUNDS.get(state)
        if bounds is None:
            problems.append(f"{key}: no bounding box for state {state}")
            continue
        lat_min, lat_max, lng_min, lng_max = bounds
        if not (lat_min <= lat <= lat_max and lng_min <= lng <= lng_max):
            problems.append(f"{key}: ({lat}, {lng}) is outside the {state} bounding box {bounds}")

    print(f"distinct (city, state) pairs in export: {len(pairs)}")
    print(f"entries in city_centroids.json:         {len(centroids)}")
    for precision, count in sorted(by_precision.items()):
        print(f"  {precision:<18} {count}")
    if problems:
        print(f"\n{len(problems)} problem(s):")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("\nOK: every pair has an in-bounds centroid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
