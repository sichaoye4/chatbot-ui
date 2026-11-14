# Chatbot UI framework: implementation and testing plan

Date: 2026-11-14  
Status: Historical CSV-first backlog. Actual results are in [IMPLEMENTATION_PROGRESS.md](./IMPLEMENTATION_PROGRESS.md). Future generalization follows [GENERAL_CHATBOT_UI_FOUNDATION_PLAN.md](./GENERAL_CHATBOT_UI_FOUNDATION_PLAN.md).  
Design baseline: [CHATBOT_UI_FRAMEWORK_DESIGN.md](./CHATBOT_UI_FRAMEWORK_DESIGN.md)  
Primary integration data: [training_data_masked_final_1.csv](../sample_data/training_data_masked_final_1.csv)

## 1. Outcome and scope

Deliver a runnable reference application in which a user asks questions about the supplied CSV, a simple agent calls approved analytical tools, and the UI displays grounded text and validated visual artifacts. Prove the complete browser → backend → real agent/model → authorized CSV computation → event stream → rendered answer path.

**Clarified UX requirement (2026-11-14):** Build a full-screen conversation, not a dashboard application with a chat sidebar. Dynamically render approved visual components inside their originating assistant message bubbles. Multi-panel dashboards are a supported kind of chat response. Keep prior message visualizations attached to their original revisions across follow-up edits and reloads; text-only replies create no artifact. This supersedes earlier workspace-first wording in the initial plan.

Build the smallest useful vertical slice early: text Q&A and a single monthly trend. Then extend it to edits, two and six panels, deterministic interactions, restoration, resilience, and the remaining framework capabilities. Completing the CSV demo is an intermediate milestone, not completion of the whole framework.

This plan explicitly extends the design's section 2.3 assumption that the CSV is unused. The CSV becomes the primary integration domain. Preserve the synthetic support example as a second domain and regression fixture; its ticket counts and SLA definitions must never be attributed to the CSV.

Current workspace inspection found the design, two example plan JSON files, and the CSV, with no application source, package manifest, test runner, or existing knowledge graph. All paths and commands below are proposed deliverables. The directory was not a Git repository at inspection time.

## 2. Data findings and semantic rules

The following were computed directly from the CSV using Python's CSV reader. Freeze these facts in a reviewed fixture manifest before implementation.

| Property                          | Observed value                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| SHA-256                           | `56fc638633ab77d75cdefb79ae988aca783c21070b96493bacca61f89f28842a`                                    |
| Rows / columns                    | 3,509 / 25                                                                                            |
| Domains                           | `payment`: 1,580; `kyc`: 1,039; `party`: 890                                                          |
| Distinct systems / country codes  | 17 / 20                                                                                               |
| Distinct months                   | 29, January 2023 through May 2025                                                                     |
| `sla_met_rate` range              | 0.34–1.0; all 3,509 values populated                                                                  |
| Arithmetic mean of `sla_met_rate` | 0.6883898546594471359361641493; display 68.84%                                                        |
| Transfer fields                   | `xfer_team_base`, `xfer_team_size`, `xfer_chg`, `xfer_inc`: 189 blanks each                           |
| Data fields                       | `data_team_base`, `data_team_size`, `data_syst_inc`, `data_syst_chg`: 120 blanks each                 |
| Candidate key                     | `(domain, system, ctry_iso_cde, month_id)` has 750 excess rows beyond unique tuples; it is not unique |
| Category spelling                 | `src_infra_tech` includes both `Linux` and `linux`                                                    |

Required ingestion and metric decisions:

1. Preserve every source row, including repeated candidate keys. Assign `rowId = sourceHash + ':' + recordOrdinal`, where ordinal is the one-based parsed data-record position, not a physical line number. Never silently deduplicate.
2. Parse `month_id` as a validated calendar month. Expose a temporal field for charting without letting timezone conversion shift the month. Missing months are gaps, not zero-valued observations.
3. Preserve raw categorical values. Do not merge `Linux` and `linux` until an explicit normalization map is approved and versioned. Keep the actual column spelling `srce_team_base` in the source mapping.
4. Convert blanks to null, never zero. Validate numeric values and report invalid records; a malformed source must fail readiness rather than silently produce a partial analysis. Fixtures can separately test an explicit quarantine policy if one is later added.
5. Label row count as **source records**, not tickets, unique systems, or unique system-months. Distinct-system count is a separate metric.
6. Label the average of `sla_met_rate` as **unweighted mean of recorded SLA rates**. The file supplies no underlying eligible/met counts; do not call this an overall weighted SLA compliance rate or derive breach counts from it.
7. Treat `avg_comp` and control-score business meanings as unconfirmed. Raw inspection is supported; do not invent a completion/compliance definition. Likewise, sums of incident/change columns require a confirmed additive grain before becoming business metrics.
8. For means, report non-null observation count and null policy. Format rate values as percentages only at presentation; compare underlying values independently of rounding.
9. Do not infer causes or relationships from column names. A chart can show an association; causal explanations require evidence absent here.
10. The CSV has no tenant or identity fields. Demo authorization is a server-owned fixture policy, not a claim about the source's ownership model.

