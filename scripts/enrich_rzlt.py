"""Enrich the RZLT vacant/idle parcels with planning, ownership, valuation,
and building-footprint data.

A non-interactive batch pipeline: reads data/rzlt_sites.geojson (the Dublin
City vacant/idle parcels written by fetch_rzlt.py) and joins four layers,
writing data/rzlt_sites_enriched.geojson, data/rzlt_sites_enriched.csv, and
data/rzlt_run_manifest.json. Runnable unattended; every fetch has timeouts
and retries, raw responses are cached under cache/ keyed by request hash,
and --offline reruns the whole pipeline from cache alone.

The four layers, all joined in Irish Transverse Mercator (EPSG:2157):

1. Planning applications (Department of Housing "IrishPlanningApplications"
   ArcGIS service, layer 1 site polygons, CC-BY 4.0). Applications received
   in the last ten years intersecting a parcel are aggregated to counts, a
   granted count, a live-permission flag, and the latest application's
   details. The GeoJSON also carries the full per-application list (newest
   first) under planning_applications, each with a Granted/Refused/Other
   outcome for the status badges - the same buckets the vacant sites register
   uses. Decision strings are messy (truncated variants, padded whitespace);
   the outcome mapping used is recorded in the run manifest. The flat CSV
   keeps only the scalar aggregates.
2. State ownership (PRA State Assets and LDA-sourced State Assets ArcGIS
   services, Land Development Agency). Overlaps count only above a sliver
   threshold: max(100 m2, 5% of parcel area). The public share of each
   parcel is computed on the unioned overlap so overlapping asset polygons
   are not double-counted.
3. Commercial valuations (Tailte Eireann Valuation Open Data API,
   opendata.tailte.ie). Every rateable property in Dublin City with its net
   annual value (NAV) and category; coordinates are already ITM. Missing
   NAVs (confidential categories) stay null rather than zero. If this API
   is unreachable the three val_* fields are written as null and the run
   still succeeds, with the manifest flagging the layer unavailable.
4. Building footprints (OpenStreetMap via Overpass, ODbL). One bbox query
   for the whole parcel set; way and multipolygon geometries are assembled
   locally and each parcel gets the unioned footprint coverage ratio.

Output is deterministic for a given cache: parcels stay sorted by parcel_id,
derived floats are rounded, and files are written to a temp path then
renamed. Requires shapely>=2, pyproj>=3.6, and requests:

    uv run --with "shapely>=2,pyproj>=3.6,requests" scripts/enrich_rzlt.py
"""

import argparse
import csv
import hashlib
import io
import json
import logging
import random
import sys
import time
import urllib.parse
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import requests
import shapely
from pyproj import Transformer
from shapely.geometry import shape
from shapely.geometry.polygon import Polygon
from shapely.strtree import STRtree

log = logging.getLogger("enrich_rzlt")

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
INPUT_PATH = DATA_DIR / "rzlt_sites.geojson"
OUTPUT_GEOJSON = DATA_DIR / "rzlt_sites_enriched.geojson"
OUTPUT_CSV = DATA_DIR / "rzlt_sites_enriched.csv"
MANIFEST_PATH = DATA_DIR / "rzlt_run_manifest.json"
CACHE_DIR = ROOT / "cache"

USER_AGENT = (
    "derelict-sites-register-enrichment/1.0 "
    "(+https://github.com/urschrei/derelict_sites_register)"
)
TIMEOUT = 30
RETRIES = 3

