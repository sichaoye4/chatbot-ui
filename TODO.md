# V2 chatbot foundation: remaining work

Status: implementation, contract parity fixes, consumer packaging, and automated acceptance suites completed on 2026-11-16. Manual assistive-technology human screen-reader sign-off remains a host manual step. See [the v2 contract](docs/FOUNDATION_V2_CONTRACTS.md), [general foundation plan](docs/GENERAL_CHATBOT_UI_FOUNDATION_PLAN.md), and [implementation progress](docs/IMPLEMENTATION_PROGRESS.md).

## First: finish the interrupted field-visibility work

- [x] Complete and review the in-progress `Policy.visibleField` and `fieldProjectionSafe` changes in the catalog, contracts and runtime.
- [x] Carry field permissions through discovery, result projection, ingestion, annotations, options, retries, snapshot persistence and restoration. Recheck changes in field visibility and authorization before publication and on every later read. Preserve compatibility with existing unrestricted snapshots.
- [x] Add security tests for hidden fields, projections, option/annotation leakage, permission revocation and concurrent changes; document host policy responsibilities in `docs/FOUNDATION_V2_CONTRACTS.md` (§11).

## Correctness and interactions

- [x] Prevent or reliably detect unsupported semantic claims, including presenting a daily value as an annual total (`validateTextClaims` and grain checks).
- [x] Implement and test scope-changing controls (`change-answer`) as new answer revisions with explicit transcript context and `dependentPolicy` (`reject` / `reset`).
- [x] Complete generic registered actions, including `ui.sort`, `ui.paginate`, `ui.refresh`, `registerAction`, and multi-binding retry and partial-failure coverage.
- [x] Complete the event taxonomy (`plan.accepted`, `binding.pending`, `binding.ready`, `binding.failed`), cancellation/replay and compatibility coverage, including frozen v1 non-reinterpretation guards and non-TypeScript wire fixtures (`tests/fixtures/wire-v2/*.json` + `tests/oracles/verify_wire_v2.py`).

## Integration and release

- [x] Replace the loopback demo identity with configurable host HMAC/pluggable authentication (`401 AUTHENTICATION_EXPIRED`) and enforce retention purging and multi-worker lease/cancel deployment behavior.
- [x] Complete the consumer SDK: compatibility policy (`docs/FOUNDATION_V2_COMPATIBILITY_POLICY.md`), compiled ESM + `.d.ts` tarball distribution (`scripts/package-foundation-v2.mjs`), fresh external installation outside the repo, and production-style independent pure-Node HTTP backend (`scripts/test-foundation-consumer.mjs`).
- [x] Run the planned 90-run held-out DeepSeek evaluation across three domains (`commerce`, `operations-topology`, `csv.analytics`: 10 held-out prompts/domain repeated 3x = 90 runs; 88/90 = 97.8% passed).
- [x] Complete security, numerical-oracle, automated accessibility (desktop, 200% zoom viewport, 375px mobile, keyboard navigation, Axe WCAG 2.0/2.1 AA), performance benchmarks (`artifacts/foundation/benchmark-v2.json`), and live browser-to-DeepSeek acceptance checks.
- [ ] Manual human assistive-technology screen-reader review (NVDA/VoiceOver manual walkthrough in host environment; automated Axe/ARIA/keyboard gates passed).