## 3. Runtime architecture and package ownership

Use a TypeScript workspace with React for the reference frontend and one Node backend. Start with a local relational persistence adapter, such as SQLite, behind interfaces; production deployment and database selection remain configurable. Use a schema validator, a unit/component test runner, and Playwright for browser tests. Confirm exact dependency APIs and pin versions during the bootstrap and OpenUI spike rather than copying unverified exports from the design.

```text
apps/reference-chat/          frontend composition, routes, demo configuration
apps/reference-server/        HTTP/SSE entrypoint, session wiring, lifecycle
packages/contracts/           schemas and protocol; no React or provider SDK
packages/catalog/             component/tool capabilities and metadata
packages/server-runtime/      policy, validation, queries, revisions, event log
packages/agent-adapter/        provider interface, tool loop, bounded repair
packages/client-runtime/       stream reducer, artifact/dataset stores, actions
packages/layout/               pure deterministic layout calculation
packages/ui-kit/               tokens, panel chrome, charts, table, graph
packages/renderer-openui/      serializer, registered library, render boundary
packages/chat-shell/           full-screen transcript, composer, visual message bubbles
packages/testing/              contract harness, fixtures, fault controls
examples/csv-analytics/        ingestion, semantic catalog, approved data tools
examples/support-operations/   independent synthetic second-domain fixture
tests/e2e/                     deterministic and live-provider browser suites
tests/oracles/                 reviewed CSV expectations and reference script
scripts/                       dev/test orchestration and evidence collection
```

Dependency rules: domain tools implement server contracts; the framework does not import CSV field names. Agent adapters return structured proposals and consume authorized results; they cannot commit revisions or execute raw SQL. UI components receive validated bindings and typed actions, never provider credentials. OpenUI compiles approved panel specs and resolves data from application context; it owns neither the grid nor queries. Each assistant message resolves its own artifact revision through the client store.

The server exposes the design's turn, cancel, artifact, edit, query, action, and event-resume endpoints. Add readiness and conversation restoration routes. Readiness succeeds only after schema migrations, source validation, policy initialization, and source-hash verification. Persist conversations, messages, immutable artifact revisions, current revision pointers, snapshots, and bounded replay events. Use atomic revision commits and optimistic concurrency.

## 4. Work breakdown and dependency order

Each row is a reviewable implementation task. Complete its acceptance checks before dependent tasks. Estimates and delivery dates should follow the integration spike, not precede it.

