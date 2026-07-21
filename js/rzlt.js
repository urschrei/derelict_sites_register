// The Vacant / Idle (RZLT) view: Dublin City parcels from the Residential
// Zoned Land Tax final map whose inclusion required a vacant-or-idle
// determination, as a selectable list, the shared polygon map, and a detail
// panel. Parcels that continue a site from the historical Vacant Sites
// Register carry its register number.

import { setRzltData, focusRzltParcel, onRzltSelect } from "./map.js";
import { RZLT_ZONES } from "./tokens.js";
import { selectSite as selectVacantSite, planningItem } from "./vacant.js";

const EURO = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

let features = [];

function zoneLabel(code) {
  return RZLT_ZONES.find((zone) => zone.code === code)?.label ?? code;
}

// Header-line figures: parcel count and the vintage of the newest additions.
export function rzltMeta() {
  if (!features.length) return null;
  const latest = features
    .map((f) => f.properties.date_added)
    .filter(Boolean)
    .sort()
    .at(-1);
  return { count: features.length, latest };
}

export function loadRzlt() {
  // Prefer the enriched parcels (planning, ownership, valuation, buildings);
  // fall back to the plain register if the weekly enrichment has not run.
  return fetch("data/rzlt_sites_enriched.geojson")
    .then((response) =>
      response.ok ? response : fetch("data/rzlt_sites.geojson")
    )
    .then((response) => (response.ok ? response.json() : null))
    .then((collection) => {
      if (!collection) return;
      // Newest additions to the map first; ties break on parcel id.
      features = collection.features
        .slice()
        .sort(
          (a, b) =>
            (b.properties.date_added ?? "").localeCompare(
              a.properties.date_added ?? ""
            ) ||
            a.properties.parcel_id.localeCompare(b.properties.parcel_id)
        );
      setRzltData(collection);
      onRzltSelect(selectParcel);
      renderKpis();
      buildList();
      // Start with the first parcel shown so the panel is never an empty box.
      if (features.length) {
        selectParcel(features[0].properties.parcel_id, { zoom: false });
      }
    });
}

function renderKpis() {
  const props = features.map((f) => f.properties);
  const set = (id, value) => {
    document.getElementById(id).textContent = value;
  };
  set("rkpi-count", String(features.length));

  const hectares = props.reduce((sum, p) => sum + (p.site_area_ha ?? 0), 0);
  set("rkpi-area", `${hectares.toFixed(1)} ha`);

  const former = props.filter((p) => p.former_vacant_sites).length;
  set("rkpi-former", String(former));

  // The remaining two tiles depend on enrichment fields; when the plain
  // register is loaded they fall back to the additions count.
  const hasEnrichment = props.some((p) => p.bld_coverage !== undefined);
  const publicTile = document.getElementById("rkpi-public");
  if (hasEnrichment) {
    const publicOwned = props.filter((p) => p.own_is_public).length;
    set("rkpi-public", String(publicOwned));
    document.getElementById("rkpi-public-note").textContent =
      "in state or council ownership";
    const undeveloped = props.filter(
      (p) => (p.bld_coverage ?? 1) < 0.1
    ).length;
    set("rkpi-new", String(undeveloped));
    document.getElementById("rkpi-new-note").textContent =
      "under 10% building coverage";
  } else {
    const added = props.filter((p) => p.date_added >= "2024-01-01").length;
    set("rkpi-new", String(added));
    if (publicTile) publicTile.textContent = "–";
  }
}

function buildList() {
  const list = document.getElementById("rzlt-list");
  list.replaceChildren();
  for (const feature of features) {
    const p = feature.properties;
    const item = document.createElement("li");
    item.className = "vacant-list-item";
    item.tabIndex = 0;
    item.setAttribute("role", "option");
    item.dataset.parcel = p.parcel_id;

    const ref = document.createElement("span");
    ref.className = "vacant-list-ref";
    ref.textContent = p.parcel_id;
    const addr = document.createElement("span");
    addr.className = "vacant-list-addr";
    const area = p.site_area_ha != null ? ` · ${p.site_area_ha.toFixed(2)} ha` : "";
    addr.textContent = `${zoneLabel(p.zone_gzt)}${area}`;
    item.append(ref, addr);

    item.addEventListener("click", () => selectParcel(p.parcel_id));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectParcel(p.parcel_id);
      }
    });
    list.append(item);
  }
}

export function selectParcel(parcelId, { zoom = true } = {}) {
  const feature = features.find((f) => f.properties.parcel_id === parcelId);
  if (!feature) return;
  for (const item of document.querySelectorAll("#rzlt-list .vacant-list-item")) {
    const on = item.dataset.parcel === parcelId;
    item.classList.toggle("is-selected", on);
    item.setAttribute("aria-selected", on ? "true" : "false");
    if (on && zoom) item.scrollIntoView({ block: "nearest" });
  }
  focusRzltParcel(parcelId, { zoom });
  renderDetail(feature);
}

function fact(label, value) {
  const row = document.createElement("div");
  row.className = "vacant-fact";
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  row.append(dt, dd);
  return row;
}

// A jargon term with a hover/focus definition. <abbr> for true abbreviations
// (NAV); a defined-term <span> for plain terms (Rateable properties). Both
// carry the title tooltip and the dotted-underline styling.
function term(text, definition, { abbreviation = false } = {}) {
  const el = document.createElement(abbreviation ? "abbr" : "span");
  el.className = "has-def";
  el.title = definition;
  el.textContent = text;
  return el;
}