PLANNING_URL = (
    "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/"
    "IrishPlanningApplications/FeatureServer/1/query"
)
PRA_URL = (
    "https://services6.arcgis.com/Vx9miIJ7oMVDgH95/arcgis/rest/services/"
    "PRA_State_Assets_OpenData_Live/FeatureServer/0/query"
)
LDA_URL = (
    "https://services6.arcgis.com/Vx9miIJ7oMVDgH95/arcgis/rest/services/"
    "State_Assets_Sourced_by_LDA_OpenData_Live/FeatureServer/0/query"
)
VALUATION_URL = "https://opendata.tailte.ie/api/Property/GetProperties"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# DCC applications carry no direct link in the national dataset, but their
# reference format matches the council's PublicAccess portal (as used by the
# vacant sites register), so the documents link is built the same way.
PORTAL_URL = (
    "https://webapps.dublincity.ie/PublicAccess_Live/SearchResult/"
    "RunThirdPartySearch?FileSystemId=PL&Folder1_Ref="
)
# Application descriptions run to thousands of characters; trim for the badge
# list so the payload and panel stay manageable.
PROPOSAL_MAX = 320

PAGE_SIZE = 2000
# Sliver guard for the ownership overlay: an overlap below this is ignored.
SLIVER_ABS_M2 = 100.0
SLIVER_FRAC = 0.05

# All 16 enrichment fields, in output column order.
ENRICHMENT_FIELDS = [
    "plan_n_apps_10yr",
    "plan_n_granted_10yr",
    "plan_live_permission",
    "plan_latest_app_no",
    "plan_latest_status",
    "plan_latest_decision",
    "plan_latest_received",
    "own_is_public",
    "own_bodies",
    "own_folios",
    "own_public_pct",
    "val_n_props",
    "val_total_nav",
    "val_uses",
    "bld_coverage",
    "bld_n_buildings",
]

ATTRIBUTION = {
    "planning": "Irish Planning Applications, Department of Housing, Local "
    "Government and Heritage (CC-BY 4.0)",
    "ownership": "PRA State Assets and State Assets Sourced by LDA, Land "
    "Development Agency open data",
    "valuation": "Valuation Open Data, Tailte Eireann",
    "buildings": "Building footprints (c) OpenStreetMap contributors, ODbL "
    "(https://www.openstreetmap.org/copyright)",
}

TO_ITM = Transformer.from_crs(4326, 2157, always_xy=True)

# Ireland's plausible ITM envelope; every layer must land inside it.
ITM_RANGE = {"x": (400_000, 800_000), "y": (500_000, 1_000_000)}


# --- HTTP with retries and a response cache ---------------------------------


def cache_key(url: str, params: dict | None, body: str | None) -> Path:
    payload = json.dumps({"url": url, "params": params, "body": body}, sort_keys=True)
    return CACHE_DIR / f"{hashlib.sha256(payload.encode()).hexdigest()}.json"


def fetch(
    url: str,
    *,
    params: dict | None = None,
    body: str | None = None,
    offline: bool = False,
    stats: dict | None = None,
    timeout: int = TIMEOUT,
) -> dict | list:
    """GET (or POST when body is given) JSON, via the response cache."""
    path = cache_key(url, params, body)
    if path.exists():
        if stats is not None:
            stats["cache_hits"] += 1
        return json.loads(path.read_text())
    if offline:
        raise RuntimeError(f"--offline but no cached response for {url}")

    headers = {"User-Agent": USER_AGENT}
    for attempt in range(RETRIES):
        try:
            if body is None:
                response = requests.get(
                    url, params=params, headers=headers, timeout=timeout
                )
            else:
                response = requests.post(
                    url, params=params, data=body, headers=headers, timeout=timeout
                )
            # Overpass signals load-shedding with 429/504; give it one long
            # pause before the normal backoff ladder continues.
            if response.status_code in (429, 504) and url == OVERPASS_URL:
                log.warning(
                    "Overpass returned %s, backing off 60 s", response.status_code
                )
                time.sleep(60)
                response = requests.post(
                    url, params=params, data=body, headers=headers, timeout=timeout
                )
            response.raise_for_status()
            payload = response.json()
        except (requests.RequestException, ValueError) as exc:
            if attempt == RETRIES - 1:
                raise RuntimeError(f"Fetch failed after {RETRIES} tries: {url}: {exc}")
            delay = 2**attempt + random.uniform(0, 1)
            log.warning("Retrying %s in %.1f s (%s)", url, delay, exc)
            time.sleep(delay)
            continue
        CACHE_DIR.mkdir(exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload))
        tmp.rename(path)
        return payload
    raise AssertionError("unreachable")


