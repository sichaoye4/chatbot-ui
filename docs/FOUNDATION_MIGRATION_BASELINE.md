# Foundation migration baseline (G01)

Captured 2026-11-14 before switching any reference-app execution to v2.

## Existing behavior and evidence

- 43 unit tests, six integrations and three deterministic browser scenarios passed.
- Browser report: [baseline report](../artifacts/e2e/2026-11-14T14-04-48-536Z/report/index.html).
- The HTTP baseline initially failed with sandbox loopback `EACCES`; rerunning with local-network permission passed. This was not an application regression.
- Browser baseline uses the existing built v1 application. New v2 implementation must be built and separately exercised before claiming browser coverage.
- `tests/fixtures/v1-conversation.json` freezes two serialized v1 revisions with synthetic data. Tests seed those bodies directly and reopen SQLite; they do not rebuild expected plans from current code. `scripts/capture-v1-fixture.ts` is a manual capture utility, never part of test setup.
- The running user preview and its database are not migration-test targets.

## Test ownership

| Existing test                                    | Classification                                             | Migration treatment                                                                |
| ------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `unit/client.test.ts`                            | Framework event/layout behavior with v1 payloads           | Preserve and add v2 lifecycle cases when client switches                           |
| `unit/contracts.test.ts`                         | Mixed: generic rejection invariants, CSV schemas/templates | Retain legacy checks; v2 schema/registry checks live in `unit/foundation.test.ts`  |
| `unit/data.test.ts`                              | CSV domain and scoped query behavior                       | Keep oracle assertions domain-owned; extract generic policy conformance separately |
| `unit/dynamic-filters.test.ts`                   | CSV question routing and fixed-scope regression            | Preserve as legacy behavior, not a general-agent evaluation                        |
| `integration/runtime.test.ts`                    | Mixed storage/HTTP lifecycle and CSV workflow              | Preserve until runtime/API migration; add generic executor tests independently     |
| `integration/recovery.test.ts`                   | Framework lifecycle with CSV fixture                       | Retain; port payloads only when v2 event protocol is ready                         |
| `e2e/journey.spec.ts`, `dynamic-filters.spec.ts` | CSV reference-app journeys                                 | Keep unchanged until v2 renderer/agent migration; not multi-domain evidence        |
| `e2e/spike.spec.ts`                              | Renderer, layout, accessibility                            | Preserve and extend with component-registration conformance                        |

## Coupling removal checklist

- [ ] Move v1 `Filters`/domain schema out of shared contracts when compatibility imports can be changed safely.
- [ ] Replace domain-list principals with host policy/context in runtime and storage.
- [ ] Replace catalog `csv.*` option-source and filter allowlists with registered controls/resolvers.
- [x] Move deterministic CSV phrase routing, business prompt and explanation templates out of shared agent adapter (now `examples/csv-analytics/legacy-agent.ts`).
- [x] Remove service-owned CSV fact formatting: v1 presentation is injected from the example; v2 materializes registered fact references.
- [ ] Replace filter action merging and option lookup with explicit generic targets and validated resolvers.
- [ ] Remove renderer defaults derived from CSV field names and observation wording.
- [ ] Extract reference chat from CSV labels, suggestions and application wiring.
- [ ] Add package import/export boundary checks and public consumer tests as migration completes.

The new v2 files are an additive migration seam. Unchecked items remain coupled in the v1 reference application; the checked ownership extractions preserve its behavior.