| ID  | Module / deliverable                                                                                                              | Depends on    | Acceptance evidence                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 | Workspace, TypeScript config, package boundaries, pinned dependencies, test commands, environment template                        | —             | Clean install, typecheck, minimal frontend/backend build; no credentials in client bundle                                                     |
| T02 | CSV profiler, fixture manifest, data dictionary, independent expected-answer script                                               | T01           | Hash, row counts, nulls, repeated keys, month validation and rate expectations match section 2                                                |
| T03 | Contracts: discriminated panel configs, bindings, filters, edits, dataset envelopes, text evidence references, actions and events | T01           | Runtime schemas reject unknown fields, oversize plans, invalid 0/7 counts, duplicate IDs and incompatible configurations                      |
| T04 | Component/tool registry and metadata-derived permitted catalog                                                                    | T03           | Registration drives validation and agent descriptions; permissions filter catalog without replacing execution-time checks                     |
| T05 | OpenUI adoption spike: chart/table, safe serialization, external dataset context, 1–6 slots                                       | T01, T03, T04 | Quotes/Unicode safe; no tool execution; remount/state, error, accessibility and bundle findings recorded; adopt or document React fallback    |
| T06 | CSV repository and approved analytical tools                                                                                      | T02, T03      | Stable row IDs, exact aggregates, bounded rows, deterministic ordering, missing-value semantics and source provenance pass independent oracle |
| T07 | Server query runtime and demo policy                                                                                              | T04, T06      | Authorization before query and cache read, scoped cache keys, cancellation/timeouts, query deduplication and immutable source version         |
| T08 | Minimal durable turn/revision store and SSE protocol                                                                              | T03, T07      | Atomic commit, idempotency, monotonic events, bounded resume, interrupted requests and conflicts tested                                       |
| T09 | Tokens, panel chrome, metric/trend/comparison/table and layout                                                                    | T04, T05      | Counts 1–6 at 360/768/1024/1440px; readable fallback; stable loading; text equivalents and keyboard support                                   |
| T10 | Client reducer, dataset store and action dispatcher                                                                               | T03, T08      | Duplicate/stale events ignored; closure does not imply success; last valid artifact survives failure                                          |
| T11 | Chat shell and reference app composition                                                                                          | T09, T10      | Browser can submit a deterministic fixture turn, receive SSE, expand a panel and show source details                                          |
| T12 | Simple real-provider agent and grounded text Q&A                                                                                  | T04, T07, T08 | Bounded tool loop, structured proposal, one repair maximum, evidence-backed answers and explicit unsupported-question response                |
| T13 | Real CSV vertical slice and live E2E harness                                                                                      | T11, T12      | Real browser asks count question and monthly trend; model/tool/stream/UI evidence all recorded; no network interception                       |
| T14 | Typed artifact edits, shared filters, table pagination/sort, refresh                                                              | T13           | One → two → six panels; stable IDs; no model calls for deterministic actions; generation barrier and partial failure behavior                 |
| T15 | Durable restoration, replay, snapshot/live semantics, concurrent edits                                                            | T08, T14      | Reload and backend restart restore revision and retained source; stale base conflicts; snapshot expiry never substitutes fresh data           |
| T16 | Security hardening and production session adapter contract                                                                        | T07, T12, T15 | Isolation across reads/cache/record routes/snapshots, revocation, injection, sanitization, CSRF where applicable and rate limits              |
| T17 | Relationship component and extension proof using support domain                                                                   | T09, T14      | Bounded graph fixture passes performance/accessibility; second domain added without framework edits; synthetic support 1→2→6 works            |
| T18 | Evaluations, performance, manual accessibility, adopter docs and release report                                                   | T13–T17       | Release criteria in section 10 pass; report separates deterministic, live-provider and deployment verification                                |

Sequence the work into these milestones:

- **M0 — foundations and adoption decision:** T01–T05. Freeze semantics and renderer decision.
- **M1 — real first answer:** T06–T13. Deliver live count Q&A and one trend before broadening the dashboard.
- **M2 — interactive analytics:** T14–T15. Complete expansion, filters, table actions and restoration.
- **M3 — full framework acceptance:** T16–T18. Complete isolation, graph capability, second-domain integration and operational evidence.

T02/T03 and later T06/T09 can proceed independently once their prerequisites exist. Keep integration contracts shared and explicit. Foundational authorization is in M1; M3 hardens it rather than adding security after the demo.

## 5. Simple CSV Q&A agent

### Approved tools

Implement bounded, parameterized functions over the immutable parsed CSV. An in-memory repository is sufficient for 3,509 rows; do not introduce a vector database or generated SQL for this tabular demo.

| Tool                | Allowed input                                               | Result                                                                  |
| ------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `csv.describe`      | Source identifier from catalog                              | Authorized fields, types, available months, definitions and limitations |
| `csv.summary`       | Typed filters; registered metric IDs                        | Record count, distinct systems, unweighted SLA mean, non-null counts    |
| `csv.monthlySla`    | Domain/system/country/month filters                         | Ordered month, unweighted rate mean, observation count per month        |
| `csv.countByDomain` | Typed filters                                               | Domain and source-record count, maximum three categories                |
| `csv.records`       | Allowed columns, typed filters, allowed sort, cursor, limit | Records with stable row IDs; default 50, maximum 200 per page           |
| `csv.filterOptions` | Registered field and current scope                          | Authorized option values only                                           |

Allowlisted filters include domain, system, country and month. Start with select controls; implement a separate typed month-range contract before exposing a range UI. Resolve categorical comparisons exactly. Pagination uses a stable secondary `rowId` order, and cursors bind to source version, filter/sort specification and effective authorization scope.

Tool results include `sourceId`, source hash/snapshot ID, query version, validated arguments, field metadata, observation count, warnings and truncation status. Tool errors use stable codes, not raw stack traces.

