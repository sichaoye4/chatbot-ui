# Project management visualizations

Implemented 2026-11-14 in the inline chat renderer. These are read-only visualizations, not a scheduling or workflow-editing application.

## Try them

Run the reference app normally and ask:

- **Show a project management demo** — four panels: schedule, process, burndown, cumulative flow.
- **Show a Gantt demo** — dates, task progress, finish-to-start arrows and a release milestone.
- **Show a flowchart demo** — approval decisions, labeled branches, resubmission and rework loops.
- **Show a burndown demo** or **Show a burnup demo** — actual work and supplied reference/scope.
- **Show a cumulative flow demo** — counts in completed, active and queued states.

These requests use explicitly synthetic fixtures in `examples/project-management/index.ts`, even when the reference app otherwise uses a live model. No model call is required for the demo. The welcome screen includes the overview prompt. Every example is labeled in its title, assistant response, source identifier and source warning. Requests for real project charts explain that the current CSV source has no project schedules or workflows.

## Online research

The implementation uses the following primary references for analytical meaning and interaction requirements:

- [Mermaid Gantt documentation](https://mermaid.js.org/syntax/gantt.html): scheduled tasks, dependencies and milestones. This implementation displays supplied calendar-date endpoints; it does not calculate a schedule from durations or exclude weekends.
- [Mermaid flowchart documentation](https://mermaid.js.org/syntax/flowchart.html): process nodes, decisions, directed connections, labels and orientation. This implementation renders typed rows directly with React/SVG. It does not parse Mermaid syntax or execute diagram callbacks.
- [Atlassian burndown tutorial](https://www.atlassian.com/agile/tutorials/burndown-charts): remaining work during an iteration. The renderer compares supplied actual/reference observations. Burnup mode instead shows completed work and total scope, making scope changes visible.
- [Atlassian cumulative flow guidance](https://support.atlassian.com/jira-software-cloud/docs/what-is-the-cumulative-flow-diagram/): colored areas represent workflow states over time. Here band thickness encodes each state's item count. A widening band supports investigation; the component does not assert a cause or compute cycle time from snapshot counts.

The implementation choices below are specific to this repository, not claims that these sources recommend its exact schema, palette or density limits.

## Components and contracts

All four are available in the v1 `Panel` union, catalog, OpenUI compiler and `PanelBody`. Foundation v2 descriptors are also registered under the corresponding `ui.*` IDs; the reference app still uses the v1 rendering bridge, as it does for existing charts. The new project domain demonstrates the v1 bridge, not a completed v2 browser host.

`Tool.projectViews` explicitly declares which project visualizations a trusted tool supports. Merely naming fields `start`, `done` or `source` does not make a CSV tool eligible. A production adapter must enforce authorization and attest to the semantic requirements below. Catalog validation checks fields and units; the query binding validates actual rows before publication; the renderer also validates restored inputs.

### Gantt (`gantt`, `ui.gantt@1`)

Configuration maps `taskIdField`, `labelField`, `startField`, `endField`, `progressField`, `dependenciesField` and `kindField`.

- One row per task, unique task ID. `kind` is `task` or `milestone`.
- Start/end are real Gregorian `YYYY-MM-DD` calendar boundaries interpreted consistently at UTC midnight. A milestone has equal start/end. The chart positions the supplied boundaries directly, without adding an inclusive extra day.
- Progress is a ratio from 0 to 1 with field unit `ratio`. It is displayed, not inferred from elapsed time.
- Dependencies are a comma-separated list of predecessor IDs; blank means none. IDs must be resolvable, dependencies unique, and the schedule graph acyclic. Use IDs without commas.
- Dependencies mean finish-to-start with zero lag. The chart flags a successor that starts before a predecessor ends, but never changes dates.
- Limit: 40 tasks. Minimum placement width 600px; always a full-width grid row. Dense schedules scroll within the card.
- Focus/click a task for full name, exact dates, completion and predecessors. Arrow keys move through task order; a source-values table exposes all fields.

### Flowchart (`flowchart`, `ui.flowchart@1`)

Configuration maps `idField`, `labelField`, `kindField`, `sourceField`, `targetField`; `direction` is `LR` or `TB`.

- Node rows use kind `start`, `end`, `process` or `decision`. Source/target may be null for nodes.
- Edge rows use kind `edge`, source/target node IDs and an optional empty-string branch label. All row IDs are unique, including edges. Edge endpoints must exist.
- Deterministic DFS identifies feedback edges; longest-path ranks of the remaining acyclic graph place nodes on aligned columns/rows. Disconnected nodes, decisions, merges, self-loops and cycles are accepted. Feedback edges use dashed outer routes.
- Limit: 40 nodes, 80 edges. Full-width placement with a 600px minimum preference. Scroll stays inside the card.
- Controls: left-to-right/top-to-bottom, zoom in/out, fit width, reset zoom/selection. Direction changes preserve selection; reset keeps the chosen direction.
- Select a node to highlight adjacent connections and inspect full incoming/outgoing branch labels. Arrow/Home/End navigation follows stable node input order. SVG labels are escaped text; no arbitrary HTML, URLs, callbacks or model-authored scripts are executed.
- Long in-diagram labels are bounded; the inspector and table retain exact text. Large or densely connected graphs may need scrolling and may have crossing edges. This is a bounded process viewer, not an obstacle-avoiding graph editor, swimlane engine or unrestricted diagram canvas.

### Burndown / burnup (`burndown`, `ui.burndown@1`)

Configuration maps `timeField`, `actualField`, `referenceField` and `mode` (`burndown` or `burnup`).

- One observation per real calendar date, sorted chronologically; duplicate dates rejected.
- Numeric fields share a declared unit. Values are finite and nonnegative. Null observations remain gaps.
- Burndown labels actual/reference as Remaining/Ideal remaining; burnup labels them Completed/Total scope. The reference is supplied by the tool, not computed or forecast by the chart.
- The reference line is dashed as well as differently colored. Hover is not required: selectable dates expose both exact values, with a complete underlying table.
- Limit: 366 observations. Minimum placement preference 400 × 320px, with local scrolling where needed.

### Cumulative flow (`cumulativeFlow`, `ui.cumulativeFlow@1`)

Configuration maps `timeField` and ordered `stageFields` (2–6 distinct field names).

- Each dated row is a complete workflow snapshot. Each item occupies exactly one declared state. The adapter owns this partition guarantee; the UI cannot infer it from numbers.
- Values are nonnegative integer counts, all in the same declared unit. Null counts and duplicate dates are rejected. A missing state is not treated as zero.
- Stage order is bottom-to-top and remains fixed. Legend uses field names. State counts need not be monotonic; scope may change and work may be reopened.
- Limit: 366 snapshots. Minimum placement preference 440 × 360px. Selecting a date reveals exact state counts; a table exposes all source values.

## Style, layout and accessibility

The diagrams reuse the existing indigo/teal accents, Inter/system typography, neutral surfaces, rounded white cards, subtle dividers and source footers. Gantt and flowchart occupy full 12-column rows; the two agile charts share a row only if both minimum widths fit. The CSS grid gutter now matches the 24px layout calculation. All graphics remain inside assistant message artifacts and respect the existing six-panel cap.

Local horizontal scroll preserves readable labels on narrow screens. Flowchart fit-to-width is an explicit overview action; restore 100% for full-sized labels. Controls wrap on mobile. Shape, dashed lines, explicit labels, selection inspectors and underlying tables supplement color. Keyboard-accessible inspection and live text summaries are included. Automated accessibility checks passed; a manual screen-reader audit has not been performed.

Source footers now show the actual dataset identifier, timestamp and warnings instead of a hardcoded CSV filename. The legacy artifact-level hash remains the reference host's source-version guard; per-dataset hashes identify the individual immutable project fixtures.

## Verification and limits

- Unit tests cover contracts, compilation, authorization, semantic eligibility, real/invalid dates, progress bounds, schedule cycles, unknown dependencies, graph cycles/self-loops, duplicate IDs, missing observations, duplicate dates and explicit synthetic routing.
- Browser tests cover all four forms, burnup mode, keyboard selection, branch inspection, feedback loops, orientation, zoom/fit, exact-value tables, provenance, reload, mobile widths and axe accessibility checks.
- Existing unit, integration, deterministic-browser and renderer-spike suites are regression gates. Live provider evaluation is separate and is not implied by deterministic demo success.

Not included: real Jira/MS Project connectors, drag-to-reschedule, working-day calendars, dependency lag/types beyond finish-to-start, resource leveling, critical-path calculation, diagram authoring, export, or swimlanes. These require explicit domain contracts and further interaction design. Useful next project views are sprint velocity, resource-capacity heatmaps and risk matrices; they are not advertised as implemented.

### User-supplied content: direct model planning

In DeepSeek mode, every request reaches the LLM directly. No timeline parser or
keyword demo router runs before it. `provided.data` accepts the model's structured
rows, field metadata, provenance label and notes, making supplied text/tables usable
by compatible registered components. The model decides the component and message
grouping. Schema and chart validation run before publication, with one bounded
repair opportunity. Clarification or failure produces a readable retry response.
Synthetic canned tools are excluded from the LLM's tools and accepted plans.

Thinking mode is enabled by default in both provider paths; set
`DEEPSEEK_THINKING=disabled` only to opt out. Multi-step tool calls retain provider
reasoning fields in backend request history, without publishing them to the UI.

The old strict schedule importer is retained only for compatibility with previously
stored artifacts. It does not route new chat requests. Deterministic mode remains
an explicit demo/test harness, not a general LLM replacement.

Live verification: `pnpm exec tsx --env-file-if-exists=.env.local tests/live/provided-content.ts`.
This sends both project fixtures and a small bar-chart request to the configured
provider. Outputs and call metadata are saved in `artifacts/provided-content/`.
Browser regression fixtures were captured from actual live results; they are not
used to generate chat answers.
