// D3-based charts: a horizontal bar chart and a column chart, each with
// hover/focus tooltips and a data-table twin. D3 is loaded globally as `d3`.

import { tokens } from "./tokens.js";

const tooltip = d3.select("#viz-tooltip");

function showTooltip(event, value, label) {
  tooltip.selectAll("*").remove();
  tooltip.append("div").attr("class", "tip-value").text(value);
  tooltip.append("div").attr("class", "tip-label").text(label);
  tooltip.node().hidden = false;
  positionTooltip(event);
}

function positionTooltip(event) {
  const pad = 12;
  const rect = tooltip.node().getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + rect.width > window.innerWidth - pad) {
    x = event.clientX - rect.width - pad;
  }
  if (y + rect.height > window.innerHeight - pad) {
    y = event.clientY - rect.height - pad;
  }
  tooltip.style("left", `${x}px`).style("top", `${y}px`);
}

export function hideTooltip() {
  tooltip.node().hidden = true;
}

function attachTooltip(selection, valueOf, labelOf) {
  selection
    .on("pointermove", (event, d) => showTooltip(event, valueOf(d), labelOf(d)))
    .on("pointerleave", hideTooltip)
    .on("focus", (event, d) => {
      const rect = event.target.getBoundingClientRect();
      showTooltip(
        { clientX: rect.left + rect.width / 2, clientY: rect.top },
        valueOf(d),
        labelOf(d)
      );
    })
    .on("blur", hideTooltip);
}

// Rounded at the data end only, square at the baseline.
function roundedRightRect(x, y, w, h, r) {
  const rr = Math.min(r, w, h / 2);
  return `M ${x} ${y} H ${x + w - rr} Q ${x + w} ${y} ${x + w} ${y + rr} V ${y + h - rr} Q ${x + w} ${y + h} ${x + w - rr} ${y + h} H ${x} Z`;
}

function roundedTopRect(x, y, w, h, r) {
  const rr = Math.min(r, h, w / 2);
  return `M ${x} ${y + h} V ${y + rr} Q ${x} ${y} ${x + rr} ${y} H ${x + w - rr} Q ${x + w} ${y} ${x + w} ${y + rr} V ${y + h} Z`;
}

// Horizontal bars: one row per category, value label at the bar tip.
// opts.emphasis: when set, only that category keeps the accent hue and the
// rest drop to the de-emphasis gray (colour follows the entity, not rank).
export function renderBarChartH(container, rows, opts = {}) {
  const t = tokens();
  const width = Math.max(container.clientWidth, 260);
  const rowH = 30;
  const barH = 18;
  const labelW = Math.min(120, width * 0.35);
  const valueW = 34;
  const padTop = 4;
  const height = rows.length * rowH + padTop * 2;
  const maxValue = d3.max(rows, (d) => d.value) || 1;

  const x = d3
    .scaleLinear()
    .domain([0, maxValue])
    .range([0, width - labelW - valueW]);
  const y = d3
    .scaleBand()
    .domain(rows.map((d) => d.label))
    .range([padTop, padTop + rows.length * rowH]);

  const svg = d3
    .create("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", width)
    .attr("height", height)
    .attr("role", "img")
    .attr("aria-label", opts.ariaLabel ?? "Bar chart");

  const row = svg
    .selectAll("g.row")
    .data(rows)
    .join("g")
    .attr("class", "row");

  row
    .append("text")
    .attr("x", labelW - 8)
    .attr("y", (d) => y(d.label) + rowH / 2)
    .attr("text-anchor", "end")
    .attr("dominant-baseline", "central")
    .attr("fill", t.textSecondary)
    .attr("font-size", 12)
    .text((d) => d.label);

  const hits = row
    .append("rect")
    .attr("class", "bar-hit")
    .attr("x", 0)
    .attr("y", (d) => y(d.label))
    .attr("width", width)
    .attr("height", rowH)
    .attr("tabindex", 0)
    .attr("role", "img")
    .attr("aria-label", (d) => `${d.label}: ${d.value}`);
  attachTooltip(hits, (d) => `${d.value} sites`, (d) => d.label);

  row
    .append("path")
    .attr("class", "bar-mark")
    .attr("pointer-events", "none")
    .attr("d", (d) =>
      roundedRightRect(labelW, y(d.label) + (rowH - barH) / 2, x(d.value), barH, 4)
    )
    .attr("fill", (d) =>
      opts.emphasis && d.label !== opts.emphasis ? t.seriesDim : t.series1
    );

  row
    .filter((d) => d.value > 0)
    .append("text")
    .attr("x", (d) => labelW + x(d.value) + 6)
    .attr("y", (d) => y(d.label) + rowH / 2)
    .attr("dominant-baseline", "central")
    .attr("fill", t.textPrimary)
    .attr("font-size", 12)
    .attr("font-weight", 600)
    .text((d) => d.value);

  container.replaceChildren(svg.node());
}