### Agent execution

1. Receive the question, selected artifact/base revision, bounded conversation context, and server-authenticated session.
2. Build a policy-filtered tool/component catalog with the CSV semantic rules. Retrieved cell strings are data, never instructions.
3. Run one model with tool calling; initially cap at six tool executions and eight model responses per turn, with a configurable wall-clock deadline. Fail clearly on exhaustion. No multi-agent orchestration is needed.
4. For numerical text answers, require successful tool evidence before finalizing claims. Represent citations as trusted source/query references and validate referenced results. Render exact numerical facts through server-owned formatting where possible; model prose must not introduce unsupported numerical claims.
5. For visuals, obtain a typed plan or edit, validate schema/semantics/policy, permit one repair, then atomically commit. Do not execute bindings from partial model output.
6. Resolve bindings through the server runtime and stream application events. Ground the final explanation in the actual successful result generation; a plan is not evidence that a query succeeded.
7. Retain the previous artifact when a candidate fails. A text-only answer has no visual artifact; do not represent it as a zero-panel plan.

Provide two adapters behind the same interface: a deterministic scripted adapter for reliable failure/state tests and a real provider adapter selected by server environment configuration. A scripted adapter passing is not evidence that live agent Q&A works. Record actual provider/model identifiers and settings in live reports; never silently fall back to the scripted adapter when credentials are missing.

## 6. Independent answer oracle

Create `tests/oracles/build_csv_expectations.py` using Python `csv` and `decimal`, independently of the production TypeScript repository and aggregation helpers. Store reviewed results in `tests/oracles/csv-expected.json`, keyed by source hash and query definition. The test runner verifies the hash but must not regenerate and accept changed expectations automatically.

Golden cases:

| ID  | Question / operation                                                           | Expected answer                                                                                          |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| G01 | How many source records are in the file?                                       | 3,509                                                                                                    |
| G02 | How many source records are in each domain?                                    | payment 1,580; kyc 1,039; party 890; total 3,509                                                         |
| G03 | What is the unweighted mean of all recorded SLA rates?                         | Underlying value 0.6883898546594471 within 1e-12; display 68.84%; denominator 3,509 records              |
| G04 | Show monthly SLA rates for domain kyc, system DSU, country AE, March–June 2023 | March 58%, May 52%, June 53%; April explicitly missing/gap, never 0%; one observation per returned month |
| G05 | How many records are in kyc / DSU / AE?                                        | 26                                                                                                       |
| G06 | How many transfer-team-size values are missing?                                | 189; summary must distinguish missing from numeric zero                                                  |
| G07 | Show records for January 2026                                                  | Empty successful result, no fabricated values                                                            |
| G08 | What is the overall weighted SLA compliance or number of breached tickets?     | Explain that eligible/met counts and ticket grain are unavailable; no invented result                    |
| G09 | Why did SLA change?                                                            | Describe observed change only; state lack of causal evidence                                             |

Use exact integer comparisons and explicit floating tolerances. Assert numerical values through accessible chart data tables and rendered metric labels as well as API evidence. Test meaning and required facts rather than exact model prose. Preserve raw expected rows for filtered pagination comparisons. Extend the oracle with all filtered six-panel results before implementing that scenario.

## 7. Real end-to-end integration test

### Harness and run lifecycle

Implement a single cross-platform entrypoint, proposed as `pnpm test:e2e:live`, that:

1. Validates required server-side provider configuration and source hash. Missing credentials make the live gate **blocked/not run**, never passed.
2. Creates a temporary test database and isolated run ID, applies migrations, seeds explicit demo principals, and starts the backend and production-built UI on available loopback ports.
3. Waits for readiness and confirms that real-provider mode is active. Loads the full original CSV, not a tiny substitute. Use a dedicated full-dataset demo principal for the golden answers.
4. Starts Playwright Chromium and opens the application. All questions are typed through the composer and submitted using visible controls.
5. Uses real HTTP, SSE, persistence, tools, CSV loading and configured inference. Do not intercept chat responses, seed completed artifacts, or substitute hardcoded tool answers. Test-only telemetry can observe calls without replacing them.
6. Waits on explicit request and artifact terminal states, not arbitrary sleeps. Use a configurable per-turn deadline, initially 60 seconds for functional live tests; measure the separate performance targets rather than equating this timeout with acceptable latency.
7. Saves browser trace, screenshots, sanitized event log, query/provenance records, numerical comparison report, versions, model settings and timing summary under `artifacts/e2e/<runId>/`.
8. Stops only processes started by the harness and cleans its temporary database in a `finally` path. Retain failure evidence. Provider errors and budget exhaustion are reported separately from application assertion failures; never auto-rerun until a pass erases a failure.

