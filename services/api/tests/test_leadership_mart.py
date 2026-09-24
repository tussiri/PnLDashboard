"""Structural test of the mart.leadership_week rebuild SQL (no database): the INSERT column list and
the final SELECT list stay aligned, and every column exists in migration 030."""
from __future__ import annotations

import re
from pathlib import Path

from app.leadership import REBUILD_SQL

MIGRATION = Path(__file__).resolve().parents[3] / "database" / "migrations" / "030_leadership_week.sql"


def _top_level_items(text: str) -> list[str]:
    items, depth, current = [], 0, ""
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            items.append(current.strip())
            current = ""
        else:
            current += ch
    if current.strip():
        items.append(current.strip())
    return items


def test_insert_and_select_lists_align_with_the_table():
    columns = [c.strip() for c in re.search(r"INSERT INTO mart\.leadership_week \((.*?)\)\s*WITH", REBUILD_SQL, re.S)[1].split(",")]
    final_select = REBUILD_SQL[REBUILD_SQL.rindex("\nSELECT") + len("\nSELECT"):REBUILD_SQL.rindex("FROM assembled a")]
    assert len(_top_level_items(final_select)) == len(columns)
    ddl = MIGRATION.read_text()
    for column in columns:
        assert re.search(rf"^\s+{column} ", ddl, re.M), column


def test_takes_the_subcontract_gl_range_as_parameters():
    assert set(re.findall(r"%\((\w+)\)s", REBUILD_SQL)) == {"subcontract_gl_low", "subcontract_gl_high"}
