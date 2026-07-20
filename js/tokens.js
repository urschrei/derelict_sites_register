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
  basemap: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
};

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function isDark() {
  return darkQuery.matches;
}

export function tokens() {
  return isDark() ? DARK : LIGHT;
}

export function onSchemeChange(handler) {
  darkQuery.addEventListener("change", handler);
}

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