// Columns over an ordered axis (years, distance bins). Values live in the
// tooltip and the y-axis ticks, not on every column.
export function renderColumnChart(container, rows, opts = {}) {
  const t = tokens();
  const width = Math.max(container.clientWidth, 260);
  const plotH = 160;
  const axisBand = 22;
  const padTop = 8;
  const yAxisW = 26;
  const height = padTop + plotH + axisBand;
  const maxValue = d3.max(rows, (d) => d.value) || 1;
  const labelEvery = opts.labelEvery ?? 1;

  const y = d3
    .scaleLinear()
    .domain([0, maxValue])
    .nice(4)
    .range([padTop + plotH, padTop]);
  const x = d3
    .scaleBand()
    .domain(rows.map((d) => d.label))
    .range([yAxisW, width - 4])
    .paddingInner(0);
  const barW = Math.min(Math.max(x.bandwidth() - 2, 2), 24);

  const svg = d3
    .create("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", width)
    .attr("height", height)
    .attr("role", "img")
    .attr("aria-label", opts.ariaLabel ?? "Column chart");

  const ticks = y.ticks(4);
  const grid = svg.selectAll("g.tick").data(ticks).join("g");
  grid
    .append("line")
    .attr("x1", yAxisW)
    .attr("x2", width)
    .attr("y1", (d) => y(d))
    .attr("y2", (d) => y(d))
    .attr("stroke", (d) => (d === 0 ? t.baseline : t.gridline))
    .attr("stroke-width", 1);
  grid
    .append("text")
    .attr("x", yAxisW - 6)
    .attr("y", (d) => y(d))
    .attr("text-anchor", "end")
    .attr("dominant-baseline", "central")
    .attr("fill", t.textMuted)
    .attr("font-size", 11)
    .text((d) => d);

  const col = svg
    .selectAll("g.col")
    .data(rows)
    .join("g")
    .attr("class", "col");

  const hits = col
    .append("rect")
    .attr("class", "bar-hit")
    .attr("x", (d) => x(d.label))
    .attr("y", padTop)
    .attr("width", x.bandwidth())
    .attr("height", plotH + axisBand)
    .attr("tabindex", 0)
    .attr("role", "img")
    .attr("aria-label", (d) => `${d.label}: ${d.value}`);
  attachTooltip(hits, (d) => `${d.value} sites`, (d) => d.label);

  col
    .filter((d) => d.value > 0)
    .append("path")
    .attr("class", "bar-mark")
    .attr("pointer-events", "none")
    .attr("d", (d) => {
      const barX = x(d.label) + (x.bandwidth() - barW) / 2;
      const h = y(0) - y(d.value);
      return roundedTopRect(barX, y(d.value), barW, h, 4);
    })
    .attr("fill", t.series1);

  svg
    .selectAll("text.x-label")
    .data(rows.filter((_, i) => i % labelEvery === 0))
    .join("text")
    .attr("class", "x-label")
    .attr("x", (d) => x(d.label) + x.bandwidth() / 2)
    .attr("y", padTop + plotH + 15)
    .attr("text-anchor", "middle")
    .attr("fill", t.textMuted)
    .attr("font-size", 10.5)
    .text((d) => (opts.shortLabel ? opts.shortLabel(d.label) : d.label));

  container.replaceChildren(svg.node());
}

// The WCAG-clean twin: a small table with the same aggregates as the chart.
export function renderDataTable(container, rows, columns) {
  const table = d3.create("table");
  table
    .append("thead")
    .append("tr")
    .selectAll("th")
    .data(columns)
    .join("th")
    .attr("scope", "col")
    .text((d) => d);
  table
    .append("tbody")
    .selectAll("tr")
    .data(rows)
    .join("tr")
    .selectAll("td")
    .data((d) => [d.label, String(d.value)])
    .join("td")
    .text((d) => d);
  container.replaceChildren(table.node());
}
