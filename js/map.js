// MapLibre map: sites coloured by time on the register, with an optional
// Turf-derived hex density overlay. MapLibre is loaded globally as
// `maplibregl`.

import { tokens, YEAR_BINS } from "./tokens.js";

const DUBLIN_CENTRE = [-6.2718, 53.3455];

let map;
let currentSites = { type: "FeatureCollection", features: [] };
let currentHexes = { type: "FeatureCollection", features: [] };
let currentVoronoi = { type: "FeatureCollection", features: [] };
let currentCases = { type: "FeatureCollection", features: [] };
let currentCaseHexes = null;
let currentVacant = { type: "FeatureCollection", features: [] };
let hexVisible = false;
let voronoiVisible = false;
let emphasiseProtected = false;
let mapMode = "register";
let casesShape = "squares";
let extrude3d = false;
let popup;

const EMPTY = { type: "FeatureCollection", features: [] };
const FADE_MS = 400;
const METRES_PER_CASE = 120;

// Overlay layers cross-fade via paint transitions; visibility is flipped
// only after a fade to zero completes. `desiredOpacity` guards against a
// stale timeout hiding a layer that has been faded back in meanwhile.
const OPACITY_PROP = {
  hexes: "fill-opacity",
  voronoi: "line-opacity",
  "cases-squares": "fill-opacity",
  "cases-hexes": "fill-opacity",
  "cases-squares-3d": "fill-extrusion-opacity",
  "cases-hexes-3d": "fill-extrusion-opacity",
  "vacant-fill": "fill-opacity",
  "vacant-line": "line-opacity",
  "vacant-selected": "line-opacity",
};
const desiredOpacity = {
  hexes: 0,
  voronoi: 0,
  "cases-squares": 0,
  "cases-hexes": 0,
  "cases-squares-3d": 0,
  "cases-hexes-3d": 0,
  "vacant-fill": 0,
  "vacant-line": 0,
  "vacant-selected": 0,
};

function fadeLayerTo(id, opacity) {
  desiredOpacity[id] = opacity;
  if (!map?.getLayer(id)) return;
  const prop = OPACITY_PROP[id];
  if (opacity > 0) {
    map.setLayoutProperty(id, "visibility", "visible");
    requestAnimationFrame(() => {
      if (desiredOpacity[id] > 0) map.setPaintProperty(id, prop, opacity);
    });
  } else {
    map.setPaintProperty(id, prop, 0);
    setTimeout(() => {
      if (desiredOpacity[id] === 0 && map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", "none");
      }
    }, FADE_MS + 100);
  }
}

// The layer opacities implied by the current mode and per-mode options.
function targetOpacities() {
  const register = mapMode === "register";
  const caseload = mapMode === "caseload";
  const vacant = mapMode === "vacant";
  const squares = caseload && casesShape === "squares";
  const hexes = caseload && casesShape === "hexes";
  return {
    hexes: register && hexVisible ? 0.55 : 0,
    voronoi: register && voronoiVisible ? 0.7 : 0,
    "cases-squares": squares && !extrude3d ? 0.55 : 0,
    "cases-hexes": hexes && !extrude3d ? 0.55 : 0,
    "cases-squares-3d": squares && extrude3d ? 0.8 : 0,
    "cases-hexes-3d": hexes && extrude3d ? 0.8 : 0,
    "vacant-fill": vacant ? 0.45 : 0,
    "vacant-line": vacant ? 0.9 : 0,
    "vacant-selected": vacant ? 1 : 0,
  };
}

function syncOverlayLayers() {
  const targets = targetOpacities();
  for (const [id, opacity] of Object.entries(targets)) {
    fadeLayerTo(id, opacity);
  }
}

// MapLibre paint transitions do not apply to data-driven (per-feature
// expression) properties such as our extrusion heights, so rises and
// collapses are driven manually: a requestAnimationFrame loop re-sets the
// height expression with an eased scale factor each frame.
const heightAnimations = {};

function activeCase3dLayer() {
  return casesShape === "squares" ? "cases-squares-3d" : "cases-hexes-3d";
}

function caseProperty(layerId) {
  return layerId.includes("hexes") ? "estimate" : "num_active";
}

