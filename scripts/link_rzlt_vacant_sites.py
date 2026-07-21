"""Link RZLT parcels to the Vacant Sites Register sites they cover.

Spatially joins data/rzlt_sites.geojson against
data/vacant_sites_register.geojson and writes data/rzlt_vacant_links.csv,
one row per (parcel, site) pair where the RZLT parcel covers at least half
of the vacant site's footprint. DCC seeded its RZLT submission from the
Vacant Sites Register, so these parcels are the historical register sites
continuing under the new regime; fetch_rzlt.py merges the link into the
parcel attributes at build time.

The links only change when either geometry set changes, so this is run
manually (it needs shapely, which CI does not install):

    uv run --with shapely scripts/link_rzlt_vacant_sites.py

The resulting CSV is committed.
"""

import csv
import json
from pathlib import Path

from shapely.geometry import shape
from shapely.strtree import STRtree

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
RZLT_PATH = DATA_DIR / "rzlt_sites.geojson"
VACANT_PATH = DATA_DIR / "vacant_sites_register.geojson"
OUT_PATH = DATA_DIR / "rzlt_vacant_links.csv"

# The parcel must cover this fraction of the vacant site to count as the
# same site. The observed distribution is strongly bimodal (near-complete
# coverage for seeded parcels, near-zero for incidental neighbours), so the
# exact cut-off is not sensitive.
MIN_COVERAGE = 0.5


def load_geoms(path):
    collection = json.loads(path.read_text())
    geoms, props = [], []
    for feature in collection["features"]:
        geom = shape(feature["geometry"])
        if not geom.is_valid:
            geom = geom.buffer(0)
        geoms.append(geom)
        props.append(feature["properties"])
    return geoms, props


def main():
    parcel_geoms, parcel_props = load_geoms(RZLT_PATH)
    site_geoms, site_props = load_geoms(VACANT_PATH)
    tree = STRtree(parcel_geoms)

    rows = []
    for site_geom, site in zip(site_geoms, site_props):
        for i in tree.query(site_geom):
            coverage = parcel_geoms[i].intersection(site_geom).area / site_geom.area
            if coverage >= MIN_COVERAGE:
                rows.append(
                    {
                        "parcel_id": parcel_props[i]["parcel_id"],
                        "register_number": site["register_number"],
                        "coverage_pct": round(coverage * 100, 1),
                    }
                )
    rows.sort(key=lambda r: (r["parcel_id"], r["register_number"]))

    with OUT_PATH.open("w", newline="") as fh:
        writer = csv.DictWriter(
            fh, fieldnames=["parcel_id", "register_number", "coverage_pct"]
        )
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows)} parcel-to-site links to {OUT_PATH.name}")


if __name__ == "__main__":
    main()
