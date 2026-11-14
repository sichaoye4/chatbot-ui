# Data visualization component expansion

**Status:** Proposed component definitions; not registered or implemented.  
**Reviewed:** 2026-11-14.  
**Scope:** Extend inline assistant artifacts with useful analytical forms while preserving the current style, deterministic layout, and one-to-six-panel limit.

## 1. Current support and gaps

Source of truth for this audit: `packages/catalog/builtins.ts`, `packages/catalog/index.ts`, `packages/ui-kit/chart.tsx`, `packages/ui-kit/panels.tsx`, `packages/renderer-openui/index.tsx`, `packages/layout/index.ts`, and the final overrides in `apps/reference-chat/src/style.css`.

| Capability | Current state | Expansion implication |
|---|---|---|
| Metric | Registered; aggregate value presentation | Add target context through a bullet chart |
| Trend | Registered; current chart renderer draws one series | Do not claim multi-series rendering from the foundation registration's allowance of up to six measures |
| Comparison | Registered; categorical bars | Grouped, stacked, and paired comparisons need additional definitions |
| Pie | Registered; complete, nonnegative partition required | Reuse its partition discipline for composition charts |
| Table | Registered; exact values and record inspection | Remains the accessible/detail fallback |
| Relationship | Legacy catalog/adapter name exists; renderer is a placeholder; absent from foundation built-ins | Completing network rendering is existing backlog, not a newly supported chart |
| Distribution, correlation, matrix, target, uncertainty, change decomposition, intervals, hierarchy, flow, geography | No corresponding foundation built-ins | Proposed below |

Existing runtime support was inspected statically; this document does not certify browser behavior. New IDs below are reserved design names, all proposed at version 1.

## 2. Research and design decisions

These definitions are project-specific recommendations. Online sources establish visualization patterns, not claims that this project already implements them.

