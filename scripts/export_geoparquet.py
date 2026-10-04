"""Write GeoParquet copies of the published GeoJSON layers.

Each data/<name>.geojson is converted to data/<name>.parquet following the
GeoParquet 1.1 specification: geometries are stored as WKB in a "geometry"
column, the properties become typed columns (nested lists such as
planning_applications become list<struct> columns rather than JSON strings),
and the "geo" file metadata records the encoding, geometry types, bbox, and
CRS. The collection-level "metadata" member (attribution and licence) is
carried over as file key-value metadata.

Unlike GeoJSON, which RFC 7946 restricts to WGS84 longitude/latitude,
GeoParquet can carry any CRS, so the geometries are projected to Irish
Transverse Mercator (EPSG:2157), the national grid used by Tailte Eireann and
the councils, giving analysts metres for areas, distances, and buffers. The
transform treats WGS84 and IRENET95 (ETRS89) as coincident, as the sources'
own servers do; it is a closed-form projection needing no grid files, so
output is reproducible offline.

Features keep their GeoJSON order and columns are sorted, so the output is
deterministic for a given input and pinned pyarrow and pyproj versions.

Requires pyarrow, pyproj, and shapely (declared in pyproject.toml):

    uv run python scripts/export_geoparquet.py
"""

import json
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import shapely
from pyproj import CRS, Transformer

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

ITM = CRS.from_epsg(2157)
TO_ITM = Transformer.from_crs(4326, ITM, always_xy=True)

LAYERS = [
    "derelict_sites_register",
    "active_cases_grid",
    "vacant_sites_register",
    "rzlt_sites",
    "rzlt_sites_enriched",
]


def to_table(collection: dict) -> pa.Table:
    features = collection["features"]
    keys = sorted({key for feature in features for key in feature["properties"]})
    columns = {}
    for key in keys:
        column = pa.array([feature["properties"].get(key) for feature in features])
        # An all-null column infers the null type, which some readers reject.
        if pa.types.is_null(column.type):
            column = column.cast(pa.string())
        columns[key] = column

    geometries = shapely.transform(
        shapely.from_geojson([json.dumps(feature["geometry"]) for feature in features]),
        lambda coords: np.column_stack(TO_ITM.transform(coords[:, 0], coords[:, 1])),
    )
    columns["geometry"] = pa.array(shapely.to_wkb(geometries), type=pa.binary())

    geo = {
        "version": "1.1.0",
        "primary_column": "geometry",
        "columns": {
            "geometry": {
                "encoding": "WKB",
                # GeoJSON type names match the GeoParquet vocabulary.
                "geometry_types": sorted(
                    {feature["geometry"]["type"] for feature in features}
                ),
                "bbox": [round(v, 3) for v in shapely.total_bounds(geometries)],
                "crs": ITM.to_json_dict(),
            }
        },
    }
    metadata = {b"geo": json.dumps(geo, sort_keys=True).encode()}
    if "metadata" in collection:
        metadata[b"metadata"] = json.dumps(
            collection["metadata"], sort_keys=True, ensure_ascii=False
        ).encode()
    return pa.table(columns).replace_schema_metadata(metadata)


def main() -> None:
    for name in LAYERS:
        source = DATA / f"{name}.geojson"
        if not source.exists():
            print(f"{source.name} missing, skipped")
            continue
        table = to_table(json.loads(source.read_text()))
        target = DATA / f"{name}.parquet"
        pq.write_table(table, target, compression="zstd")
        print(f"Wrote {table.num_rows} rows to {target.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
