"""Fetch the Dublin City Council Vacant Sites Register from MapZone.

The Vacant Sites Register is a separate statutory register from the Derelict
Sites Register (it is maintained under the Urban Regeneration and Housing Act
2015). DCC publishes it only through the MapZone planning viewer, which is
backed by an "M.App Enterprise" server. That server exposes an authenticated
SQL-query endpoint returning GeoJSON; the login is the public/public account
embedded in the viewer, so no secret is required.

Two datasets are written:

- the register itself, as polygon GeoJSON plus a CSV of the attribute table.
  Each site carries the planning applications recorded against it, newest
  first.
- a flat CSV of every site-to-application link.

Linking sites to applications
-----------------------------
The council does not publish a site-to-application list, so the link is
reconstructed from two independent signals that must agree:

1. Spatial: the application footprint intersects the site boundary (the two
   geometries are stored under different Web Mercator SRIDs - 3785 for the
   register, 3857 for planning - so the join re-stamps the SRID first).
2. Relational: the application is in the council's own "related applications"
   record for the site's best-overlapping application (its anchor), fetched
   from the viewer's GetRelatedTooltipInfo endpoint.

Keeping only applications that satisfy both signals removes footprints that
merely touch the boundary and the very large "related" clusters the council
records for regeneration areas. Sites with no strongly-overlapping anchor fall
back to the spatial signal alone and are flagged (council_confirmed = false).

Enriching ownership and valuation
---------------------------------
The MapZone feed's ownership and valuation attributes are stale: most market
values are missing and several owner names are superseded. The register PDF
published on dublincity.ie is the source of record for those fields, so the
feed's values are replaced at build time from data/vacant_sites_enrichment.csv
(produced from the PDF by extract_vacant_sites_pdf.py). Sites absent from the
enrichment file - for example any added to the register after the PDF was
published - keep the feed's values.

Output is deterministic (sites ordered by register number, applications by
date, sorted keys). The volatile ETL_date column is dropped. Uses only the
standard library so it can run in CI without dependencies.
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
RELATED_URL = (
    "https://mapzone.dublincity.ie/MapZonePlanning/MapZone.aspx/GetRelatedTooltipInfo"
)
PORTAL_URL = (
    "https://webapps.dublincity.ie/PublicAccess_Live/SearchResult/"
    "RunThirdPartySearch?FileSystemId=PL&Folder1_Ref="
)

# A site's best spatial overlap must reach this fraction of the smaller
# footprint for its anchor - and therefore the council related-applications
# cross-check - to be trusted. The overlap distribution is strongly bimodal
# (near-1 or near-0), so the exact cut-off is not sensitive.
ANCHOR_MIN_OVERLAP = 0.1

RESTAMP = "geometry::STGeomFromWKB(v.GEOM.STAsBinary(),3857)"

REGISTER_QUERY = (
    "select Register_No, Address_of_Property, RegisterStatus, PriorityCode, "
    "Folio_Reference, Ownership, Owner_address, Valuation, DateRegistered, GEOM "
    "from PL_VacantSites order by Register_No"
)
# Every application whose footprint intersects a site, with the overlap area
# (EPSG:3857 metres - only used as a ratio, so the Mercator inflation cancels)
# and the fields the detail view needs.
PAIRS_QUERY = (
    "select v.Register_No as register_number, p.Plan_Ref as plan_ref, "
    "p.Regdate as registration_date, p.App_Type as app_type, "
    "p.Status_Desc as status, p.Decision as decision, p.Dec_date as decision_date, "
    "p.Applicant as applicant, p.SProposal as proposal, "
    f"{RESTAMP}.STArea() as site_area, p.GEOM.STArea() as app_area, "
    f"p.GEOM.STIntersection({RESTAMP}).STArea() as overlap_area, "
    "geometry::STGeomFromText('POINT(0 0)',3857) as GEOM "
    "from PL_VacantSites v inner join PL_PlanningApplications p "
    f"on p.GEOM.STIntersects({RESTAMP}) = 1"
)

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
# Order fixes the columns of both the geojson property block and the links CSV.
LINK_FIELDS = [
    "register_number",
    "plan_ref",
    "registration_date",
    "app_type",
    "outcome",
    "decision",
    "decision_date",
    "applicant",
    "proposal",
    "overlap_pct",
    "council_confirmed",
    "planning_portal_url",
]
CSV_FIELDS = list(REGISTER_FIELDS.values()) + ["linked_planning_ref_count"]
CSV_FIELDS.insert(CSV_FIELDS.index("valuation") + 1, "valuation_date")

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
GEOJSON_PATH = DATA_DIR / "vacant_sites_register.geojson"
CSV_PATH = DATA_DIR / "vacant_sites_register.csv"
LINKS_PATH = DATA_DIR / "vacant_sites_planning_links.csv"
ENRICHMENT_PATH = DATA_DIR / "vacant_sites_enrichment.csv"

# Top-level GeoJSON metadata (a foreign member on the FeatureCollection, not
# repeated per feature).
REPOSITORY = "https://github.com/urschrei/derelict_sites_register"
METADATA = {
    "attribution": "Compiled by Stephan Hügel",
    "license": "CC-BY-4.0",
    "license_url": "https://creativecommons.org/licenses/by/4.0/",
    "repository": REPOSITORY,
}


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


def related_applications(reference: str) -> set[str]:
    """The council's related-application references for a planning reference."""
    body = json.dumps({"referenceId": reference}).encode()
    req = urllib.request.Request(
        RELATED_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        rows = json.loads(json.load(response)["d"])
    return {
        row["value"]
        for row in rows
        if row.get("column") == "Plan_Ref" and row.get("value")
    }


def iso_date(value):
    # Planning dates arrive as YYYYMMDD strings; register dates as ISO datetimes.
    if not value:
        return None
    text = str(value)
    if "T" in text:
        return text.split("T", 1)[0]
    if len(text) == 8 and text.isdigit():
        return f"{text[:4]}-{text[4:6]}-{text[6:]}"
    return text


def outcome_of(decision):
    if not decision:
        return "Undecided"
    lowered = decision.lower()
    if "refuse" in lowered or "invalid" in lowered:
        return "Refused"
    if "grant" in lowered or "declare" in lowered or "permission" in lowered:
        return "Granted"
    return "Other"


def link_record(props: dict, overlap_pct: float, confirmed: bool) -> dict:
    return {
        "register_number": props["register_number"],
        "plan_ref": props["plan_ref"],
        "registration_date": iso_date(props.get("registration_date")),
        "app_type": props.get("app_type"),
        "outcome": outcome_of(props.get("decision")),
        "decision": props.get("decision") or None,
        "decision_date": iso_date(props.get("decision_date")),
        "applicant": props.get("applicant") or None,
        "proposal": props.get("proposal") or None,
        "overlap_pct": overlap_pct,
        "council_confirmed": confirmed,
        "planning_portal_url": PORTAL_URL
        + urllib.parse.quote(props["plan_ref"], safe=""),
    }


def build_links(pairs: dict) -> dict[str, list[dict]]:
    """Group intersecting pairs by site and apply the two-signal linkage."""
    by_site: dict[str, list[dict]] = {}
    for feature in pairs["features"]:
        p = feature["properties"]
        site_area = p.get("site_area") or 0
        app_area = p.get("app_area") or 0
        overlap = p.get("overlap_area") or 0
        smaller = min(site_area, app_area)
        p["_overlap"] = overlap / smaller if smaller else 0.0
        by_site.setdefault(p["register_number"], []).append(p)

    links: dict[str, list[dict]] = {}
    for reg, candidates in by_site.items():
        anchor = max(candidates, key=lambda p: p["_overlap"])
        confirmed = anchor["_overlap"] >= ANCHOR_MIN_OVERLAP
        related = related_applications(anchor["plan_ref"]) if confirmed else None
        kept = []
        for p in candidates:
            # Strong anchor: keep only applications the council also relates to
            # it. Weak anchor: fall back to the spatial signal alone.
            if related is not None and p["plan_ref"] not in related:
                continue
            kept.append(link_record(p, round(p["_overlap"] * 100, 1), bool(related)))
        # Newest first; undated applications sort last.
        kept.sort(
            key=lambda r: (r["registration_date"] or "", r["plan_ref"]), reverse=True
        )
        links[reg] = kept
    return links


def clean_date(value):
    return iso_date(value)


def load_enrichment() -> dict[str, dict]:
    """PDF-sourced ownership and valuation rows keyed by register number."""
    if not ENRICHMENT_PATH.exists():
        return {}
    with ENRICHMENT_PATH.open(newline="") as fh:
        return {row["register_number"]: row for row in csv.DictReader(fh)}


def build_register(
    register: dict, links: dict[str, list[dict]], enrichment: dict[str, dict]
) -> dict:
    features = []
    for feature in register["features"]:
        src = feature["properties"]
        props = {out: src.get(col) for col, out in REGISTER_FIELDS.items()}
        props["date_registered"] = clean_date(props["date_registered"])
        extra = enrichment.get(props["register_number"])
        if extra:
            for field in ("folio_reference", "ownership", "owner_address"):
                props[field] = extra[field]
            props["valuation"] = int(extra["market_value"])
            props["valuation_date"] = extra["valuation_date"]
        else:
            props["valuation_date"] = None
        site_links = links.get(props["register_number"], [])
        props["linked_planning_ref_count"] = len(site_links)
        props["planning_applications"] = site_links
        features.append(
            {"type": "Feature", "properties": props, "geometry": feature["geometry"]}
        )
    features.sort(key=lambda f: f["properties"]["register_number"])
    return {"type": "FeatureCollection", "metadata": METADATA, "features": features}


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
    pairs = run_query(token, PAIRS_QUERY, 3857)
    links = build_links(pairs)

    collection = build_register(register, links, load_enrichment())
    write_json(GEOJSON_PATH, collection)
    write_csv(CSV_PATH, CSV_FIELDS, [f["properties"] for f in collection["features"]])

    flat = [row for reg in sorted(links) for row in links[reg]]
    write_csv(LINKS_PATH, LINK_FIELDS, flat)

    confirmed = sum(1 for r in flat if r["council_confirmed"])
    print(
        f"Wrote {len(collection['features'])} sites to {GEOJSON_PATH.name} "
        f"and {CSV_PATH.name}"
    )
    print(
        f"Wrote {len(flat)} planning links ({confirmed} council-confirmed) "
        f"to {LINKS_PATH.name}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Data fetch failed: {exc}", file=sys.stderr)
        sys.exit(1)
