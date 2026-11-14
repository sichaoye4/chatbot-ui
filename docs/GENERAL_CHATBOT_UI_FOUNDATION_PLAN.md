# General chatbot UI foundation: implementation and testing plan

Date: 2026-11-14  
Status: Implementation underway; see the tracking log for completed checks and unfinished gates. This document specifies the target rather than claiming it is all implemented.  
Tracking: [IMPLEMENTATION_PROGRESS.md](./IMPLEMENTATION_PROGRESS.md)  
Design baseline: [CHATBOT_UI_FRAMEWORK_DESIGN.md](./CHATBOT_UI_FRAMEWORK_DESIGN.md)

## 1. Objective and acceptance standard

Build a reusable foundation for agents that answer questions through conversation and selectively compose data visualizations inside their replies. A dashboard is one possible reply, not the application model. Support both an existing host chat application and the full-screen reference chat.

The supplied CSV becomes one domain plugin and regression fixture. Its fields, business definitions, question patterns, tool names and authorization model must not define framework contracts or global agent behavior.

The decisive acceptance exercise is to integrate an unseen domain and a new component through documented registrations and public APIs, without changing framework source, global prompts or existing plugins. Passing the CSV journey alone does not establish generality.

Product invariants:

- Text-only answers, clarification and unsupported requests are first-class outcomes. Neither charts nor filters are mandatory.
- Visual components belong to the originating assistant message. Follow-ups create revisions; historical messages retain their original scope, meaning and provenance.
- The agent chooses elements, grouping and relevant controls from the question, conversation context, semantic metadata and available capabilities.
- Explicit scope is preserved. Exploration cannot silently replace the requested subject or period.
- Analytical values come from authorized results or approved deterministic calculations with provenance. A model-supplied number is not a trusted dataset.
- Registrations describe capabilities; policy determines permission; the agent chooses a presentation; validation checks that it can execute correctly.
- Extensibility means installing reviewed capabilities, not accepting generated executable HTML, JavaScript, CSS or SQL.

## 2. Current coupling and migration targets

These are source-grounded migration targets, not completed improvements.

