"""Unit tests for the area-history log's pure logic."""

import importlib.util
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "update_area_history",
    Path(__file__).resolve().parent.parent / "scripts" / "update_area_history.py",
)
history = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(history)


def test_total_hectares_skips_missing_areas():
    collection = {
        "features": [
            {"properties": {"site_area_ha": 1.25}},
            {"properties": {"site_area_ha": None}},
            {"properties": {}},
            {"properties": {"site_area_ha": 0.5}},
        ]
    }
    assert history.total_hectares(collection) == 1.75


def test_record_logs_changes_only():
    series = []
    assert history.record(series, "2026-07-20T00:00Z", 88.578)
    assert not history.record(series, "2026-07-21T00:00Z", 88.581)
    assert history.record(series, "2026-07-22T00:00Z", 90.1)
    assert series == [
        {"date": "2026-07-20T00:00Z", "hectares": 88.58},
        {"date": "2026-07-22T00:00Z", "hectares": 90.1},
    ]
