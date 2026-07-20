"""Fetch the Dublin City Council Vacant Sites Register from MapZone.

The Vacant Sites Register is a separate statutory register from the Derelict
Sites Register (it is maintained under the Urban Regeneration and Housing Act
2015). DCC publishes it only through the MapZone planning viewer, which is
backed by an "M.App Enterprise" server. That server exposes an authenticated
SQL-query endpoint returning GeoJSON; the login is the public/public account
embedded in the viewer, so no secret is required.

Two datasets are written:

- the register itself, as polygon GeoJSON plus a CSV of the attribute table
- the planning applications whose footprint falls within each site boundary,
  as a CSV. The two registers are linked spatially, not by a shared key: the
  vacant-site geometry is stored under the legacy SRID 3785 while the planning
  geometry uses 3857, so the join re-stamps the SRID before intersecting.

Output is deterministic (features ordered by register number, sorted keys) so
that repeated runs produce identical files unless the underlying data has
changed. The volatile ETL_date column is dropped for the same reason.

Uses only the standard library so it can run in CI without dependencies.
"""

import csv
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

TENANT = "MAPZONE"
TOKEN_URL = "https://mapzone.dublincity.ie/api/v1/oauth2/token"
QUERY_URL = "https://mapzone.dublincity.ie/api/v1/sqlquery/Sites"

# The register is small; the planning-application table it is joined against
# holds ~106k rows, so the intersection is done server-side against its spatial
# index rather than by downloading the whole table.
REGISTER_QUERY = (
    "select Register_No, Address_of_Property, RegisterStatus, PriorityCode, "
    "Folio_Reference, Ownership, Owner_address, Valuation, DateRegistered, GEOM "
    "from PL_VacantSites order by Register_No"
)
LINKS_QUERY = (
    "select v.Register_No as register_number, p.Plan_Ref as plan_ref, "
    "p.Regdate as registration_date, p.Status_Desc as status, "
    "p.Applicant as applicant, p.SProposal as proposal, p.GEOM as GEOM "
    "from PL_VacantSites v inner join PL_PlanningApplications p "
    "on p.GEOM.STIntersects(geometry::STGeomFromWKB(v.GEOM.STAsBinary(), 3857)) = 1 "
    "order by v.Register_No, p.Regdate, p.Plan_Ref"
)

# Source column -> output property name. Ordering here also fixes CSV columns.
REGISTER_FIELDS = {
    "Register_No": "register_number",
    "Address_of_Property": "address",
    "RegisterStatus": "register_status",
    "PriorityCode": "priority_code",
    "Folio_Reference": "folio_reference",
    "Ownership": "ownership",
    "Owner_address": "owner_address",
    "Valuation": "valuation",
    "DateRegistered": "date_registered",
}
CSV_FIELDS = list(REGISTER_FIELDS.values()) + [
    "linked_planning_ref_count",
    "linked_planning_refs",
]
LINKS_FIELDS = [
    "register_number",
    "plan_ref",
    "registration_date",
    "status",
    "applicant",
    "proposal",
]

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
GEOJSON_PATH = DATA_DIR / "vacant_sites_register.geojson"
CSV_PATH = DATA_DIR / "vacant_sites_register.csv"
LINKS_PATH = DATA_DIR / "vacant_sites_planning_links.csv"


def get_token() -> str:
    body = urllib.parse.urlencode(
        {
            "grant_type": "password",
            "username": "public",
            "password": "public",
            "client_id": "App",
        }
    ).encode()
    req = urllib.request.Request(
        TOKEN_URL, data=body, headers={"tenant": TENANT}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)["access_token"]


def run_query(token: str, sql: str, srid: int) -> dict:
    params = {"query": sql, "format": "geojson", "srid": str(srid)}
    url = f"{QUERY_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}", "Tenant": TENANT}
    )
    with urllib.request.urlopen(req, timeout=120) as response:
        payload = json.load(response)
    if payload.get("type") != "FeatureCollection":
        raise RuntimeError(f"Query failed: {payload}")
    return payload


def clean_date(value):
    # DateRegistered arrives as "2017-03-31T00:00:00"; keep the date only.
    if isinstance(value, str) and "T" in value:
        return value.split("T", 1)[0]
    return value


def build_links(links: dict) -> dict:
    """Group linked planning references by register number, in query order."""
    grouped: dict[str, list[str]] = {}
    rows = []
    for feature in links["features"]:
        props = feature["properties"]
        reg = props["register_number"]
        grouped.setdefault(reg, []).append(props["plan_ref"])
        rows.append({field: props.get(field) for field in LINKS_FIELDS})
    return {"grouped": grouped, "rows": rows}


def build_register(register: dict, grouped: dict[str, list[str]]) -> dict:
    features = []
    for feature in register["features"]:
        src = feature["properties"]
        props = {out: src.get(col) for col, out in REGISTER_FIELDS.items()}
        props["date_registered"] = clean_date(props["date_registered"])
        refs = grouped.get(props["register_number"], [])
        props["linked_planning_ref_count"] = len(refs)
        props["linked_planning_refs"] = "; ".join(refs)
        features.append(
            {"type": "Feature", "properties": props, "geometry": feature["geometry"]}
        )
    features.sort(key=lambda f: f["properties"]["register_number"])
    return {"type": "FeatureCollection", "features": features}


def write_json(path: Path, collection: dict) -> None:
    path.write_text(
        json.dumps(collection, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    )


def write_csv(path: Path, fields: list[str], rows: list[dict]) -> None:
    with path.open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    token = get_token()

    register = run_query(token, REGISTER_QUERY, 4326)
    links = run_query(token, LINKS_QUERY, 4326)
    grouped_and_rows = build_links(links)

    collection = build_register(register, grouped_and_rows["grouped"])
    write_json(GEOJSON_PATH, collection)
    write_csv(CSV_PATH, CSV_FIELDS, [f["properties"] for f in collection["features"]])
    write_csv(LINKS_PATH, LINKS_FIELDS, grouped_and_rows["rows"])

    print(
        f"Wrote {len(collection['features'])} sites to {GEOJSON_PATH.name} "
        f"and {CSV_PATH.name}"
    )
    print(
        f"Wrote {len(grouped_and_rows['rows'])} linked planning applications "
        f"to {LINKS_PATH.name}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Data fetch failed: {exc}", file=sys.stderr)
        sys.exit(1)
