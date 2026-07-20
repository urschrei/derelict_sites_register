"""Fetch the Dublin City Council Derelict Sites Register from ArcGIS Online.

Writes deterministic GeoJSON (features ordered by OBJECTID, sorted keys) so
that repeated runs produce identical files unless the underlying data has
changed, keeping version-control diffs meaningful. Also writes a CSV of the
attribute table for users who do not work with GIS formats.

Uses only the standard library so it can run in CI without dependencies.
"""

import csv
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

SERVICE_URL = (
    "https://services-eu1.arcgis.com/PyGgzM45TvWtSBsM/arcgis/rest/services/"
    "DCC_Derelict_Sites_Register_Public_points_view/FeatureServer/0/query"
)

QUERY_PARAMS = {
    "where": "1=1",
    "outFields": "*",
    "outSR": "4326",
    "orderByFields": "OBJECTID",
    "f": "geojson",
}

CSV_FIELDS = [
    "derelict_site_reference_number",
    "full_address",
    "administrative_area_name",
    "derelict_site_status",
    "is_on_current_derelict_sites_register",
    "is_active_derelict_site_case",
    "is_on_current_record_of_protected_structures",
    "is_owned_by_dublin_city_council",
    "date_added_to_the_derelict_sites_register",
    "most_recent_update_date",
    "derelict_site_description",
    "site_location_latitude",
    "site_location_longitude",
]

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
GEOJSON_PATH = DATA_DIR / "derelict_sites_register.geojson"
CSV_PATH = DATA_DIR / "derelict_sites_register.csv"


def fetch_geojson() -> dict:
    url = f"{SERVICE_URL}?{urllib.parse.urlencode(QUERY_PARAMS)}"
    with urllib.request.urlopen(url, timeout=60) as response:
        payload = json.load(response)
    if "error" in payload:
        raise RuntimeError(f"ArcGIS query failed: {payload['error']}")
    if payload.get("type") != "FeatureCollection":
        raise RuntimeError(f"Unexpected response type: {payload.get('type')}")
    return payload


def write_outputs(collection: dict) -> int:
    features = collection["features"]
    DATA_DIR.mkdir(exist_ok=True)
    GEOJSON_PATH.write_text(
        json.dumps(collection, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    )
    with CSV_PATH.open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for feature in features:
            writer.writerow(feature["properties"])
    return len(features)


def main() -> None:
    collection = fetch_geojson()
    count = write_outputs(collection)
    print(f"Wrote {count} features to {GEOJSON_PATH.name} and {CSV_PATH.name}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Data fetch failed: {exc}", file=sys.stderr)
        sys.exit(1)
