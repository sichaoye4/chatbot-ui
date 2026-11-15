# Experimental v2 consumer guide

This is an experimental React/TypeScript source distribution. It is not a stable or published npm release. It requires a TypeScript-aware build tool, React 19, React DOM 19 and Zod 4. Server consumers also need Node 24.14 or later and Node type definitions. The included SQLite adapters use Node's experimental `node:sqlite` API.

From the repository root, run `node scripts/package-foundation-v2.mjs my-build` with a new output name. The package is staged at `artifacts/foundation-sdk/my-build`. Its `package.json` exposes these entry points:

| Import | Purpose |
| --- | --- |
| `@source/chat-foundation-v2/contracts` | Serializable schemas and the `BackendClient` interface |
| `@source/chat-foundation-v2/react` | `ChatShell`, `ResponseRenderer`, registry and presentation types |
| `@source/chat-foundation-v2/client` | HTTP/SSE adapter and event reducer |
| `@source/chat-foundation-v2/server` | Optional catalog, validation, runtime, backend and storage interfaces |
| `@source/chat-foundation-v2/styles.css` | Default styles |

Install the staged directory as a package using the host's package manager; do not copy individual source files into the application. The current verification resolves external dependencies from this workspace and does not establish a clean installation from a public registry. Package exports and compatibility may change while the v2 delivery gates remain open.

For an existing chat, supply a validated materialized response and a versioned renderer registry to `ResponseRenderer`. For the full interface, pass `ChatShell` a conversation ID, registry and `BackendClient`. The client supplies transport and history; negotiate the intersection of backend capabilities and installed renderers. The React components do not supply authentication or call an agent provider. A custom renderer is registered under `capability.id@version` and receives its declared fields and result data.

The host backend remains responsible for identity, authorization, source ownership, retention and its wire adapter. The optional server runtime can validate and ingest trusted precomputed results or execute registered tools; its policies must be configured by the host. Do not import the server entry into browser code or treat model output as authorized data. See [v2 contracts](FOUNDATION_V2_CONTRACTS.md) for the complete target and [progress](IMPLEMENTATION_PROGRESS.md) for implemented scope.

`pnpm test:foundation:consumer` builds a separate synthetic host using the staged exports, checks the server entry and browser bundle, and exercises a host-owned event stream and history. The fixture is illustrative, not an LLM or production integration.
