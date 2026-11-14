# OpenUI adoption spike

Decision: retain **@openuidev/react-lang 1.1.1** for the current reference implementation. This decision applies to the tested flat-plan adapter; it does not approve unrestricted model-generated OpenUI, hosted generation/repair, or telemetry.

The package's installed exports and types were checked alongside [component documentation](https://www.openui.com/docs/openui-lang/defining-components) and [renderer documentation](https://www.openui.com/docs/openui-lang/renderer). The framework compiles a single registered component call per panel using JSON string serialization. Panel data comes from React context. `toolProvider` is explicitly null. The framework owns the outer grid, revisions and data execution. Optional package postinstall telemetry is disabled in workspace policy.

Executed browser evidence:

- One through six separately bound panel renderers mounted successfully.
- Unicode, quotes, backslashes, newlines and strings resembling scripts/tool calls remained literal text.
- Chart disclosure state survived the live follow-up edit with unchanged panel identity.
- Renderer interactions caused no backend tool or model calls; browser requests remained local.
- Metric, trend, comparison and table components were exercised using the actual CSV tools. Per-panel source errors retain their slots and recover on retry.
- Automated WCAG A/AA checks, keyboard dialog opening/Escape/focus restoration, and 200% text scaling passed after contrast and keyboard-scroll fixes.
- Current complete client bundle is about 433 kB / 135 kB gzip, including React, Zod, the app and OpenUI. This is not an isolated incremental OpenUI cost measurement.

Passing spike evidence: `artifacts/e2e/2026-11-14T13-02-29-691Z/`. The earlier contrast failure is retained separately. Manual screen-reader review, broader render-exception/error-state coverage, comparative bundle cost and relationship-panel behavior remain open. Reevaluate the design's direct React fallback if those gates expose unacceptable costs.
