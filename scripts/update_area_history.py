"""Record the total area of the RZLT parcels over time.

Appends an entry to data/area_history.json whenever the total area of the
RZLT parcels differs from the last recorded entry, so the file is a change
log the site draws as a step sparkline. Git history is not available to the
static frontend, hence the file. The total is the sum of the published
site_area_ha values, matching the figure the site shows.

With --backfill, rebuilds the file from every committed version of the
parcels instead.

Uses only the standard library so it can run in CI without dependencies.
"""

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HISTORY_PATH = ROOT / "data" / "area_history.json"
PARCELS = "data/rzlt_sites.geojson"


def total_hectares(collection: dict) -> float:
    return sum(f["properties"].get("site_area_ha") or 0 for f in collection["features"])


def record(series: list, date: str, hectares: float) -> bool:
    hectares = round(hectares, 2)
    if series and series[-1]["hectares"] == hectares:
        return False
    series.append({"date": date, "hectares": hectares})
    return True


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, check=True, cwd=ROOT
    ).stdout


def backfill() -> list:
    series = []
    for line in git("log", "--reverse", "--format=%H %ct", "--", PARCELS).splitlines():
        sha, timestamp = line.split()
        date = datetime.fromtimestamp(int(timestamp), timezone.utc)
        collection = json.loads(git("show", f"{sha}:{PARCELS}"))
        record(series, date.strftime("%Y-%m-%dT%H:%MZ"), total_hectares(collection))
    return series


def main() -> None:
    history = json.loads(HISTORY_PATH.read_text()) if HISTORY_PATH.exists() else {}
    if sys.argv[1:] == ["--backfill"]:
        history["rzlt"] = backfill()
        changed = True
    else:
        date = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
        collection = json.loads((ROOT / PARCELS).read_text())
        changed = record(
            history.setdefault("rzlt", []), date, total_hectares(collection)
        )
    if changed:
        HISTORY_PATH.write_text(json.dumps(history, indent=2, sort_keys=True) + "\n")
    print(f"Area history: {'updated' if changed else 'no change'}")


if __name__ == "__main__":
    main()
