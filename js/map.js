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
let hexVisible = false;
let voronoiVisible = false;
let emphasiseProtected = false;
let casesVisible = false;
let casesShape = "squares";
let popup;

const EMPTY = { type: "FeatureCollection", features: [] };

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

function caseColourExpression(property, features) {
  const t = tokens();
  const max = Math.max(...features.map((f) => f.properties[property]), 2);
  const expression = ["interpolate", ["linear"], ["get", property]];
  t.caseRamp.forEach((colour, i) => {
    const value = i === 0 ? 0.05 : (max * i) / (t.caseRamp.length - 1);
    expression.push(value, colour);
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
    layout: { visibility: hexVisible ? "visible" : "none" },
    paint: {
      "fill-color": hexColourExpression(maxCount),
      "fill-opacity": 0.55,
      "fill-outline-color": t.surface,
    },
  });

  map.addSource("cases-squares", { type: "geojson", data: currentCases });
  map.addLayer({
    id: "cases-squares",
    type: "fill",
    source: "cases-squares",
    filter: [">", ["get", "num_active"], 0],
    layout: {
      visibility:
        casesVisible && casesShape === "squares" ? "visible" : "none",
    },
    paint: {
      "fill-color": caseColourExpression("num_active", currentCases.features),
      "fill-opacity": 0.55,
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
    layout: {
      visibility: casesVisible && casesShape === "hexes" ? "visible" : "none",
    },
    paint: {
      "fill-color": caseColourExpression(
        "estimate",
        currentCaseHexes?.features ?? []
      ),
      "fill-opacity": 0.55,
      "fill-outline-color": t.surface,
    },
  });

  map.addSource("voronoi", { type: "geojson", data: currentVoronoi });
  map.addLayer({
    id: "voronoi",
    type: "line",
    source: "voronoi",
    layout: { visibility: voronoiVisible ? "visible" : "none" },
    paint: {
      "line-color": t.textMuted,
      "line-width": 1,
      "line-opacity": 0.7,
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
    },
  });
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

function openPopup(feature) {
  if (popup) popup.remove();
  popup = new maplibregl.Popup({ closeButton: true, maxWidth: "300px" })
    .setLngLat(feature.geometry.coordinates)
    .setDOMContent(popupContent(feature.properties))
    .addTo(map);
}

function syncCaseLayers() {
  if (!map) return;
  if (map.getLayer("cases-squares")) {
    map.setLayoutProperty(
      "cases-squares",
      "visibility",
      casesVisible && casesShape === "squares" ? "visible" : "none"
    );
  }
  if (map.getLayer("cases-hexes")) {
    map.setLayoutProperty(
      "cases-hexes",
      "visibility",
      casesVisible && casesShape === "hexes" ? "visible" : "none"
    );
  }
}

function buildCasesLegend() {
  const t = tokens();
  const legend = document.getElementById("cases-legend");
  legend.replaceChildren();
  const title = document.createElement("span");
  title.className = "legend-title";
  title.textContent = "Active cases per cell";
  const strip = document.createElement("span");
  strip.className = "legend-gradient";
  strip.style.background = `linear-gradient(to right, ${t.caseRamp.join(", ")})`;
  const range = document.createElement("span");
  range.className = "legend-range";
  const hexMode = casesShape === "hexes" && currentCaseHexes;
  const max = hexMode
    ? Math.max(...currentCaseHexes.features.map((f) => f.properties.estimate), 0)
    : Math.max(...currentCases.features.map((f) => f.properties.num_active), 0);
  const low = document.createElement("span");
  low.textContent = hexMode ? "~0" : "1";
  const high = document.createElement("span");
  high.textContent = hexMode ? `~${Math.round(max)}` : String(max);
  range.append(low, high);
  legend.append(title, strip, range);
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
    if (e.features?.length) openPopup(e.features[0]);
  });
  map.on("mouseenter", "sites", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "sites", () => {
    map.getCanvas().style.cursor = "";
  });

  document.getElementById("toggle-hex").addEventListener("change", (e) => {
    hexVisible = e.target.checked;
    if (map.getLayer("hexes")) {
      map.setLayoutProperty(
        "hexes",
        "visibility",
        hexVisible ? "visible" : "none"
      );
    }
  });

  document.getElementById("toggle-voronoi").addEventListener("change", (e) => {
    voronoiVisible = e.target.checked;
    if (map.getLayer("voronoi")) {
      map.setLayoutProperty(
        "voronoi",
        "visibility",
        voronoiVisible ? "visible" : "none"
      );
    }
  });

  document.getElementById("toggle-cases").addEventListener("change", (e) => {
    casesVisible = e.target.checked;
    document.getElementById("cases-mode").hidden = !casesVisible;
    document.getElementById("cases-legend").hidden = !casesVisible;
    syncCaseLayers();
  });
  for (const radio of document.querySelectorAll('input[name="cases-shape"]')) {
    radio.addEventListener("change", (e) => {
      casesShape = e.target.value;
      syncCaseLayers();
      buildCasesLegend();
    });
  }

  document
    .getElementById("toggle-protected")
    .addEventListener("change", (e) => {
      emphasiseProtected = e.target.checked;
      if (map.getLayer("sites")) {
        map.setPaintProperty("sites", "circle-color", siteColourExpression());
        map.setPaintProperty("sites", "circle-radius", siteRadiusExpression());
      }
    });

  buildLegend();
  buildCasesLegend();
  return map;
}

// The caseload grid is static (not affected by the filter row), so it is
// set once rather than through updateMapData.
export function setCaseloadData(grid) {
  currentCases = grid;
  if (map?.getSource("cases-squares")) {
    map.getSource("cases-squares").setData(currentCases);
    map.setPaintProperty(
      "cases-squares",
      "fill-color",
      caseColourExpression("num_active", currentCases.features)
    );
  }
  buildCasesLegend();
}

export function setCaseloadHexes(hexes) {
  currentCaseHexes = hexes;
  if (map?.getSource("cases-hexes")) {
    map.getSource("cases-hexes").setData(currentCaseHexes);
    map.setPaintProperty(
      "cases-hexes",
      "fill-color",
      caseColourExpression("estimate", currentCaseHexes.features)
    );
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
}

let userMarker;

// Show the user's position and the nearest site together.
export function showNearestSite(userLngLat, feature) {
  if (!map) return;
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
