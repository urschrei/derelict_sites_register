// The register table: sortable columns, keyboard-focusable rows, row click
// locates the site on the map.

const COLUMNS = [
  {
    key: "ref",
    label: "Reference",
    value: (p) => p.derelict_site_reference_number ?? "",
    cellClass: "cell-ref",
  },
  {
    key: "address",
    label: "Address",
    value: (p) => p.full_address ?? "",
  },
  {
    key: "area",
    label: "Area",
    value: (p) => p.administrative_area_name ?? "",
  },
  {
    key: "protected",
    label: "Protected structure",
    value: (p) => p.is_on_current_record_of_protected_structures ?? "No",
    flag: true,
  },
  {
    key: "council",
    label: "Council-owned",
    value: (p) => p.is_owned_by_dublin_city_council ?? "No",
    flag: true,
  },
  {
    key: "added",
    label: "Added",
    value: (p) => p.date_added_to_the_derelict_sites_register ?? "",
    numeric: true,
  },
  {
    key: "years",
    label: "Years on register",
    value: (p) => p.years_on_register,
    format: (v) => (v === null ? "–" : v.toFixed(1)),
    numeric: true,
  },
];

const sortState = { key: "added", dir: -1 };

function compareBy(column) {
  return (a, b) => {
    const va = column.value(a.properties);
    const vb = column.value(b.properties);
    if (va === null || va === "") return 1;
    if (vb === null || vb === "") return -1;
    if (typeof va === "number") return (va - vb) * sortState.dir;
    return String(va).localeCompare(String(vb)) * sortState.dir;
  };
}

export function renderTable(features, onRowSelect) {
  const table = document.getElementById("register-table");
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");

  const headRow = document.createElement("tr");
  for (const column of COLUMNS) {
    const th = document.createElement("th");
    th.scope = "col";
    if (column.numeric) th.classList.add("col-num");
    const active = sortState.key === column.key;
    th.setAttribute(
      "aria-sort",
      active ? (sortState.dir === 1 ? "ascending" : "descending") : "none"
    );
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = column.label;
    if (active) {
      const arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = sortState.dir === 1 ? "▲" : "▼";
      button.append(arrow);
    }
    button.addEventListener("click", () => {
      if (sortState.key === column.key) {
        sortState.dir *= -1;
      } else {
        sortState.key = column.key;
        sortState.dir = column.numeric ? -1 : 1;
      }
      renderTable(features, onRowSelect);
    });
    th.append(button);
    headRow.append(th);
  }
  thead.replaceChildren(headRow);

  const column = COLUMNS.find((c) => c.key === sortState.key);
  const sorted = [...features].sort(compareBy(column));

  const rows = sorted.map((feature) => {
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    for (const col of COLUMNS) {
      const td = document.createElement("td");
      const raw = col.value(feature.properties);
      const text = col.format ? col.format(raw) : String(raw);
      td.textContent = col.flag && text === "No" ? "–" : text;
      if (col.cellClass) td.classList.add(col.cellClass);
      if (col.numeric) td.classList.add("col-num");
      if (col.flag) {
        td.classList.add("cell-flag");
        if (text === "Yes") td.classList.add("is-yes");
      }
      tr.append(td);
    }
    const select = () => onRowSelect(feature);
    tr.addEventListener("click", select);
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select();
      }
    });
    return tr;
  });
  tbody.replaceChildren(...rows);
}