The real provider must be configured before executing this gate, including the deployment's inference/data-egress choice. The model receives bounded authorized metadata/results rather than an automatic upload of the whole CSV. Keep credentials out of screenshots, traces and browser assets.

### Primary browser journey

| Step | User action                                                                                                | Assertions                                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E01  | Open new chat and ask G01                                                                                  | Real inference recorded; approved summary tool runs; UI says 3,509 source records with provenance; text-only response creates no empty artifact                   |
| E02  | Ask G04                                                                                                    | Exactly one trend panel; accessible values 58%, 52%, 53%; April is a gap; correct scope and unweighted-rate label; no filler panels                               |
| E03  | “Add the underlying records.”                                                                              | Same artifact, next revision, exactly two panels; trend ID retained; table agrees with source rows and active scope                                               |
| E04  | Start a new all-data artifact: “Show monthly unweighted mean SLA rate and source-record counts by domain.” | Exactly two panels with all-data scope explicitly visible; domain values match G02; monthly values match independent oracle                                       |
| E05  | “Add source-record count, distinct-system count, unweighted mean SLA rate, and the underlying records.”    | Six panels: existing trend/comparison, three metrics, one table; metrics 3,509 / 17 / 68.84%; preserve existing panel IDs; shared summary binding executes once   |
| E06  | Select `kyc` using the domain filter                                                                       | All affected panels reach one generation; count 1,039; domain comparison only shows kyc; other values match filtered oracle; model invocation counter unchanged   |
| E07  | Sort table, navigate next page, open a record, refresh                                                     | Correct stable order and authorized details; source IDs agree; no model calls; refresh uses declared immutable source version                                     |
| E08  | Save view, reload browser, then restart backend and reopen conversation                                    | Six-panel revision, saved filter, source snapshot and message association restored; no accidental regeneration; table state restored only if explicitly persisted |
| E09  | Ask to add a seventh panel without specifying replacement                                                  | Clarification/cap explanation; no seven-panel commit, silent truncation or loss of last valid artifact                                                            |
| E10  | Ask G08 and G09 in a fresh chat                                                                            | Unsupported metric/cause explained; no invented denominator, breach count, or causal claim                                                                        |

Inspect tool and model-call telemetry before and after E06/E07 to prove local actions do not call the agent. Inspect revision IDs, generation IDs and source hashes alongside the DOM so a plausible screenshot alone cannot pass.

Use the configured provider's structured-output/tool-call facility. A live run may expose poor model choices; report these as failures and improve catalog/prompts rather than changing assertions to accept arbitrary panels. Preserve the validated artifact after an unsuccessful edit.

### Resilience and isolation browser journeys

Run these against real services/CSV with deterministic agent responses and controlled backend faults so results are reproducible. Keep their results separate from the live-provider journey.

- Delay one binding, rapidly change domain from payment to kyc, release the old response: no stale payment values appear as completed kyc results.
- Fail the comparison query: its slot shows error/retry while other panels remain usable; retry completes the matching generation without replanning.
- Disconnect SSE before completion: reconnect and replay without duplicate messages; expired replay history triggers status/artifact fetch. A closed stream is not reported as success.
- Cancel an in-flight turn and attempt a concurrent stale-base edit: cancellation is visible; stale commit returns conflict; prior valid artifact survives.
- Seed two server-owned demo tenant scopes with distinguishable authorized subsets, then attempt cross-scope artifact, query, cache, cursor, snapshot and record access. Assert absence of unauthorized values in responses/events as well as the DOM. These are test policies, not CSV tenant metadata.
- Revoke a principal's data scope while a view is open: clear affected client data, invalidate options/cache access and reject refresh.
- Use separate adversarial fixtures for instruction-like labels, unsafe links, malformed plans, repeated keys and corrupt numeric cells. Do not alter the canonical CSV to manufacture these cases.

## 8. Layered verification and design traceability

