# Foundation v2 Compatibility Policy

`@source/chat-foundation-v2` versions its public TypeScript/ESM package surface, wire protocol, and registered capability contracts separately so independent hosts can upgrade safely without silent wire or validation breakage.

## 1. Package & Runtime Surface

- **Public entrypoints**:
  - `@source/chat-foundation-v2/contracts` (browser + server safe Zod schemas and TypeScript types)
  - `@source/chat-foundation-v2/react` (`ChatShell`, `ResponseRenderer`, `builtinRegistry`, `installedComponents`, presentation types)
  - `@source/chat-foundation-v2/client` (`FoundationHttpClient`, `FoundationSession`, client stream reducers)
  - `@source/chat-foundation-v2/server` (server-only runtime, catalog, control service, backend, SQLite stores; imports `node:*` and must never be bundled into browser code)
  - `@source/chat-foundation-v2/styles.css` (scoped CSS variables and foundation layout styles)
- **Distribution format**: Compiled ESM JavaScript (`dist/**/*.js`) plus generated declaration files (`dist/**/*.d.ts` and `.d.ts.map`) with zero runtime dependency on `tsx` or monorepo source paths.
- **Peer & Engine Requirements**: `react ^19.0.0`, `react-dom ^19.0.0`, `zod ^4.0.0`, `node >=24.14.0`.

## 2. Semantic Versioning Rules

- **PATCH (`0.1.x` / `x.y.z`)**:
  - Bug fixes in validation, normalization, SQLite store durability, focus/ARIA attributes, or rendering that do not tighten existing valid inputs or remove fields.
- **MINOR (`0.x.0` / `x.y.0`)**:
  - Additive optional properties on wire objects (`MaterializedResponse`, `ProtocolEvent`, `ToolRegistration`, `BindingDescriptor`, `Presentation`), new `FoundationError` diagnostic codes, new `builtinRegistry` component ids, or new registered actions.
  - Consumers running against an older minor backend continue negotiating cleanly via `negotiate()` because unsupported optional operations/components remain capability-gated.
- **MAJOR (`x.0.0`)**:
  - Removing a public symbol or subpath export, tightening an existing required schema field, changing semantics of an existing capability version (`id@1`), or dropping support for a peer dependency major version.

## 3. Wire Protocol & Capability Versioning

- **Wire envelope (`protocolVersion: 2`)**:
  - Every `ProtocolEvent`, `MaterializedResponse`, `ControlUpdateResult`, and `ConversationSnapshot` carries `protocolVersion: 2`.
  - Incompatible envelope changes require bumping `protocolVersion` to `3` and adding an explicit adapter or negotiation path rather than mutating v2 invariants.
  - Legacy v1 records remain strictly separated: `MaterializedResponse.safeParse` and `ConversationSnapshot.safeParse` reject v1 payloads.
- **Capabilities (`id@version`)**:
  - Tools, UI components, and interactive actions (`ui.sort@1`, `ui.paginate@1`, `ui.refresh@1`, `core.table@1`, etc.) use explicit integer `version` numbers.
  - Breaking input/role/payload schema changes for a tool, component, or action **must** introduce a new version (e.g. `core.table@2` or `ui.sort@2`) while keeping `@1` registered during the deprecation window.
- **Session capability negotiation (`GET /v2/options` / `BackendClient.negotiate()`)**:
  - Clients must treat omitted operations (`replay`, `cancellation`, `history`) or unregistered actions as disabled rather than assuming fixed server features.

## 4. Deprecation Window & Breaking Changes

- Deprecated fields, actions, or component versions remain supported and documented for at least one minor release cycle before removal in the next major release.
- Deprecations must emit clear diagnostics or documentation notes in `docs/FOUNDATION_V2_CONTRACTS.md` before removal.
