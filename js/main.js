import { onSchemeChange } from "./tokens.js";
import {
  deriveFeatures,
  clarkEvans,
  describeClustering,
  hexDensity,
  median,
  countByArea,
  countByYearAdded,
  countByDistance,
} from "./analysis.js";
import {
  renderBarChartH,
  renderColumnChart,
  renderDataTable,
  hideTooltip,
} from "./charts.js";
import { initMap, updateMapData, refreshMapStyle, focusSite } from "./map.js";
import { renderTable } from "./table.js";

const state = { area: "", protected: false, council: false, search: "" };

let allFeatures = [];
let areas = [];
let yearRange = [2007, new Date().getFullYear()];
let maxDistanceKm = 8;

function applyFilters({ ignoreArea = false } = {}) {
  const query = state.search.trim().toLowerCase();
  return allFeatures.filter((f) => {
    const p = f.properties;
    if (!ignoreArea && state.area && p.administrative_area_name !== state.area) {
      return false;
    }
    if (
      state.protected &&
      p.is_on_current_record_of_protected_structures !== "Yes"
    ) {
      return false;
    }
    if (state.council && p.is_owned_by_dublin_city_council !== "Yes") {
      return false;
    }
    if (query) {
      const haystack = `${p.full_address ?? ""} ${p.derelict_site_reference_number ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function renderKpis(filtered) {
  const count = document.getElementById("kpi-count");
  count.textContent = String(filtered.length);
  document.getElementById("kpi-count-note").textContent =
    `of ${allFeatures.length} sites on the register`;

  const years = filtered
    .map((f) => f.properties.years_on_register)
    .filter((y) => y !== null);
  const med = median(years);
  document.getElementById("kpi-median-years").textContent =
    med === null ? "–" : `${med.toFixed(1)} yrs`;
  document.getElementById("kpi-oldest").textContent = years.length
    ? `longest: ${Math.max(...years).toFixed(1)} years`
    : "";

  const protectedCount = filtered.filter(
    (f) => f.properties.is_on_current_record_of_protected_structures === "Yes"
  ).length;
  document.getElementById("kpi-protected").textContent = String(protectedCount);

  const councilCount = filtered.filter(
    (f) => f.properties.is_owned_by_dublin_city_council === "Yes"
  ).length;
  document.getElementById("kpi-council").textContent = String(councilCount);

  const ce = clarkEvans(filtered);
  document.getElementById("kpi-cluster").textContent = ce
    ? ce.ratio.toFixed(2)
    : "–";
  document.getElementById("kpi-cluster-note").textContent = ce
    ? `${describeClustering(ce.ratio)} (Clark–Evans ratio)`
    : "Clark–Evans nearest-neighbour ratio";
}

function renderCharts(filtered) {
  const areaRows = countByArea(applyFilters({ ignoreArea: true }), areas);
  renderBarChartH(document.getElementById("chart-area"), areaRows, {
    emphasis: state.area || null,
    ariaLabel: "Sites by administrative area",
  });
  renderDataTable(document.getElementById("chart-area-table"), areaRows, [
    "Area",
    "Sites",
  ]);

  const yearRows = countByYearAdded(filtered, yearRange[0], yearRange[1]);
  renderColumnChart(document.getElementById("chart-year"), yearRows, {
    labelEvery: Math.max(Math.ceil(yearRows.length / 7), 1),
    ariaLabel: "Additions to the register by year",
  });
  renderDataTable(document.getElementById("chart-year-table"), yearRows, [
    "Year",
    "Sites added",
  ]);

  const distanceRows = countByDistance(filtered, maxDistanceKm);
  renderColumnChart(document.getElementById("chart-distance"), distanceRows, {
    labelEvery: 2,
    shortLabel: (label) => label.split("–")[0],
    ariaLabel: "Sites by distance from the Spire",
  });
  renderDataTable(
    document.getElementById("chart-distance-table"),
    distanceRows,
    ["Distance", "Sites"]
  );
}

function render() {
  const filtered = applyFilters();
  document.getElementById("filter-status").textContent =
    `Showing ${filtered.length} of ${allFeatures.length} sites`;
  renderKpis(filtered);
  renderCharts(filtered);
  updateMapData(filtered, hexDensity(filtered));
  renderTable(filtered, focusSite);
  hideTooltip();
}

function wireFilters() {
  const areaSelect = document.getElementById("filter-area");
  for (const area of areas) {
    const option = document.createElement("option");
    option.value = area;
    option.textContent = area;
    areaSelect.append(option);
  }
  areaSelect.addEventListener("change", () => {
    state.area = areaSelect.value;
    render();
  });

  const protectedBox = document.getElementById("filter-protected");
  protectedBox.addEventListener("change", () => {
    state.protected = protectedBox.checked;
    render();
  });

  const councilBox = document.getElementById("filter-council");
  councilBox.addEventListener("change", () => {
    state.council = councilBox.checked;
    render();
  });

  const search = document.getElementById("filter-search");
  let searchTimer;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = search.value;
      render();
    }, 150);
  });

  document.getElementById("filter-reset").addEventListener("click", () => {
    state.area = "";
    state.protected = false;
    state.council = false;
    state.search = "";
    areaSelect.value = "";
    protectedBox.checked = false;
    councilBox.checked = false;
    search.value = "";
    render();
  });
}

function renderHeaderMeta() {
  const updates = allFeatures
    .map((f) => f.properties.most_recent_update_date)
    .filter(Boolean)
    .sort();
  const latest = updates.at(-1);
  const line = document.getElementById("site-count-line");
  line.textContent =
    `${allFeatures.length} sites on the register` +
    (latest ? ` · register last amended ${latest}` : "") +
    " · data refreshed twice daily";
}

async function init() {
  const response = await fetch("data/derelict_sites_register.geojson");
  if (!response.ok) {
    document.getElementById("site-count-line").textContent =
      "Failed to load register data.";
    return;
  }
  const collection = await response.json();
  allFeatures = deriveFeatures(collection);

  areas = [
    ...new Set(allFeatures.map((f) => f.properties.administrative_area_name)),
  ].sort();
  const addedYears = allFeatures
    .map((f) => f.properties.year_added)
    .filter((y) => y !== null);
  yearRange = [Math.min(...addedYears), new Date().getFullYear()];
  maxDistanceKm = Math.ceil(
    Math.max(...allFeatures.map((f) => f.properties.distance_from_centre_km))
  );

  renderHeaderMeta();
  wireFilters();
  initMap();
  render();

  onSchemeChange(() => {
    refreshMapStyle();
    render();
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderCharts(applyFilters()), 150);
  });
}

init();
