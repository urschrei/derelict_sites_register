// Spatial and attribute analysis. Turf.js is loaded globally as `turf`.

import { yearBinIndex } from "./tokens.js";

// The Spire, O'Connell Street: a conventional city-centre reference point.
export const CITY_CENTRE = [-6.260262, 53.349805];

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

// Annotate each feature with derived values used throughout the page.
export function deriveFeatures(collection) {
  const now = Date.now();
  return collection.features.map((feature, index) => {
    const props = feature.properties;
    const added = props.date_added_to_the_derelict_sites_register;
    const addedDate = added ? new Date(added) : null;
    const years = addedDate ? (now - addedDate.getTime()) / MS_PER_YEAR : null;
    const distanceKm = turf.distance(CITY_CENTRE, feature.geometry.coordinates);
    return {
      ...feature,
      id: index,
      properties: {
        ...props,
        years_on_register: years,
        year_bin: years === null ? 0 : yearBinIndex(years),
        year_added: addedDate ? addedDate.getUTCFullYear() : null,
        distance_from_centre_km: distanceKm,
      },
    };
  });
}

// Clark-Evans nearest-neighbour ratio: observed mean nearest-neighbour
// distance over the value expected for a random pattern of the same density
// within the pattern's convex hull. R < 1 indicates clustering, R = 1 a
// random pattern, R > 1 dispersion.
export function clarkEvans(features) {
  if (features.length < 10) return null;
  const points = turf.featureCollection(
    features.map((f) => turf.point(f.geometry.coordinates))
  );
  const hull = turf.convex(points);
  if (!hull) return null;
  const areaKm2 = turf.area(hull) / 1e6;
  if (areaKm2 === 0) return null;

  let totalKm = 0;
  for (let i = 0; i < features.length; i++) {
    let best = Infinity;
    for (let j = 0; j < features.length; j++) {
      if (i === j) continue;
      const d = turf.distance(
        features[i].geometry.coordinates,
        features[j].geometry.coordinates
      );
      if (d < best) best = d;
    }
    totalKm += best;
  }
  const observed = totalKm / features.length;
  const expected = 0.5 / Math.sqrt(features.length / areaKm2);
  return { ratio: observed / expected, meanNearestKm: observed };
}

export function describeClustering(ratio) {
  if (ratio < 0.5) return "strongly clustered";
  if (ratio < 0.8) return "clustered";
  if (ratio < 1.2) return "close to random";
  return "dispersed";
}

// Hexagonal density grid over the current sites (600 m cells).
//
// turf.hexGrid converts the cell side from kilometres to degrees with a
// single spherical factor applied to both axes, so in WGS84 at Dublin's
// latitude the cells would come out about 600 m tall but only 360 m wide.
// To get ground-regular hexagons we build the grid in a locally corrected
// frame (longitudes scaled by cos of the mid-latitude, making a degree
// metrically equal on both axes), then scale the cell geometry back. The
// city spans well under a degree of latitude, so a single correction
// factor is accurate here.
export function hexDensity(features) {
  if (!features.length) return turf.featureCollection([]);
  const bbox = turf.bbox(
    turf.featureCollection(features.map((f) => turf.point(f.geometry.coordinates)))
  );
  const k = Math.cos((((bbox[1] + bbox[3]) / 2) * Math.PI) / 180);
  const projected = turf.featureCollection(
    features.map((f) => {
      const [lon, lat] = f.geometry.coordinates;
      return turf.point([lon * k, lat]);
    })
  );
  const pBbox = turf.bbox(projected);
  const padded = [
    pBbox[0] - 0.01,
    pBbox[1] - 0.01,
    pBbox[2] + 0.01,
    pBbox[3] + 0.01,
  ];
  const grid = turf.hexGrid(padded, 0.6, { units: "kilometers" });
  const cells = [];
  for (const cell of grid.features) {
    const inside = turf.pointsWithinPolygon(projected, cell);
    if (inside.features.length > 0) {
      cell.properties.count = inside.features.length;
      cell.geometry.coordinates = cell.geometry.coordinates.map((ring) =>
        ring.map(([x, y]) => [x / k, y])
      );
      cells.push(cell);
    }
  }
  return turf.featureCollection(cells);
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Aggregations for the charts.

export function countByArea(features, allAreas) {
  const counts = new Map(allAreas.map((a) => [a, 0]));
  for (const f of features) {
    const area = f.properties.administrative_area_name;
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

export function countByYearAdded(features, minYear, maxYear) {
  const counts = new Map();
  for (let y = minYear; y <= maxYear; y++) counts.set(y, 0);
  for (const f of features) {
    const y = f.properties.year_added;
    if (y !== null) counts.set(y, (counts.get(y) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, value]) => ({
    label: String(label),
    value,
  }));
}

export function countByDistance(features, maxKm) {
  const bins = [];
  for (let d = 0; d < maxKm; d++) {
    bins.push({ label: `${d}–${d + 1} km`, value: 0 });
  }
  for (const f of features) {
    const idx = Math.min(
      Math.floor(f.properties.distance_from_centre_km),
      bins.length - 1
    );
    bins[idx].value += 1;
  }
  return bins;
}
