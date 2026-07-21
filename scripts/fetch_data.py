"""Fetch the Dublin City Council Derelict Sites Register from ArcGIS Online.

Retrieves two datasets:

- the public register points, written as GeoJSON plus a CSV of the attribute
  table for users who do not work with GIS formats
- the council's active-cases grid, an aggregation of all active derelict
  site cases (a much larger set than the published register) to square
  cells, written as GeoJSON

Output is deterministic (features ordered by object id, sorted keys) so that
repeated runs produce identical files unless the underlying data has
changed, keeping version-control diffs meaningful.

Uses only the standard library so it can run in CI without dependencies.
"""

import csv
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

SERVICE_ROOT = "https://services-eu1.arcgis.com/PyGgzM45TvWtSBsM/arcgis/rest/services"

REGISTER_URL = (
    f"{SERVICE_ROOT}/DCC_Derelict_Sites_Register_Public_points_view/"
    "FeatureServer/0/query"
)
REGISTER_PARAMS = {
    "where": "1=1",
    "outFields": "*",
    "outSR": "4326",
    "orderByFields": "OBJECTID",
    "f": "geojson",
}

# Note: despite the name, the grid was generated in Web Mercator, so the
# "1000 m" cells are really about 600 m across on the ground at Dublin's
# latitude (Shape__Area reports the nominal Mercator area, not the true one).
GRID_URL = (
    f"{SERVICE_ROOT}/Derelict_SItes_Active_Cases_1000m_Grid/FeatureServer/1/query"
)
GRID_PARAMS = {
    "where": "1=1",
    "outFields": "OID,num_active",
    "outSR": "4326",
    "orderByFields": "OID",
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
GRID_PATH = DATA_DIR / "active_cases_grid.geojson"

# Top-level GeoJSON metadata (a foreign member on the FeatureCollection, not
# repeated per feature). Underlying data is Dublin City Council's; this credits
# the compilation and points back to the project.
REPOSITORY = "https://github.com/urschrei/derelict_sites_register"
METADATA = {
    "attribution": "Compiled by Stephan Hügel",
    "license": "CC-BY-4.0",
    "license_url": "https://creativecommons.org/licenses/by/4.0/",
    "repository": REPOSITORY,
}


def fetch_geojson(base_url: str, params: dict) -> dict:
    url = f"{base_url}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=60) as response:
        payload = json.load(response)
    if "error" in payload:
        raise RuntimeError(f"ArcGIS query failed: {payload['error']}")
    if payload.get("type") != "FeatureCollection":
        raise RuntimeError(f"Unexpected response type: {payload.get('type')}")
    return payload


def write_json(path: Path, collection: dict) -> None:
    path.write_text(
        json.dumps(collection, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    )


def write_register(collection: dict) -> int:
    features = collection["features"]
    write_json(GEOJSON_PATH, collection)
    with CSV_PATH.open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for feature in features:
            writer.writerow(feature["properties"])
    return len(features)


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    register = fetch_geojson(REGISTER_URL, REGISTER_PARAMS)
    register["metadata"] = METADATA
    count = write_register(register)
    print(f"Wrote {count} features to {GEOJSON_PATH.name} and {CSV_PATH.name}")

    grid = fetch_geojson(GRID_URL, GRID_PARAMS)
    grid["metadata"] = METADATA
    write_json(GRID_PATH, grid)
    total = sum(f["properties"]["num_active"] for f in grid["features"])
    print(
        f"Wrote {len(grid['features'])} grid cells ({total} active cases) "
        f"to {GRID_PATH.name}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Data fetch failed: {exc}", file=sys.stderr)
        sys.exit(1)