def arcgis_pages(url: str, params: dict, *, offline: bool, stats: dict):
    """Yield feature pages until the transfer limit flag clears.

    Absence of exceededTransferLimit means the page is the last one; a page
    with zero features also terminates (some servers omit the flag).
    """
    offset = 0
    while True:
        page_params = params | {
            "resultOffset": str(offset),
            "resultRecordCount": str(PAGE_SIZE),
        }
        payload = fetch(url, params=page_params, offline=offline, stats=stats)
        if "error" in payload:
            raise RuntimeError(f"ArcGIS query failed: {payload['error']}")
        features = payload.get("features", [])
        yield features
        if not features or not exceeded_limit(payload):
            return
        offset += len(features)


def exceeded_limit(payload: dict) -> bool:
    return bool(
        payload.get("exceededTransferLimit")
        or payload.get("properties", {}).get("exceededTransferLimit")
    )


# --- Geometry helpers -------------------------------------------------------


def to_itm(geom):
    return shapely.transform(
        geom,
        lambda coords: np.column_stack(TO_ITM.transform(coords[:, 0], coords[:, 1])),
    )


def valid(geom, repairs: list, label: str):
    if geom.is_valid:
        return geom
    repairs.append(label)
    return shapely.make_valid(geom)


def assert_itm_bbox(geoms, layer: str) -> None:
    xmin, ymin, xmax, ymax = shapely.total_bounds(geoms)
    (x_lo, x_hi), (y_lo, y_hi) = ITM_RANGE["x"], ITM_RANGE["y"]
    if not (x_lo <= xmin <= xmax <= x_hi and y_lo <= ymin <= ymax <= y_hi):
        raise RuntimeError(
            f"{layer}: bbox ({xmin:.0f},{ymin:.0f},{xmax:.0f},{ymax:.0f}) "
            "outside Ireland's ITM range - wrong CRS?"
        )


def epoch_ms_to_iso(value) -> str | None:
    """ArcGIS dates are epoch milliseconds."""
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).date().isoformat()


def detect_parcels_crs(collection: dict) -> str:
    """GeoJSON is 4326 by spec, but a projected export is possible."""
    coords = shapely.get_coordinates(shape(collection["features"][0]["geometry"]))
    crs = "EPSG:2157" if abs(coords[0][0]) > 180 else "EPSG:4326"
    log.info("Input parcel CRS detected as %s", crs)
    return crs


# --- Layer 1: planning applications -----------------------------------------


def normalise_decision(raw: str | None) -> str:
    return (raw or "").strip().upper()


def outcome_of(raw: str | None) -> str:
    """A decision string mapped to a badge outcome.

    The same buckets the vacant sites register uses, so both views share the
    Granted / Refused badge colours. Refusal is tested first because refused
    decisions also mention "permission".
    """
    lowered = normalise_decision(raw).lower()
    if not lowered:
        return "Undecided"
    if "refuse" in lowered or "invalid" in lowered:
        return "Refused"
    if "grant" in lowered or "declare" in lowered or "permission" in lowered:
        return "Granted"
    return "Other"


def portal_url(app_number: str) -> str:
    return PORTAL_URL + urllib.parse.quote(app_number, safe="")


def application_record(src: dict) -> dict:
    """A planning feature as the badge list needs it (vacant-register shape)."""
    proposal = (src.get("DevelopmentDescription") or "").strip()
    if len(proposal) > PROPOSAL_MAX:
        proposal = proposal[: PROPOSAL_MAX - 1].rstrip() + "…"
    app_number = src.get("ApplicationNumber") or ""
    return {
        "plan_ref": app_number or None,
        "outcome": outcome_of(src.get("Decision")),
        "decision": normalise_decision(src.get("Decision")) or None,
        "status": src.get("ApplicationStatus") or None,
        "app_type": src.get("ApplicationType") or None,
        "registration_date": epoch_ms_to_iso(src.get("ReceivedDate")),
        "proposal": proposal or None,
        "expiry_ms": src.get("ExpiryDate") or 0,
        "planning_portal_url": portal_url(app_number) if app_number else None,
    }


