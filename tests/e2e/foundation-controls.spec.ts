import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { z } from 'zod';
import AxeBuilder from '@axe-core/playwright';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import { FoundationControlService } from '../../packages/server-runtime/controls.ts';
import {
  domains,
  field,
  permissivePolicy,
  plan,
  principal,
  result,
} from '../fixtures/foundation-domains.ts';
import type { ResponsePlan } from '../../packages/contracts/foundation.ts';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  const catalog = registerBuiltins(new FoundationCatalog(permissivePolicy));
  catalog.registerOptionResolver({
    ref: { id: 'fixture.regions', version: 1 },
    resolve: async () => ({
      options: [
        { value: 'east', label: 'East' },
        { value: 'west', label: 'West' },
      ],
      nextCursor: null,
    }),
    accepts: async ({ value }) => ['east', 'west'].includes(value),
  });
  const domain = domains[1];
  const tool = domain.tools[0];
  catalog.registerDomain({
    ...domain,
    tools: [
      {
        ...tool,
        interactive: {
          ...tool.interactive,
          region: { ...tool.interactive.region, options: { id: 'fixture.regions', version: 1 } },
        },
        execute: async (args, context, signal) => {
          if (args.region === 'west') throw new Error('fixture source failure');
          return tool.execute(args, context, signal);
        },
      },
    ],
  });
  let sourceAttempts = 0;
  catalog.registerDomain({
    ...domains[0],
    tools: [
      {
        ...domains[0].tools[0],
        execute: async (...args) => {
          if (sourceAttempts++ === 0) throw new Error('fixture source failure');
          return domains[0].tools[0].execute(...args);
        },
      },
    ],
  });
  catalog.registerOptionResolver({
    ref: { id: 'warehouse.categories', version: 1 },
    resolve: async () => ({
      options: [
        { value: 'books', label: 'Books' },
        { value: 'tools', label: 'Tools' },
      ],
      nextCursor: null,
    }),
    accepts: async ({ value }) => ['books', 'tools'].includes(value),
  });
  catalog.registerDomain({
    ref: { id: 'warehouse.domain', version: 1 },
    description: 'Synthetic warehouse',
    semantics: ['Counts represent inventory.'],
    tools: [
      {
        ref: { id: 'warehouse.stock', version: 1 },
        description: 'Stock by date and category',
        args: z.strictObject({
          categories: z
            .array(z.enum(['books', 'tools']))
            .min(1)
            .max(2)
            .nullable(),
          period: z.tuple([z.iso.date(), z.iso.date()]),
        }),
        fields: [
          field('day', 'date', 'time'),
          field('category', 'string', 'dimension'),
          field('units', 'number', 'measure', 'items'),
        ],
        grain: 'one row per category',
        interactive: {
          categories: {
            description: 'Categories',
            controls: [{ id: 'ui.multiSelect', version: 1 }],
            options: { id: 'warehouse.categories', version: 1 },
          },
          period: { description: 'Date range', controls: [{ id: 'ui.dateRange', version: 1 }] },
        },
        execute: async (args) => {
          const categories = args.categories as string[] | null;
          const period = args.period as string[];
          return result(
            [
              { day: '2024-01-01', category: 'books', units: 7 },
              { day: '2024-01-01', category: 'tools', units: 12 },
            ].filter(
              (row) =>
                (!categories || categories.includes(row.category)) &&
                row.day >= period[0] &&
                row.day <= period[1],
            ),
            'one row per category',
          );
        },
      },
    ],
  });
  let orderRefreshCount = 0;
  catalog.registerOptionResolver({
    ref: { id: 'orders.tiers', version: 1 },
    resolve: async () => ({
      options: [
        { value: 'retail', label: 'Retail' },
        { value: 'wholesale', label: 'Wholesale' },
      ],
      nextCursor: null,
    }),
    accepts: async ({ value }) => ['retail', 'wholesale'].includes(value),
  });
  catalog.registerDomain({
    ref: { id: 'orders.domain', version: 1 },
    description: 'Orders domain',
    semantics: ['Orders'],
    tools: [
      {
        ref: { id: 'orders.list', version: 1 },
        description: 'Orders list',
        args: z.strictObject({
          tier: z.enum(['retail', 'wholesale']).nullable().optional(),
          sort: z.enum(['date', 'item', 'amount']).optional(),
          direction: z.enum(['asc', 'desc']).optional(),
          cursor: z.string().optional(),
        }),
        fields: [
          field('date', 'date', 'time'),
          field('item', 'string', 'dimension'),
          field('amount', 'number', 'measure', 'items'),
        ],
        grain: 'one row per order',
        refreshable: true,
        sorting: {
          fieldArg: 'sort',
          directionArg: 'direction',
          fields: ['date', 'item', 'amount'],
          localSort: false,
        },
        pagination: { cursorArg: 'cursor' },
        interactive: {
          tier: {
            description: 'Order tier',
            controls: [{ id: 'ui.select', version: 1 }],
            options: { id: 'orders.tiers', version: 1 },
          },
        },
        execute: async (args) => {
          orderRefreshCount++;
          const base =
            args.tier === 'wholesale'
              ? [
                  { date: '2024-02-01', item: 'bulk-gamma', amount: 500 + orderRefreshCount },
                  { date: '2024-02-02', item: 'bulk-alpha', amount: 300 },
                  { date: '2024-02-03', item: 'bulk-beta', amount: 400 },
                ]
              : [
                  { date: '2024-01-01', item: 'alpha', amount: 10 + orderRefreshCount },
                  { date: '2024-01-02', item: 'beta', amount: 30 },
                  { date: '2024-01-03', item: 'gamma', amount: 20 },
                ];
          const sortKey = (args.sort as 'date' | 'item' | 'amount' | undefined) ?? 'date';
          const dir = args.direction === 'desc' ? -1 : 1;
          const sorted = [...base].sort(
            (a, b) => (a[sortKey] < b[sortKey] ? -1 : a[sortKey] > b[sortKey] ? 1 : 0) * dir,
          );
          const offset = args.cursor === 'page2' ? 2 : 0;
          const page = sorted.slice(offset, offset + 2);
          const hasMore = offset + page.length < sorted.length;
          return {
            rows: page,
            provenance: {
              sourceId: 'orders-fixture',
              sourceVersion: `v${orderRefreshCount}`,
              queryId: `q${orderRefreshCount}`,
              executedAt: '2026-11-15T00:00:00Z',
              sourceAsOf: '2026-11-15T00:00:00Z',
              grain: 'one row per order',
              truncated: hasMore,
              nextCursor: hasMore ? 'page2' : null,
              warnings: [],
            },
          };
        },
      },
    ],
  });
  const proposal = plan(catalog);
  const block = proposal.blocks[0];
  if (block.kind !== 'visual') throw new Error('Expected visual');
  block.controls.push({
    id: 'region',
    control: { id: 'ui.select', version: 1 },
    label: 'Region',
    purpose: 'Select a region',
    scopeMode: 'within-answer',
    targets: [{ bindingId: 'data', argument: 'region' }],
    initialValue: null,
    dependsOn: [],
  });
  const runtime = new FoundationRuntime(catalog);
  const executed = await runtime.execute(proposal, principal, new AbortController().signal);
  const materialized = await runtime.ingest(
    proposal,
    executed.datasets,
    principal,
    new AbortController().signal,
    { messageId: 'message1', responseId: 'response1', revision: 1, generation: 0 },
  );
  const service = new FoundationControlService(catalog, (who) => String(who.context.account));
  await service.attach(materialized, principal, new AbortController().signal, {
    enableControls: true,
  });
  const warehouse: ResponsePlan = {
    schemaVersion: 2,
    capabilitySnapshotId: catalog.snapshot(principal).id,
    bindings: [
      {
        id: 'data',
        tool: { id: 'warehouse.stock', version: 1 },
        args: { categories: null, period: ['2024-01-01', '2024-12-31'] },
        fixedArgs: {},
      },
    ],
    facts: [],
    blocks: [
      {
        id: 'visual',
        kind: 'visual',
        layoutIntent: 'auto',
        elements: [
          {
            id: 'stock',
            component: { id: 'ui.table', version: 1 },
            title: 'Stock',
            roles: {
              columns: ['day', 'category', 'units'].map((fieldId) => ({
                bindingId: 'data',
                fieldId,
              })),
            },
            props: {},
          },
        ],
        controls: [
          {
            id: 'categories',
            control: { id: 'ui.multiSelect', version: 1 },
            label: 'Categories',
            purpose: 'Select categories',
            scopeMode: 'within-answer',
            targets: [{ bindingId: 'data', argument: 'categories' }],
            initialValue: null,
            dependsOn: [],
          },
          {
            id: 'period',
            control: { id: 'ui.dateRange', version: 1 },
            label: 'Period',
            purpose: 'Select dates',
            scopeMode: 'within-answer',
            targets: [{ bindingId: 'data', argument: 'period' }],
            initialValue: ['2024-01-01', '2024-12-31'],
            dependsOn: [],
          },
        ],
      },
    ],
  };
  const warehouseData = await runtime.execute(warehouse, principal, new AbortController().signal);
  const warehouseSnapshot = await runtime.ingest(
    warehouse,
    warehouseData.datasets,
    principal,
    new AbortController().signal,
    { messageId: 'warehouseMessage', responseId: 'warehouseResponse', revision: 1, generation: 0 },
  );
  await service.attach(warehouseSnapshot, principal, new AbortController().signal, {
    enableControls: true,
  });
  const partial = structuredClone(proposal);
  partial.bindings.push({
    id: 'broken',
    tool: domains[0].tools[0].ref,
    args: {},
    fixedArgs: { area: 'north', region: null },
  });
  const partialBlock = partial.blocks[0];
  if (partialBlock.kind !== 'visual') throw new Error('Expected visual');
  partialBlock.elements.push({
    id: 'failedview',
    component: { id: 'ui.table', version: 1 },
    title: 'Recovered source',
    roles: { columns: [{ bindingId: 'broken', fieldId: 'score' }] },
    props: {},
  });
  const partialData = await runtime.execute(
    partial,
    principal,
    new AbortController().signal,
    undefined,
    true,
  );
  const partialSnapshot = await runtime.ingest(
    partial,
    partialData.datasets,
    principal,
    new AbortController().signal,
    { messageId: 'partialMessage', responseId: 'partialResponse', revision: 1, generation: 0 },
    undefined,
    partialData.failedBindings,
  );
  await service.attach(partialSnapshot, principal, new AbortController().signal, {
    enableControls: true,
  });
  const ordersSnapId = catalog.snapshot(principal).id;
  const actionsPlan: ResponsePlan = {
    schemaVersion: 2,
    capabilitySnapshotId: ordersSnapId,
    bindings: [
      {
        id: 'orders',
        tool: { id: 'orders.list', version: 1 },
        args: { tier: null },
        fixedArgs: {},
      },
    ],
    facts: [],
    blocks: [
      {
        id: 'answer',
        kind: 'visual',
        layoutIntent: 'auto',
        controls: [
          {
            id: 'tier',
            control: { id: 'ui.select', version: 1 },
            label: 'Tier',
            purpose: 'Switch order tier',
            scopeMode: 'change-answer',
            targets: [{ bindingId: 'orders', argument: 'tier' }],
            initialValue: null,
            dependsOn: [],
          },
        ],
        elements: [
          {
            id: 'ordersTable',
            component: { id: 'ui.table', version: 1 },
            title: 'Orders table',
            roles: {
              columns: [
                { bindingId: 'orders', fieldId: 'date' },
                { bindingId: 'orders', fieldId: 'item' },
                { bindingId: 'orders', fieldId: 'amount' },
              ],
            },
            props: {},
          },
        ],
      },
    ],
  };
  const actionsExec = await runtime.execute(actionsPlan, principal, new AbortController().signal);
  const actionsInitial = await runtime.ingest(
    actionsPlan,
    actionsExec.datasets,
    principal,
    new AbortController().signal,
    {
      messageId: 'actionsMessage',
      responseId: 'actionsResponse',
      revision: 1,
      generation: 0,
    },
  );
  await service.attach(actionsInitial, principal, new AbortController().signal, {
    enableControls: true,
  });
  const conversation4Entries: Array<{
    id: string;
    role: 'user' | 'assistant';
    text: string;
    responseId?: string;
  }> = [{ id: 'actionsMessage', role: 'assistant', text: '', responseId: 'actionsResponse' }];
  const conversation4ResponseIds = new Set(['actionsResponse']);
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [
      {
        name: 'control-fixture',
        configureServer(vite) {
          vite.middlewares.use('/api/v2', (req, res) => {
            void (async () => {
              const json = (value: unknown) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
              };
              if (req.url === '/capabilities')
                return json({
                  protocolVersion: 2,
                  components: catalog.snapshot(principal).components.map((item) => item.ref),
                  operations: [
                    { id: 'ui.setControl', version: 1 },
                    { id: 'ui.retryBinding', version: 1 },
                    { id: 'ui.sort', version: 1 },
                    { id: 'ui.paginate', version: 1 },
                    { id: 'ui.refresh', version: 1 },
                  ],
                  history: true,
                  replay: false,
                  cancellation: false,
                });
              if (req.url === '/conversations/conversation1')
                return json({
                  conversationId: 'conversation1',
                  messages: [
                    {
                      id: 'message1',
                      role: 'assistant',
                      text: '',
                      response: await service.read(
                        'response1',
                        principal,
                        new AbortController().signal,
                      ),
                    },
                  ],
                });
              if (req.url === '/conversations/conversation2')
                return json({
                  conversationId: 'conversation2',
                  messages: [
                    {
                      id: 'warehouseMessage',
                      role: 'assistant',
                      text: '',
                      response: await service.read(
                        'warehouseResponse',
                        principal,
                        new AbortController().signal,
                      ),
                    },
                  ],
                });
              if (req.url === '/conversations/conversation3')
                return json({
                  conversationId: 'conversation3',
                  messages: [
                    {
                      id: 'partialMessage',
                      role: 'assistant',
                      text: '',
                      response: await service.read(
                        'partialResponse',
                        principal,
                        new AbortController().signal,
                      ),
                    },
                  ],
                });
              if (req.url === '/conversations/conversation4')
                return json({
                  conversationId: 'conversation4',
                  messages: await Promise.all(
                    conversation4Entries.map(async (entry) => ({
                      id: entry.id,
                      role: entry.role,
                      text: entry.text,
                      ...(entry.responseId
                        ? {
                            response: await service.read(
                              entry.responseId,
                              principal,
                              new AbortController().signal,
                            ),
                          }
                        : {}),
                    })),
                  ),
                });
              let raw = '';
              for await (const chunk of req) raw += String(chunk);
              const input = JSON.parse(raw);
              if (req.url === '/options')
                return json(
                  await service.resolveOptions(input, principal, new AbortController().signal),
                );
              if (req.url === '/actions') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                const isConv4 = conversation4ResponseIds.has(input.responseId);
                const newMessageId =
                  typeof input.payload?.newMessageId === 'string'
                    ? input.payload.newMessageId
                    : undefined;
                const conv4Entry = isConv4
                  ? conversation4Entries.find((e) => e.responseId === input.responseId)
                  : undefined;
                const base = {
                  protocolVersion: 2,
                  requestId: `request_${Date.now()}_${Math.random().toString(16).slice(2)}`,
                  conversationId:
                    input.responseId === 'warehouseResponse'
                      ? 'conversation2'
                      : input.responseId === 'partialResponse'
                        ? 'conversation3'
                        : isConv4
                          ? 'conversation4'
                          : 'conversation1',
                  messageId:
                    newMessageId ??
                    conv4Entry?.id ??
                    (input.responseId === 'warehouseResponse'
                      ? 'warehouseMessage'
                      : input.responseId === 'partialResponse'
                        ? 'partialMessage'
                        : 'message1'),
                };
                const emit = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
                emit({ ...base, type: 'request.started', eventId: 'event1', sequence: 0 });
                try {
                  const response =
                    input.action.id === 'ui.retryBinding'
                      ? await service.retry(
                          {
                            responseId: input.responseId,
                            revision: input.revision,
                            generation: input.generation,
                            bindingId: input.payload.bindingId,
                            idempotencyKey: input.idempotencyKey,
                          },
                          principal,
                          new AbortController().signal,
                        )
                      : input.action.id === 'ui.setControl'
                        ? await service.change(
                            {
                              responseId: input.responseId,
                              revision: input.revision,
                              generation: input.generation,
                              controlId: input.payload.controlId,
                              value: input.payload.value,
                              idempotencyKey: input.idempotencyKey,
                              ...(newMessageId ? { newMessageId } : {}),
                            },
                            principal,
                            new AbortController().signal,
                          )
                        : await service.performAction(
                            input,
                            principal,
                            new AbortController().signal,
                          );
                  if (isConv4 && newMessageId && typeof input.payload?.userMessageId === 'string') {
                    conversation4ResponseIds.add(response.responseId);
                    conversation4Entries.push(
                      {
                        id: input.payload.userMessageId,
                        role: 'user',
                        text: `Scope change (Tier): ${String(input.payload.value ?? 'all permitted values')}`,
                      },
                      {
                        id: newMessageId,
                        role: 'assistant',
                        text: '',
                        responseId: response.responseId,
                      },
                    );
                  }
                  emit({
                    ...base,
                    type: 'response.committed',
                    eventId: 'event2',
                    sequence: 1,
                    response,
                  });
                  emit({ ...base, type: 'request.completed', eventId: 'event3', sequence: 2 });
                } catch {
                  emit({
                    ...base,
                    type: 'request.failed',
                    eventId: 'event2',
                    sequence: 1,
                    diagnostic: {
                      code: 'SOURCE_FAILURE',
                      message: 'The selected region could not be loaded.',
                      retryable: true,
                    },
                  });
                }
                res.end();
                return;
              }
              res.writeHead(404).end();
            })().catch(() => {
              if (!res.headersSent) res.writeHead(500);
              res.end();
            });
          });
        },
      },
    ],
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Vite address unavailable');
  url = `http://127.0.0.1:${address.port}`;
});

