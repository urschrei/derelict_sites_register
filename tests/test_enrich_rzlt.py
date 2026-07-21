"""Unit tests for the RZLT enrichment pipeline's pure logic.

No network: each test drives one helper with small in-memory fixtures.
"""

import importlib.util
from datetime import date
from pathlib import Path

import shapely

SPEC = importlib.util.spec_from_file_location(
    "enrich_rzlt", Path(__file__).resolve().parent.parent / "scripts" / "enrich_rzlt.py"
)
enrich = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(enrich)


def test_epoch_ms_to_iso():
    # 2022-04-05T00:00:00Z in epoch milliseconds.
    assert enrich.epoch_ms_to_iso(1649116800000) == "2022-04-05"
    assert enrich.epoch_ms_to_iso(None) is None


def test_arcgis_pages_terminates_on_missing_flag(monkeypatch):
    # A single full page with no exceededTransferLimit flag must terminate.
    pages = [{"features": [{"id": i} for i in range(2000)]}]

    def fake_fetch(url, **kwargs):
        return pages.pop(0) if pages else {"features": []}

    monkeypatch.setattr(enrich, "fetch", fake_fetch)
    got = list(
        enrich.arcgis_pages(
            "u", {"where": "1=1"}, offline=False, stats={"cache_hits": 0}
        )
    )
    assert len(got) == 1
    assert len(got[0]) == 2000


def test_arcgis_pages_follows_transfer_limit(monkeypatch):
    responses = [
        {"features": [{"id": 1}], "exceededTransferLimit": True},
        {"features": [{"id": 2}], "exceededTransferLimit": True},
        {"features": [{"id": 3}]},
    ]

    def fake_fetch(url, **kwargs):
        return responses.pop(0)

    monkeypatch.setattr(enrich, "fetch", fake_fetch)
    got = list(enrich.arcgis_pages("u", {}, offline=False, stats={"cache_hits": 0}))
    assert [f[0]["id"] for f in got] == [1, 2, 3]


def test_arcgis_pages_stops_on_empty_page(monkeypatch):
    # A zero-feature page terminates even if the flag says otherwise.
    responses = [{"features": [], "exceededTransferLimit": True}]

    def fake_fetch(url, **kwargs):
        return responses.pop(0)

    monkeypatch.setattr(enrich, "fetch", fake_fetch)
    got = list(enrich.arcgis_pages("u", {}, offline=False, stats={"cache_hits": 0}))
    assert got == [[]]


def test_outcome_of_buckets():
    assert enrich.outcome_of("GRANT PERMISSION") == "Granted"
    assert enrich.outcome_of("GRANT RETENTION PERMISSIO") == "Granted"  # truncated
    assert enrich.outcome_of("grant permission   ") == "Granted"  # padded
    # Refusal is tested before permission, since refused decisions also
    # mention "permission".
    assert enrich.outcome_of("REFUSE PERMISSION") == "Refused"
    assert enrich.outcome_of("APPLICATION DECLARED INVALID") == "Refused"
    assert enrich.outcome_of("APPLICATION WITHDRAWN") == "Other"
    assert enrich.outcome_of("") == "Undecided"
    assert enrich.outcome_of(None) == "Undecided"


def test_portal_url_encodes_reference():
    url = enrich.portal_url("4253/24")
    assert url.endswith("Folder1_Ref=4253%2F24")


def test_application_record_truncates_long_proposal():
    src = {
        "ApplicationNumber": "1234/25",
        "Decision": "GRANT PERMISSION",
        "ApplicationType": "Permission",
        "ReceivedDate": 1649116800000,
        "DevelopmentDescription": "x" * 1000,
    }
    rec = enrich.application_record(src)
    assert rec["outcome"] == "Granted"
    assert rec["registration_date"] == "2022-04-05"
    assert len(rec["proposal"]) <= enrich.PROPOSAL_MAX
    assert rec["proposal"].endswith("…")


def test_join_planning_sorts_and_aggregates(monkeypatch):
    monkeypatch.setattr(enrich, "assert_itm_bbox", lambda *a, **k: None)
    parcel = _square(0, 0, 100)

    # Three applications all intersecting the parcel: a granted 2023, a
    # refused 2024, and an undated one.
    def feature(app_no, decision, received):
        return {
            "geometry": shapely.geometry.mapping(_square(10, 10, 50)),
            "properties": {
                "ApplicationNumber": app_no,
                "Decision": decision,
                "ReceivedDate": received,
                "ApplicationType": "Permission",
                "ApplicationStatus": "Decided",
                "DevelopmentDescription": "desc",
            },
        }

    features = [
        feature("1/23", "GRANT PERMISSION", 1672531200000),  # 2023-01-01
        feature("2/24", "REFUSE PERMISSION", 1704067200000),  # 2024-01-01
        feature("3/22", "", None),  # undated, undecided
    ]
    results, decision_map = enrich.join_planning(
        [("P", parcel)], features, [], date(2025, 1, 1)
    )
    r = results["P"]
    assert r["plan_n_apps_10yr"] == 3
    assert r["plan_n_granted_10yr"] == 1
    # Newest first; the undated application sinks to the bottom.
    order = [a["plan_ref"] for a in r["planning_applications"]]
    assert order == ["2/24", "1/23", "3/22"]
    assert r["plan_latest_app_no"] == "2/24"
    # The internal expiry helper is not published.
    assert all("expiry_ms" not in a for a in r["planning_applications"])
    assert decision_map["GRANT PERMISSION"] == "Granted"