def fetch_planning(offline: bool, stats: dict, cutoff: date):
    params = {
        "where": (
            "PlanningAuthority='Dublin City Council' "
            f"AND ReceivedDate >= DATE '{cutoff.isoformat()}'"
        ),
        "outFields": (
            "ApplicationNumber,ApplicationStatus,ApplicationType,Decision,"
            "DevelopmentDescription,ReceivedDate,DecisionDate,ExpiryDate"
        ),
        "outSR": "2157",
        "orderByFields": "OBJECTID",
        "f": "geojson",
    }
    features = []
    for page in arcgis_pages(PLANNING_URL, params, offline=offline, stats=stats):
        features.extend(page)
    return features


def join_planning(parcels, features, repairs, today: date):
    geoms = []
    props = []
    for feature in features:
        if not feature.get("geometry"):
            continue
        geoms.append(valid(shape(feature["geometry"]), repairs, "planning"))
        props.append(feature["properties"])
    decision_map = {}
    results = {}
    if geoms:
        assert_itm_bbox(geoms, "planning")
    tree = STRtree(geoms) if geoms else None
    now_ms = (
        datetime(today.year, today.month, today.day, tzinfo=timezone.utc).timestamp()
        * 1000
    )
    for parcel_id, geom in parcels:
        idx = tree.query(geom, predicate="intersects") if tree else []
        apps = [application_record(props[i]) for i in idx]
        for app in apps:
            decision_map[app["decision"] or ""] = app["outcome"]
        # Newest first; undated applications sink to the bottom.
        apps.sort(
            key=lambda a: (a["registration_date"] or "", a["plan_ref"] or ""),
            reverse=True,
        )
        granted = [a for a in apps if a["outcome"] == "Granted"]
        live = any(a["expiry_ms"] > now_ms for a in granted)
        latest = apps[0] if apps else None
        # The expiry helper is internal to the live-permission test; drop it
        # from the published records.
        for app in apps:
            app.pop("expiry_ms", None)
        results[parcel_id] = {
            "plan_n_apps_10yr": len(apps),
            "plan_n_granted_10yr": len(granted),
            "plan_live_permission": live,
            "plan_latest_app_no": latest and latest["plan_ref"],
            "plan_latest_status": latest and latest["status"],
            "plan_latest_decision": latest and latest["decision"],
            "plan_latest_received": latest and latest["registration_date"],
            "planning_applications": apps,
        }
    return results, decision_map


# --- Layer 2: state ownership -----------------------------------------------


def fetch_state_assets(offline: bool, stats: dict):
    """Both state-asset layers, with their differing owner/folio fields."""
    sources = [
        (PRA_URL, "REG_OWNER", "FOLIO,REG_OWNER,GovAgency"),
        (LDA_URL, "Registered_Owner", "Registered_Owner,GovAgency"),
    ]
    assets = []
    for url, owner_field, out_fields in sources:
        params = {
            "where": "COUNTY='Dublin'",
            "outFields": out_fields,
            "outSR": "2157",
            "orderByFields": "OBJECTID",
            "f": "geojson",
        }
        count = 0
        for page in arcgis_pages(url, params, offline=offline, stats=stats):
            for feature in page:
                if not feature.get("geometry"):
                    continue
                p = feature["properties"]
                assets.append(
                    {
                        "geometry": feature["geometry"],
                        "owner": p.get("GovAgency") or p.get(owner_field),
                        "folio": p.get("FOLIO"),
                    }
                )
                count += 1
        log.info("State assets: %d Dublin polygons from %s", count, url.split("/")[-4])
    return assets


def sliver_threshold(parcel_area: float) -> float:
    return max(SLIVER_ABS_M2, SLIVER_FRAC * parcel_area)