function setHeightScale(layerId, scale) {
  if (!map?.getLayer(layerId)) return;
  map.setPaintProperty(layerId, "fill-extrusion-height", [
    "*",
    ["get", caseProperty(layerId)],
    METRES_PER_CASE * scale,
  ]);
}

function animateHeight(layerId, from, to, duration, onDone) {
  cancelAnimationFrame(heightAnimations[layerId]);
  const start = performance.now();
  const easeOutCubic = (t) => 1 - (1 - t) ** 3;
  const step = (now) => {
    const t = Math.min((now - start) / duration, 1);
    setHeightScale(layerId, from + (to - from) * easeOutCubic(t));
    if (t < 1) {
      heightAnimations[layerId] = requestAnimationFrame(step);
    } else if (onDone) {
      onDone();
    }
  };
  heightAnimations[layerId] = requestAnimationFrame(step);
}

// In caseload mode the register points fade back into small neutral
// reference dots: still present for official-vs-caseload comparison, but
// no longer carrying the time-on-register encoding.
function syncSitePaint() {
  if (!map?.getLayer("sites")) return;
  const t = tokens();
  if (mapMode === "register") {
    map.setPaintProperty("sites", "circle-color", siteColourExpression());
    map.setPaintProperty("sites", "circle-radius", siteRadiusExpression());
    map.setPaintProperty("sites", "circle-opacity", 1);
    map.setPaintProperty("sites", "circle-stroke-opacity", 1);
  } else if (mapMode === "vacant") {
    // The vacant sites are a different register; hide the derelict points
    // entirely so the two are not read as one dataset.
    map.setPaintProperty("sites", "circle-opacity", 0);
    map.setPaintProperty("sites", "circle-stroke-opacity", 0);
  } else {
    // Circles render as screen-facing billboards at ground positions, so
    // under a pitched camera they read as floating blobs among the prisms.
    // Hide them entirely in the extruded view.
    const opacity = extrude3d ? 0 : 0.6;
    map.setPaintProperty("sites", "circle-color", t.seriesDim);
    map.setPaintProperty("sites", "circle-radius", 3.5);
    map.setPaintProperty("sites", "circle-opacity", opacity);
    map.setPaintProperty("sites", "circle-stroke-opacity", opacity);
  }
}

function basemapStyle() {
  const t = tokens();
  return {
    version: 8,
    sources: {
      basemap: {
        type: "raster",
        tiles: [t.basemap],
        tileSize: 256,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      },
    },
    layers: [{ id: "basemap", type: "raster", source: "basemap" }],
  };
}

function rampExpression() {
  const t = tokens();
  return [
    "match",
    ["get", "year_bin"],
    0,
    t.ramp[0],
    1,
    t.ramp[1],
    2,
    t.ramp[2],
    3,
    t.ramp[3],
    t.ramp[1],
  ];
}

const PROTECTED = [
  "==",
  ["get", "is_on_current_record_of_protected_structures"],
  "Yes",
];

// With emphasis on, protected structures keep the ramp colour and everything
// else drops to the de-emphasis gray.
function siteColourExpression() {
  const t = tokens();
  return emphasiseProtected
    ? ["case", PROTECTED, rampExpression(), t.seriesDim]
    : rampExpression();
}

function siteRadiusExpression() {
  const base = ["interpolate", ["linear"], ["zoom"], 10, 4, 14, 7];
  return emphasiseProtected
    ? ["+", base, ["case", PROTECTED, 1.5, 0]]
    : base;
}

function hexColourExpression(maxCount) {
  const t = tokens();
  return [
    "interpolate",
    ["linear"],
    ["get", "count"],
    1,
    t.hexRamp[0],
    Math.max(maxCount / 2, 2),
    t.hexRamp[1],
    Math.max(maxCount, 3),
    t.hexRamp[2],
  ];
}