test('retry recovers one failed source without replacing the successful result', async ({
  page,
}) => {
  await page.goto(`${url}/tests/fixtures/foundation-browser.html?controls=partial`);
  const recovered = page.getByRole('region', { name: 'Recovered source' });
  await expect(recovered.getByText('This data source is unavailable.')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Recorded results' }).getByRole('table').first(),
  ).toContainText('170');
  await recovered.getByRole('button', { name: 'Retry data source' }).click();
  await expect(recovered.getByRole('table').first()).toContainText('82');
  await expect(
    page.getByRole('region', { name: 'Recorded results' }).getByRole('table').first(),
  ).toContainText('170');
  await page.reload();
  await expect(recovered.getByRole('table').first()).toContainText('82');
});
test.afterAll(async () => {
  await server?.close();
});

test('scoped controls update and restore the last good generation through HTTP', async ({
  page,
}) => {
  await page.goto(`${url}/tests/fixtures/foundation-browser.html?controls=1`);
  const assistant = page.getByLabel('Assistant');
  const region = page.getByRole('combobox', { name: 'Region' });
  await expect(assistant.getByRole('table').first()).toContainText('170');
  await expect(region.locator('option', { hasText: 'East' })).toHaveCount(1);
  await region.selectOption({ label: 'East' });
  await expect(assistant.getByRole('table').first()).toContainText('130');
  await expect(region).toHaveValue('value:east');
  await page.reload();
  await expect(assistant.getByRole('table').first()).toContainText('130');
  await expect(region).toHaveValue('value:east');
  await expect(region.locator('option', { hasText: 'West' })).toHaveCount(1);
  await region.selectOption({ label: 'West' });
  await expect(assistant.getByText('The selected region could not be loaded.')).toBeVisible();
  await expect(assistant.getByRole('table').first()).toContainText('130');
  await expect(region).toHaveValue('value:east');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});

