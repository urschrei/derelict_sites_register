"""Record register membership changes after a data refresh.

Compares the freshly fetched register GeoJSON files in the working tree
against the versions committed at HEAD, and when membership has changed
prepends an entry to data/changelog.json recording the added and removed
reference numbers for each register. The site reads that file to show
recent changes; git history is not available to the static frontend.

Prints a plain-text summary for use in the commit message body, so the
same information is visible when browsing the repository history.

Uses only the standard library so it can run in CI without dependencies.
"""

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOG_PATH = ROOT / "data" / "changelog.json"
MAX_ENTRIES = 24

REGISTERS = [
    (
        "derelict",
        "data/derelict_sites_register.geojson",
        "derelict_site_reference_number",
    ),
    ("vacant", "data/vacant_sites_register.geojson", "register_number"),
]


def reference_numbers(text: str, key: str) -> set:
    collection = json.loads(text)
    return {
        ref
        for feature in collection["features"]
        if (ref := feature["properties"].get(key)) is not None
    }


def head_version(path: str) -> str | None:
    result = subprocess.run(
        ["git", "show", f"HEAD:{path}"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    return result.stdout if result.returncode == 0 else None


def main() -> None:
    entry: dict = {"date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")}
    summary = []
    changed = False
    for name, path, key in REGISTERS:
        new_refs = reference_numbers((ROOT / path).read_text(), key)
        old_text = head_version(path)
        if old_text is None:
            summary.append(f"{name.capitalize()}: no baseline at HEAD, skipped")
            continue
        old_refs = reference_numbers(old_text, key)
        added = sorted(new_refs - old_refs)
        removed = sorted(old_refs - new_refs)
        entry[name] = {"total": len(new_refs), "added": added, "removed": removed}
        if added or removed:
            changed = True
            summary.append(
                f"{name.capitalize()}: +{len(added)} -{len(removed)} "
                f"({len(new_refs)} sites)"
            )
        else:
            summary.append(f"{name.capitalize()}: no change ({len(new_refs)} sites)")

    if changed:
        entries = (
            json.loads(CHANGELOG_PATH.read_text()) if CHANGELOG_PATH.exists() else []
        )
        entries.insert(0, entry)
        CHANGELOG_PATH.write_text(
            json.dumps(entries[:MAX_ENTRIES], indent=2, sort_keys=True) + "\n"
        )

    print("\n".join(summary))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Changelog update failed: {exc}", file=sys.stderr)
        sys.exit(1)