// Classed choropleth styling for the caseload overlays. The values are
// heavily right-skewed, so classes come from ckmeans natural breaks
// (d3.scaleCluster) rather than equal intervals, which would waste most of
// the ramp on the near-empty cells.
function caseClassification(property, features) {
  const t = tokens();
  const values = features
    .map((f) => f.properties[property])
    .filter((v) => v > 0);
  if (!values.length) return null;
  const unique = [...new Set(values)];
  const n = Math.min(t.caseRamp.length, unique.length);
  const colours =
    n === t.caseRamp.length
      ? t.caseRamp
      : Array.from(
          { length: n },
          (_, i) =>
            t.caseRamp[Math.round((i * (t.caseRamp.length - 1)) / Math.max(n - 1, 1))]
        );
  const scale = d3.scaleCluster().domain(values).range(colours);
  return {
    colours,
    breaks: scale.clusters(),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function caseColourExpression(property, features) {
  const classification = caseClassification(property, features);
  if (!classification) return tokens().caseRamp[0];
  const { colours, breaks } = classification;
  if (colours.length === 1) return colours[0];
  const expression = ["step", ["get", property], colours[0]];
  breaks.forEach((value, i) => {
    expression.push(value, colours[i + 1]);
  });
  return expression;
}

function addDataLayers() {
  const t = tokens();
  const maxCount = Math.max(
    ...currentHexes.features.map((f) => f.properties.count),
    1
  );

  map.addSource("hexes", { type: "geojson", data: currentHexes });
  map.addLayer({
    id: "hexes",
    type: "fill",
    source: "hexes",
    layout: { visibility: "none" },
    paint: {
      "fill-color": hexColourExpression(maxCount),
      "fill-opacity": 0,
      "fill-opacity-transition": { duration: FADE_MS },
      "fill-outline-color": t.surface,
    },
  });

  map.addSource("cases-squares", { type: "geojson", data: currentCases });
  map.addLayer({
    id: "cases-squares",
    type: "fill",
    source: "cases-squares",
    filter: [">", ["get", "num_active"], 0],
    layout: { visibility: "none" },
    paint: {
      "fill-color": caseColourExpression("num_active", currentCases.features),
      "fill-opacity": 0,
      "fill-opacity-transition": { duration: FADE_MS },
      "fill-outline-color": t.surface,
    },
  });

  map.addSource("cases-hexes", {
    type: "geojson",
    data: currentCaseHexes ?? EMPTY,
  });
  map.addLayer({
    id: "cases-hexes",
    type: "fill",
    source: "cases-hexes",
    layout: { visibility: "none" },
    paint: {
      "fill-color": caseColourExpression(
        "estimate",
        currentCaseHexes?.features ?? []
      ),
      "fill-opacity": 0,
      "fill-opacity-transition": { duration: FADE_MS },
      "fill-outline-color": t.surface,
    },
  });

  map.addLayer({
    id: "cases-squares-3d",
    type: "fill-extrusion",
    source: "cases-squares",
    filter: [">", ["get", "num_active"], 0],
    layout: { visibility: "none" },
    paint: {
      "fill-extrusion-color": caseColourExpression(
        "num_active",
        currentCases.features
      ),
      "fill-extrusion-height": ["*", ["get", "num_active"], METRES_PER_CASE],
      "fill-extrusion-height-transition": { duration: FADE_MS },
      "fill-extrusion-opacity": 0,
      "fill-extrusion-opacity-transition": { duration: FADE_MS },
    },
  });

  map.addLayer({
    id: "cases-hexes-3d",
    type: "fill-extrusion",
    source: "cases-hexes",
    layout: { visibility: "none" },
    paint: {
      "fill-extrusion-color": caseColourExpression(
        "estimate",
        currentCaseHexes?.features ?? []
      ),
      "fill-extrusion-height": ["*", ["get", "estimate"], METRES_PER_CASE],
      "fill-extrusion-height-transition": { duration: FADE_MS },
      "fill-extrusion-opacity": 0,
      "fill-extrusion-opacity-transition": { duration: FADE_MS },
    },
  });

  map.addSource("voronoi", { type: "geojson", data: currentVoronoi });
  map.addLayer({
    id: "voronoi",
    type: "line",
    source: "voronoi",
    layout: { visibility: "none" },
    paint: {
      "line-color": t.textMuted,
      "line-width": 1,
      "line-opacity": 0,
      "line-opacity-transition": { duration: FADE_MS },
    },
  });

  map.addSource("vacant", { type: "geojson", data: currentVacant });
  map.addLayer({
    id: "vacant-fill",
    type: "fill",
    source: "vacant",
    layout: { visibility: "none" },
    paint: {
      "fill-color": t.vacantFill,
      "fill-opacity": 0,
      "fill-opacity-transition": { duration: FADE_MS },
    },
  });
  map.addLayer({
    id: "vacant-line",
    type: "line",
    source: "vacant",
    layout: { visibility: "none" },
    paint: {
      "line-color": t.vacantLine,
      "line-width": 2,
      "line-opacity": 0,
      "line-opacity-transition": { duration: FADE_MS },
    },
  });
  map.addLayer({
    id: "vacant-selected",
    type: "line",
    source: "vacant",
    layout: { visibility: "none" },
    filter: ["==", ["get", "register_number"], "__none__"],
    paint: {
      "line-color": t.series1,
      "line-width": 3.5,
      "line-opacity": 0,
      "line-opacity-transition": { duration: FADE_MS },
    },
  });

  map.addSource("sites", { type: "geojson", data: currentSites });
  map.addLayer({
    id: "sites",
    type: "circle",
    source: "sites",
    paint: {
      "circle-radius": siteRadiusExpression(),
      "circle-color": siteColourExpression(),
      "circle-stroke-color": t.surface,
      "circle-stroke-width": 1.5,
      "circle-color-transition": { duration: FADE_MS },
      "circle-radius-transition": { duration: FADE_MS },
      "circle-opacity-transition": { duration: FADE_MS },
      "circle-stroke-opacity-transition": { duration: FADE_MS },
    },
  });
  syncSitePaint();
  syncOverlayLayers();
}

function popupContent(props) {
  const wrap = document.createElement("div");

  const ref = document.createElement("div");
  ref.className = "popup-ref";
  ref.textContent = props.derelict_site_reference_number ?? "";
  wrap.append(ref);

  const address = document.createElement("div");
  address.className = "popup-address";
  address.textContent = props.full_address ?? "";
  wrap.append(address);

  const added = props.date_added_to_the_derelict_sites_register;
  if (added) {
    const line = document.createElement("div");
    line.className = "popup-line";
    const years = props.years_on_register;
    const yearsText =
      years === null ? "" : ` (${years < 1 ? "under a year" : `${years.toFixed(1)} years`} on the register)`;
    line.textContent = `Added ${added}${yearsText}`;
    wrap.append(line);
  }

  const flags = [];
  if (props.is_on_current_record_of_protected_structures === "Yes") {
    flags.push("Protected structure");
  }
  if (props.is_owned_by_dublin_city_council === "Yes") {
    flags.push("Owned by Dublin City Council");
  }
  if (flags.length) {
    const line = document.createElement("div");
    line.className = "popup-line";
    line.textContent = flags.join(" · ");
    wrap.append(line);
  }

  if (props.derelict_site_description) {
    const desc = document.createElement("div");
    desc.className = "popup-desc";
    const text = props.derelict_site_description;
    desc.textContent = text.length > 220 ? `${text.slice(0, 220)}…` : text;
    wrap.append(desc);
  }

  return wrap;
}

// The grid carries no attributes beyond the case count, so the cell popup
// simply reports the exact value behind the class colour.
function openCellPopup(lngLat, props, isHex) {
  if (popup) popup.remove();
  const wrap = document.createElement("div");
  const value = document.createElement("div");
  value.className = "popup-address";
  value.textContent = isHex
    ? `≈ ${props.estimate.toFixed(1)} active cases`
    : `${props.num_active} active ${props.num_active === 1 ? "case" : "cases"}`;
  const note = document.createElement("div");
  note.className = "popup-line";
  note.textContent = isHex
    ? "area-weighted estimate for this hexagon"
    : "in this grid cell";
  wrap.append(value, note);
  popup = new maplibregl.Popup({ closeButton: true, maxWidth: "240px" })
    .setLngLat(lngLat)
    .setDOMContent(wrap)
    .addTo(map);
}

function openPopup(feature) {
  if (popup) popup.remove();
  popup = new maplibregl.Popup({ closeButton: true, maxWidth: "300px" })
    .setLngLat(feature.geometry.coordinates)
    .setDOMContent(popupContent(feature.properties))
    .addTo(map);
}

// The vacant view drives a detail panel rather than a popup: a click reports
// the site's register number to whoever registered a handler.
let vacantSelectHandler = null;

export function onVacantSelect(handler) {
  vacantSelectHandler = handler;
}

// Outline a site as the current selection, optionally zooming to it. Called
// from a map click and from the site list; the initial auto-selection passes
// zoom:false so the map keeps its city-wide overview.
export function focusVacantSite(registerNumber, { zoom = true } = {}) {
  if (!map) return;
  const feature = currentVacant.features.find(
    (f) => f.properties.register_number === registerNumber
  );
  if (!feature) return;
  if (map.getLayer("vacant-selected")) {
    map.setFilter("vacant-selected", [
      "==",
      ["get", "register_number"],
      registerNumber,
    ]);
  }
  if (zoom) {
    map.fitBounds(turf.bbox(feature), {
      padding: 90,
      maxZoom: 16,
      duration: 700,
    });
  }
}

// Switch between the register view (points and point-derived overlays) and
// the caseload view (choropleth with faded reference points). Exported so
// other interactions, such as the locate button, can force the register
// view.
export function setMapMode(mode) {
  if (mode === mapMode) return;
  mapMode = mode;
  const register = mode === "register";
  const caseload = mode === "caseload";
  const vacant = mode === "vacant";
  document.getElementById("panel-register").hidden = !register;
  document.getElementById("panel-caseload").hidden = !caseload;
  document.getElementById("panel-vacant").hidden = !vacant;
  document.getElementById("cases-hint").hidden = !caseload;
  const radio = document.querySelector(
    `input[name="map-mode"][value="${mode}"]`
  );
  if (radio) radio.checked = true;
  if (popup) popup.remove();
  // Leaving the caseload's extruded view collapses the prisms and levels the
  // camera before the other views take over.
  if (!caseload && extrude3d) {
    animateHeight(activeCase3dLayer(), 1, 0, 450);
    extrude3d = false;
    document.getElementById("toggle-extrude").checked = false;
    map?.easeTo({ pitch: 0, bearing: 0, duration: 900 });
  }
  syncSitePaint();
  syncOverlayLayers();
  buildCasesLegend();
}

function buildCasesLegend() {
  const legend = document.getElementById("cases-legend");
  legend.replaceChildren();
  const hexMode = casesShape === "hexes" && currentCaseHexes;
  const title = document.createElement("span");
  title.className = "legend-title";
  title.textContent = hexMode
    ? "Active cases per cell (est.)"
    : "Active cases per cell";
  legend.append(title);
  const classification = hexMode
    ? caseClassification("estimate", currentCaseHexes.features)
    : caseClassification("num_active", currentCases.features);
  if (!classification) return;
  const { colours, breaks, min, max } = classification;

  const fmt = (v) => String(Math.round(v));
  colours.forEach((colour, i) => {
    const lower = i === 0 ? min : breaks[i - 1];
    const upper = i < colours.length - 1 ? breaks[i] : null;
    const row = document.createElement("span");
    row.className = "legend-row";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch legend-swatch-square";
    swatch.style.background = colour;
    const label = document.createElement("span");
    if (upper === null) {
      label.textContent =
        fmt(lower) === fmt(max) ? fmt(max) : `${fmt(lower)}–${fmt(max)}`;
    } else if (hexMode) {
      label.textContent = `${fmt(lower)}–${fmt(upper)}`;
    } else {
      const top = Math.round(upper) - 1;
      label.textContent =
        Math.round(lower) === top
          ? String(top)
          : `${Math.round(lower)}–${top}`;
    }
    row.append(swatch, label);
    legend.append(row);
  });

  if (!extrude3d) {
    const siteRow = document.createElement("span");
    siteRow.className = "legend-row";
    const dot = document.createElement("span");
    dot.className = "legend-swatch";
    dot.style.background = tokens().seriesDim;
    const siteLabel = document.createElement("span");
    siteLabel.textContent = "site on the register";
    siteRow.append(dot, siteLabel);
    legend.append(siteRow);
  }
}

function buildLegend() {
  const t = tokens();
  const legend = document.getElementById("map-legend");
  legend.replaceChildren();
  const title = document.createElement("span");
  title.className = "legend-title";
  title.textContent = "Time on register";
  legend.append(title);
  YEAR_BINS.forEach((bin, i) => {
    const row = document.createElement("span");
    row.className = "legend-row";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = t.ramp[i];
    const label = document.createElement("span");
    label.textContent = bin.label;
    row.append(swatch, label);
    legend.append(row);
  });
}

function buildVacantLegend() {
  const legend = document.getElementById("vacant-legend");
  if (!legend) return;
  const t = tokens();
  legend.replaceChildren();
  const title = document.createElement("span");
  title.className = "legend-title";
  title.textContent = "Vacant Sites Register";
  legend.append(title);
  const row = document.createElement("span");
  row.className = "legend-row";
  const swatch = document.createElement("span");
  swatch.className = "legend-swatch legend-swatch-square";
  swatch.style.background = t.vacantFill;
  swatch.style.boxShadow = `0 0 0 1.5px ${t.vacantLine}`;
  const label = document.createElement("span");
  label.textContent = `${currentVacant.features.length} vacant sites`;
  row.append(swatch, label);
  legend.append(row);
}

export function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: basemapStyle(),
    center: DUBLIN_CENTRE,
    zoom: 11.4,
    attributionControl: { compact: false },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
  map.on("load", addDataLayers);

  map.on("click", "sites", (e) => {
    if (mapMode === "register" && e.features?.length) openPopup(e.features[0]);
  });
  for (const layer of [
    "cases-squares",
    "cases-hexes",
    "cases-squares-3d",
    "cases-hexes-3d",
  ]) {
    map.on("click", layer, (e) => {
      if (!e.features?.length) return;
      openCellPopup(e.lngLat, e.features[0].properties, layer.includes("hexes"));
    });
    map.on("mouseenter", layer, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
    });
  }
  map.on("mouseenter", "sites", () => {
    if (mapMode === "register") map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "sites", () => {
    map.getCanvas().style.cursor = "";
  });

  map.on("click", "vacant-fill", (e) => {
    if (mapMode === "vacant" && e.features?.length) {
      vacantSelectHandler?.(e.features[0].properties.register_number);
    }
  });
  map.on("mouseenter", "vacant-fill", () => {
    if (mapMode === "vacant") map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "vacant-fill", () => {
    map.getCanvas().style.cursor = "";
  });

  document.getElementById("toggle-hex").addEventListener("change", (e) => {
    hexVisible = e.target.checked;
    syncOverlayLayers();
  });

  document.getElementById("toggle-voronoi").addEventListener("change", (e) => {
    voronoiVisible = e.target.checked;
    syncOverlayLayers();
  });

  for (const radio of document.querySelectorAll('input[name="map-mode"]')) {
    radio.addEventListener("change", (e) => {
      if (e.target.checked) setMapMode(e.target.value);
    });
  }
  for (const radio of document.querySelectorAll('input[name="cases-shape"]')) {
    radio.addEventListener("change", (e) => {
      const previous3d = activeCase3dLayer();
      casesShape = e.target.value;
      if (popup) popup.remove();
      if (extrude3d) {
        // Collapse the outgoing shape, then raise the incoming one.
        const next3d = activeCase3dLayer();
        animateHeight(previous3d, 1, 0, 350, () => {
          setHeightScale(next3d, 0);
          syncOverlayLayers();
          animateHeight(next3d, 0, 1, 350);
        });
      } else {
        syncOverlayLayers();
      }
      buildCasesLegend();
    });
  }
  document.getElementById("toggle-extrude").addEventListener("change", (e) => {
    extrude3d = e.target.checked;
    const layer = activeCase3dLayer();
    if (extrude3d) {
      setHeightScale(layer, 0);
      syncOverlayLayers();
      animateHeight(layer, 0, 1, 800);
    } else {
      animateHeight(layer, 1, 0, 450);
      syncOverlayLayers();
    }
    syncSitePaint();
    buildCasesLegend();
    map.easeTo(
      extrude3d
        ? { pitch: 55, bearing: -15, duration: 900 }
        : { pitch: 0, bearing: 0, duration: 900 }
    );
  });

  document
    .getElementById("toggle-protected")
    .addEventListener("change", (e) => {
      emphasiseProtected = e.target.checked;
      syncSitePaint();
    });

  buildLegend();
  buildCasesLegend();
  buildVacantLegend();
  return map;
}

// The caseload grid is static (not affected by the filter row), so it is
// set once rather than through updateMapData.
export function setCaseloadData(grid) {
  currentCases = grid;
  if (map?.getSource("cases-squares")) {
    map.getSource("cases-squares").setData(currentCases);
    const colour = caseColourExpression("num_active", currentCases.features);
    map.setPaintProperty("cases-squares", "fill-color", colour);
    map.setPaintProperty("cases-squares-3d", "fill-extrusion-color", colour);
  }
  buildCasesLegend();
}

// The vacant sites register is static (independent of the register filters),
// so it is set once like the caseload grid.
export function setVacantData(collection) {
  currentVacant = collection;
  map?.getSource("vacant")?.setData(currentVacant);
  buildVacantLegend();
}

export function setCaseloadHexes(hexes) {
  currentCaseHexes = hexes;
  if (map?.getSource("cases-hexes")) {
    map.getSource("cases-hexes").setData(currentCaseHexes);
    const colour = caseColourExpression("estimate", currentCaseHexes.features);
    map.setPaintProperty("cases-hexes", "fill-color", colour);
    map.setPaintProperty("cases-hexes-3d", "fill-extrusion-color", colour);
  }
}

export function updateMapData(sites, hexes, voronoi) {
  currentSites = { type: "FeatureCollection", features: sites };
  currentHexes = hexes;
  currentVoronoi = voronoi;
  if (!map || !map.isStyleLoaded()) return;
  map.getSource("sites")?.setData(currentSites);
  map.getSource("voronoi")?.setData(currentVoronoi);
  const hexSource = map.getSource("hexes");
  if (hexSource) {
    hexSource.setData(currentHexes);
    const maxCount = Math.max(
      ...currentHexes.features.map((f) => f.properties.count),
      1
    );
    map.setPaintProperty("hexes", "fill-color", hexColourExpression(maxCount));
  }
}

// Swap basemap and re-add data layers when the colour scheme changes.
export function refreshMapStyle() {
  if (!map) return;
  if (popup) popup.remove();
  map.setStyle(basemapStyle());
  map.once("styledata", () => {
    if (!map.getSource("sites")) addDataLayers();
  });
  buildLegend();
  buildCasesLegend();
  buildVacantLegend();
}

let userMarker;

// Show the user's position and the nearest site together. The result is a
// register site, so this always returns to the register view.
export function showNearestSite(userLngLat, feature) {
  if (!map) return;
  setMapMode("register");
  if (userMarker) userMarker.remove();
  userMarker = new maplibregl.Marker({ color: tokens().series1 })
    .setLngLat(userLngLat)
    .addTo(map);
  const bounds = new maplibregl.LngLatBounds(userLngLat, userLngLat);
  bounds.extend(feature.geometry.coordinates);
  map.fitBounds(bounds, { padding: 90, maxZoom: 16, duration: 900 });
  openPopup(feature);
}

// Fit the camera to the current sites (used by embed mode).
export function fitToSites(padding = 70) {
  if (!map || !currentSites.features.length) return;
  map.fitBounds(turf.bbox(currentSites), {
    padding,
    duration: 0,
    maxZoom: 13,
  });
}

export function focusSite(feature) {
  if (!map) return;
  setMapMode("register");
  map.flyTo({
    center: feature.geometry.coordinates,
    zoom: Math.max(map.getZoom(), 15),
    duration: 900,
  });
  openPopup(feature);
  document
    .querySelector(".map-section")
    .scrollIntoView({ behavior: "smooth", block: "nearest" });
}