| Layer                           | Main coverage                                                                                                           | Requirement mapping |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Contract tests                  | Counts 1–6 and invalid 0/7, 64KB cap, discriminated configs, unknown fields, tool args and action allowlists            | FR-01, FR-03        |
| Data/semantic tests             | Independent goldens, nulls, repeated source keys, percentages, missing months, undefined SLA denominators               | FR-04               |
| Server integration              | Policy before reads/cache, bounded queries, deduplication, transactions, idempotency and edit conflicts                 | FR-04, FR-09, FR-10 |
| State/protocol tests            | Duplicate/out-of-order events, superseded revision/generation, cancel, interrupted streams, barrier with partial errors | FR-06, FR-08        |
| Renderer/layout component tests | Safe compilation, stable slots, 1–6 mixed panels at all four widths, inline/expanded shared state                       | FR-01, FR-03, FR-05 |
| Browser deterministic suite     | Expansion, filters, paging, refresh, restoration, failures, injection and tenant isolation                              | FR-06–FR-10         |
| Browser live-provider suite     | Actual Q&A, smallest sufficient visuals, numerical grounding and follow-up planning                                     | FR-02, FR-04, FR-06 |
| Extension contract suite        | Support tools and bounded relationship fixture integrate without framework-internal edits                               | FR-11               |
| Accessibility/visual review     | Keyboard, focus, 200% zoom, chart text equivalents, loading/empty/error/long-label states and screen reader             | FR-12               |

Retain the design's 60-prompt evaluation minimum: propose 15 text/metric questions, 15 visual questions covering counts 1–6, 10 follow-up edits, 10 ambiguity/unsupported-definition cases and 10 malicious or over-cap cases. Tag each prompt with independent expected facts and allowed visual choices. Run with pinned prompt/catalog/model settings. Report first-pass validity, validity after one repair, semantic correctness and grounded-answer accuracy separately. Never average authorization failures into an acceptable success rate.

For performance, record acknowledgment, plan commitment, query completion and render timings separately. Measure the design's p95 targets using at least 100 measured turns/interactions per relevant class after warm-up on documented hardware/network; stratify one-panel and six-panel workloads. A single live smoke test does not establish p95 latency. Measure layout movement during data arrival; exercise maximum table/chart/graph bounds with dedicated synthetic fixtures where the CSV lacks enough diversity.

## 9. Planned developer commands and CI

Implement these script interfaces during T01/T13; they do not exist yet:

```text
pnpm install --frozen-lockfile
pnpm data:verify
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm test:e2e:deterministic
pnpm test:e2e:live
pnpm test:a11y
pnpm eval:agent
pnpm build
pnpm dev:csv
```

Pull-request CI runs source verification, static checks, deterministic unit/integration/browser tests and build. Run live-provider tests explicitly or in a configured credential-bearing release job with a spending limit; protect credentials from untrusted jobs. Release reports must say when live checks were not run. Keep screenshot changes reviewed rather than automatically updating visual baselines. `dev:csv` launches the documented demonstration with an explicit agent-mode indicator in developer diagnostics.

## 10. Completion criteria and handoff

The **CSV integration milestone** is complete only when E01–E10 pass with a real provider and the complete CSV, expected numerical answers match the independent oracle, deterministic interactions have zero additional model calls, and reload/backend-restart restoration works. Include a short reproducible manual walkthrough and recorded run evidence.

The **full framework implementation** additionally requires:

- Every FR-01–FR-12 mapping above passes, including all six panel counts, failure/replay behavior and access revocation.
- OpenUI's adoption result and exact version are documented, or the authorized design fallback is explained and tested against the same contracts.
- Relationship rendering passes dedicated bounded-data accessibility/performance checks; it is not fabricated from the CSV merely to demonstrate a graph.
- The independent support domain reproduces the design's 328-created / 300-due / 270-met / 30-breached fixture semantics and one→two→six flow.
- Agent evaluation reaches the design's pilot targets: at least 95% first-plan validity, 99% after one repair and 95% semantically correct visual choices. Every authorization test passes. Report counts and rates rather than implying small samples establish production reliability.
- Manual keyboard/screen-reader review and measured performance results are attached, including deviations from targets.
- Identity integration, inference/hosting boundaries, retention, theme, browsers/locales and sharing policy are recorded before a corporate pilot. Default artifacts to private. Demo identity tests do not establish that a production identity provider or connector has been validated.

Final handoff must list completed task IDs, actual commands and results, source hash, application/adapter/catalog/provider versions, evidence locations, failed or blocked gates, and remaining deployment decisions. Distinguish **static validation**, **deterministic browser integration**, **real-provider browser integration**, and **production deployment validation**. This document provides the plan only; its source profiling is not evidence of runtime success.