- [Carbon chart overview](https://www.carbondesignsystem.com/building-blocks/data-visualization/overview) provides a useful breadth check across simple, flow, and spatial visualizations.
- [Carbon simple charts](https://www.carbondesignsystem.com/building-blocks/data-visualization/simple-charts) supplies reference forms for grouped/stacked bars, histograms, box plots, scatter plots, bullet charts, and treemaps. We adopt their analytical purposes, not Carbon's theme or library wholesale.
- [IBM 2x Grid](https://www.carbondesignsystem.com/building-blocks/foundations/2x-grid/overview) demonstrates shared geometric units and alignment across typography and layout. Our Swiss-inspired adaptation retains the project's 12 columns; it does not adopt Carbon's column system or claim formal Swiss-design certification.
- [Vega-Lite waterfall example](https://vega.github.io/vega-lite/examples/waterfall_chart.html) demonstrates ordered positive/negative contributions and totals. Our data tools must supply authoritative contributions and reconciliation.
- [Vega-Lite error bands](https://vega.github.io/vega-lite/docs/errorband.html) distinguishes statistical interval types and precomputed bounds. Our renderer consumes declared bounds rather than choosing a statistical method.
- [W3C complex images guidance](https://www.w3.org/WAI/tutorials/images/complex/) supports short chart descriptions plus detailed equivalent information, including values and relationships.

No new chart dependency is selected by this specification. Evaluate renderer libraries separately after the data contracts and first components are proven.

## 3. Shared visual and Swiss-grid contract

### Preserve the existing visual language

Reuse Inter/system sans-serif, tabular numerals, ink `#35465f`, white cards, artifact surface `#f1f4fa`, subtle borders, 14px card radius, and restrained existing shadows. Retain `--chart-line: #586fd5`, `--chart-bar: #299da9`, `--chart-grid: #e5eaf4`, and `--chart-label: #63728c`. Preserve the current 14px panel headings and 2.5px trend strokes as the starting point.

New sequential/diverging palettes require dedicated reviewed tokens; do not manufacture a rainbow or treat existing light grid colors as sufficiently contrasting data marks. Use hue plus shape, dash, signed labels, or patterns. Category-to-color assignments must remain stable across filtering and related panels. Show meaning through aligned marks and labels; avoid 3D, decorative gradients on quantitative fills, and animation that changes apparent magnitude.

### Grid geometry

The existing design document proposes 24px panel padding/gutters; current CSS uses 22px card padding and 20px grid gutters, while the layout function subtracts 24px gutters. Resolve this explicitly during implementation by sharing layout tokens between CSS and layout calculations. Proposed target: 24px wide gutters/padding, 16px compact gutters/padding, and a 4px spacing base. Preserve the current palette, typography, radius, and surfaces during that spacing change.

- Measure the artifact's available inner width, not the browser viewport. Use 12 columns with `minmax(0, 1fr)`; no masonry or dense packing.
- Default charts to span 6 when both panels fit; otherwise span 12. Wide forms below use span 12. A single panel always spans 12. Compact target cards may span 4 only when their minimum widths fit.
- Use `slotWidth = (containerWidth - 11 * gap) * span / 12 + (span - 1) * gap`. Width here excludes artifact padding. Reject a candidate if any panel fails its minimum width; preserve semantic and keyboard order.
- Table sizes below are proposed **outer card** minima including padding and chrome. They guide side-by-side placement, not a hard CSS `min-width` that overflows mobile.
- At widths below the card minimum, use a full-width card and a documented narrow treatment. Prefer fewer ticks, wrapped labels, a vertical arrangement, or a labeled local scroll region. Never shrink all chart text with an SVG viewBox to force a fit.
- Share left title edges, units rows, plot gutters, legend positions, and source footer baselines. For comparable charts in a row, reserve the largest needed axis gutter and header height. Grow row height for wrapping rather than clipping.
- Allocate minimum height before loading; allow growth for text zoom. Keep tooltip overlays out of layout flow. Changes in row count must not reorder panels.
- Keep every chart inside its assistant message artifact. Chart details and underlying values do not create extra overview panels; independently titled facets do count toward the six-panel limit.

## 4. Proposed component catalog

All bounds and density limits here are initial product defaults to validate, not measured performance guarantees. `number` means finite numeric data; category and identifier fields are declared dimensions. Units, ordering, aggregation method, calendar, and grain come from trusted field/tool metadata.

| Proposed ID | Question and required binding roles | Presentation and initial limits | Grid / minimum W × H | Avoid / fallback |
|---|---|---|---|---|
| `ui.histogram` | How are observations distributed? `binStart`, `binEnd`, `count`; tool declares bin policy, sample size, missing count, and measure unit | Adjacent teal bins; count axis begins at zero; 5–40 equal-width bins by default; final bin explicitly includes its upper boundary | 6 or 12 / 380 × 320 | No raw rows or trusted bins: table. Unequal bins require a separately defined density mode; do not use count-height bars |
| `ui.boxPlot` | How do distributions differ by group? `category`, `lowWhisker`, `q1`, `median`, `q3`, `highWhisker`, `sampleCount` | Horizontal boxes; indigo median, outlined whiskers; 1–12 groups; tooltip states whisker method and sample count | 6 or 12 / 440 × 360 | Means alone cannot produce quartiles. Tiny groups need a stated sample policy or raw-value table |
| `ui.scatter` | How do two measures vary together? `x`, `y`, `recordId`; optional `category` | Hollow indigo points, independent numeric axes with units; up to 500 visible points; overlap counts or disclosed sampling | 6 or 12 / 400 × 360 | No joined observation grain: table. Do not infer causality or silently fit regression |
| `ui.heatmap` | Where are high/low values across two dimensions? `row`, `column`, `value` | Rectangular cells; ordered axes; labeled sequential legend, or diverging legend with declared center; up to 20 × 24 cells | 12 / 600 × 400 | Mixed units in one color scale: separate panels/table. Narrow: labeled local horizontal scroll with row headers retained |
| `ui.bullet` | How far is actual performance from a target? `category`, `actual`, `target`; optional ordered range boundaries | Horizontal teal bar, indigo target tick, subtle neutral ranges; 1–8 rows; actual and target printed together | 4, 6, or 12 / 320 × 240 | No authorized target or direction-of-goodness: metric/comparison. Never invent red/green thresholds |
| `ui.groupedBar` | How do cohorts compare within each category? `category`, `series`, `value` | Aligned grouped bars with a zero baseline; 2–4 series and up to 12 categories; prefer horizontal bars for long labels | 6 or 12 / 440 × 360 | Too many combinations: heatmap/table; incompatible units: separate panels |
| `ui.stackedBar` | What contributes to each category total? `category`, `series`, `value`; partition metadata scoped to category | Horizontal segments; `absolute` or `percent` mode; up to 6 series × 12 categories; totals plus direct/legend labels | 6 or 12 / 440 × 360 | Missing/negative values, overlapping parts, or incomplete partitions: grouped bars/table. Percent requires positive denominators |
| `ui.dumbbell` | What changed between two comparable observations? `category`, `before`, `after`; declared endpoint labels | Two differentiated markers joined by a neutral line; signed delta label; 1–12 categories | 6 or 12 / 440 × 360 | Different units/grains/cohorts: table. More than two time points: trend |
| `ui.waterfall` | Which contributions explain the change from start to finish? `step`, `order`, `kind`, `value`; kind is opening/delta/subtotal/closing | Floating contributions with thin connectors; totals anchored at zero; signed labels and patterned negative bars; up to 16 steps | 12 / 600 × 360 | Unreconciled totals or arbitrary order: comparison/table. Narrow: local horizontal scroll retaining readable labels |
| `ui.intervalTrend` | What range surrounds an estimate over time? `time`, `estimate`, `lower`, `upper`; interval method/level metadata | Indigo estimate with light band and visible bound strokes; observed/forecast status declared; up to 240 time points | 6 or 12 / 440 × 360 | No supplied bounds/method: trend. Do not label min/max as confidence intervals |
| `ui.timeline` | When do activities start, end, and overlap? `entity`, `start`, `end`; optional `status`, milestone flag | Horizontal interval rows, calendar axis and exact date labels; up to 20 visible rows; milestone uses a distinct symbol | 12 / 600 × 400 | Unknown dates/timezone semantics: table. Narrow: labeled time-axis scroll; do not imply dependency edges |
| `ui.treemap` | How is a total divided through a hierarchy? `nodeId`, `parentId`, `label`, `value`; declared leaf aggregation rule | Stable nested rectangles with thin white separators; up to 40 leaves and 3 levels; small leaves retain table access | 12 / 600 × 400 | Signed values, cycles, overlapping totals, or precision-first ranking: comparison/table. Narrow: table alternative |
| `ui.sankey` | What quantities move between stages? `sourceId`, `targetId`, `sourceStage`, `targetStage`, `value` plus labels | Left-to-right stages aligned on columns; flat restrained ribbons; up to 20 nodes / 40 links; exact flow on focus | 12 / 640 × 440 | Arbitrary/cyclic relationships: existing relationship backlog/table. Narrow: source–target–value table |
| `ui.choropleth` | How does a comparable rate vary geographically? `regionId`, `value`; declared geography version and unit | Approved local boundary asset; sequential scale and explicit missing regions; accompanying ranked values; up to 250 regions | 12 / 600 × 400 | Ambiguous geography or incomparable denominators: comparison/table. For absolute counts prefer ranked bars; do not color by area |

### Priority

1. **First delivery:** histogram, scatter, heatmap, bullet. These add four distinct analytical capabilities with relatively small rendering/data contracts.
2. **Second delivery:** grouped bar, stacked bar, dumbbell, box plot, waterfall, interval trend. These extend comparison and statistical interpretation.
3. **Specialized delivery:** timeline, treemap, Sankey, choropleth. Each needs additional domain semantics, density handling, or assets.

Complete the existing relationship renderer separately. A sparkline can later be a metric variant; a donut can be a pie variant. Multi-series trends should first reconcile existing catalog promises with renderer behavior. Small multiples are a layout composition using existing panels, not a way to bypass the panel cap. Radar charts, 3D charts, and decorative gauges are not prioritized because the proposed Cartesian forms provide clearer aligned comparisons for this product.

## 5. Data validation and computation rules

Every proposed component starts with a single authorized binding. Tools perform joins, binning, quantiles, normalization, interval estimation, and cumulative calculations. The client may map validated values to geometry and format labels; it must not infer business semantics or accept model-authored numerical datasets.

| Component | Required semantic and result checks |
|---|---|
| Histogram | Bins sorted, nonoverlapping, contiguous over the declared range; start < end; nonnegative integer counts; reconcile counts with included observations; disclose missing and outside-range counts |
| Box plot | `lowWhisker ≤ q1 ≤ median ≤ q3 ≤ highWhisker`; consistent quantile/whisker method and units; positive sample count. If outliers are omitted, say so; optional outlier support needs its own authorized result contract |
| Scatter | Both measures refer to the same observation; unique interaction key; reject nonfinite coordinates; disclose excluded missing pairs and sampling; zero is not automatically required for both axes |
| Heatmap | One value per ordered row/column pair or explicit tool aggregation; missing cells distinct from zero; scale bounds/center declared and preserved for comparisons |
| Bullet | Actual, target, and optional ranges share units and grain; ordered ranges; domain contains actual and target; target provenance visible; negative values supported only with a signed axis |
| Grouped / stacked bar | Unique category–series pair; consistent units/grain; explicit absent-versus-zero policy. Stacked mode additionally requires a complete nonnegative partition per category; percent totals reconcile to 100% before display rounding |
| Dumbbell | Endpoints have matching units, population, and grain; supplied endpoint labels; signed delta arithmetic verified; missing endpoint is not zero |
| Waterfall | Unique stable order; opening + deltas reconciles with closing within declared numeric tolerance; subtotals do not increment the running total; endpoint and subtotal values verified |
| Interval trend | Ordered unique timestamps; same units for all three measures; lower ≤ estimate ≤ upper; interval type/level supplied; missing bounds break the band; forecast provenance and cutoff declared |
| Timeline | Start ≤ end; timezone/calendar supplied; zero duration requires milestone treatment; open-ended intervals explicitly flagged and labeled |
| Treemap | Unique nodes, valid parents, acyclic single-root hierarchy; nonnegative weights and positive root total; prevent double-counting parent and leaf totals; omitted leaves disclosed |
| Sankey | Valid endpoint IDs, forward stage order, nonnegative flows; units compatible; conservation checked only where the tool declares a conserved process; explicitly disclose sources, sinks, and losses |
| Choropleth | Region IDs match a versioned approved geometry; unmatched IDs disclosed; no implicit geocoding; comparable rate definitions, time window, and denominators; boundary assets bundled or served by an approved source |

If data does not support a requested chart, explain the missing requirement and show an authorized table or an appropriate supported chart. Do not silently claim the requested form was delivered. An empty valid result, invalid data, unavailable capability, forbidden data, stale data, and rendering error remain distinct panel states.

## 6. Interaction and accessible equivalents

Every chart has a visible title, units, source/freshness details, a concise data-derived summary, and a “View values” disclosure exposing the same authorized result in an HTML table. The summary describes the displayed subset and its limitations. A table for an aggregate chart exposes aggregates, not unauthorized underlying records.

- Pointer hover, keyboard focus, and touch selection expose the same exact values. Escape dismisses transient details. Tooltips never contain the only available value or label.
- Use one entry point with roving focus for marks; arrows traverse chart order, Home/End reach endpoints. Heatmaps use two-dimensional navigation. Dense charts may use the values table as the primary navigation equivalent rather than hundreds of tab stops.
- Static marks must not be announced as buttons unless they perform a defined action. Label interactive marks with category, value, unit, and relevant bounds/target.
- Use direct labels or shape/pattern distinctions in addition to color. Check text and essential graphic contrast against WCAG requirements; the existing tokens are not automatic proof of compliance.
- Local inspection does not call the model. Filtering/drill-down requires a registered action and renewed server authorization. Preserve read-only historical revision behavior.
- Check 200% text zoom, long/CJK labels, reduced motion, touch use, keyboard-only navigation, and a screen reader. Never truncate the only accessible label.

## 7. Integration contract and release gate

The foundation registration already supports versioned refs, guidance, Zod props, field roles, minimum layout sizes, and a validation hook. Use those surfaces; do not add unimplemented IDs to the planner-visible catalog.

For each component, ship these together:

1. `packages/catalog/builtins.ts`: versioned registration, strict configuration enums, use/avoid guidance, role cardinality, unit/grain checks, and layout minima. Suggested histogram roles are `binStart`, `binEnd`, and `count`, each exactly one numeric measure; props initially allow only `mode: 'count'`.
2. Domain tool: authorized fields and trusted statistical/partition metadata. Existing `partitionRoles` describes one category/value pair; grouped partitions, hierarchies, intervals, and geographic metadata need explicit contract extensions. Plan validation is insufficient for row-level invariants: validate actual tool results before rendering.
3. `packages/ui-kit`: reusable chart model and presentation using shared panel chrome, scale/label helpers, state handling, and accessible values. Derived geometry must be deterministic for the same data and size.
4. `packages/renderer-openui`: explicit registered renderer path. The current adapter and legacy `Panel` union are fixed mappings; adding a foundation definition alone does not create a renderer. Either extend the legacy bridge deliberately or finish a generic foundation renderer first.
5. `packages/layout` and app CSS: shared gutter/padding tokens, per-component minimum-width decisions, narrow behavior, and reserved loading heights. Never let the agent set arbitrary pixel positions or CSS.
6. Persistence/capabilities: retain old revisions; unsupported component versions show a local explanation and safe equivalent where available. Only advertise installed, validated components to the agent.

Release evidence for each component must include:

- Semantic tests for its invariants, empty/null/zero/negative cases, duplicates, limits, and mismatched units/grain.
- Deterministic integration checks from authorized tool result through plan validation and renderer, including rejected results and historical revision restoration.
- Browser evidence at 320px, 768px, and 1200px artifact containers, plus zoom and long labels; exercise one, two, and six panels. Verify no page overflow, no overlapping labels, no displaced focus, and matching CSS/layout gutters.
- Keyboard/touch and screen-reader checks, equivalent-value checks, automated accessibility checks, and screenshot review against the current cards.
- Clear disclosure when sampling, binning, truncation, missingness, or incomplete geography affects interpretation.

This change defines the expansion only. No runtime registrations, dependencies, or supported-capability claims change until those gates are met.
