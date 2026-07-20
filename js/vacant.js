// The Vacant Sites Register view: a selectable list of sites, the polygon
// map (shared with the derelict view, driven through map.js), and a detail
// panel showing ownership, valuation, and planning history newest first.

import { setVacantData, focusVacantSite, onVacantSelect } from "./map.js";

const EURO = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

let features = [];

function isCouncilOwned(p) {
  return (
    /dublin city council/i.test(p.ownership ?? "") ||
    /\bDCC\b/.test(p.register_status ?? "")
  );
}

export function loadVacant() {
  return fetch("data/vacant_sites_register.geojson")
    .then((response) => (response.ok ? response.json() : null))
    .then((collection) => {
      if (!collection) return;
      features = collection.features
        .slice()
        .sort((a, b) =>
          (a.properties.address ?? "").localeCompare(b.properties.address ?? "")
        );
      setVacantData(collection);
      onVacantSelect(selectSite);
      renderKpis();
      buildList();
      // Start with the first site shown so the panel is never an empty box.
      if (features.length) {
        selectSite(features[0].properties.register_number, { zoom: false });
      }
    });
}

function renderKpis() {
  const props = features.map((f) => f.properties);
  const set = (id, value) => {
    document.getElementById(id).textContent = value;
  };
  set("vkpi-count", String(features.length));
  set("vkpi-count-note", "on the Vacant Sites Register");

  const hectares = features.reduce((sum, f) => sum + turf.area(f), 0) / 10000;
  set("vkpi-area", `${hectares.toFixed(1)} ha`);

  const valuations = props.map((p) => p.valuation ?? 0);
  set("vkpi-valuation", EURO.format(valuations.reduce((a, b) => a + b, 0)));
  const valued = valuations.filter((v) => v > 0).length;
  set("vkpi-valuation-note", `${valued} of ${features.length} sites valued`);

  set("vkpi-council", String(props.filter(isCouncilOwned).length));
  set(
    "vkpi-apps",
    String(props.reduce((sum, p) => sum + (p.linked_planning_ref_count ?? 0), 0))
  );
}

function buildList() {
  const list = document.getElementById("vacant-list");
  list.replaceChildren();
  for (const feature of features) {
    const p = feature.properties;
    const item = document.createElement("li");
    item.className = "vacant-list-item";
    item.tabIndex = 0;
    item.setAttribute("role", "option");
    item.dataset.reg = p.register_number;

    const ref = document.createElement("span");
    ref.className = "vacant-list-ref";
    ref.textContent = p.register_number;
    const addr = document.createElement("span");
    addr.className = "vacant-list-addr";
    addr.textContent = p.address ?? "";
    item.append(ref, addr);

    item.addEventListener("click", () => selectSite(p.register_number));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectSite(p.register_number);
      }
    });
    list.append(item);
  }
}

export function selectSite(registerNumber, { zoom = true } = {}) {
  const feature = features.find(
    (f) => f.properties.register_number === registerNumber
  );
  if (!feature) return;
  for (const item of document.querySelectorAll(".vacant-list-item")) {
    const on = item.dataset.reg === registerNumber;
    item.classList.toggle("is-selected", on);
    item.setAttribute("aria-selected", on ? "true" : "false");
    if (on && zoom) item.scrollIntoView({ block: "nearest" });
  }
  focusVacantSite(registerNumber, { zoom });
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

function planningItem(app) {
  const item = document.createElement("li");
  item.className = "vp-item";

  const head = document.createElement("div");
  head.className = "vp-head";
  const badge = document.createElement("span");
  badge.className = `vp-badge vp-${(app.outcome ?? "other").toLowerCase()}`;
  badge.textContent = app.outcome ?? "—";
  const date = document.createElement("span");
  date.className = "vp-date";
  date.textContent = app.registration_date ?? "";
  const type = document.createElement("span");
  type.className = "vp-type";
  type.textContent = app.app_type ?? "";
  head.append(badge, date, type);

  const proposal = document.createElement("p");
  proposal.className = "vp-proposal";
  proposal.textContent = app.proposal ?? "";

  const link = document.createElement("a");
  link.className = "vp-link";
  link.href = app.planning_portal_url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = `${app.plan_ref} · documents`;

  item.append(head, proposal, link);
  return item;
}

function renderDetail(feature) {
  const p = feature.properties;
  const panel = document.getElementById("vacant-detail");
  panel.replaceChildren();

  const head = document.createElement("div");
  head.className = "vacant-detail-head";
  const ref = document.createElement("span");
  ref.className = "vacant-detail-ref";
  ref.textContent = p.register_number;
  const addr = document.createElement("h2");
  addr.className = "vacant-detail-addr";
  addr.textContent = p.address ?? "";
  head.append(ref, addr);
  panel.append(head);

  const facts = document.createElement("dl");
  facts.className = "vacant-facts";
  if (p.register_status) facts.append(fact("Status", p.register_status));
  if (p.ownership) facts.append(fact("Owner", p.ownership));
  if (p.owner_address) facts.append(fact("Owner address", p.owner_address));
  if (p.valuation > 0) {
    facts.append(fact("Market valuation", EURO.format(p.valuation)));
  }
  if (p.folio_reference) facts.append(fact("Folio", p.folio_reference));
  if (p.date_registered) facts.append(fact("Registered", p.date_registered));
  facts.append(fact("Site area", `${(turf.area(feature) / 10000).toFixed(2)} ha`));
  panel.append(facts);

  const apps = p.planning_applications ?? [];
  const heading = document.createElement("h3");
  heading.className = "vacant-planning-title";
  heading.textContent = `Planning history (${apps.length})`;
  panel.append(heading);

  const note = document.createElement("p");
  note.className = "vacant-planning-note";
  const confirmed = apps.length > 0 && apps.every((a) => a.council_confirmed);
  note.textContent = confirmed
    ? "Applications are linked to this site where the council's mapped footprints overlap and its own related-applications record connects them."
    : "This site has no strongly-overlapping application to confirm the link, so these applications are matched by map location alone and may be less precise.";
  panel.append(note);

  if (apps.length) {
    const ol = document.createElement("ol");
    ol.className = "vp-list";
    for (const app of apps) ol.append(planningItem(app));
    panel.append(ol);
  }
}
