# Implementation progress and issues

Started: 2026-11-14 (Asia/Shanghai)

Source plan: [IMPLEMENTATION_AND_TESTING_PLAN.md](./IMPLEMENTATION_AND_TESTING_PLAN.md).
Generalization plan: [GENERAL_CHATBOT_UI_FOUNDATION_PLAN.md](./GENERAL_CHATBOT_UI_FOUNDATION_PLAN.md).
This log distinguishes implemented code, executed checks, and unverified scope. No gate is complete merely because a file exists.

## Explicit chart requests and relevant reply text — 2026-11-14

- **I21 — Resolved for the reported request:** The active v1 catalog/schema/renderer had no pie component, so the agent generated a bar chart. The service also hardcoded the same SLA sentence for every visual answer. Neither behavior met the request.
- Added reusable pie rendering, a shared percentage/denominator calculation, and pie registration in both the active protocol and v2 capability registry. Category partitions are declared by tools and checked by validators. Pie rendering refuses missing/negative/zero-total, duplicate-category, oversized or truncated inputs rather than showing misleading shares or silently changing chart type.
- Agent guidance now exposes the component catalog and instructs it to honor an explicitly requested supported type or explain an unsupported/unsuitable choice. The scripted fixture supports pie requests; the real provider selected the pie through its schema/guidance.
- Visual replies now use domain-owned presentation generated from the actual result, rather than a universal service sentence. Pie text and labels share the same denominator calculation. The reference UI only shows the SLA-average footnote when an SLA mean is actually displayed.
- The reported question produces a pie with payment 45.03% (1,580), kyc 29.61% (1,039), party 25.36% (890), out of 3,509 records. The answer explicitly identifies these as CSV rows, not distinct source systems. No domain selector or unrelated SLA commentary appears.
- Verification: 58 unit tests, 12 integrations, five deterministic browser cases, three renderer/accessibility cases, and the exact question through the real DeepSeek browser flow passed. Build/typecheck/format and boundary checks passed. Pie keyboard focus/tooltips, Escape, persistence and mobile overflow are covered.
- Evidence: [deterministic browser](../artifacts/e2e/2026-11-14T15-08-43-157Z/report/index.html), [renderer/accessibility](../artifacts/e2e/2026-11-14T15-08-51-837Z/report/index.html), [real provider browser](../artifacts/e2e/2026-11-14T15-08-57-363Z/report/index.html).
- Restarted the verified local preview on port 4317 with the updated backend. Historical answers remain original snapshots; refresh and submit a new question to generate the corrected response.

## Component visual refinement — 2026-11-14

