# V2 foundation contracts and current implementation

Implemented increment: 2026-11-14. This is an additive backend foundation; the reference browser application still uses the v1 compatibility protocol.

## Public seams implemented

| Source                                         | Executable responsibility                                                                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/foundation.ts`             | Strict response blocks, bindings, data roles, typed controls, grounded fact references, provenance, action envelope, agent/policy interfaces and structured diagnostics |
| `packages/catalog/foundation.ts`               | Versioned registrations, authorized discovery, JSON Schema descriptors, cross-reference/role/unit/grain validation, safe default scope and result validation            |
| `packages/catalog/builtins.ts`                 | Metric/trend/comparison/table contracts and select/multi-select/date-range contracts with selection guidance                                                            |
| `packages/server-runtime/foundation.ts`        | Bounded plan repair, query authorization before/after execution, result checking and deterministic fact formatting                                                      |
| `packages/agent-adapter/foundation.ts`         | Provider-independent planning instructions and model interface                                                                                                          |
| `packages/agent-adapter/providers/deepseek.ts` | Credential/transport handling, structured output, timeout and usage reporting                                                                                           |
| `examples/csv-analytics/foundation.ts`         | Real CSV aggregate plugin and host-owned v1 identity bridge                                                                                                             |

`pnpm check:foundation` checks that the isolated foundation files do not import v1 modules, domain examples or applications. This is a conservative source import guard, not a complete security analysis. The remaining legacy packages are deliberately outside that isolation claim.

## Request flow

1. The host authenticates a `Principal`; identity/context is never taken from the model plan.
2. `FoundationCatalog.snapshot(principal)` exposes authorized tools/components/controls and domain semantics. Executors, credentials and host context are excluded.
3. A `PlanningAgent` proposes a v2 plan. The included capability planner uses generated descriptors rather than CSV templates. An external backend agent may implement the same interface.
4. `FoundationRuntime.plan` validates the proposal and returns structured feedback for at most the configured repair budget (default one).
5. `FoundationRuntime.execute` validates again, authorizes each query, executes registered tools and validates returned fields/types/grain/provenance. It rechecks authorization after tool execution.
6. Fact references are materialized from result rows. Visual elements retain explicit role references to their datasets; actual browser rendering is a subsequent migration task.

The initial planner is schema-guided: it does not inspect query samples or dynamically discover additional tools during planning. The snapshot contains all registered permitted capabilities. Discovery paging, provider-facing sample budgets and exploratory tool loops remain future work.

## Scope and control invariants

Bindings accept `args` and `fixedArgs` without overlapping keys. Validation produces a canonical plan: arguments are fixed by default. Only a declared `within-answer` control keeps its owned argument editable. A `change-answer` control targets fixed scope explicitly, with a user-visible label/purpose and matching initial value.

This normalization addresses observed model variation: placing the same constraint in `args` rather than `fixedArgs` must not silently make it editable. It uses control ownership rather than business-field names or question regexes. It preserves effective query values and does not mutate the caller's proposal.

Controls must use a registered tool-argument/control pairing, target bindings displayed in their own visual block, start with the query's initial value and have an acyclic dependency graph. Two controls cannot own the same target. Controls cannot supply identities or arbitrary option URLs.

The current implementation validates control plans only. Option resolvers, action execution, generation handling and browser controls are not yet implemented for v2. The v1 application retains its separately tested CSV controls.

## Data and presentation semantics

Fields declare stable IDs, labels, types, semantic roles, null meaning, units and measure/time metadata. A component declares accepted role types/cardinalities, shared-unit/grain rules, property schema and guidance. New IDs/versions do not require editing a core union.

Cross-binding components are rejected by the built-in contracts; a reviewed join operation must return a coherent dataset first. Result rows must match the registered projection. Nullable measures cannot be silently zero-filled. Unsupported component versions and unknown fields fail validation.

`executedAt` is an ISO query timestamp. `sourceAsOf` optionally records the source reporting period. `sourceVersion` is opaque: a CSV hash and a synthetic fixture version both work. They are distinct concepts, not interchangeable timestamps.

Text fact tokens are grounded; free-form prose is not numerically/semantically verified by the structural validator. Prevention of unsupported claims requires the agent guidance and evaluation gates, with further runtime semantic validation considered as those tests expose failures. Structural validity alone does not prove the agent answered the intended question.

## Compatibility and evidence

The v1 protocol remains readable. A frozen two-revision conversation fixture is loaded directly into SQLite and reopened; historical message attachments, values and access restrictions are checked. The fixture uses synthetic values and is not an analytics oracle.

CSV-specific prompts, deterministic routing and explanation text now live in `examples/csv-analytics/legacy-agent.ts`. CSV fact formatting lives in `presentation.ts` and is injected by the reference application. Shared v1 contracts/policy/storage/filter handling still contain CSV coupling and remain migration work.

New tests include three domain contract fixtures, renamed fields, extension registrations, mixed units, scope conflicts, malformed results, authorization changes, bounded repair and actual CSV execution. The real DeepSeek smoke suite covers two grounded text questions and two visual/control planning questions. It runs backend-to-provider-to-tool execution, **not v2 browser integration**, and is much smaller than the planned held-out evaluation corpus.

```powershell
pnpm typecheck
pnpm check:foundation
pnpm test:unit
pnpm test:integration
pnpm build
pnpm test:e2e:deterministic
pnpm test:spike
# Opt-in external provider test; requires approved data scope and configured server credentials.
pnpm test:foundation:live
```

Remaining boundaries: v2 event/revision storage adapters, field-level authorization conformance, generic options/actions, renderer/client integration, full domain plugins, public package consumer tests and release-scale agent evaluation. No production-readiness claim is made.