def join_ownership(parcels, assets, repairs):
    geoms = [valid(shape(a["geometry"]), repairs, "state-assets") for a in assets]
    if geoms:
        assert_itm_bbox(geoms, "state-assets")
    tree = STRtree(geoms) if geoms else None
    results = {}
    for parcel_id, geom in parcels:
        overlaps = []
        bodies = set()
        folios = set()
        for i in tree.query(geom, predicate="intersects") if tree else []:
            inter = geoms[i].intersection(geom)
            if inter.area <= sliver_threshold(geom.area):
                continue
            overlaps.append(inter)
            if assets[i]["owner"]:
                bodies.add(assets[i]["owner"])
            if assets[i]["folio"]:
                folios.add(assets[i]["folio"])
        # Union before measuring so overlapping asset polygons are not
        # double-counted.
        pct = shapely.union_all(overlaps).area / geom.area * 100 if overlaps else 0.0
        results[parcel_id] = {
            "own_is_public": bool(overlaps),
            "own_bodies": "; ".join(sorted(bodies)) or None,
            "own_folios": "; ".join(sorted(folios)) or None,
            "own_public_pct": round(min(pct, 100.0), 2),
        }
    return results


# --- Layer 3: commercial valuations -----------------------------------------


def fetch_valuations(offline: bool, stats: dict):
    params = {
        "Fields": "*",
        "LocalAuthority": "DUBLIN CITY COUNCIL",
        "Format": "json",
    }
    payload = fetch(
        VALUATION_URL, params=params, offline=offline, stats=stats, timeout=120
    )
    if not isinstance(payload, list):
        raise RuntimeError(f"Unexpected valuation payload: {type(payload)}")
    return payload


def join_valuations(parcels, properties):
    points = []
    rows = []
    for prop in properties:
        x, y = prop.get("Xitm"), prop.get("Yitm")
        if not x or not y:
            continue
        points.append(shapely.Point(x, y))
        rows.append(prop)
    if points:
        assert_itm_bbox(points, "valuations")
    tree = STRtree(points) if points else None
    results = {}
    for parcel_id, geom in parcels:
        idx = tree.query(geom, predicate="covers") if tree else []
        hits = [rows[i] for i in idx]
        navs = [p["Valuation"] for p in hits if p.get("Valuation") is not None]
        uses = sorted({p["Uses"] for p in hits if p.get("Uses")})
        results[parcel_id] = {
            "val_n_props": len(hits),
            "val_total_nav": round(float(sum(navs)), 2) if navs else None,
            "val_uses": "; ".join(uses) or None,
        }
    return results


def null_valuations(parcels):
    return {
        parcel_id: {"val_n_props": None, "val_total_nav": None, "val_uses": None}
        for parcel_id, _ in parcels
    }


# --- Layer 4: OSM building footprints ---------------------------------------


def overpass_query(bbox_4326) -> str:
    xmin, ymin, xmax, ymax = bbox_4326
    bbox = f"{ymin},{xmin},{ymax},{xmax}"
    return (
        "[out:json][timeout:120];"
        f'(way["building"]({bbox});relation["building"]({bbox}););'
        "out geom;"
    )


def ring_from_geometry(points) -> list | None:
    """An Overpass geometry node list as a closed ring, or None if degenerate."""
    ring = [(p["lon"], p["lat"]) for p in points]
    if ring and ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring if len(ring) >= 4 else None


def _clean(polygon):
    """A ring polygon repaired to validity, or None if it collapses."""
    if polygon.is_valid:
        return polygon
    repaired = shapely.make_valid(polygon)
    return repaired if not repaired.is_empty else None


