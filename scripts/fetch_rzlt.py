"""Fetch Dublin City vacant/idle land from the Residential Zoned Land Tax map.

The Vacant Sites Register was made obsolete by the Residential Zoned Land Tax
(RZLT, Finance Act 2021), and DCC has added nothing to it since April 2022.
The RZLT final map, published by the Department of Housing, Local Government
and Heritage as a public ArcGIS feature service, is the living successor: for
land not zoned solely residential (the generalised zoning types M1, M2, and
M3, and Dublin City's R3 parcels, which are Z14 strategic development and
regeneration areas), inclusion on the map requires the council to have
determined that the land is vacant or idle. Those parcels are what this
script fetches.

Blanket residential zonings (R2, the bulk of the map) are excluded: they are
on the map because the land is serviced, not because it is vacant, and they
arrive as neighbourhood-scale polygons that identify no individual site. R1
(undeveloped residential land) is included in the filter for future-proofing,
although Dublin City's current development plan produces no R1 parcels.

If data/rzlt_vacant_links.csv exists (built by link_rzlt_vacant_sites.py),
each parcel gains the register numbers of the Vacant Sites Register sites it
covers, linking the living dataset back to the historical register.

Output is deterministic (parcels ordered by parcel id, sorted keys) so diffs
only appear when the underlying data changes. Uses only the standard library
so it can run in CI without dependencies.
"""

import csv
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

LAYER_URL = (
    "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/"
    "Residential_Zoned_Land_Tax_Final_Map2026_view/FeatureServer/0/query"
)
WHERE = (
    "LOCAL_AUTHORITY_NAME='Dublin City Council' "
    "AND ZONE_GZT IN ('R1','R3','M1','M2','M3')"
)
PAGE_SIZE = 2000

FIELDS = {
    "PARCEL_ID": "parcel_id",
    "ZONE_GZT": "zone_gzt",
    "ZONE_ORIG": "zone_orig",
    "ZONE_DESC": "zone_desc",
    "SITE_AREA": "site_area_ha",
    "DATE_ADDED": "date_added",
}
CSV_FIELDS = list(FIELDS.values()) + ["former_vacant_sites"]

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
GEOJSON_PATH = DATA_DIR / "rzlt_sites.geojson"
CSV_PATH = DATA_DIR / "rzlt_sites.csv"
LINKS_PATH = DATA_DIR / "rzlt_vacant_links.csv"

# Top-level GeoJSON metadata (a foreign member on the FeatureCollection, not
# repeated per feature). RZLT parcels also link to the enrichment methodology.
REPOSITORY = "https://github.com/urschrei/derelict_sites_register"
METADATA = {
    "attribution": "Compiled by Stephan Hügel",
    "license": "CC-BY-4.0",
    "license_url": "https://creativecommons.org/licenses/by/4.0/",
    "repository": REPOSITORY,
    "methodology": f"{REPOSITORY}/blob/main/docs/rzlt_enrichment.md",
}


def fetch_parcels() -> list[dict]:
    features = []
    offset = 0
    while True:
        params = {
            "where": WHERE,
            "outFields": ",".join(FIELDS),
            "outSR": "4326",
            "orderByFields": "PARCEL_ID",
            "resultOffset": str(offset),
            "resultRecordCount": str(PAGE_SIZE),
            "f": "geojson",
        }
        url = f"{LAYER_URL}?{urllib.parse.urlencode(params)}"
        with urllib.request.urlopen(url, timeout=120) as response:
            payload = json.load(response)
        if "error" in payload:
            raise RuntimeError(f"ArcGIS query failed: {payload['error']}")
        if payload.get("type") != "FeatureCollection":
            raise RuntimeError(f"Unexpected response type: {payload.get('type')}")
        features.extend(payload["features"])
        if len(payload["features"]) < PAGE_SIZE:
            return features
        offset += PAGE_SIZE


def load_links() -> dict[str, list[str]]:
    """Former Vacant Sites Register numbers keyed by RZLT parcel id."""
    if not LINKS_PATH.exists():
        return {}
    links: dict[str, list[str]] = {}
    with LINKS_PATH.open(newline="") as fh:
        for row in csv.DictReader(fh):
            links.setdefault(row["parcel_id"], []).append(row["register_number"])
    return {pid: sorted(regs) for pid, regs in links.items()}


def iso_date(epoch_ms):
    if not epoch_ms:
        return None
    return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).date().isoformat()


def build_collection(raw: list[dict], links: dict[str, list[str]]) -> dict:
    features = []
    for feature in raw:
        src = feature["properties"]
        props = {out: src.get(col) for col, out in FIELDS.items()}
        props["date_added"] = iso_date(props["date_added"])
        props["site_area_ha"] = (
            round(props["site_area_ha"], 3)
            if props["site_area_ha"] is not None
            else None
        )
        props["former_vacant_sites"] = "; ".join(links.get(props["parcel_id"], []))
        features.append(
            {"type": "Feature", "properties": props, "geometry": feature["geometry"]}
        )
    features.sort(key=lambda f: f["properties"]["parcel_id"])
    return {"type": "FeatureCollection", "metadata": METADATA, "features": features}


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    collection = build_collection(fetch_parcels(), load_links())
    GEOJSON_PATH.write_text(
        json.dumps(collection, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    )
    with CSV_PATH.open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for feature in collection["features"]:
            writer.writerow(feature["properties"])
    linked = sum(
        1 for f in collection["features"] if f["properties"]["former_vacant_sites"]
    )
    print(
        f"Wrote {len(collection['features'])} RZLT parcels "
        f"({linked} matching former vacant sites) "
        f"to {GEOJSON_PATH.name} and {CSV_PATH.name}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Data fetch failed: {exc}", file=sys.stderr)
        sys.exit(1)