# The ownership and valuation joins assert their geometry falls inside
# Ireland's ITM envelope, so fixtures sit at a real Dublin ITM origin
# (Grand Canal Dock, ~715000/733000) rather than at the coordinate origin.
ITM_X0, ITM_Y0 = 715_000, 733_000


def _square(x0, y0, size):
    return shapely.box(x0, y0, x0 + size, y0 + size)


def _itm_square(dx, dy, size):
    return _square(ITM_X0 + dx, ITM_Y0 + dy, size)


def test_sliver_guard_rejects_small_overlaps():
    # A 100x100 = 10000 m2 parcel: threshold is max(100, 0.05*10000) = 500 m2.
    parcel_geom = _itm_square(0, 0, 100)
    # An asset overlapping only a 5x5 = 25 m2 corner is below threshold.
    tiny = {
        "geometry": shapely.geometry.mapping(_itm_square(-95, -95, 100)),
        "owner": "X",
        "folio": "F",
    }
    result = enrich.join_ownership([("P", parcel_geom)], [tiny], [])
    assert result["P"]["own_is_public"] is False
    assert result["P"]["own_public_pct"] == 0.0


def test_sliver_guard_accepts_real_overlaps():
    parcel_geom = _itm_square(0, 0, 100)  # 10000 m2
    asset = {
        "geometry": shapely.geometry.mapping(_itm_square(50, 0, 100)),
        "owner": "State Body",
        "folio": "DN1",
    }
    result = enrich.join_ownership([("P", parcel_geom)], [asset], [])
    assert result["P"]["own_is_public"] is True
    assert result["P"]["own_bodies"] == "State Body"
    assert result["P"]["own_public_pct"] == 50.0


def test_public_pct_unions_overlapping_assets():
    # Two assets covering the same half must not sum past 50%.
    parcel_geom = _itm_square(0, 0, 100)
    assets = [
        {
            "geometry": shapely.geometry.mapping(_itm_square(0, 0, 50)),
            "owner": "A",
            "folio": None,
        },
        {
            "geometry": shapely.geometry.mapping(_itm_square(0, 0, 50)),
            "owner": "B",
            "folio": None,
        },
    ]
    result = enrich.join_ownership([("P", parcel_geom)], assets, [])
    assert result["P"]["own_public_pct"] == 25.0  # a 50x50 corner of a 100x100
    assert result["P"]["own_bodies"] == "A; B"


def test_coverage_ratio_unions_overlapping_footprints():
    parcel = _square(0, 0, 100)  # 100x100
    # Two overlapping full-height strips, x in [0,60] and [40,90]; their
    # union is x in [0,90] = 90% of the parcel, not 60% + 50% = 110%.
    footprints = [shapely.box(0, 0, 60, 100), shapely.box(40, 0, 90, 100)]
    result = enrich.join_buildings([("P", parcel)], footprints)
    assert result["P"]["bld_n_buildings"] == 2
    assert result["P"]["bld_coverage"] == 0.9


def test_coverage_ratio_never_exceeds_one():
    parcel = _square(0, 0, 100)
    footprints = [_square(0, 0, 200), _square(-10, -10, 200)]  # both cover the parcel
    result = enrich.join_buildings([("P", parcel)], footprints)
    assert result["P"]["bld_coverage"] == 1.0


def test_assemble_buildings_way_ring():
    elements = [
        {
            "type": "way",
            "geometry": [
                {"lon": 0, "lat": 0},
                {"lon": 1, "lat": 0},
                {"lon": 1, "lat": 1},
                {"lon": 0, "lat": 1},
            ],
        }
    ]
    polys = enrich.assemble_buildings(elements)
    assert len(polys) == 1
    assert polys[0].area == 1.0


def test_assemble_buildings_skips_degenerate_ring():
    elements = [
        {"type": "way", "geometry": [{"lon": 0, "lat": 0}, {"lon": 1, "lat": 1}]}
    ]
    assert enrich.assemble_buildings(elements) == []


def test_assemble_buildings_relation_with_hole():
    outer = [
        {"lon": 0, "lat": 0},
        {"lon": 10, "lat": 0},
        {"lon": 10, "lat": 10},
        {"lon": 0, "lat": 10},
    ]
    inner = [
        {"lon": 4, "lat": 4},
        {"lon": 6, "lat": 4},
        {"lon": 6, "lat": 6},
        {"lon": 4, "lat": 6},
    ]
    elements = [
        {
            "type": "relation",
            "members": [
                {"role": "outer", "geometry": outer},
                {"role": "inner", "geometry": inner},
            ],
        }
    ]
    polys = enrich.assemble_buildings(elements)
    assert len(polys) == 1
    assert polys[0].area == 100 - 4  # 10x10 outer minus 2x2 hole


def test_detect_crs():
    wgs84 = {"features": [{"geometry": shapely.geometry.mapping(_square(-6, 53, 1))}]}
    itm = {
        "features": [
            {"geometry": shapely.geometry.mapping(_square(715000, 733000, 100))}
        ]
    }
    assert enrich.detect_parcels_crs(wgs84) == "EPSG:4326"
    assert enrich.detect_parcels_crs(itm) == "EPSG:2157"
