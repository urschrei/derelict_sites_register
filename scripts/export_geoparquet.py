"""Write GeoParquet copies of the published GeoJSON layers.

Each data/<name>.geojson is converted to data/<name>.parquet following the
GeoParquet 1.1 specification: geometries are stored as WKB in a "geometry"
column, the properties become typed columns (nested lists such as
planning_applications become list<struct> columns rather than JSON strings),
and the "geo" file metadata records the encoding, geometry types and bbox.
The CRS is left unset, which GeoParquet defines as OGC:CRS84, matching the
WGS84 longitude/latitude GeoJSON sources. The collection-level "metadata"
member (attribution and licence) is carried over as file key-value metadata.

Features keep their GeoJSON order and columns are sorted, so the output is
deterministic for a given input and pinned pyarrow version.

Requires pyarrow and shapely (declared in pyproject.toml):

    uv run python scripts/export_geoparquet.py
"""

import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import shapely

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

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

    geometries = shapely.from_geojson(
        [json.dumps(feature["geometry"]) for feature in features]
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
                "bbox": [round(v, 8) for v in shapely.total_bounds(geometries)],
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
