import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FoundationCatalog } from '../packages/catalog/foundation.ts';
import { registerBuiltins } from '../packages/catalog/builtins.ts';
import { AuthorizedConversations } from '../packages/server-runtime/authorized-conversations.ts';
import { AuthorizedRequestJournal, type JournalPolicy } from '../packages/server-runtime/authorized-journal.ts';
import { FoundationBackend } from '../packages/server-runtime/backend.ts';
import { SqliteControlSnapshotStore } from '../packages/server-runtime/control-sqlite.ts';
import { FoundationControlService } from '../packages/server-runtime/controls.ts';
import { SqliteConversationStore } from '../packages/server-runtime/conversation-store.ts';
import { SqliteRequestJournal } from '../packages/server-runtime/request-journal.ts';
import { ResponseRenderer } from '../packages/renderer-openui/foundation.tsx';
import { builtinRegistry } from '../packages/renderer-openui/builtins.tsx';
import { FoundationError, type PlanningAgent, type Principal, type ResponsePlan } from '../packages/contracts/foundation.ts';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(3));
}

function summarize(name: string, samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    name,
    iterations: sorted.length,
    minMs: Number(sorted[0].toFixed(3)),
    meanMs: Number((sum / sorted.length).toFixed(3)),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

const dir = mkdtempSync(join(tmpdir(), 'foundation-bench-'));
try {
  const dbPath = join(dir, 'bench.sqlite');
  const rows = Array.from({ length: 120 }, (_, i) => ({
    id: `R-${String(i + 1).padStart(3, '0')}`,
    region: i % 2 === 0 ? 'east' : 'west',
    day: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
    amount: 100 + i * 3,
  }));
  const regions = ['east', 'west'];

  const catalog = registerBuiltins(
    new FoundationCatalog({
      visible: () => true,
      authorize: async (_tool, _args, principal) => ({ scopeKey: principal.subject, context: {} }),
    }),
  );

  catalog.registerOptionResolver({
    ref: { id: 'bench.regions', version: 1 },
    resolve: async () => ({
      options: regions.map((r) => ({ value: r, label: r.toUpperCase() })),
      nextCursor: null,
    }),
    accepts: async ({ value }) => regions.includes(value),
  });

  catalog.registerDomain({
    ref: { id: 'bench.sales', version: 1 },
    description: 'Synthetic benchmark sales domain',
    semantics: ['One row per order record'],
    tools: [
      {
        ref: { id: 'bench.orders', version: 1 },
        description: 'Query synthetic orders',
        args: z
          .object({
            region: z.string().nullable().optional(),
            sortField: z.enum(['day', 'amount']).optional(),
            sortDirection: z.enum(['asc', 'desc']).optional(),
            cursor: z.string().nullable().optional(),
          })
          .strict(),
        interactive: {
          region: {
            description: 'Filter region',
            controls: [{ id: 'ui.select', version: 1 }],
            options: { id: 'bench.regions', version: 1 },
          },
        },
        grain: 'one synthetic order record',
        refreshable: true,
        sorting: { fieldArg: 'sortField', directionArg: 'sortDirection', fields: ['day', 'amount'] },
        pagination: { cursorArg: 'cursor' },
        fields: [
          { id: 'id', label: 'Order ID', type: 'string', role: 'identifier', nullable: false, description: 'ID' },
          { id: 'region', label: 'Region', type: 'string', role: 'dimension', nullable: false, description: 'Region' },
          { id: 'day', label: 'Day', type: 'string', role: 'time', nullable: false, description: 'Day' },
          {
            id: 'amount',
            label: 'Amount',
            type: 'number',
            role: 'measure',
            nullable: false,
            description: 'Order amount',
            unit: 'USD',
            measure: { aggregation: 'Total amount', precision: 0, additive: true },
          },
        ],
        execute: async (args) => {
          const filtered =
            typeof args.region === 'string' ? rows.filter((r) => r.region === args.region) : rows;
          const sortField = args.sortField === 'day' ? 'day' : 'amount';
          const dir = args.sortDirection === 'asc' ? 'asc' : 'desc';
          const sorted = [...filtered].sort((a, b) => {
            const cmp = sortField === 'amount' ? a.amount - b.amount : a.day.localeCompare(b.day);
            return dir === 'asc' ? cmp : -cmp;
          });
          const offset = typeof args.cursor === 'string' ? Number(args.cursor) : 0;
          const page = sorted.slice(offset, offset + 25);
          const nextCursor = offset + page.length < sorted.length ? String(offset + page.length) : null;
          return {
            rows: page,
            provenance: {
              sourceId: 'bench.sales',
              sourceVersion: '1',
              queryId: 'qbench',
              executedAt: '2026-01-01T00:00:00Z',
              grain: 'one synthetic order record',
              truncated: nextCursor !== null,
              nextCursor,
              warnings: [],
            },
          };
        },
      },
    ],
  });

  const principal: Principal = { subject: 'bench-user', context: {} };
  const owner = (p: Principal) => p.subject;
  const snapshots = new SqliteControlSnapshotStore(dbPath);
  const controls = new FoundationControlService(catalog, owner, snapshots);
  const requestStore = new SqliteRequestJournal(dbPath, { maxEvents: 100, retentionMs: 86_400_000 });
  const policy: JournalPolicy = {
    owner,
    scope: async (cid, p) => `${p.subject}:${cid}`,
    response: async (resp, p, signal) => {
      const stored = await controls.read(resp.responseId, p, signal, resp.revision, resp.generation);
      if (!isDeepStrictEqual(stored, resp))
        throw new FoundationError({ code: 'DATA_FORBIDDEN', path: '', message: 'Mismatch' });
    },
    recovery: async (rid, p, signal) => {
      await controls.read(rid, p, signal);
    },
  };
  const authedConversations = new AuthorizedConversations(
    new SqliteConversationStore(requestStore.connectionForConversations()),
    controls,
    policy,
  );
  const journal = new AuthorizedRequestJournal(requestStore, policy);

  const agent: PlanningAgent = {
    async propose({ capabilities, feedback }) {
      if (feedback.length) console.error('Plan feedback:', JSON.stringify(feedback));
      const plan: ResponsePlan = {
        schemaVersion: 2,
        capabilitySnapshotId: capabilities.id,
        bindings: [
          {
            id: 'orders',
            tool: { id: 'bench.orders', version: 1 },
            args: { region: null },
            fixedArgs: {},
          },
        ],
        facts: [],
        blocks: [
          {
            id: 'intro',
            kind: 'text',
            parts: [{ text: 'Synthetic benchmark table.' }],
          },
          {
            id: 'visual',
            kind: 'visual',
            layoutIntent: 'auto',
            controls: [
              {
                id: 'regionFilter',
                control: { id: 'ui.select', version: 1 },
                label: 'Region',
                purpose: 'Choose a region',
                scopeMode: 'within-answer',
                initialValue: null,
                dependsOn: [],
                targets: [{ bindingId: 'orders', argument: 'region' }],
              },
            ],
            elements: [
              {
                id: 'ordersTable',
                component: { id: 'ui.table', version: 1 },
                title: 'Benchmark orders',
                roles: {
                  columns: [
                    { bindingId: 'orders', fieldId: 'id' },
                    { bindingId: 'orders', fieldId: 'region' },
                    { bindingId: 'orders', fieldId: 'day' },
                    { bindingId: 'orders', fieldId: 'amount' },
                  ],
                },
                props: {},
              },
            ],
          },
        ],
      };
      return plan;
    },
  };

  const backend = new FoundationBackend(catalog, agent, controls, authedConversations, journal, policy, {
    workerId: 'bench-worker',
  });

  const turnLatencies: number[] = [];
  const actionLatencies: number[] = [];
  const renderLatencies: number[] = [];
  let latestResponse: any;

  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    let committed: any;
    for await (const event of backend.turn(
      {
        conversationId: 'benchconv',
        messageId: `msg${i}`,
        idempotencyKey: `idemturn${i}`,
        text: 'Show orders',
        previous: [],
        components: [{ id: 'ui.table', version: 1 }],
      },
      principal,
      AbortSignal.timeout(10_000),
    )) {
      if (event.type === 'request.failed') {
        console.error('Turn failed event:', event);
      }
      if (event.type === 'response.committed') committed = event.response;
    }
    const elapsed = performance.now() - start;
    assert.ok(committed, `Turn ${i} committed`);
    latestResponse = committed;
    turnLatencies.push(elapsed);
  }

  let cursorResp = latestResponse;
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    const isFilter = i % 2 === 0;
    let updated: any;
    for await (const event of backend.action(
      isFilter
        ? {
            responseId: cursorResp.responseId,
            revision: cursorResp.revision,
            generation: cursorResp.generation,
            idempotencyKey: `idemact${i}`,
            action: { id: 'ui.setControl', version: 1 },
            payload: { controlId: 'regionFilter', value: i % 4 === 0 ? 'east' : 'west' },
          }
        : {
            responseId: cursorResp.responseId,
            revision: cursorResp.revision,
            generation: cursorResp.generation,
            idempotencyKey: `idemact${i}`,
            action: { id: 'ui.sort', version: 1 },
            payload: {
              bindingId: 'orders',
              fieldId: 'amount',
              direction: i % 4 === 1 ? 'asc' : 'desc',
            },
          },
      principal,
      AbortSignal.timeout(10_000),
    )) {
      if (event.type === 'response.committed') updated = event.response;
    }
    const elapsed = performance.now() - start;
    assert.ok(updated, `Action ${i} committed`);
    cursorResp = updated;
    actionLatencies.push(elapsed);
  }

  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    const html = renderToStaticMarkup(
      createElement(ResponseRenderer, { response: cursorResp, registry: builtinRegistry }),
    );
    const elapsed = performance.now() - start;
    assert.ok(html.includes('Benchmark orders'));
    renderLatencies.push(elapsed);
  }

  const metrics = {
    recordedAt: new Date().toISOString(),
    iterations: 100,
    turn: summarize('backend.turn (plan + execute + ingest + persist)', turnLatencies),
    action: summarize('backend.action (ui.setControl + ui.sort)', actionLatencies),
    render: summarize('ResponseRenderer SSR markup (25 rows + control)', renderLatencies),
  };

  assert.ok(metrics.turn.p95Ms < 250, `Expected turn p95 < 250ms, got ${metrics.turn.p95Ms}`);
  assert.ok(metrics.action.p95Ms < 250, `Expected action p95 < 250ms, got ${metrics.action.p95Ms}`);
  assert.ok(metrics.render.p95Ms < 100, `Expected render p95 < 100ms, got ${metrics.render.p95Ms}`);

  const outDir = resolve('artifacts/foundation');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'benchmark-v2.json'), JSON.stringify(metrics, null, 2));
  const md = [
    '# Foundation v2 Benchmark Report (100 iterations)',
    '',
    `Recorded at: \`${metrics.recordedAt}\``,
    '',
    '| Operation | Iterations | Min (ms) | Mean (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Max (ms) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...[metrics.turn, metrics.action, metrics.render].map(
      (m) =>
        `| ${m.name} | ${m.iterations} | ${m.minMs} | ${m.meanMs} | ${m.p50Ms} | ${m.p95Ms} | ${m.p99Ms} | ${m.maxMs} |`,
    ),
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'benchmark-v2.md'), md);
  console.log(md);
} finally {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Best-effort cleanup
  }
}