test('multi-select and date range work in an unrelated registered domain', async ({ page }) => {
  await page.goto(`${url}/tests/fixtures/foundation-browser.html?controls=warehouse`);
  const stock = page.getByRole('region', { name: 'Stock', exact: true });
  await expect(stock.getByRole('table').first()).toContainText('books');
  await expect(stock.getByRole('table').first()).toContainText('tools');
  const categories = page.getByRole('listbox', { name: 'Categories' });
  await expect(categories.locator('option', { hasText: 'Books' })).toHaveCount(1);
  await categories.selectOption(['books']);
  await page.getByRole('button', { name: 'Apply selection' }).click();
  await expect(stock.getByRole('table').first()).not.toContainText('tools');
  await expect(stock.getByRole('table').first()).toContainText('books');
  await page.getByLabel('Start', { exact: true }).fill('2025-01-01');
  await page.getByLabel('End', { exact: true }).fill('2025-12-31');
  await page.getByRole('button', { name: 'Apply dates' }).click();
  await expect(stock.getByText('No observations are available.')).toBeVisible();
});

test('table sorting, pagination, refresh, and change-answer controls work end-to-end in browser', async ({
  page,
}) => {
  await page.goto(`${url}/tests/fixtures/foundation-browser.html?controls=actions`);
  const tableRegion = page.getByRole('region', { name: 'Orders table', exact: true }).first();
  await expect(tableRegion.getByRole('table').first()).toContainText('alpha');
  await expect(tableRegion.getByRole('table').first()).toContainText('11');

  // Paginate Next page -> Previous page
  await tableRegion.getByRole('button', { name: 'Next page' }).click();
  await expect(tableRegion.getByRole('table').first()).toContainText('gamma');
  await tableRegion.getByRole('button', { name: 'Previous page' }).click();
  await expect(tableRegion.getByRole('table').first()).toContainText('alpha');

  // Sort by amount asc -> desc
  await tableRegion.getByRole('button', { name: /^amount/ }).click();
  await expect(tableRegion.getByRole('columnheader', { name: /amount/ })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await tableRegion.getByRole('button', { name: /^amount/ }).click();
  await expect(tableRegion.getByRole('columnheader', { name: /amount/ })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
  await expect(tableRegion.getByRole('table').first()).toContainText('beta');

  // Refresh re-executes binding
  await page.getByRole('button', { name: 'Refresh data' }).click();
  await expect(tableRegion.getByRole('table').first()).toContainText('beta');

  // change-answer control creates a new revision message leaving previous assistant immutable
  const tierSelect = page.getByRole('combobox', { name: 'Tier' }).first();
  await expect(tierSelect.locator('option', { hasText: 'Wholesale' })).toHaveCount(1);
  await tierSelect.selectOption({ label: 'Wholesale' });
  await expect(page.getByLabel('Assistant')).toHaveCount(2);
  await expect(page.getByLabel('Assistant').first()).toContainText('beta');
  await expect(page.getByLabel('Assistant').last()).toContainText('bulk-gamma');
  await page.reload();
  await expect(page.getByLabel('Assistant')).toHaveCount(2);
  await expect(page.getByLabel('Assistant').last()).toContainText('bulk-gamma');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});
