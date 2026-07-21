"""Extract the Vacant Sites Register PDF into the enrichment CSV.

DCC's live MapZone feed (fetched by fetch_vacant_sites.py) carries stale
ownership and valuation attributes: cross-checking against the register PDF
published on dublincity.ie shows the feed missing most market values and
holding superseded owner names. The PDF is therefore the source of record for
those fields. This script converts its table into
data/vacant_sites_enrichment.csv, which fetch_vacant_sites.py merges over the
feed at build time.

Run it whenever DCC publishes a new register PDF:

    uv run --with pdfplumber scripts/extract_vacant_sites_pdf.py <register.pdf>

Unlike the fetch scripts this is not run in CI and needs pdfplumber; the
resulting CSV is committed.
"""

import csv
import re
import sys
from datetime import datetime
from pathlib import Path

import pdfplumber

OUT_PATH = (
    Path(__file__).resolve().parent.parent / "data" / "vacant_sites_enrichment.csv"
)

FIELDS = [
    "register_number",
    "address",
    "folio_reference",
    "ownership",
    "owner_address",
    "market_value",
    "valuation_date",
    "date_entered",
]


def clean(cell):
    return re.sub(r"\s+", " ", cell or "").strip()


def euro_to_int(text):
    """'€1,100,000.00' -> 1100000."""
    amount = clean(text).replace("€", "").replace(",", "")
    return int(float(amount))


def iso_date(text):
    return datetime.strptime(clean(text), "%d/%m/%Y").date().isoformat()


def extract(pdf_path):
    rows = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for row in table:
                    if not (row and row[0] and clean(row[0]).startswith("VS-")):
                        continue
                    reg, address, folio, owner, owner_addr, value, valued, entered = (
                        clean(c) for c in row
                    )
                    rows.append(
                        {
                            "register_number": reg,
                            "address": address,
                            "folio_reference": folio,
                            "ownership": owner,
                            "owner_address": owner_addr,
                            "market_value": euro_to_int(value),
                            "valuation_date": iso_date(valued),
                            "date_entered": iso_date(entered),
                        }
                    )
    rows.sort(key=lambda r: r["register_number"])
    return rows


def main():
    if len(sys.argv) != 2:
        sys.exit(f"Usage: {sys.argv[0]} <vacant-sites-register.pdf>")
    rows = extract(sys.argv[1])
    if not rows:
        sys.exit("No register rows found in PDF")
    with OUT_PATH.open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows)} sites to {OUT_PATH.name}")


if __name__ == "__main__":
    main()
