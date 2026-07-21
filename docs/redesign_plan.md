# Visual redesign plan: Tailwind and HTMX

A plan for a visual redesign of the site, written for handoff to an
implementing agent. Read the whole document before writing code; the
"Do not break" section is a hard contract.

## 1. What the site is

A fully static single page (`index.html`) served directly from this
repository by GitHub Pages. There is no server and no build step for the
site itself: GitHub Actions (`refresh-data.yml`, `enrich-rzlt.yml`) refresh
the data files twice daily and push; the page fetches GeoJSON/JSON and
renders everything client-side with vanilla ES modules:

- `js/main.js` — bootstrapping, view switching, filters, KPIs, changelog
- `js/map.js` — MapLibre GL map, layers, legends, popups
- `js/charts.js` / `js/analysis.js` / `js/spatial.js` — D3 charts and stats
- `js/table.js` — sortable register table
- `js/vacant.js` / `js/rzlt.js` — list + detail panels for the two
  polygon registers
- `js/tokens.js` — hard-coded light/dark colour tokens mirroring
  `css/style.css`, consumed by map and chart code

Three registers share the page, switched by a radio group that stamps
`view-vacant` / `view-rzlt` classes on `<body>`; sections carry
`derelict-only` / `vacant-only` / `rzlt-only` visibility classes. Each
register has an accent hue: derelict blue (`--series-1`), vacant burnt
orange (`--vacant-accent`), RZLT teal (`--rzlt-accent`).

Non-obvious constraints:

- **Embed mode**: `?embed` strips the page down to the map
  (`body.embed` rules). `scripts/social_preview.cjs` screenshots the dark
  embed view at 1280 x 640 to produce `assets/social-preview.png`, which
  must be regenerated after the redesign and manually re-uploaded in the
  GitHub repository settings (Pages does not pick it up from the repo).
- **Theming**: an inline head script stamps `data-theme` on `<html>`
  before first paint; `tokens.js` and the toggle keep it in sync. Keep
  this mechanism exactly as is.
- **Validated data palettes**: the ordinal time-on-register ramp, the
  viridis caseload ramp, the RZLT zoning hues, and the coverage ramp were
  validated for CVD separation and surface contrast in both themes (see
  comments in `js/tokens.js`). **Do not change any data-encoding colour.**
  The redesign is typography, layout, hierarchy, and chrome.
- **Accessibility**: the page has deliberate a11y work — `role="status"`
  live regions, `aria-live` detail panels, visually-hidden radio inputs
  with `:has()` styling, focus-visible outlines, `role="listbox"` lists,
  a hidden table caption. Preserve all of it.

## 2. Stack decisions

### 2.1 Tailwind

Use Tailwind CSS v4 with the CSS-first configuration (no
`tailwind.config.js`).

- Add a minimal `package.json` with `tailwindcss` and `@tailwindcss/cli`
  as dev dependencies and a script:
  `"build:css": "tailwindcss -i css/style.src.css -o css/style.css --minify"`.
  Add `node_modules/` to `.gitignore`.
- `css/style.src.css` is the new source of truth. It begins:

  ```css
  @import "tailwindcss";

  @custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

  @theme {
    --color-page: #f9f9f7;
    --color-surface: #fcfcfb;
    /* ... map the existing custom properties into theme tokens ... */
    --font-display: "Barlow Semi Condensed", "Arial Narrow", sans-serif;
    --font-body: "Public Sans", system-ui, sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, monospace;
  }
  ```

- The **compiled `css/style.css` is committed** — GitHub Pages serves the
  branch directly and the data-refresh workflows must not need Node. The
  `index.html` stylesheet link is unchanged. Run `npm run build:css`
  before every commit that touches styles.
- Migration strategy — this is the important part. Roughly thirty
  component classes are assigned from JavaScript (`vacant-list-item`,
  `vp-badge`, `sort-arrow`, popup and legend classes, and so on), and
  MapLibre's own DOM needs `.maplibregl-*` overrides. Do **not** rewrite
  the JS to emit utility strings. The split is:
  - **Utilities in `index.html`** for static layout: masthead, grids,
    spacing, the download rows, section scaffolding.
  - **Component classes in `@layer components`** (plain CSS, `@apply`
    where it helps) for everything JS-generated, MapLibre overrides, the
    embed-mode block, and the view-switch visibility rules.
  - Keep the semantic custom properties (`--ink`, register accents,
    text/surface roles) as CSS variables in `@layer base` so both
    utilities (via `@theme`) and component CSS reference one source.
