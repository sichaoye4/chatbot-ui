# Source — CSV chatbot UI reference

A local React/TypeScript application for grounded Q&A over the supplied CSV. A Node backend owns CSV computation, plan validation, SQLite persistence and the DeepSeek credential. OpenUI renders approved panels using application-owned data context.

The interface is a full-screen conversation. Charts, tables and optional multi-panel overviews appear inside assistant message bubbles, alongside the answer. Follow-up visualizations appear in new responses; earlier visual responses remain in conversation history, including after reload.

This is a working local reference application, not a completed corporate deployment. See [progress and issues](docs/IMPLEMENTATION_PROGRESS.md) for exact verified scope and remaining tasks.

A generic v2 backend foundation is being developed alongside this reference app. It has capability registrations, typed response/control plans, semantic validation, host policy and a provider-independent planner. See the [generalization plan](docs/GENERAL_CHATBOT_UI_FOUNDATION_PLAN.md) and [implemented v2 contracts](docs/FOUNDATION_V2_CONTRACTS.md). The browser still uses the compatible v1 path; `pnpm test:foundation:live` explicitly tests the new backend rather than switching the app.

## Run locally

Requirements: Node 24.14 or newer, pnpm 11.25, Python 3.11 or newer for the independent oracle.

```powershell
pnpm install --frozen-lockfile
pnpm data:verify
pnpm build
pnpm dev:csv
```

Open http://127.0.0.1:4317. The app binds to loopback only and uses an explicitly labeled single-user demo identity. Do not expose it to a network as an authenticated corporate service.

Copy `.env.example` to `.env.local` for a new installation. Set `AGENT_MODE=deterministic` for the scripted demo, or `AGENT_MODE=deepseek` for actual model-backed Q&A. Set `DEEPSEEK_API_KEY_FILE` to an existing secret file (preferred) or inject `DEEPSEEK_API_KEY` into the server environment. Never use a `VITE_` variable for credentials. The current workspace's ignored `.env.local` references the user-authorized Football Legend key file; it contains no copied key.

The live adapter uses `https://api.deepseek.com` and `deepseek-v4-flash` by default, matching that project's integration. It sends the question, schemas, selected artifact and bounded tool results (at most 20 rows per model-facing tool result). The user approved this bounded transfer for the test. Changing destination or data scope requires a new decision.

## Walkthrough

1. Ask “How many source records are in the file?” Expect **3,509** and expandable source evidence.
2. Ask “Show monthly SLA rates for domain kyc, system DSU, country AE, March–June 2023.” Expect one chart, with April missing rather than zero.
3. Ask “Add the underlying records.” Expect a new assistant bubble containing the chart and a table. The earlier one-chart response stays intact above it.
4. Start a new chat and ask “Show monthly unweighted mean SLA rate and source-record counts by domain. Include a domain filter.”
5. Ask “Add source-record count, distinct-system count, unweighted mean SLA rate, and the underlying records.” Expect six panels with metrics **3,509**, **17**, **68.84%**.
6. Filter to kyc, sort/page records, open a record, refresh and save the view. These controls do not call the model. Reload or restart the backend and reopen the same browser.

Filters are optional and question-driven. “What's payment domain's data quality's trend in 2024?” should show three inline trends (`avg_comp`, `data_ctrl_score`, `sla_met_rate`) scoped to payment/2024, without a domain selector. “Show only avg_comp trend for payment in 2024 and let me filter by country” should show one trend and a country selector, keeping payment and the year fixed.

State is in `.runtime/chat.sqlite`; the browser remembers its conversation ID. Original source records and design files are unchanged. This source is an immutable snapshot, so refresh recomputes against the same file version. Historical snapshot and current view are stored separately.

## Verification

```powershell
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e:deterministic
pnpm test:e2e:live
pnpm test:spike
```

Build before browser tests: the harness starts the production build in isolated processes/databases and cleans up its own resources. Each browser run retains traces, screenshots, reports and sanitized execution evidence in `artifacts/e2e/<timestamp>/`. Missing live credentials fail the live gate rather than substituting a mock. Live tests spend provider tokens; deterministic and renderer tests require no provider calls. `lint` currently means formatting validation; semantic checks are the strict TypeScript build and tests.

The browser suite tests actual network requests, CSV tools, persistence and UI. The separate spike suite seeds validated plans through a test-token-only endpoint to isolate renderer behavior; it is not counted as live-agent evidence. Test control routes are unavailable without the harness's random server token.

## Source semantics

Rows are source observations, not tickets. Duplicate candidate keys are preserved. SLA averages are unweighted means of recorded rates, not overall weighted compliance. Missing values remain null. Business definitions for `avg_comp` and score columns are unconfirmed. See the [CSV data dictionary](docs/CSV_DATA_DICTIONARY.md).

## Roadmap and evidence

Project-management charts are now available as an explicitly synthetic inline demo. Ask **“Show a project management demo”**, **“Show a Gantt demo”**, **“Show a flowchart demo”**, **“Show a burnup demo”**, or **“Show a cumulative flow demo”**. See [project visualization contracts and research](docs/PROJECT_MANAGEMENT_VISUALIZATIONS.md) for integration requirements and limitations. Real project data is not connected.

- [Implementation/testing plan](docs/IMPLEMENTATION_AND_TESTING_PLAN.md)
- [Progress, checks and blockers](docs/IMPLEMENTATION_PROGRESS.md)
- [OpenUI adoption decision](docs/OPENUI_ADOPTION.md)
- [Framework design](docs/CHATBOT_UI_FRAMEWORK_DESIGN.md)
- [Visualization component expansion and Swiss-grid rules](docs/DATA_VISUALIZATION_COMPONENTS.md) — researched definitions; proposed, not implemented
- [Implemented project-management visualizations](docs/PROJECT_MANAGEMENT_VISUALIZATIONS.md) — Gantt, interactive flowchart, burndown/burnup, cumulative flow

Remaining release work includes a generic second-domain integration, relationship rendering, the 60-prompt evaluation, performance sampling, manual screen-reader review and production identity/retention decisions. Passing the local demo does not establish those capabilities.

Data visualization charts are implemented in the reference chat. Try **“Show a visualization demo”**, **“Show a comparison visualization demo”**, or **“Show a specialized visualization demo”**. Individual requests such as **“Show a histogram demo”** and **“Show a percent stacked bar demo”** also work. See [implementation and supported contracts](docs/DATA_VISUALIZATION_IMPLEMENTATION.md). All these demos use explicitly synthetic tool results.
