// MapLibre map: sites coloured by time on the register, with an optional
// Turf-derived hex density overlay. MapLibre is loaded globally as
// `maplibregl`.

import { tokens, YEAR_BINS } from "./tokens.js";

const DUBLIN_CENTRE = [-6.2718, 53.3455];

let map;
let currentSites = { type: "FeatureCollection", features: [] };
let currentHexes = { type: "FeatureCollection", features: [] };
let hexVisible = false;
let popup;

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

  map.addSource("sites", { type: "geojson", data: currentSites });
  map.addLayer({
    id: "sites",
    type: "circle",
    source: "sites",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 14, 7],
      "circle-color": rampExpression(),
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

  buildLegend();
  return map;
}

export function updateMapData(sites, hexes) {
  currentSites = { type: "FeatureCollection", features: sites };
  currentHexes = hexes;
  if (!map || !map.isStyleLoaded()) return;
  map.getSource("sites")?.setData(currentSites);
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