// Like fact(), but the label and value may be DOM nodes so definitions can be
// embedded inline.
function factNodes(label, value) {
  const row = document.createElement("div");
  row.className = "vacant-fact";
  const dt = document.createElement("dt");
  dt.append(label);
  const dd = document.createElement("dd");
  dd.append(value);
  row.append(dt, dd);
  return row;
}

function renderDetail(feature) {
  const p = feature.properties;
  const panel = document.getElementById("rzlt-detail");
  panel.replaceChildren();

  const head = document.createElement("div");
  head.className = "vacant-detail-head";
  const ref = document.createElement("span");
  ref.className = "vacant-detail-ref";
  ref.textContent = p.parcel_id;
  const title = document.createElement("h2");
  title.className = "vacant-detail-addr";
  title.textContent = zoneLabel(p.zone_gzt);
  head.append(ref, title);
  panel.append(head);

  const facts = document.createElement("dl");
  facts.className = "vacant-facts";
  if (p.zone_orig) facts.append(fact("Development plan zoning", p.zone_orig));
  if (p.site_area_ha != null) {
    facts.append(fact("Site area", `${p.site_area_ha.toFixed(2)} ha`));
  }
  if (p.date_added) facts.append(fact("On the RZLT map since", p.date_added));

  // Enrichment facts, present only when the enriched dataset is loaded.
  const enriched = p.bld_coverage !== undefined;
  if (enriched) {
    facts.append(
      fact("Building coverage", `${Math.round((p.bld_coverage ?? 0) * 100)}%`)
    );
    if (p.own_is_public) {
      facts.append(fact("Ownership", p.own_bodies ?? "State or council"));
    }
    if (p.own_folios) facts.append(fact("Folio", p.own_folios));
    if (p.plan_live_permission) {
      facts.append(fact("Live permission", "Yes"));
    }
    if (p.val_n_props) {
      const label = term(
        "Rateable properties",
        "Commercial properties on Tailte Éireann's valuation list, liable " +
          "for commercial rates. Residential property is not rated and does " +
          "not appear here."
      );
      const value = document.createElement("span");
      value.append(String(p.val_n_props));
      if (p.val_total_nav != null) {
        value.append(` (${EURO.format(p.val_total_nav)} total `);
        value.append(
          term(
            "NAV",
            "Net annual value: the estimated open-market yearly rent of a " +
              "property, which commercial rates are charged on.",
            { abbreviation: true }
          )
        );
        value.append(")");
      }
      facts.append(factNodes(label, value));
    }
  }
  panel.append(facts);

  // Planning history: the same status-badge list the vacant register uses,
  // newest first, linking to the council's planning portal.
  const apps = enriched ? (p.planning_applications ?? []) : [];
  if (enriched) {
    const heading = document.createElement("h3");
    heading.className = "vacant-planning-title";
    const granted = p.plan_n_granted_10yr ?? 0;
    heading.textContent =
      `Planning history (${apps.length}` +
      (apps.length ? `, ${granted} granted` : "") +
      ")";
    panel.append(heading);

    const note = document.createElement("p");
    note.className = "vacant-planning-note";
    note.textContent = apps.length
      ? "Applications whose mapped footprint overlaps this parcel, over the " +
        "last ten years. The parcel is not the application boundary, so some " +
        "may relate to adjacent land."
      : "No planning applications overlap this parcel in the last ten years.";
    panel.append(note);

    if (apps.length) {
      const ol = document.createElement("ol");
      ol.className = "vp-list";
      for (const app of apps) ol.append(planningItem(app));
      panel.append(ol);
    }
  }

  if (p.zone_desc) {
    const desc = document.createElement("p");
    desc.className = "vacant-planning-note";
    desc.textContent = `Zoning objective: ${p.zone_desc}`;
    panel.append(desc);
  }

  // Parcels seeded from the Vacant Sites Register link back to the
  // historical register entry, which carries ownership and valuation.
  if (p.former_vacant_sites) {
    const wrap = document.createElement("p");
    wrap.className = "vacant-planning-note";
    wrap.append("Continues ");
    const registers = p.former_vacant_sites.split("; ");
    registers.forEach((reg, i) => {
      if (i > 0) wrap.append(", ");
      const link = document.createElement("a");
      link.href = "#";
      link.textContent = reg;
      link.addEventListener("click", (e) => {
        e.preventDefault();
        document.querySelector('input[name="view"][value="vacant"]').click();
        selectVacantSite(reg);
      });
      wrap.append(link);
    });
    wrap.append(
      registers.length > 1
        ? " from the historical Vacant Sites Register; the register entries record ownership and valuation."
        : " from the historical Vacant Sites Register; the register entry records ownership and valuation."
    );
    panel.append(wrap);
  }

  const note = document.createElement("p");
  note.className = "vacant-planning-note";
  note.textContent = enriched
    ? "The RZLT map itself carries only the boundary and zoning; planning, " +
      "ownership, valuation, and building-coverage figures are joined from " +
      "separate open datasets and may not align exactly with the parcel."
    : "RZLT parcels are published without addresses, ownership, or " +
      "valuations; the mapped boundary and zoning are the authoritative record.";
  panel.append(note);
}