- Keep the visibility classes (`derelict-only` etc.) and `body.view-*` /
  `body.embed` rules as hand-written CSS; they are behavioural, not
  visual.

### 2.2 HTMX — flagged

HTMX is requested, but this site gives it almost nothing to do, and that
should be understood before implementation. HTMX expresses
"event → HTTP request → swap HTML fragment". This site has no server, and
its interactivity — client-side filtering of in-memory GeoJSON, MapLibre
layers, D3 charts, sorting — cannot be expressed as fragment swaps.
Converting any of that to HTMX would mean pre-rendering fragments we
already render perfectly well, with no UX gain.

There is exactly one honest hypermedia niche here: **build-time
pre-rendered fragments served as static files**.

1. **Changelog**: `update_changelog.py` additionally emits
   `data/changelog.html`; the section becomes
   `<div hx-get="data/changelog.html" hx-trigger="load" hx-swap="innerHTML">`,
   deleting the changelog-rendering JS.
2. **Vacant and RZLT detail panels**: the refresh scripts emit one
   fragment per site (`data/fragments/vacant/<ref>.html`,
   `data/fragments/rzlt/<ref>.html`). List items become `hx-get` triggers
   targeting the detail panel; map clicks call `htmx.ajax()`. This
   deletes most of the DOM-building in `vacant.js` / `rzlt.js` and makes
   each site's record a crawlable static file.

Costs: a new rendering step in the Python refresh pipeline, formatting
logic duplicated between Python (fragments) and JS (map popups), and a
few hundred small HTML files churning in git twice daily.

**Recommendation**: implement the redesign without HTMX (phases 1 to 8),
and treat the fragment work as an optional final phase gated on explicit
user approval. If the user wants HTMX in the shipped result regardless,
the changelog fragment (item 1) is the cheapest defensible use; start
there.

## 3. Design direction

### 3.1 Concept: the register, made legible

The subject is three statutory registers of neglected Dublin land; the
audience is journalists, planners, activists, and curious residents; the
page's one job is to show where the land is and how long it has been left.
The design language comes from the registers' own world: the statutory
ledger with its stamped reference numbers (DS576, VS-103), civic signage,
and the cadastral map. Paper-and-ink neutrals (already present), signage
typography, monospace reference numbers, and one signature device:

**Signature — register re-inking.** Each register already owns a validated
hue. Promote it from a subtle left-edge bar to the page's ink: a single
`--ink` custom property set by the existing `body.view-*` classes
(default: derelict blue; `view-vacant`: burnt orange; `view-rzlt`: teal).
Tabs, selected states, section rules, KPI figures, list selection bars,
and the locate button all reference `--ink`, so switching register
visibly re-inks the interface. This encodes information (which register
am I looking at?) rather than decorating, and costs one CSS variable.
Focus outlines stay `--focus` (constant blue) in both themes for
predictability.

Restraint rules: no gradients, no shadows beyond the existing popup and
tooltip elevation, no decorative animation. The only motion added is a
~150 ms colour transition on re-inking, disabled under
`prefers-reduced-motion`.

### 3.2 Typography

Typography carries the redesign. Self-host all three faces as woff2 in
`assets/fonts/` (subset to latin) — do not use the Google Fonts CDN; the
audience is in the EU and third-party font requests are a GDPR liability
the site currently does not have.

- **Display — Barlow Semi Condensed** (500, 600): the H1, KPI figures,
  section headings, embed title. A DIN-descended signage face; condensed
  civic authority without broadsheet pastiche.
- **Body — Public Sans** (400, 600): all running text, controls, table
  cells. A face commissioned for government digital services — on-subject
  and very legible at small sizes.
- **Data — IBM Plex Mono** (400, 500): reference numbers, the meta line,
  eyebrows, KPI labels, legend text, table numerals, dates, format tags.
  Register refs render as small stamped chips (mono, tracked, muted).