| Location                                         | Current coupling                                                                            | Target                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/contracts/index.ts`                    | CSV filters, fixed domain enum and closed panel/action structures                           | Versioned generic response, component, constraint, action and result envelopes    |
| `packages/catalog/index.ts`                      | Domain-based principal, `csv.*` option sources, fixed filter allowlist                      | Unified capability registration and policy-scoped discovery/validation            |
| `packages/agent-adapter/index.ts`                | CSV templates, fact enums and regex routing mixed with provider transport and orchestration | Provider-independent agent interface and capability-guided planner                |
| `packages/server-runtime/queries.ts`, `store.ts` | Domain-specific scope checks and persisted permissions                                      | Host policy adapter, authorized scope fingerprints and versioned revision storage |
| `packages/server-runtime/service.ts`             | CSV fact formatting and filter-option lookup                                                | Generic execution, grounded response materialization and interactions             |
| `packages/ui-kit/panels.tsx`                     | Dataset-specific sort and observation wording                                               | Explicit data-role bindings and metadata-driven rendering                         |
| `packages/renderer-openui/index.tsx`             | Component definitions overlap other registries                                              | Adapter consuming one versioned component manifest                                |
| `apps/reference-chat/src/main.tsx`               | Reusable chat rendering mixed with CSV labels and application wiring                        | Optional chat shell plus domain-configured reference app                          |
| `examples/csv-analytics/*`                       | Owns tools but not all CSV semantics                                                        | Own every CSV schema, metric definition, tool, policy, example and fixture agent  |

Preserve bounded queries, event reduction, staged revisions, immutable message snapshots, pagination, local failure handling and client/server boundary checks. Refactor behind regression tests rather than replace the runtime wholesale.

## 3. Modules and dependency boundaries

Use a modular monorepo initially, not separately deployed services. Create packages only for independently useful implementation or public boundaries.

| Module                          | Responsibility                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `contracts`                     | Protocol versions, IDs/references, response blocks, result envelopes, errors and events              |
| `catalog`                       | Domain/component/control registrations, discovery, schemas and semantic validation                   |
| `server-runtime`                | Query/action execution, planning lifecycle, revision commits, cancellation/replay and grounded facts |
| `agent-adapter`                 | Agent interface, capability-guided planning and bounded repair protocol                              |
| `providers/deepseek` (proposed) | Transport, tool-call translation, usage, timeouts and cancellation                                   |
| `client-runtime`                | Transport interface, event reduction, actions and revision state                                     |
| `ui-kit`, `layout`              | Reviewed components/controls, accessibility and responsive composition                               |
| `renderer-openui`               | Translate validated plans to the selected renderer                                                   |
| `chat-shell` (proposed)         | Optional full-screen conversation, inline artifacts, composer and history                            |
| `examples/*`, reference apps    | Domain semantics, host policy, connectors, fixture agents and application composition                |
| `testing` (proposed)            | Plugin conformance, scripted agents and evaluation helpers                                           |

Enforce import boundaries: core packages cannot import examples or reference apps. Provider modules depend on the agent interface, not vice versa. Separate serializable public descriptors from server executors and client implementations. Browser bundles must contain neither credentials nor server execution/policy code.

## 4. Contracts to establish before implementation

### 4.1 Domain and dataset semantics

A domain plugin registers namespaced, versioned datasets, tools and semantic definitions. Fields have stable IDs separate from labels, physical types, semantic roles, units, null meanings, allowed operations and sensitivity. Temporal fields declare timezone, calendar and supported grains. Measures declare allowed aggregations, formula ownership, denominators, precision and meaningful comparisons/combinations.

Tools declare argument/result schemas, field metadata, supported predicates, sorting/pagination, bounds and provenance. Results carry query identity, source version, execution time, row/grain information, truncation and missingness. A file hash is one source-version strategy, not a universal requirement.

Business defaults and ambiguity handling belong to plugins. The user's three-measure interpretation of unspecified CSV data quality stays in the CSV plugin. Another domain may need clarification. Unknown units or aggregations cannot be inferred from a column name.

Do not build a universal query engine during this migration. Registered tools execute native queries. An optional declarative query capability can expose measures, dimensions and predicates compiled by its connector. Cross-source joins require a registered operation with explicit keys and grain; matching labels never authorize a join.

### 4.2 Component registration and guidance

Each component registration supplies:

- Stable ID/version, serializable property schema and supported dataset shapes.
- Required/optional data roles, type/unit/grain constraints and cardinality limits.
- Selection guidance: useful intents, prerequisites, poor fits and alternatives.
- Layout bounds, supported actions, accessibility behavior and client renderer.
- Semantic validators and conformance fixtures for valid, empty, partial and invalid data.

Generate agent capability descriptions and validation schemas from this registration. Avoid independent lists in prompts, validators and rendering code. Registrations are application-installed code, never model-provided executable code.

Start with metric, temporal line chart, category comparison and table. Advertise relationship rendering only after its graph contract and renderer pass conformance. Other components use the same extension mechanism; a large chart catalog is not a prerequisite for foundation acceptance.

Guidance explains choices rather than prescribing a layout per keyword. A trend may need one multi-series chart or separate panels depending on units and readability. Exact lookup may need text or a table. Comparisons require compatible measures. Different correct compositions should pass evaluation.

### 4.3 Response and planning protocol

Proposed conceptual structure, formalized and versioned in G02:

```text
ResponsePlan(version, capabilitySnapshotId, blocks[])
  text: prose + grounded fact references
  clarification: unresolved semantic choice + optional known choices
  visual: viewId, bindings[], elements[], controls[], layoutIntent

Binding(id, toolRef, validatedArgs, fixedConstraints[], resultContract)
Element(id, componentRef, roleBindings, validatedProps)
Control(id, controlRef, targets[], optionsResolver?, initialValue, purpose)
FactRef(bindingId, resultPath, approvedFormat)
```

The planner receives a compact authorized capability snapshot, conversation context and explicitly referenced prior artifacts. It may discover more capabilities through scoped lookup. Candidate validation returns structured errors and permits repair within configured budgets. Recheck permissions before query/action execution even when discovery was authorized.

Support both the built-in tool-using planner and a host backend agent submitting candidates through the same validation/execution API. DeepSeek is one transport implementation. Scripted agents belong to tests, not the framework's production fallback.

Distinguish hard errors from guidance warnings. A suboptimal but valid chart must not be rejected by a CSV heuristic. Diagnostics record capability IDs and concise declared selection reasons, not private chain-of-thought. Define failure outcomes for unavailable tools, invalid plans, repair exhaustion and cancellation.

Begin with flat groups of elements inside visual blocks, not an arbitrary recursive UI language. Element, row, byte, query and time limits are host policy; retain current conservative limits as reference defaults. Budget exhaustion should produce a useful partial answer, clarification or simplification option.

### 4.4 Scope, controls and actions

Model three separate concepts:

1. **Authorization scope:** server-owned limits, never editable by the agent or UI.
2. **Answer scope:** constraints needed to answer the question, such as an entity or period.
3. **Exploration controls:** typed interactions deliberately offered to explore the answer.

A control targets explicit binding arguments or semantic field references. Never bind by equal labels or automatically apply every control to every panel. Supported predicates are declared by tool/field: equality, membership, numeric interval, temporal range and other registered operations.

Initial controls: single select, multi-select and date range. Add numeric range through the extension exercise. Option resolvers support authorization, dependencies, bounded search/paging, loading/empty/error states and stale selections. Define unset, null and “all permitted values” separately.

Agent guidance:

- Honor explicitly requested controls when supported.
- Exploration intent may justify controls without the literal phrase “add a filter.”
- A fixed entity/period does not automatically become a selector. A control must enable useful exploration rather than repeat every available column.
- If a control deliberately changes initial answer scope, label that behavior clearly and preserve the historical response. Authorization can never broaden.
- Dependent controls resolve under remaining constraints; invalid selections reset visibly according to declared policy.
- Pure data interactions execute registered actions without a model call. Changes needing interpretation create a planning turn/revision.

Actions carry artifact/revision/generation IDs and validated payloads. Specify conflicts, idempotency, cancellation and stale-result rejection. Saved-control compatibility depends on field/tool/control versions and semantics, not equal IDs alone.

### 4.5 Host, policy and persistence integration

Provide two documented entry points: embed inline artifact rendering in an existing chat, or mount the optional reference shell. Both use the same client runtime and event contract. SSE is the initial transport adapter, not a required property of every host agent.

The host supplies authentication and policy: capability visibility, query/row/field access, action permissions, source access and an authorized scope fingerprint for caches. Domain names are host data rather than fixed principal fields. Client-supplied fingerprints are never authorization evidence.

Keep SQLite as the reference storage adapter behind an interface. Version stored plans/events; retain a v1 reader or migration for existing CSV conversations. Unknown component versions display an intelligible unsupported state rather than silently reinterpreting history. Reauthorize restoration; immutable history does not bypass current permissions.

## 5. Implementation tasks and exit gates

Task status is maintained in the progress log. Begin each with contract fixtures or acceptance tests, record evidence there and finish its exit gate before dependent production migration.

| ID  | Deliverable                                                                                                           | Dependencies | Exit gate                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| G01 | Coupling inventory, framework/domain test classification, representative v1 stored conversations and browser baseline | None         | Migration checklist and reproducible baseline without runtime behavior changes                   |
| G02 | V2 contracts, agent/policy interfaces, error taxonomy, lifecycle and compatibility examples from three domains        | G01          | Text, clarification, scoped visuals and interactions represented without CSV enums               |
| G03 | Unified domain/component/control registrations, scoped discovery and generated agent descriptors                      | G02          | Registry conformance; new IDs need no core union or prompt-list edits                            |
| G04 | Move CSV definitions, templates, scripted agent and policy into example/testing ownership                             | G03          | Core import-boundary checks pass; CSV oracle results unchanged                                   |
| G05 | Generic queries, policy checks, options resolvers, cache scopes and provenance                                        | G03–G04      | Tenant/field/scope denial tests pass; no hardcoded domain filter paths                           |
| G06 | Provider-independent planner, validation/repair and extracted DeepSeek transport                                      | G03, G05     | Host agent and DeepSeek use identical contracts; invalid plans cannot execute                    |
| G07 | Generic constraints, typed controls/actions, dependent options and explicit scope changes                             | G05–G06      | Select/multi-select/date-range flows work across two domains; stale-generation/scope checks pass |
| G08 | Metadata/role-driven components and layout; shared manifest with OpenUI adapter                                       | G03, G07     | Component conformance, empty/mixed-unit/accessibility and client-boundary checks pass            |
| G09 | Chat embedding APIs, optional shell, generic response/fact rendering and revision compatibility                       | G06–G08      | Existing-host and full-screen inline flows work; history/reload tests pass                       |
| G10 | Commerce and service-topology plugins with independent fixtures/oracles and full vertical slices                      | G05, G09     | Three structurally different domains run on unchanged core                                       |
| G11 | Held-out plugin plus new component/control, integrated through public APIs                                            | G10          | Consumer builds/runs without internal imports or core/global-prompt edits                        |
| G12 | Generalization evaluation, resilience/security/accessibility and real browser-to-model journeys                       | G10–G11      | Acceptance gates in section 7 met; every failure assigned to its owning layer                    |
| G13 | SDK guides, package exports, compatibility policy and release evidence                                                | G12          | Clean consumer follows guide successfully; production limitations documented                     |

Milestones:

- **M1: contracts and isolation — G01–G04.** Preserve the demo while removing its authority over framework design.
- **M2: reusable vertical slice — G05–G09.** Bring in a minimal commerce fixture here: text → chart → interaction → reload must work before broader polishing.
- **M3: evidence of generality — G10–G12.** Complete multi-domain plugins, held-out extension and live evaluation.
- **M4: usable foundation — G13.** Public APIs and reproducible consumer documentation.

Use incremental compatibility adapters. Do not delete the v1 reader or mutate historical artifacts until migration fixtures pass. Adding templates for every evaluation question does not satisfy these gates.

## 6. Test domains and independent truth

| Domain                     | Distinct concerns                                                                                   | Independent oracle                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Existing CSV operations    | Raw score versus ratio, missing measures, monthly observations and scoped records                   | Existing Python Decimal calculations and CSV goldens                                                      |
| Synthetic commerce         | Order/line-item grains, currency, refunds, weighted rates and daily/monthly time                    | Hand-audited ledger and independent calculation script; no mixed-currency totals or duplicated order sums |
| Synthetic service topology | Entity/edge results, dependency paths, service states, sparse time observations and hidden entities | Explicit graph fixtures and independent path/count expectations; no invented links                        |

Each domain supports text answers, visual answers, clarification and constrained interactions. Graph rendering is an extension, not a core domain branch. Without that capability, the planner must choose a valid table/text alternative or state the limitation.

Separate prompt examples from evaluation cases. Hold-outs include renamed fields, unseen measure combinations and constraints. After interfaces freeze, author a fourth small plugin from the public guide. Record every needed core change as a failed extension gate requiring contract reassessment.

## 7. Test strategy and acceptance

### 7.1 Deterministic checks

- Protocol/schema, registry, plugin conformance and package dependency checks.
- Semantics: units, grain, weighted/unweighted measures, nulls, empty data, temporal boundaries/timezones, truncation and provenance.
- Authorization on discovery, query, options, paging, actions, restoration and caches; include revocation between planning/execution and forged scope arguments.
- Lifecycle: retries, duplicate/out-of-order events, disconnect/replay, cancellation, restart, stale actions, concurrent revisions and partial connector failures.
- UI: role mismatch, unsafe content/props, keyboard/screen-reader labels, underlying table access, responsive layout and no page-level horizontal overflow.
- Compatibility: v1 conversations retain values/scope; incompatible versions fail visibly.

Retain current CSV tests as regression evidence. Extract reusable tests by contract rather than merely changing field names in copied tests. Automated accessibility checks are supplemented with manual keyboard and screen-reader checks.

### 7.2 Agent decision evaluation

Create at least 90 cases: 30 per main domain, with at least 10 per domain held out from prompt/example development. Cover lookup, trend, comparison, detail, multi-measure overview, ambiguous meaning, insufficient capability, explicit controls, exploratory controls and follow-up edits. Add paraphrases without matching regex patches.

Judge semantic constraints and allowed choices, not exact prose, IDs or one layout. Cases declare required measures/scope, acceptable response forms, forbidden claims, acceptable controls and clarification conditions. Human review covers a stratified sample and disputed failures. A model judge cannot establish numerical or authorization correctness.

Metamorphic checks:

- Renamed fields with equivalent metadata preserve meaning.
- Equivalent paraphrases preserve measure, scope and control intent.
- Additional explicit constraints narrow results without unrelated selectors.
- Exploration can introduce useful controls; fixed scope can remove redundant ones.
- Removing a capability yields a valid alternative or limitation, never an invented tool/component.
- Compatible units/grains permit combinations; incompatible ones require separation or approved conversion.
- Restricted users cannot discover hidden values through options, counts, errors, caches or history.

Proposed release gates: all deterministic/security/numeric-oracle checks pass; zero unauthorized execution, fabricated numerical facts or silently changed explicit scope in the evaluation corpus; at least 90% task success overall and 85% per domain. Run each held-out live case three times; report variance, first-pass validity, repaired validity and exhausted repairs separately. These are future acceptance thresholds, not measured results or guarantees beyond the corpus.

Capture latency, tokens, tool counts, result bytes and first-useful-response time by stage. Establish a baseline before choosing performance budgets. Use a separate 100-run representative benchmark for distributions; report deterministic action latency separately from model latency.

### 7.3 Real browser-to-agent integration

Run the actual reference server, real model provider, registered tools and browser. Do not inject finished plans into these live journeys. Scripted fault tests remain separate and explicitly labeled.

For each main domain:

1. Ask a factual question; verify grounded text without unnecessary visuals.
2. Ask an unseen analytical question; verify suitable elements inside its assistant bubble and compare values/units/scope with the independent oracle.
3. Change measure/composition in a follow-up; verify a new revision and unchanged history.
4. Request exploration; operate generated controls and verify dependent options, scoped results and no model call for deterministic actions.
5. Ask a fixed-scope question; verify controls do not silently broaden it.
6. Exercise supported sorting/paging, provenance and empty states.
7. Save/reload/restart; verify conversation restoration under current permissions.
8. Revoke scope and inject connector failure in controlled cases; verify no leakage, local errors and a usable conversation.
9. Ask an ambiguous/unsupported question; verify clarification/limitation rather than invented business meaning.

Also run a minimal host-chat embedding with a host-supplied agent to prove the reference shell and DeepSeek transport are optional.

Archive manifests, model/adapter/catalog versions, fixture versions, sanitized plans/tool traces, oracle comparisons, browser reports and screenshots. Never record credentials or unrestricted records. Reuse the user's approved bounded DeepSeek CSV transfer: schemas, counts, averages and up to 20 selected rows per tool response. Use synthetic data for other domains and keep model payloads bounded.

## 8. Tracking, blockers and scope

Track G01–G13 separately from the original T01–T18 demo tasks in the progress log. Completed tasks need changed boundaries, tests actually run, evidence paths, limitations and migration implications. Issues need an ID, symptom, root cause, owning layer, resolution/test and status. A live failure is not resolved just because its scripted counterpart passes.

Resolve routine engineering choices within this plan. Discuss genuine blockers with the user using the failing case, alternatives and recommendation: undefined business meaning, conflicting product requirements, unavailable authorized credentials or external transfers beyond approval. Production deployment choices do not block local contract or synthetic-domain work.

Assumptions: TypeScript/React remain the stack; OpenUI remains an interchangeable renderer adapter; SQLite remains local reference storage; DeepSeek remains the initial live provider. Generality is proven through interfaces and alternate consumers rather than implementing every provider/database/chart now.

Deferred beyond foundation acceptance: production identity-provider wiring, distributed storage/execution, arbitrary SQL authoring, end-user executable plugins, unrestricted nested UI generation and a large visualization catalog. Document their extension seams without claiming production readiness.

**First implementation step: G01–G02, establishing the migration baseline and cross-domain contracts before changing the agent prompt again.**
