# Data visualization implementation

Implemented 2026-11-15, following the research and visual conventions in [the design](DATA_VISUALIZATION_COMPONENTS.md).

## Available charts

All 14 core forms render in the reference chat: histogram, box plot, scatter, heatmap, bullet, grouped bar, stacked bar (absolute/percent), dumbbell, waterfall, interval trend, timeline, treemap and Sankey, plus a choropleth renderer using a versioned local geometry registry.

The v1 `Panel` component names are the catalog names without `ui.`. Each has `config: { fields: { role: fieldName }, mode: 'absolute' | 'percent' }`. Mode is percent only for stacked bars. `packages/contracts/visualization.ts` defines exact required roles, types, minima, density limits and trusted result metadata. No arbitrary coordinates, CSS, remote geometry URLs or executable chart definitions are accepted from the planner.

The data tool must explicitly advertise `visualizationViews` and return `Dataset.visualization` with matching kind, grain, explanatory note and chart-specific semantics. Catalog validation checks field roles/units; query execution checks results before publication; the renderer revalidates historical data. Server-side authentication and cache scope remain unchanged. Existing revisions remain valid because visualization metadata is optional for old forms.

Foundation v2 also has versioned descriptors for all forms. Its renderer migration and visualization-result metadata are **not** implemented here: these are executable components in the existing v1 host, not a claim of a completed v2 host. The shared descriptor module imports only Zod and is included in the foundation boundary guard; local geometry lives outside that module.

## Semantics

- Histograms consume contiguous equal-width bins and reconcile counts against supplied included observations, with missing/outside accounting. Final upper boundary is inclusive.
- Box plots require ordered supplied quartiles/whiskers, positive sample counts and a method disclosure. Scatter requires unique observations and supplied missing/sampling policy.
- Heatmaps use fixed supplied sequential domains, unique pairs and explicit absent-cell styling. Choropleths require a registered geometry version, matching IDs, fixed domain and comparable rate definition. Missing geometry values are hatched.
- Bullets show signed actuals and targets with target provenance and direction of improvement. Dumbbells show distinct endpoint marks and calculated signed differences with supplied endpoint labels.
- Grouped/stacked bars require a complete explicit category-series matrix and shared units. Stacks require nonnegative disjoint complete partitions. Percentage mode rejects zero denominators.
- Waterfalls require ordered opening/delta/subtotal/closing rows and reconcile all totals using a fixed relative tolerance of 1e-8. Subtotals do not increment totals.
- Interval trends draw supplied bounds and estimate, breaking each series/band at missing data; no statistical estimates are computed in the browser. Timelines require valid UTC Gregorian dates; zero-duration events use diamonds.
- Treemaps validate a single acyclic root, parent totals, depth and leaf count. Deterministic slice-and-dice preserves relative leaf area; exact inspection includes the ancestor path.
- Sankey ribbons use a common quantity-to-thickness scale across all stages. Forward links and consistent node stages are required. Intermediate conservation is checked when declared; the tool note explains sources, sinks and losses.

## Style and interactions

The existing typography, card surfaces, indigo/teal colors and 12-column layout are retained. Cartesian charts measure card width; dense/time/geographic forms use labeled local scrolling. Text is never scaled down through an SVG viewBox. The existing 24px grid gutter remains shared by CSS and layout calculations.

Each chart provides exact-value click/touch/keyboard inspection, arrow/Home/End traversal, a persistent inspector, source metadata and an HTML values-table disclosure. Chart marks expose an inspection action; inspection does not invoke the model. Series indices and endpoint shapes supplement color. Long display labels may be shortened, while accessible labels, inspection and the values table retain full values.

## Demos and present limits

Use these explicit demo prompts (each obeys the six-panel cap):

- `Show a visualization demo` — histogram, scatter, heatmap, bullet.
- `Show a comparison visualization demo` — grouped/stacked bar, dumbbell, box plot, waterfall, interval trend.
- `Show a specialized visualization demo` — timeline, treemap, Sankey, choropleth.
- Individual names work, for example `Show a box plot demo` or `Show a percent stacked bar demo`.

`examples/data-visualization/index.ts` supplies immutable synthetic fixtures through authorized tools, not model-authored numerical payloads. Existing CSV data does not acquire invented statistical or geographic semantics; unsupported real-data requests explain what is missing. A real domain integration must supply an eligible tool and validated semantics.

The only bundled geography is **fictional four-district geometry**, clearly labeled as such. Real world/country boundaries must be reviewed and added to the local registry before those maps are available. No geocoding, remote tile requests or arbitrary SVG supplied by users are accepted.

This first implementation uses sequential color scales, core scatter roles, core bullet actual/target roles, closed timeline intervals, and single-category box summaries. Optional scatter categories, bullet range bands, heatmap diverging centers, explicit forecast cutoff styling, timeline status/open-ended intervals and box outlier marks remain future extensions. Dense graphs may have crossing ribbons; small treemap leaves use the exact-values table. A manual screen-reader audit and live-model selection evaluation remain outstanding.

## Verification

Unit tests cover all 14 contracts, authorized query execution, compilation, density/semantic failures, empty data, nonfinite values, missing metadata, field-role errors and revoked access. Browser tests cover all forms, keyboard inspection, exact-value tables, durable reload, 320/768/1200px viewports and automated accessibility. Existing CSV/project-chart/browser regression suites remain included. Screenshot review checks the new chart forms in their real cards. See the final work log for current check counts and evidence location.
