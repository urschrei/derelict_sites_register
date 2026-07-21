// Colour tokens for chart and map code, mirroring css/style.css.
// The ordinal ramp encodes years on the register and was validated for both
// modes (single hue, monotone lightness, visible step gaps, surface contrast).

const LIGHT = {
  surface: "#fcfcfb",
  page: "#f9f9f7",
  textPrimary: "#0b0b0b",
  textSecondary: "#52514e",
  textMuted: "#898781",
  gridline: "#e1e0d9",
  baseline: "#c3c2b7",
  series1: "#2a78d6",
  seriesDim: "#d5d4cd",
  ramp: ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"],
  hexRamp: ["#cde2fb", "#3987e5", "#0d366b"],
  caseRamp: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
  // The vacant sites are a separate register, so they read in a warm accent
  // that sits apart from the blue time-on-register ramp.
  vacantFill: "#e07b2f",
  vacantLine: "#b5540f",
  // Categorical hues for the RZLT generalised zoning classes, validated for
  // adjacent-pair CVD separation and surface contrast in legend order.
  rzltColours: {
    M1: "#6b46a8",
    M2: "#e06377",
    M3: "#8a6d00",
    R3: "#1b9e77",
  },
  basemap: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
};

const DARK = {
  surface: "#1a1a19",
  page: "#0d0d0d",
  textPrimary: "#ffffff",
  textSecondary: "#c3c2b7",
  textMuted: "#898781",
  gridline: "#2c2c2a",
  baseline: "#383835",
  series1: "#3987e5",
  seriesDim: "#3a3a38",
  ramp: ["#9ec5f4", "#5598e7", "#2a78d6", "#184f95"],
  hexRamp: ["#184f95", "#5598e7", "#cde2fb"],
  // Viridis is perceptually uniform and works on both surfaces, so the
  // caseload ramp is mode-invariant.
  caseRamp: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
  vacantFill: "#e8823c",
  vacantLine: "#f6a866",
  rzltColours: {
    M1: "#9d7ad8",
    M2: "#d9647f",
    M3: "#9c8427",
    R3: "#2fa88f",
  },
  basemap: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
};

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const schemeHandlers = [];

// The active theme is whatever the inline head script (or the toggle) stamped
// on <html>; tokens() and the map/chart palettes follow it.
export function isDark() {
  return document.documentElement.dataset.theme === "dark";
}

export function tokens() {
  return isDark() ? DARK : LIGHT;
}

export function onSchemeChange(handler) {
  schemeHandlers.push(handler);
}

function notifySchemeChange() {
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
