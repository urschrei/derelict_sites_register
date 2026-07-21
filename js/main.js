import { onSchemeChange, toggleTheme } from "./tokens.js";
import {
  deriveFeatures,
  clarkEvans,
  describeClustering,
  hexDensity,
  voronoiCatchments,
  median,
  countByArea,
  countByYearAdded,
  countByDistance,
  regridCaseloadToHexes,
} from "./analysis.js";
import {
  renderBarChartH,
  renderColumnChart,
  renderDataTable,
  hideTooltip,
} from "./charts.js";
import {
  initMap,
  updateMapData,
  refreshMapStyle,
  focusSite,
  showNearestSite,
  fitToSites,
  setCaseloadData,
  setCaseloadHexes,
  setMapMode,
} from "./map.js";
import { renderTable } from "./table.js";
import { buildIndex, nearestSites } from "./spatial.js";
import { loadVacant, vacantMeta } from "./vacant.js";
import { loadRzlt, rzltMeta } from "./rzlt.js";

const state = { area: "", protected: false, council: false, search: "" };
let currentView = "derelict";

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
  document.getElementById("kpi-council-note").textContent =
    `${filtered.length - councilCount} not in council ownership`;

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
  updateMapData(filtered, hexDensity(filtered), voronoiCatchments(filtered));
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

function formatDistance(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

function wireLocateButton() {
  const button = document.getElementById("locate-button");
  const status = document.getElementById("locate-status");
  button.addEventListener("click", () => {
    if (!("geolocation" in navigator)) {
      status.textContent = "This browser does not support geolocation.";
      return;
    }
    status.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { longitude, latitude } = position.coords;
        const [nearest] = nearestSites(longitude, latitude, 1);
        if (!nearest) {
          status.textContent = "No sites available.";
          return;
        }
        const p = nearest.feature.properties;
        status.textContent =
          `Closest site: ${p.derelict_site_reference_number}, ` +
          `${p.full_address} — ${formatDistance(nearest.distanceKm)} away.`;
        showNearestSite([longitude, latitude], nearest.feature);
      },
      (error) => {
        status.textContent =
          error.code === error.PERMISSION_DENIED
            ? "Location permission was declined."
            : "Could not determine your location.";
      },
      { timeout: 10000, maximumAge: 60000 }
    );
  });
}

function derelictHeaderLine() {
  // Update dates are DD/MM/YYYY strings; compare them in YYYYMMDD order.
  const key = (d) => d.split("/").reverse().join("");
  const latest = allFeatures
    .map((f) => f.properties.most_recent_update_date)
    .filter(Boolean)
    .sort((a, b) => key(a).localeCompare(key(b)))
    .at(-1);
  return (
    `${allFeatures.length} sites on the register` +
    (latest ? ` · register last amended ${latest}` : "") +
    " · data refreshed twice daily"
  );
}

function vacantHeaderLine() {
  const meta = vacantMeta();
  if (!meta) return "Loading register data…";
  const [y, m, d] = (meta.latest ?? "").split("-");
  return (
    `${meta.count} sites on the historical register` +
    (meta.latest ? ` · last registration ${d}/${m}/${y}` : "") +
    " · superseded by the RZLT · removals still tracked"
  );
}

function rzltHeaderLine() {
  const meta = rzltMeta();
  if (!meta) return "Loading register data…";
  return (
    `${meta.count} vacant or idle parcels on the RZLT map` +
    (meta.latest ? ` · newest additions ${meta.latest.slice(0, 4)}` : "") +
    " · data refreshed twice daily"
  );
}

const HEADER_LINES = {
  derelict: derelictHeaderLine,
  vacant: vacantHeaderLine,
  rzlt: rzltHeaderLine,
};

function renderHeaderMeta() {
  document.getElementById("site-count-line").textContent =
    HEADER_LINES[currentView]();
}

