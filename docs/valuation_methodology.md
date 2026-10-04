# Valuation layer: data-quality methodology

How the RZLT enrichment handles faults in the Tailte Éireann valuation data
(the `val_*` fields), why each rule exists, and how to audit a run. The
general enrichment pipeline is described in
[`rzlt_enrichment.md`](rzlt_enrichment.md); this document covers only the
valuation layer's validation and failure handling.

## Why this exists

The valuation layer is the one enrichment source allowed to fail without
failing the run, so its failure modes have to be handled deliberately rather
than by aborting. On 2026-10-04 two different faults surfaced within an hour,
and the original handling turned each into silently wrong output:

1. **An empty response.** The API returned `[]` for Dublin City. The pipeline
   accepted it as valid, joined zero properties, and wrote
   `val_n_props = 0` with null NAVs for every parcel, wiping the valuations
   of the 42 parcels that had them. The change was committed and deployed
   before it was noticed, then reverted.
2. **One mis-geocoded record.** A fresh request an hour later returned the
   full dataset (19,796 records), but the layer-wide bounding-box check
   rejected all of it as a probable CRS error because of a single record.

The rules below came out of investigating both.

## Rules

### 1. An empty response is a fault, not data

Dublin City always has rateable properties (about 19,800 in 2026), so an
empty list can only be an upstream fault. `fetch_valuations` raises on it
instead of returning it.

Every HTTP response is cached, and the CI cache persists between runs, so the
empty response is also **deleted from the cache** before raising. Otherwise
every later run in the same cache window would replay it rather than asking
the API again.

### 2. When the layer fails, carry the last good values forward

When valuations cannot be fetched or validated, the run still succeeds, but
the `val_*` fields are copied from the previous output rather than written
as null. Stale-but-real valuations are more useful than blanks, and NAVs
change slowly (the record in the worked example was last valued in 2011).

The manifest makes the substitution explicit:

```json
"layers":  { "valuation": "carried_forward" },
"sources": { "valuation": { "fetched": 0, "fetched_at": "2026-07-21T12:49:20Z", "url": "…" } }
```

`fetched_at` is the date of the last *successful* fetch, and it carries over
through consecutive failed runs, so it always says how old the values are.
A parcel that was not in the previous output gets nulls. If there is no
previous output at all, the layer is recorded as `unavailable` with null
fields, as before.

### 3. Validate coordinates per record, not per layer

Each valuation record carries ITM coordinates (`Xitm`, `Yitm`). Every other
layer is checked with a whole-layer bounding box (`assert_itm_bbox`), which is
the right test for its purpose: catching a layer delivered in the wrong CRS.
For a point layer of ~20,000 records, though, one bad record is enough to
push the bounding box out of range and reject everything.

So valuation points are checked individually against Ireland's ITM envelope
(x 400–800 km, y 500–1,000 km):

- Records outside it are **dropped**, logged with their `PropertyNumber`, and
  listed in the manifest under `sources.valuation.dropped_out_of_range`.
- If **more than 1%** of located records are outside it
  (`MAX_OUT_OF_RANGE`), the layer as a whole is treated as being in the wrong
  CRS. That raises, and rule 2 applies.

A CRS mistake moves every point, not one in a hundred, so the 1% threshold
separates the two cases with a wide margin: the 2026-10-04 response had 1
bad record in 19,784 (0.005%), while Irish Grid or Web Mercator coordinates
would put 100% of records out of range.

Records with no coordinates (12 in that response) are skipped, as before.

### 4. Do not repair bad coordinates

Dropped records are not corrected, even when the fault can be explained (see
the worked example below). A repair needs the true position to within the
size of a parcel, and the faults seen so far do not preserve that.

### 5. Scope the response cache to the ISO week

Cached responses never expire, and the CI cache's restore key used to match
any earlier cache, so weekly runs could replay months-old responses from
every source. The cache key now includes the ISO week
(`rzlt-enrich-cache-2026-W40-…`): re-runs within a week reuse responses, and
each week's scheduled run fetches fresh data.

## Worked example: the EXO Building record

The record that failed the bounding-box check on 2026-10-04:

| Field | Value |
|---|---|
| PropertyNumber | 10029125 |
| Address | EXO Building, Floors 1 & 2, Point Square, North Wall Quay, Dublin 1 |
| Eircode | D01 W5Y2 |
| Xitm, Yitm | 1,543,960.92, 827,841.2 |

**Not a CRS mismatch.** The other 19,783 located records fall within x
704.6–723.0 km and y 729.4–741.0 km, which is Dublin City in ITM. None of the
other plausible CRSs puts Dublin anywhere near the outlying value; for
reference, the Spire on O'Connell Street is at:

| CRS | x | y |
|---|---|---|
| ITM (EPSG:2157) | 715,827 | 734,698 |
| Irish Grid, TM65/TM75 (EPSG:29902/29903) | 315,901 | 234,671 |
| Web Mercator (EPSG:3857) | −696,893 | 7,047,965 |
| UTM 29N (EPSG:25829/32629) | 682,353 | 5,914,683 |
| LAEA Europe (EPSG:3035) | 3,248,576 | 3,481,178 |

**A lost minus sign.** Inverting the ITM projection gives longitude
**+6.22°**, latitude **53.347481°**. The latitude is North Wall Quay's; the
longitude has the right magnitude but the wrong sign (east rather than west).
Projecting (+6.22, 53.347481) reproduces the published coordinates to the
millimetre, so the record was geocoded with its longitude's sign dropped, and
then projected. The longitude also carries only two decimal places, against
six for the latitude, so it was truncated too.

**Why it is dropped, not repaired.** Flipping the sign back gives ITM
(718,516, 734,506), on North Wall Quay by Point Square: the right
neighbourhood. But a longitude truncated to 0.01° is uncertain by up to
about 0.66 km east–west at this latitude, far larger than most parcels, so
the repaired point cannot be trusted for a point-in-polygon join. In this
case the decision has no effect on the output: the nearest RZLT parcel is
814 m from the repaired point.

The record is worth reporting to Tailte Éireann.

## Auditing a run

`data/rzlt_run_manifest.json` records, for the valuation layer:

| Field | Meaning |
|---|---|
| `layers.valuation` | `ok`, `carried_forward`, or `unavailable` |
| `sources.valuation.fetched` | records returned this run (0 when carried forward) |
| `sources.valuation.dropped_out_of_range` | `PropertyNumber`s dropped by rule 3 |
| `sources.valuation.fetched_at` | when carried-forward values were last fetched |

The workflow log repeats the same information as warnings
(`Valuation: dropped …`, `Valuation layer unavailable (…); carried forward …`).

Per parcel, the enriched output records which valuation records joined:
`val_property_numbers` (in the GeoJSON and CSV) and the nested
`valuation_properties` list (GeoJSON and GeoParquet), with each record's
address, category, uses, NAV, and dates. Diffing either between commits
shows exactly which records entered or left a parcel. Carried-forward runs
copy both along with the other `val_*` fields.

This was added after parcel DCC000064181 (the St Teresa's Gardens
regeneration site, Dublin 8) went from six matched records in July 2026 to
none in October. The aggregates showed the drop but not which records had
gone, and the July response had not been kept, so the records' identities
could only be inferred: none of the six uses reappeared within plausible
re-geocoding distance (the nearest butcher was 530 m away), and no current
record is addressed at St Teresa's Gardens, consistent with the estate's
shop units leaving the valuation list after demolition.
