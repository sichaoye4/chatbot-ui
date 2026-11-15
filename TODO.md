# V2 chatbot foundation: remaining work

Status: paused on 2026-11-15. The v2 reference path is experimental; completing this list requires the acceptance checks in [the v2 contract](docs/FOUNDATION_V2_CONTRACTS.md) and [general foundation plan](docs/GENERAL_CHATBOT_UI_FOUNDATION_PLAN.md).

## First: finish the interrupted field-visibility work

- [ ] Complete and review the in-progress `Policy.visibleField` and `fieldProjectionSafe` changes in the catalog, contracts and runtime. They were interrupted before completion and have not been tested.
- [ ] Carry field permissions through discovery, result projection, ingestion, annotations, options, retries, snapshot persistence and restoration. Recheck changes in field visibility and authorization before publication and on every later read. Preserve compatibility with existing unrestricted snapshots.
- [ ] Add security tests for hidden fields, projections, option/annotation leakage, permission revocation and concurrent changes. Do not treat the current implementation as a production field-level security boundary until these pass and the host policy responsibilities are documented.

## Correctness and interactions

- [ ] Prevent or reliably detect unsupported semantic claims, including presenting a daily value as an annual total. Fact row context is displayed, but model-written prose is not semantically verified.
- [ ] Implement and test scope-changing controls as new answer revisions with explicit transcript context.
- [ ] Complete generic registered actions, including sort, pagination and refresh; broaden scoped retry and partial-failure coverage.
- [ ] Complete the event taxonomy, cancellation/replay and compatibility coverage, including frozen v1 restoration and non-TypeScript wire fixtures.

## Integration and release

- [ ] Replace the loopback demo identity with host authentication and production authorization; define and enforce retention and multi-worker deployment behavior.
- [ ] Complete the consumer SDK: stable compatibility policy, compiled distribution, a fresh external installation and a production-style independent backend integration.
- [ ] Run the planned held-out evaluation: at least 90 cases across the main domains, with held-out cases repeated three times and semantic errors, repairs and unsupported requests reported. Existing exploratory synthetic runs do not satisfy this gate.
- [ ] Complete security, numerical-oracle, manual screen-reader, accessibility, performance and live browser-to-DeepSeek acceptance checks. Review the latest evidence and unresolved failures in [implementation progress](docs/IMPLEMENTATION_PROGRESS.md).