function loadCaseload() {
  return fetch("data/active_cases_grid.geojson")
    .then((response) => (response.ok ? response.json() : null))
    .then((grid) => {
      if (!grid) return;
      setCaseloadData(grid);
      const total = grid.features.reduce(
        (sum, f) => sum + f.properties.num_active,
        0
      );
      document.getElementById("cases-hint").textContent =
        `The DCC caseload overlay shows all ${total} active dereliction ` +
        "cases, aggregated by the council to a grid before publication " +
        "(only sites formally on the register appear as points). The " +
        "hexagon view re-grids the counts by area weighting, so its " +
        "values are estimates. Click a cell for its exact count.";
      // The hexagon re-grid is moderately expensive; compute it off the
      // critical path once the page has settled.
      setTimeout(() => {
        setCaseloadHexes(regridCaseloadToHexes(grid.features));
      }, 1500);
    });
}

function describeRegisterChange(change) {
  if (!change) return "not recorded";
  const parts = [];
  if (change.added.length) parts.push(`${change.added.length} added`);
  if (change.removed.length) parts.push(`${change.removed.length} removed`);
  const detail = parts.length ? parts.join(", ") : "no change";
  return `${detail} (${change.total} sites)`;
}

// The changelog is written by the refresh workflow whenever register
// membership changes, so every entry represents an actual change.
function loadChangelog() {
  return fetch("data/changelog.json")
    .then((response) => (response.ok ? response.json() : null))
    .then((entries) => {
      if (!entries?.length) return;
      const list = document.getElementById("changelog-list");
      for (const entry of entries.slice(0, 3)) {
        const item = document.createElement("li");
        const [y, m, d] = entry.date.split("T")[0].split("-");
        const time = document.createElement("time");
        time.dateTime = entry.date;
        time.textContent = `${d}/${m}/${y}`;
        // Entries gain a commit hash once the refresh workflow has stamped
        // them; link the date to the data commit when it is available.
        let dateNode = time;
        if (entry.commit) {
          const link = document.createElement("a");
          link.href = `https://github.com/urschrei/derelict_sites_register/commit/${entry.commit}`;
          link.append(time);
          dateNode = link;
        }
        // Older entries predate RZLT tracking; only mention it once present.
        const rzltPart = entry.rzlt
          ? ` · RZLT: ${describeRegisterChange(entry.rzlt)}`
          : "";
        item.append(
          dateNode,
          ` · Derelict: ${describeRegisterChange(entry.derelict)}` +
            ` · Vacant: ${describeRegisterChange(entry.vacant)}` +
            rzltPart
        );
        list.append(item);
      }
      document.getElementById("changelog-section").hidden = false;
    });
}

// Top-level switch between the three registers. Derelict keeps its register /
// caseload map modes and its filters, charts, and table; vacant and RZLT
// swap in their own figures, site lists, and detail panels. The map element
// is shared.
function setView(view) {
  currentView = view;
  document.body.classList.toggle("view-vacant", view === "vacant");
  document.body.classList.toggle("view-rzlt", view === "rzlt");
  renderHeaderMeta();
  if (view === "derelict") {
    const checked = document.querySelector('input[name="map-mode"]:checked');
    setMapMode(checked ? checked.value : "register");
  } else {
    setMapMode(view);
  }
}

function wireViewSwitch() {
  for (const radio of document.querySelectorAll('input[name="view"]')) {
    radio.addEventListener("change", (e) => {
      if (e.target.checked) setView(e.target.value);
    });
  }
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

  const embed = new URLSearchParams(window.location.search).has("embed");
  if (embed) document.body.classList.add("embed");

  buildIndex(allFeatures);
  renderHeaderMeta();
  wireFilters();
  wireLocateButton();
  wireViewSwitch();
  document
    .getElementById("theme-toggle")
    ?.addEventListener("click", toggleTheme);
  initMap();
  render();
  loadCaseload();
  loadChangelog();
  loadVacant().then(() => {
    if (currentView === "vacant") renderHeaderMeta();
  });
  loadRzlt().then(() => {
    if (currentView === "rzlt") renderHeaderMeta();
  });

  if (embed) {
    document.getElementById("embed-count").textContent =
      `${allFeatures.length} sites, mapped and refreshed twice daily`;
    fitToSites();
  }

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
