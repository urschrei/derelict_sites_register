// Spatial index over the register points. The RBush tree is built once from
// the full register and kept for any future spatial work; nearest-neighbour
// lookups go through rbush-knn.

import RBush from "https://cdn.jsdelivr.net/npm/rbush@4.0.1/+esm";
import knn from "https://cdn.jsdelivr.net/npm/rbush-knn@4.0.0/+esm";

let tree = null;

export function buildIndex(features) {
  tree = new RBush();
  tree.load(
    features.map((feature) => {
      const [x, y] = feature.geometry.coordinates;
      return { minX: x, minY: y, maxX: x, maxY: y, feature };
    })
  );
  return tree;
}

export function spatialIndex() {
  return tree;
}

// Bounding-box index over arbitrary polygon features, for fast candidate
// lookup in overlay computations. Entries carry the feature and its area.
export function buildPolygonIndex(features) {
  const polyTree = new RBush();
  polyTree.load(
    features.map((feature) => {
      const [minX, minY, maxX, maxY] = turf.bbox(feature);
      return { minX, minY, maxX, maxY, feature, area: turf.area(feature) };
    })
  );
  return polyTree;
}

// k nearest sites to a lon/lat position. rbush-knn ranks by planar degree
// distance, which misorders candidates slightly at Dublin's latitude, so we
// over-fetch and re-rank the candidates by true great-circle distance.
export function nearestSites(lon, lat, k = 1) {
  if (!tree) return [];
  const candidates = knn(tree, lon, lat, Math.max(k * 8, 8));
  return candidates
    .map((item) => ({
      feature: item.feature,
      distanceKm: turf.distance([lon, lat], item.feature.geometry.coordinates),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, k);
}
