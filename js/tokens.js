// Colour tokens for chart and map code.
//
// Chrome colours (surfaces, text roles, gridlines, the derelict series hue and
// the two register accents) are defined once in css/style.css and read from the
// document at theme-change time, so this module holds no duplicate hex values
// for them. The data-encoding ramps (the ordinal time-on-register ramp, the
// viridis caseload ramp, the RZLT zoning hues and coverage ramp) stay
// hard-coded here: they are validated, mode-dependent, and have no CSS
// consumers. The ordinal ramp was validated for both modes (single hue,
// monotone lightness, visible step gaps, surface contrast).

// Chrome colours, keyed by the CSS custom property that defines each one.
const CHROME_VARS = {
  surface: "--surface-1",
  page: "--page",
  textPrimary: "--text-primary",
  textSecondary: "--text-secondary",
  textMuted: "--text-muted",
  gridline: "--gridline",
  baseline: "--baseline",
  series1: "--series-1",
  seriesDim: "--series-dim",
  vacantLine: "--vacant-accent",
  rzltAccent: "--rzlt-accent",
};

// Data-encoding colours, per theme. Mode-dependent and validated; no CSS
// equivalents, so they remain literal here.
const DATA = {
  light: {
    ramp: ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"],
    hexRamp: ["#cde2fb", "#3987e5", "#0d366b"],
    caseRamp: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
    // The vacant sites read in a warm accent that sits apart from the blue
    // time-on-register ramp; the fill is a lighter tint of the --vacant-accent
    // line, which is read from CSS.
    vacantFill: "#e07b2f",
    // Categorical hues for the RZLT generalised zoning classes, validated for
    // adjacent-pair CVD separation and surface contrast in legend order. R3
    // (strategic regeneration) is the RZLT register accent and is read from
    // --rzlt-accent so the hue has a single source of truth.
    rzltZoning: { M1: "#6b46a8", M2: "#e06377", M3: "#8a6d00" },
    // Sequential ramp (single hue, light to dark) for building coverage, and a
    // two-class scheme for public vs private ownership.
    rzltCoverageRamp: ["#f2e6d8", "#e0a878", "#c06a2c", "#7a3d10"],
    rzltPublic: "#0073a8",
    rzltPrivate: "#d29338",
    basemap: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
  },
  dark: {
    ramp: ["#9ec5f4", "#5598e7", "#2a78d6", "#184f95"],
    hexRamp: ["#184f95", "#5598e7", "#cde2fb"],
    // Viridis is perceptually uniform and works on both surfaces, so the
    // caseload ramp is mode-invariant.
    caseRamp: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
    vacantFill: "#e8823c",
    rzltZoning: { M1: "#9d7ad8", M2: "#d9647f", M3: "#9c8427" },
    rzltCoverageRamp: ["#3a3020", "#7a5a2e", "#c08a44", "#f0c67e"],
    rzltPublic: "#3ba0c6",
    rzltPrivate: "#b57f38",
    basemap: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
  },
};

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const schemeHandlers = [];

// The active theme is whatever the inline head script (or the toggle) stamped
// on <html>; tokens() and the map/chart palettes follow it.
export function isDark() {
  return document.documentElement.dataset.theme === "dark";
}

// Read the chrome colours from the resolved custom properties. Unregistered
// custom properties are returned as their authored value (hex here), so the
// palette map and chart code receive the same strings they did when these were
// literals.
function readChromeColours() {
  const styles = window.getComputedStyle(document.documentElement);
  const chrome = {};
  for (const [key, prop] of Object.entries(CHROME_VARS)) {
    chrome[key] = styles.getPropertyValue(prop).trim();
  }
  return chrome;
}

// Assemble the full token set: chrome colours from CSS merged with the
// hard-coded data ramps for the active theme.
function buildTokens() {
  const chrome = readChromeColours();
  const data = isDark() ? DATA.dark : DATA.light;
  return {
    surface: chrome.surface,
    page: chrome.page,
    textPrimary: chrome.textPrimary,
    textSecondary: chrome.textSecondary,
    textMuted: chrome.textMuted,
    gridline: chrome.gridline,
    baseline: chrome.baseline,
    series1: chrome.series1,
    seriesDim: chrome.seriesDim,
    ramp: data.ramp,
    hexRamp: data.hexRamp,
    caseRamp: data.caseRamp,
    vacantFill: data.vacantFill,
    vacantLine: chrome.vacantLine,
    rzltColours: {
      M1: data.rzltZoning.M1,
      M2: data.rzltZoning.M2,
      M3: data.rzltZoning.M3,
      R3: chrome.rzltAccent,
    },
    rzltCoverageRamp: data.rzltCoverageRamp,
    rzltPublic: data.rzltPublic,
    rzltPrivate: data.rzltPrivate,
    basemap: data.basemap,
  };
}

// Cached per theme and rebuilt whenever the theme changes, so getComputedStyle
// runs once per change rather than on every token lookup.
let cache = null;

export function tokens() {
  if (!cache) cache = buildTokens();
  return cache;
}

export function onSchemeChange(handler) {
  schemeHandlers.push(handler);
}

function notifySchemeChange() {
  // The theme has changed; drop the cache so the next tokens() call re-reads
  // the chrome colours for the new theme before handlers render.
  cache = null;
  for (const handler of schemeHandlers) handler();
}

export function toggleTheme() {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  window.localStorage.setItem("theme", next);
  notifySchemeChange();
}

// Follow the operating system until the visitor makes an explicit choice.
darkQuery.addEventListener("change", (event) => {
  if (window.localStorage.getItem("theme")) return;
  document.documentElement.dataset.theme = event.matches ? "dark" : "light";
  notifySchemeChange();
});

// The RZLT generalised zoning classes present in Dublin City's vacant/idle
// parcels, in fixed legend order. Labels paraphrase the national RZLT
// zoning typology.
export const RZLT_ZONES = [
  { code: "M1", label: "Mixed use, general" },
  { code: "M2", label: "City centre, central area" },
  { code: "M3", label: "Neighbourhood or urban village centre" },
  { code: "R3", label: "Strategic regeneration area" },
];

// Bin edges (in whole years on the register) for the ordinal ramp.
export const YEAR_BINS = [
  { max: 2, label: "Under 2 years" },
  { max: 5, label: "2 to 5 years" },
  { max: 10, label: "5 to 10 years" },
  { max: Infinity, label: "10 years or more" },
];

export function yearBinIndex(years) {
  return YEAR_BINS.findIndex((bin) => years < bin.max);
}