def assemble_buildings(elements) -> list:
    """Overpass ways and multipolygon relations as shapely polygons.

    Individual rings are repaired before any set operation: OSM buildings
    include self-intersecting ways and relations, which would otherwise
    raise a TopologyException in the outer/inner union.
    """
    polygons = []
    for element in elements:
        if element["type"] == "way" and "geometry" in element:
            ring = ring_from_geometry(element["geometry"])
            if ring:
                cleaned = _clean(Polygon(ring))
                if cleaned is not None:
                    polygons.append(cleaned)
        elif element["type"] == "relation":
            outers = []
            inners = []
            for member in element.get("members", []):
                if "geometry" not in member:
                    continue
                ring = ring_from_geometry(member["geometry"])
                if not ring:
                    continue
                cleaned = _clean(Polygon(ring))
                if cleaned is None:
                    continue
                (inners if member.get("role") == "inner" else outers).append(cleaned)
            if outers:
                geom = shapely.union_all(outers)
                if inners:
                    geom = geom.difference(shapely.union_all(inners))
                if not geom.is_empty:
                    polygons.append(geom)
    return polygons


def fetch_buildings(parcels, offline: bool, stats: dict, repairs: list):
    # One Overpass request for the buffered bbox of the whole parcel set,
    # expressed in 4326; assembly and the join happen locally.
    bounds = shapely.total_bounds([geom for _, geom in parcels])
    buffered = shapely.box(*bounds).buffer(100)
    from_itm = Transformer.from_crs(2157, 4326, always_xy=True)
    bbox_geom = shapely.transform(
        buffered,
        lambda c: np.column_stack(from_itm.transform(c[:, 0], c[:, 1])),
    )
    payload = fetch(
        OVERPASS_URL,
        body=overpass_query(shapely.total_bounds(bbox_geom)),
        offline=offline,
        stats=stats,
        timeout=150,
    )
    footprints = [
        to_itm(valid(p, repairs, "osm"))
        for p in assemble_buildings(payload["elements"])
    ]
    if footprints:
        assert_itm_bbox(footprints, "buildings")
    return footprints


def join_buildings(parcels, footprints):
    tree = STRtree(footprints) if footprints else None
    results = {}
    for parcel_id, geom in parcels:
        idx = tree.query(geom, predicate="intersects") if tree else []
        clipped = [footprints[i].intersection(geom) for i in idx]
        # Union first so overlapping OSM geometries cannot push the ratio
        # past 1.
        coverage = shapely.union_all(clipped).area / geom.area if clipped else 0.0
        results[parcel_id] = {
            "bld_coverage": round(coverage, 3),
            "bld_n_buildings": len(idx),
        }
    return results


# --- Assembly ---------------------------------------------------------------