- Applied the visual direction of [Kate Koltunova's Analytic dashboard concept](https://dribbble.com/shots/11278226-Analytic-dashboard-concept): pale blue-gray canvas, white rounded cards, soft shadows, indigo trends and teal comparisons. Retained full-screen chat and inline assistant visualizations.
- Extracted a reusable, data-bound `AnalyticsChart` in `packages/ui-kit/chart.tsx`. Added dashed horizontal/vertical grids, axis values, zero baseline, active-point crosshairs and exact-value HTML tooltips. Pointer hover, click/tap, keyboard focus, arrow/Home/End navigation and Escape dismissal are supported. Missing values remain gaps and are inspectable as “Missing.”
- Chart geometry now follows the card's measured width, keeping labels readable on phones; dense time labels thin responsively, while small category charts retain their category labels. Bar widths adapt to category count; negative values use the zero baseline rather than producing invalid rectangles.
- Updated metric/table/control styling alongside charts. Chart underlying-value tables now use their configured x/y fields rather than appending a CSV-specific observation field automatically.
- Verification: typecheck, production build/client boundary and formatting passed. Four conversation/browser regressions passed: [report](../artifacts/e2e/2026-11-14T14-48-35-797Z/report/index.html). Three chart/renderer/accessibility scenarios passed on the final build: [report](../artifacts/e2e/2026-11-14T14-49-20-981Z/report/index.html). Includes exact percentage/count tooltips, missing-month line gaps, keyboard dismissal/navigation, mobile tooltip bounds, automated accessibility and 200% text scaling.
- Desktop and mobile screenshots were reviewed. No model/provider call was needed for this presentation change. V2 client migration remains unfinished as recorded below; these enhancements are active in the existing reference UI.

## General foundation planning — 2026-11-14

- User clarified that element selection and controls must be flexible and capability-guided across domains. The new generalization plan supersedes the CSV-first backlog for future foundation work; existing test results remain regression evidence only.
- Created G01–G13 with module boundaries, generic contracts, incremental migration gates, three-domain independent oracles, a held-out extension exercise and real browser-to-agent acceptance journeys.
- At the planning checkpoint, G01–G13 were all planned. The implementation checkpoint below supersedes that status.
- **I15 — Open: business-specific logic in shared framework modules.** Current contracts, catalog, agent adapter and runtime still embed CSV fields, tools, authorization and formatting. Resolve through G02–G09 and prove isolation with import checks and the G10–G11 domain/component extension gates. Fixing one prompt or one example does not close this issue.
- **I16 — Open: current passing tests do not establish generality.** Existing evidence centers on the CSV and scripted question paths. Resolve through independent commerce/topology fixtures, held-out questions, semantic/metamorphic evaluation and public-API consumer tests in G10–G12.

## General foundation implementation checkpoint — 2026-11-14

The v2 backend foundation is executable alongside the working v1 reference chat. The entire generalization plan is not complete, and the browser has not switched to v2.

| Task    | Current status                                                 | Evidence / remaining work                                                                                                                                                                |
| ------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G01     | Complete                                                       | [Migration baseline](./FOUNDATION_MIGRATION_BASELINE.md), current unit/integration/browser baseline, frozen two-revision v1 restoration fixture and coupling/test ownership inventory    |
| G02     | Initial contracts implemented; lifecycle work remains          | Generic response/data/action envelopes, agent/policy interfaces, explicit data roles and scope; v2 event and persisted-revision protocol still to finalize                               |
| G03     | Server registry implemented; client/action integration remains | Versioned domain/tool/component/control registrations, generated schemas/guidance, policy discovery and semantic conformance tests; resolver/action registry and renderer linkage remain |
| G04     | Partial                                                        | CSV agent templates/routing/prompts and fact formatting moved into the example; real aggregate plugin added. Legacy Filters, policies, persistence and option lookup still coupled       |
| G05     | Partial                                                        | Generic executor, before/after query authorization, result/provenance validation and grounded facts; options, caches and field-level policy conformance remain                           |
| G06     | Partial, live backend smoke passed                             | Provider-independent capability planner, bounded repair and separate DeepSeek transport; exploratory tool loop and paged capability discovery remain                                     |
| G07     | Contracts only                                                 | Control ownership/dependencies, initial scope and scope-changing intent validated; actual v2 option/action execution and state transitions remain                                        |
| G08–G09 | Not migrated                                                   | Browser/OpenUI/client/revision storage still use the v1 compatibility path                                                                                                               |
| G10     | Fixtures started                                               | Real CSV aggregate bridge plus synthetic commerce/topology contract/execution fixtures; complete multi-domain apps and independent oracle suites remain                                  |
| G11–G13 | Not complete                                                   | Registration extension test exists, but independent held-out consumer exercise, release evaluation and SDK packaging remain                                                              |

Implemented sources and exact limits: [V2 contract notes](./FOUNDATION_V2_CONTRACTS.md).

Verification in this increment:

- 55 unit tests and 12 integration tests passed; independent CSV oracle, typecheck, production build, formatting, client boundary and isolated foundation import checks passed.
- Four deterministic browser tests passed after fixing a conversation-hydration race: [browser report](../artifacts/e2e/2026-11-14T14-21-08-215Z/report/index.html). These exercise the rebuilt **v1** reference app, including the new controlled-delay regression.
- Two renderer/accessibility browser scenarios passed on the final rebuilt client: [report](../artifacts/e2e/2026-11-14T14-28-13-984Z/report/index.html).
- Four real DeepSeek **backend** smoke cases passed in three consecutive runs after scope normalization: [run 1](../artifacts/foundation/2026-11-14T14-24-50-821Z/live-backend.json), [run 2](../artifacts/foundation/2026-11-14T14-25-01-472Z/live-backend.json), [run 3](../artifacts/foundation/2026-11-14T14-25-10-680Z/live-backend.json). Cases cover CSV count, commerce revenue, fixed-scope multi-measure trends and a relevant region control. This is not the planned 90-case evaluation or v2 browser-to-model acceptance gate.
- No preview database was migrated; v1 history remains compatible. The new foundation is not selected by `AGENT_MODE=deepseek` in the reference app yet.

Issues encountered:

- **I17 — Resolved: provenance timestamp conflation.** CSV `asOf` is a source month, not execution time. V2 now preserves `sourceAsOf` separately and creates an actual query timestamp/ID.
- **I18 — Resolved: new-chat hydration race.** Browser regression exposed a late empty conversation restore overwriting a newly sent message. Composer submission now waits for hydration; a deliberately delayed restoration test proves the fix. Failed run retained at `artifacts/e2e/2026-11-14T14-19-21-909Z`.
- **I19 — Resolved for captured failure: equivalent scope represented inconsistently.** Live plans sometimes put fixed constraints in `args` while preserving the correct query. Catalog normalization now fixes all uncontrolled arguments by default; only explicit control ownership grants editability. No domain names or question regexes are involved. Broader semantic scope evaluation remains G12 work.
- **I20 — Approval resolved.** Automatic approval review blocked a visualization/control diagnostic rerun. The user explicitly approved test questions, registered CSV schemas/metric descriptions, generated plans and validation feedback to DeepSeek; this planner transfers no CSV rows or computed results. Server credentials remain server-side.
- **I15/I16 remain open.** Domain extraction and evidence of generality are incomplete. Passing backend smoke cases does not close either issue.

Next implementation gate: finish generic options/actions and v2 lifecycle contracts, then migrate renderer/client execution while preserving the frozen v1 fixture. No outstanding user-input blocker at this checkpoint.

**UX correction, 2026-11-14:** The user clarified that this is a full-screen chatbot with dynamically generated UI inside assistant message bubbles. The initial split chat/dashboard implementation was the wrong product layout. Replaced it with a conversation-first shell; a multi-panel dashboard is now only one possible visual response. This clarification supersedes earlier references to a persistent artifact workspace.

## Task status

| Task                     | Status                        | Evidence / remaining work                                                                                                                                                                                           |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 Workspace            | Complete for reference app    | 12 private workspace projects, pinned lockfile, format/type checks, production builds, client/server boundary check, environment template and README                                                                |
| T02 CSV oracle           | Complete                      | Independent Python Decimal expectations and verification; data dictionary; hash/null/key/month facts frozen                                                                                                         |
| T03 Contracts            | Partial                       | Strict plans, configs, tool args, actions, dataset envelopes and event payloads implemented; standalone typed edit-operation API remains                                                                            |
| T04 Catalog              | Partial                       | Policy-filtered tools, metadata-derived prompts and semantic validation; full registration-driven renderer/layout/prompt unification remains                                                                        |
| T05 OpenUI spike         | Passed for current components | Escaping/context/counts/state/no-tools checks pass; decision in OPENUI_ADOPTION.md; comparative bundle cost/manual screen reader remain                                                                             |
| T06 CSV tools            | Implemented                   | Summary/monthly/domain-count/records verified against oracle; describe/options tools registered; pagination cursors scoped and signed                                                                               |
| T07 Query runtime/policy | Partial                       | Scoped cache, reauthorization, query deduplication, four-binding concurrency, cancellation and fault recovery implemented; connector-specific timeouts/retries and field ACLs remain                                |
| T08 Persistence/SSE      | Partial                       | SQLite revisions/snapshots, idempotency, HTTP/SSE, bounded 200-event replay and status fallback; generic API/persistence adapters and retention lifecycle remain                                                    |
| T09 Components/layout    | Partial                       | Metric/trend/comparison/table and 1–6 layout checks pass at four widths; relationship component and full design-intent template selection remain                                                                    |
| T10 Client runtime       | Implemented for CSV slice     | Validated stream payloads, deduplication/stale rejection, settled generation barrier, replay recovery and terminal-state handling                                                                                   |
| T11 Shell                | Partial                       | Full-screen transcript, user/assistant bubbles, bottom composer, inline dynamic visuals, per-message revision history and record dialog tested; extract reusable chat-shell package and add conversation navigation |
| T12 Agent                | Passed real-provider journey  | DeepSeek backend adapter, bounded tool loop/repair, deterministic fact formatting and source evidence; CSV-specific prompt/response catalog needs extension refactor                                                |
| T13 Live E2E             | Passed CSV journey            | E01–E10 pass using actual DeepSeek, original CSV, built UI, HTTP/SSE and SQLite; no response interception                                                                                                           |
| T14 Edits/interactions   | Partial                       | Chat follow-up 1→2 and 2→6, stable IDs, filter/sort/page/record/refresh/save pass without model calls for controls; direct typed edit API and scoped retry action remain                                            |
| T15 Restoration/replay   | Partial                       | Reload/backend restart, saved filters, immutable first-result snapshots, optimistic conflict and bounded replay pass; replay-expiry browser fault and live-source/retention semantics need broader tests            |
| T16 Security             | Partial                       | Loopback-only demo, origin/body bounds, scoped data/cache/cursors/history, CSP, escaped UI, backend-only key, revocation polling; real authentication, field permissions and production audit remain                |
| T17 Graph/second domain  | Not started                   | Implement bounded graph and independent support fixture; remove CSV coupling from framework interfaces before claiming extension gate                                                                               |
| T18 Release evaluation   | Not started beyond smoke/a11y | No 60-prompt agent evaluation, 100-sample performance run, manual screen-reader review or production connector verification yet                                                                                     |

## Decisions and issue log

| ID  | Status                         | Finding / decision                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I01 | Resolved                       | Sandbox registry DNS and loopback HTTP access failed. Approved external operations succeed; HTTP test passed when rerun with network access.                                                                                                                                                                                                   |
| I02 | Resolved                       | User selected DeepSeek and pointed to I:/football_legend. Reuse backend-only key-file loading and deepseek-v4-flash; never copy/log credential.                                                                                                                                                                                                |
| I03 | Open                           | Source has no business SLA denominators, tenant metadata or confirmed grain. Keep explicit unweighted-rate semantics and demo policy.                                                                                                                                                                                                          |
| I04 | Resolved authorization         | Automatic review initially rejected external CSV-derived data transfer. User explicitly approved questions, schema, aggregates and up to 20 rows per tool response to DeepSeek. Live test launched after approval.                                                                                                                             |
| I05 | Resolved in smoke regression   | First live test answered G01 correctly but added an unrequested table to G04. Kept failure trace under artifacts/browser; strengthened smallest-sufficient-plan instructions. Two subsequent live journeys passed unchanged panel-count assertions. Broad model reliability still needs T18.                                                   |
| I06 | Resolved                       | Automated accessibility found weak secondary-text contrast and a non-focusable scroll region. Darkened secondary text, made scrolling keyboard accessible and verified native dialog focus/Escape behavior.                                                                                                                                    |
| I07 | Resolved                       | A shell newline literal briefly broke CSS build; corrected the source and rebuilt before accepted browser runs. Failed spike evidence remains retained.                                                                                                                                                                                        |
| I08 | Known limitation               | Demo identity is not authentication. Server listens only on loopback; deployment beyond a single-user local environment is out of this checkpoint's accepted scope.                                                                                                                                                                            |
| I09 | Known limitation               | Node's built-in SQLite emits an experimental-feature warning. Current pinned runtime passes persistence tests; select/test production persistence before pilot.                                                                                                                                                                                |
| I10 | Known limitation               | Old next-page cursors expire on backend restart because their signing key is process-local. Refresh starts a new page; saved table position is not promised.                                                                                                                                                                                   |
| I11 | Resolved                       | New workspace manifests required pnpm symlink registration outside the sandbox. Approved install and frozen-lockfile verification passed.                                                                                                                                                                                                      |
| I12 | Resolved                       | User trial exposed a product-layout mismatch: a dashboard shell with a chat sidebar instead of a chatbot. Removed the split workspace and blank dashboard placeholder; bound visualizations to assistant messages and immutable historical revisions. Design, plan, README and tests updated.                                                  |
| I13 | Resolved                       | Domain filters were hardcoded in the demo plan, reinforced by the model prompt and always rendered by the UI. Removed defaults: controls now come only from plan filter definitions chosen for the question. Added scoped server-side options, rejection of undeclared/invalid filter changes, and removal of stale controls on revised plans. |
| I14 | Resolved by user clarification | Unspecified data quality means all three measures discussed: avg_comp, data_ctrl_score, sla_met_rate. Added three separately labeled monthly trends on their recorded scales; explicitly requested metrics narrow the response. No combined quality score is invented.                                                                         |

## Executed checks

- Environment inspected: Node v24.14.1, pnpm 11.25.0, Python 3.11.
- `pnpm install --frozen-lockfile`: passed. OpenUI's optional postinstall is disabled explicitly; distributed runtime is present.
- `pnpm data:verify`: passed against the original source hash.
- `pnpm typecheck`: passed.
- `pnpm test:unit`: 40 passed (data, schemas, layout counts/widths, event reducer, SSE framing).
- `pnpm lint`: passed (Prettier format validation; strict type checks are separate).
- `pnpm test:integration`: 6 passed (durable revisions, HTTP/SSE, identity/scope boundaries, filters/failures/generations, replay bounds, payload validation and cancellation).
- `pnpm build`: passed; current client JS 436.25 kB / 135.49 kB gzip, CSS 7.90 kB. Client boundary check found no server credential configuration/filesystem/SQLite imports. This is measured output, not a performance acceptance claim.
- `pnpm test:e2e:deterministic`: 2 passed, including the full E01–E10 scripted-agent journey, four widths and scoped failure/retry.
- First `pnpm test:e2e:live`: failed at E02 because the real agent created two panels instead of one. This is a semantic agent failure, not a successful live gate.
- Final `pnpm test:e2e:deterministic`: 2 passed. Evidence: [deterministic report](../artifacts/e2e/2026-11-14T13-08-43-408Z/report/index.html).
- Final `pnpm test:spike`: 2 passed. Counts 1–6, Unicode/escaping, no outbound requests/tool execution, automated WCAG A/AA, keyboard dialog/focus and 200% text scaling. Evidence: [spike report](../artifacts/e2e/2026-11-14T13-08-49-837Z/report/index.html).
- Final `pnpm test:e2e:live`: 1 full E01–E10 journey passed; 1 deterministic-only fault scenario intentionally skipped in this project (it passed in the deterministic project). Evidence: [live report](../artifacts/e2e/2026-11-14T13-08-55-075Z/report/index.html).
- Live report records 12 model calls across pre/post restart, requested `deepseek-v4-flash`, returned `deepseek-flash`, and 101,105 total reported input/output tokens for that run. Local filter/sort/page/record/refresh operations added **zero model calls**. No price or production latency claim is inferred from this run.
- Visually inspected the final 1440px six-panel screenshot. Original source hash remains `56fc638633ab77d75cdefb79ae988aca783c21070b96493bacca61f89f28842a`.

## Checkpoint history

- Initial checkpoint: workspace scaffold started; original CSV and design documents preserved.
- CSV checkpoint: runnable app, validated tools, actual DeepSeek integration, persistence, renderer and browser evidence completed. The approved data transfer was used only through the server-side provider adapter; the key was not copied into the workspace or printed.

## Next implementation steps

1. Complete contract/API seams: typed edits, explicit query endpoint, scoped panel retry, generic domain adapter and reusable chat shell.
2. Expand resilience/authorization tests: browser stream interruption and replay expiry, field-level ACLs, revocation/cached snapshot paths, invalid-source fixtures and retention expiry.
3. Implement the independent support domain and graph capability before declaring the extension contract complete.
4. Add the 60-prompt evaluation and performance harness, then run their defined release gates. Manual screen-reader review needs a recorded human review.
5. Before a corporate pilot, discuss real identity provider, deployment/inference boundaries, retention policy, sharing and production connector semantics with the user.

## Conversation-first correction verification

- Every generated panel is a descendant of its originating `.message.assistant .message-bubble`; there is no separate workspace or empty dashboard surface.
- Text-only answers produce ordinary assistant messages. Visual answers render their components in the same response while data loads. Single charts use a compact inline width; a multi-panel overview remains contained within one message.
- Follow-ups create new visual response bubbles. Earlier one-/two-panel snapshots remain intact rather than being replaced by the latest six-panel plan. Server restoration hydrates each message's referenced revision; only the current revision offers data-changing controls. Historical charts still expose underlying values.
- The transcript fills the application surface; the composer remains at the bottom. Enter sends, Shift+Enter inserts a newline, and IME composition is respected. Scrolling up to inspect history stops automatic following of new content.
- Typecheck, build/client-boundary check, formatting, 40 unit tests and 6 integration tests passed.
- Corrected E01–E10 real DeepSeek journey passed: [live report](../artifacts/e2e/2026-11-14T13-26-55-831Z/report/index.html). One deterministic-only fault test remains intentionally skipped in that live project.
- Final compact-layout deterministic journey and four-width checks passed: [browser report](../artifacts/e2e/2026-11-14T13-28-29-778Z/report/index.html). Tests verify historical visual counts after follow-up/reload, full-width conversation and no transcript horizontal overflow.
- Renderer and automated accessibility/keyboard/200%-text checks passed: [spike report](../artifacts/e2e/2026-11-14T13-28-35-607Z/report/index.html).
- The broader unfinished framework tasks above remain unfinished; this correction changes the core interaction model, not the underlying acceptance status of graph support or production deployment.

## Blockers requiring user input

None for running the current local CSV demonstration. DeepSeek configuration and bounded test-data transfer were resolved with the user. The production decisions above are future pilot gates, not reasons to stop local implementation work.

## Question-driven filters and quality trends — 2026-11-14

- Fixed scope is expressed in binding args, not mandatory controls. The exact question `what's payment domain's data quality's trend in 2024` produces three trends, fixed payment/January–December 2024 scope, and no selectors.
- Explicit `avg_comp` plus “let me filter by country” produces one trend and only a country selector. Options respect the remaining fixed payment/year scope and authorization. Changes cannot override an undeclared domain or time argument.
- `csv.monthlyQuality` computes separate unweighted monthly means and observation counts. The independent Python Decimal oracle now includes payment/2024 quality expectations; every previous golden value is unchanged.
- Existing filter tests now explicitly request a domain filter, rather than assuming every response has one. The initial test adapter missed the phrase “domain filter”; fixed its explicit-interaction phrase matching and retained the original user-intent assertions.
- New revisions keep only declared, compatible filter state; historical responses retain their original snapshots. Existing saved responses are not retroactively replanned: ask again to generate the new question-driven response.
- Verification: 43 unit tests, 6 integration tests, 3 deterministic browser scenarios, 2 renderer/accessibility scenarios, and 2 real DeepSeek scenarios passed. One deterministic-only fault scenario is intentionally skipped in the live project. Typecheck, production build, client boundary, oracle verification and formatting passed.
- Evidence: [deterministic](../artifacts/e2e/2026-11-14T13-44-00-233Z/report/index.html), [renderer/accessibility](../artifacts/e2e/2026-11-14T13-44-06-816Z/report/index.html), [live DeepSeek](../artifacts/e2e/2026-11-14T13-44-12-467Z/report/index.html).
- Scope limitation: select controls currently support domain, country, system and month. Custom date-range controls and a generic domain registration system remain future framework tasks; no claim that arbitrary filter types are implemented.