Scale (Tailwind theme values): H1
`font-display 600, clamp(2.1rem, 4.5vw, 3rem), line-height 1.05`;
section headings `font-display 600, 1.05rem, letter-spacing 0.01em`;
eyebrows and labels `font-mono 500, 0.72rem, uppercase, tracking 0.08em`;
body 1rem/1.55; small print 0.82rem. Use `font-variant-numeric:
tabular-nums` wherever figures align (already partly done).

### 3.3 Colour

Keep the existing palette. The neutrals (warm paper greys, near-black
ink) and the three register hues are good and already validated; the
redesign spends nothing here. The only structural change: **split the UI
accent from the data series**. `--series-1` blue currently doubles as
chart series and generic UI accent (hovers, checkboxes, selected pills).
Introduce `--ink` as above; UI states use `--ink`, charts keep their own
series tokens untouched.

### 3.4 Layout

Top-to-bottom, largest changes first:

1. **Masthead.** Eyebrow in mono ("Statutory registers · Dublin City ·
   refreshed twice daily"), then the H1 in condensed display type, then a
   short lede. Promote `#site-count-line` from a muted meta line to the
   masthead's data headline: a full sentence set at ~1.15rem with mono
   tabular figures ("112 derelict sites; median 5.5 years on the
   register"). The data is the hero; keep the sentence form, not a stat
   grid. Theme toggle stays top right.
2. **Downloads.** Compress the seven buttons into three labelled rows,
   one per register, inked by that register's hue: name once, then
   format links as small mono tags ("Derelict Sites — GeoJSON · CSV ·
   grid GeoJSON"). Halves the vertical space while keeping the open-data
   offer above the fold. Keep `download` attributes and hrefs unchanged.
3. **Register tabs.** Restyle the view switch from filled pills to three
   flat tabs on one baseline rule, each with a 3px underline in its own
   register hue; the selected tab's label is full-strength ink. Keep the
   radio-input markup, names, and values exactly as they are.
4. **KPI band.** Replace the five bordered tiles with a single ruled
   band: one horizontal rule above and below, figures separated by
   hairline vertical rules. Per figure: mono eyebrow label, display-face
   value (tabular), muted note. Wraps to a two-column grid under 640px.
   All existing element ids stay.
5. **Map card.** Keep the card and all chrome positions. Restyle panels:
   legends and toggles get mono labels, tighter padding, and the panel
   group inked per view. Hints become smaller and quieter.
6. **Lists and detail panels** (vacant/RZLT). Same layout; refs become
   stamped mono chips, selection bar uses `--ink`, the facts grid gets
   mono `dt`s. Detail panel keeps `aria-live`.
7. **Charts and table.** Chart cards lose their borders in favour of a
   heading rule (the surface cards multiply boxes; rules are quieter).
   Table: mono refs and numerals, sticky header on an opaque surface,
   row hover tint moves from blue to `--ink`.
8. **Changelog and footer.** Changelog dates in mono; footer set in two
   columns of small print under a top rule.
9. **Embed mode.** Re-verify after every phase; the embed title picks up
   the display face.

Card radius: keep 8 to 10px on genuinely interactive surfaces (map card,
inputs, popups, buttons); drop it where boxes become rules. Do not go to
zero-radius everywhere — this should not read as a newspaper pastiche.

### 3.5 Copy

No copy rewrite is in scope, with two exceptions: the masthead eyebrow
(new) and the count-line sentence (existing text, promoted). Keep UK
spelling and the existing factual register throughout.

## 4. Token architecture

Single source of truth in CSS, one deliberate exception:

- `@theme` in `style.src.css` defines neutrals, register hues, fonts,
  and radii; `@layer base` derives the semantic roles and `--ink`.
- Refactor `js/tokens.js` so chrome colours (surface, page, text roles,
  gridline, baseline, series-1, accents) are read from
  `getComputedStyle(document.documentElement)` at theme-change time
  instead of being duplicated hex values. The **data ramps stay
  hard-coded in JS** — they are data-encoding, mode-dependent, validated,
  and have no CSS consumers. Keep the existing `tokens()` /
  `onSchemeChange()` API so map and chart code is untouched.

## 5. Implementation phases

One jj commit per phase, `jj fix` before each commit, message format
`[WIP: claude] <description>`. Run `npm run build:css` and
`eslint --fix` on any touched JS before committing. Verify each phase in
both themes and all three views before moving on.

1. **Scaffold**: `package.json`, `.gitignore` entry, `style.src.css`
   importing Tailwind plus the entire current `style.css` verbatim,
   compiled output replacing `css/style.css` byte-for-byte in effect.
   The site must be pixel-identical after this commit.
2. **Fonts and theme tokens**: self-hosted woff2, `@theme`, `--ink`
   wiring, type scale applied to base elements.
3. **Masthead, downloads, tabs** (layout items 1 to 3).
4. **KPI band and filters** (item 4).
5. **Map chrome** (item 5).
6. **Lists, detail panels, popups** (item 6; popup classes live in
   `map.js` — grep before touching).
7. **Charts and table** (item 7).
8. **Changelog, footer, embed**; regenerate `assets/social-preview.png`
   (`python3 -m http.server 8741 &` then
   `node scripts/social_preview.cjs`; needs local Chrome and
   `npm install --no-save puppeteer-core`). Remind the user to upload
   the new preview in the GitHub repo settings.
9. **tokens.js refactor** (section 4).
10. **Optional, user-approved only**: HTMX fragments (section 2.2),
    changelog first.

## 6. Do not break

- **Element ids** — all of them; JS queries dozens: `#map`, `#kpi-*`,
  `#vkpi-*`, `#rkpi-*`, `#filter-*`, `#toggle-*`, `#panel-*`,
  `#locate-*`, `#cases-*`, `#rzlt-*`, `#vacant-*`, `#chart-*`,
  `#register-table`, `#changelog-*`, `#site-count-line`, `#embed-count`,
  `#theme-toggle`, `#viz-tooltip`.
- **Input names and values**: `view`, `map-mode`, `cases-shape`,
  `rzlt-colour` radios — `rzlt.js` programmatically clicks
  `input[name="view"][value="vacant"]`.
- **Behavioural classes**: `view-vacant`, `view-rzlt`, `embed` on body;
  `derelict-only` / `vacant-only` / `rzlt-only`; `is-selected`;
  `visually-hidden`.
- **JS-assigned component classes** (restyle, never rename):
  `vacant-list-item/-ref/-addr`, `vacant-fact(s)`,
  `vacant-detail-head/-ref/-addr`, `vacant-planning-title/-note`,
  `vp-list/-item/-head/-badge/-date/-type/-proposal/-link`,
  `vp-granted`/`vp-refused` (generated from outcome strings), `has-def`,
  `sort-arrow`, `col-num`, `cell-flag`, `is-yes`, `bar-hit`/`bar-mark`,
  `tip-value`/`tip-label`, plus whatever `map.js` emits for popups and
  legends (`popup-*`, `legend-*`) — grep `map.js` for the full list.
- **`.maplibregl-*` overrides**, the inline theme-stamping script, the
  `?embed` mode, and every data-encoding colour in `js/tokens.js`.

## 7. Verification checklist

- `npm run build:css` succeeds; compiled CSS committed; `eslint --fix`
  clean on touched JS; `uv run pytest` still passes (Python untouched).
- Serve locally (`python3 -m http.server`) and exercise: all three
  register views; map modes (register/caseload, density grid, Voronoi,
  protected highlight, 2.5D extrusion, colour-by modes); filters,
  search, reset; table sort and row-to-map click; list-to-detail and
  map-click-to-detail in both polygon views; locate button; changelog.
- Both themes, including toggling mid-session; no flash of wrong theme
  on reload.
- `?embed` view intact; social preview regenerated at 1280 x 640 dark.
- 375px viewport: no horizontal scroll, KPI band wraps, map chrome
  usable.
- Keyboard: tab through tabs, filters, table headers, lists; focus
  visible everywhere; `prefers-reduced-motion` disables the re-inking
  transition.
- Screenshot before/after pairs per section for review.