def atomic_write(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    tmp.rename(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--offline", action="store_true", help="serve every request from cache"
    )
    args = parser.parse_args()
    logging.basicConfig(
        stream=sys.stderr, level=logging.INFO, format="%(levelname)s %(message)s"
    )

    today = date.today()
    # Pinned to a calendar-year boundary so the upstream query (and its
    # cache key) is stable across reruns within the same year.
    cutoff = date(today.year - 10, 1, 1)
    stats = {"cache_hits": 0}
    repairs: list[str] = []
    manifest: dict = {
        "run": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "planning_received_cutoff": cutoff.isoformat(),
        "sources": {},
        "layers": {},
        "attribution": ATTRIBUTION,
    }

    collection = json.loads(INPUT_PATH.read_text())
    features = collection["features"]
    crs = detect_parcels_crs(collection)
    parcels = []
    for feature in features:
        geom = shape(feature["geometry"])
        if crs == "EPSG:4326":
            geom = to_itm(geom)
        parcels.append(
            (feature["properties"]["parcel_id"], valid(geom, repairs, "parcel"))
        )
    assert_itm_bbox([geom for _, geom in parcels], "parcels")
    parcel_ids = [pid for pid, _ in parcels]
    if len(set(parcel_ids)) != len(parcel_ids):
        raise RuntimeError("Duplicate parcel_id in input")
    log.info("Loaded %d parcels", len(parcels))

    planning_features = fetch_planning(args.offline, stats, cutoff)
    planning, decision_map = join_planning(parcels, planning_features, repairs, today)
    manifest["sources"]["planning"] = {
        "url": PLANNING_URL,
        "fetched": len(planning_features),
    }
    manifest["decision_normalisation"] = dict(sorted(decision_map.items()))
    manifest["layers"]["planning"] = "ok"
    log.info(
        "Planning: fetched %d, parcels with apps %d",
        len(planning_features),
        sum(1 for v in planning.values() if v["plan_n_apps_10yr"]),
    )

    assets = fetch_state_assets(args.offline, stats)
    ownership = join_ownership(parcels, assets, repairs)
    manifest["sources"]["ownership"] = {
        "urls": [PRA_URL, LDA_URL],
        "fetched": len(assets),
    }
    manifest["layers"]["ownership"] = "ok"
    log.info(
        "Ownership: fetched %d, public parcels %d",
        len(assets),
        sum(1 for v in ownership.values() if v["own_is_public"]),
    )

    try:
        properties = fetch_valuations(args.offline, stats)
        valuations = join_valuations(parcels, properties)
        manifest["sources"]["valuation"] = {
            "url": VALUATION_URL,
            "fetched": len(properties),
        }
        manifest["layers"]["valuation"] = "ok"
        log.info(
            "Valuation: fetched %d, parcels with properties %d",
            len(properties),
            sum(1 for v in valuations.values() if v["val_n_props"]),
        )
    except RuntimeError as exc:
        # The valuation API is the one layer allowed to fail without
        # failing the run.
        log.warning("Valuation layer unavailable: %s", exc)
        valuations = null_valuations(parcels)
        manifest["layers"]["valuation"] = "unavailable"

    footprints = fetch_buildings(parcels, args.offline, stats, repairs)
    buildings = join_buildings(parcels, footprints)
    manifest["sources"]["buildings"] = {
        "url": OVERPASS_URL,
        "fetched": len(footprints),
    }
    manifest["layers"]["buildings"] = "ok"
    log.info(
        "Buildings: %d footprints, mean coverage %.2f",
        len(footprints),
        sum(v["bld_coverage"] for v in buildings.values()) / len(parcels),
    )

    if repairs:
        log.info(
            "Repaired %d invalid geometries: %s", len(repairs), sorted(set(repairs))
        )
    manifest["geometry_repairs"] = sorted(set(repairs))

    enriched = []
    for feature in features:
        pid = feature["properties"]["parcel_id"]
        props = dict(feature["properties"])
        for layer in (planning, ownership, valuations, buildings):
            props.update(layer[pid])
        enriched.append(
            {"type": "Feature", "properties": props, "geometry": feature["geometry"]}
        )
    enriched.sort(key=lambda f: f["properties"]["parcel_id"])

    out = {"type": "FeatureCollection", "features": enriched}
    geojson_text = json.dumps(out, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    atomic_write(OUTPUT_GEOJSON, geojson_text)

    # The per-application list is a nested field carried only in the GeoJSON;
    # the flat CSV keeps the scalar columns and drops it via extrasaction.
    skip = set(ENRICHMENT_FIELDS) | {"planning_applications"}
    base_fields = [k for k in enriched[0]["properties"] if k not in skip]
    csv_fields = base_fields + ENRICHMENT_FIELDS
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=csv_fields, extrasaction="ignore")
    writer.writeheader()
    for feature in enriched:
        writer.writerow(feature["properties"])
    atomic_write(OUTPUT_CSV, buffer.getvalue())

    manifest["parcels_in"] = len(features)
    manifest["parcels_out"] = len(enriched)
    manifest["cache_hits"] = stats["cache_hits"]
    manifest["output_sha256"] = hashlib.sha256(geojson_text.encode()).hexdigest()
    atomic_write(MANIFEST_PATH, json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    log.info(
        "Wrote %d enriched parcels to %s (cache hits: %d)",
        len(enriched),
        OUTPUT_GEOJSON.name,
        stats["cache_hits"],
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        log.error("Enrichment failed: %s", exc)
        sys.exit(1)
