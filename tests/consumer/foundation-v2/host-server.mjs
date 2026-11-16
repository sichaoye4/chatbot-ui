import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { FoundationError } from '@source/chat-foundation-v2/contracts';
import {
  AuthorizedConversations,
  AuthorizedRequestJournal,
  FoundationBackend,
  FoundationCatalog,
  FoundationControlService,
  FoundationRuntime,
  SqliteControlSnapshotStore,
  SqliteConversationStore,
  SqliteRequestJournal,
  registerBuiltins,
} from '@source/chat-foundation-v2/server';

const root = resolve(process.argv[2] ?? '.');
const buildDir = join(root, 'build');
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, 'consumer-host.sqlite');
const AUTH_TOKEN = 'host-dev-secret';

const readingComponent = { id: 'host.reading', version: 1 };
const warehouseRows = [
  { sku: 'W-101', name: 'Pallet Jack', stock: 18 },
  { sku: 'W-102', name: 'Forklift Battery', stock: 7 },
  { sku: 'W-103', name: 'Scanner Cradle', stock: 34 },
  { sku: 'W-104', name: 'Dock Seal', stock: 12 },
];
let inventoryRefreshes = 0;

const policy = {
  owner: (principal) => principal.subject,
  scope: async (conversationId, principal) => `${principal.subject}:${conversationId}`,
  sameScope: (a, b) => a === b,
};

const catalog = registerBuiltins(
  new FoundationCatalog({
    visible: (field, principal) =>
      field.visibility !== 'restricted' || principal.subject === 'supervisor',
    authorize: async (_tool, _args, principal) => ({
      scopeKey: principal.subject,
      context: {},
    }),
  }),
);

catalog.registerComponent({
  ref: readingComponent,
  description: 'Displays a host reading with unit',
  guidance: {
    useWhen: 'Displaying a single scalar reading with its unit.',
    avoidWhen: 'Displaying multi-row datasets or categorical comparisons.',
    alternatives: ['core.metric@1', 'core.table@1'],
  },
  props: z.object({}).strict(),
  roles: {
    value: { types: ['number'], min: 1, max: 1 },
  },
  singleBinding: true,
  layout: { minWidth: 1, minHeight: 1 },
});

catalog.registerDomain({
  ref: { id: 'host.operations', version: 1 },
  description: 'Library, energy, and warehouse operations tools',
  semantics: ['All quantities reflect current point-in-time inventory or capacity readings.'],
  tools: [
    {
      ref: { id: 'library.read', version: 1 },
      description: 'Read library book count',
      args: z.object({}).strict(),
      interactive: {},
      grain: 'one library reading',
      fields: [
        {
          id: 'value',
          label: 'Library books',
          type: 'number',
          role: 'measure',
          nullable: false,
          description: 'Total books available',
          unit: 'books',
          measure: { aggregation: 'Current total', precision: 0, additive: false },
        },
      ],
      execute: async () => ({
        rows: [{ value: 42 }],
        provenance: {
          sourceId: 'library',
          sourceVersion: '1',
          queryId: `query${randomUUID().replaceAll('-', '')}`,
          executedAt: '2026-01-01T00:00:00Z',
          grain: 'one library reading',
          truncated: false,
          nextCursor: null,
          warnings: [],
        },
      }),
    },
    {
      ref: { id: 'energy.read', version: 1 },
      description: 'Read site energy capacity',
      args: z.object({}).strict(),
      interactive: {},
      grain: 'one energy reading',
      fields: [
        {
          id: 'value',
          label: 'Energy capacity',
          type: 'number',
          role: 'measure',
          nullable: false,
          description: 'Available backup energy',
          unit: 'MW',
          measure: { aggregation: 'Current total', precision: 0, additive: false },
        },
      ],
      execute: async () => ({
        rows: [{ value: 17 }],
        provenance: {
          sourceId: 'energy',
          sourceVersion: '1',
          queryId: `query${randomUUID().replaceAll('-', '')}`,
          executedAt: '2026-01-01T00:00:00Z',
          grain: 'one energy reading',
          truncated: false,
          nextCursor: null,
          warnings: [],
        },
      }),
    },
    {
      ref: { id: 'warehouse.items', version: 1 },
      description: 'Paginated warehouse inventory rows',
      args: z
        .object({
          sortField: z.enum(['name', 'stock']).optional(),
          sortDirection: z.enum(['asc', 'desc']).optional(),
          cursor: z.string().nullable().optional(),
        })
        .strict(),
      interactive: {},
      grain: 'one warehouse SKU',
      refreshable: true,
      sorting: { fieldArg: 'sortField', directionArg: 'sortDirection', fields: ['name', 'stock'] },
      pagination: { cursorArg: 'cursor' },
      fields: [
        {
          id: 'sku',
          label: 'SKU',
          type: 'string',
          role: 'identifier',
          nullable: false,
          description: 'Warehouse SKU identifier',
        },
        {
          id: 'name',
          label: 'Item',
          type: 'string',
          role: 'dimension',
          nullable: false,
          description: 'Item name',
        },
        {
          id: 'stock',
          label: 'Stock',
          type: 'number',
          role: 'measure',
          nullable: false,
          description: 'Units on hand',
          unit: 'units',
          measure: { aggregation: 'Current stock', precision: 0, additive: true },
        },
      ],
      execute: async (args) => {
        inventoryRefreshes += 1;
        const field = typeof args.sortField === 'string' ? args.sortField : 'stock';
        const dir = args.sortDirection === 'asc' ? 'asc' : 'desc';
        const sorted = [...warehouseRows].sort((a, b) => {
          const av = a[field];
          const bv = b[field];
          const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
          return dir === 'asc' ? cmp : -cmp;
        });
        const offset = typeof args.cursor === 'string' ? Number(args.cursor) : 0;
        const page = sorted.slice(offset, offset + 2);
        const nextOffset = offset + page.length;
        const nextCursor = nextOffset < sorted.length ? String(nextOffset) : null;
        return {
          rows: page,
          provenance: {
            sourceId: 'warehouse',
            sourceVersion: '1',
            queryId: `query${randomUUID().replaceAll('-', '')}`,
            executedAt: '2026-01-01T00:00:00Z',
            grain: 'one warehouse SKU',
            truncated: nextCursor !== null,
            nextCursor,
            warnings: inventoryRefreshes > 1 ? [`Refreshed #${inventoryRefreshes}`] : [],
          },
        };
      },
    },
  ],
});

const agent = {
  async propose(request) {
    if (request.feedback?.length) {
      console.error('[agent propose feedback]', JSON.stringify(request.feedback));
    }
    const prompt = request.question.toLowerCase();
    if (prompt.includes('energy')) {
      return {
        schemaVersion: 2,
        capabilitySnapshotId: request.capabilities.id,
        bindings: [{ id: 'data', tool: { id: 'energy.read', version: 1 }, args: {}, fixedArgs: {} }],
        facts: [],
        blocks: [
          {
            id: 'intro',
            kind: 'text',
            parts: [{ text: 'Independent energy capacity reading.' }],
          },
          {
            id: 'visual',
            kind: 'visual',
            layoutIntent: 'auto',
            controls: [],
            elements: [
              {
                id: 'reading',
                component: readingComponent,
                title: 'Energy capacity',
                roles: { value: [{ bindingId: 'data', fieldId: 'value' }] },
                props: {},
              },
            ],
          },
        ],
      };
    }
    return {
      schemaVersion: 2,
      capabilitySnapshotId: request.capabilities.id,
      bindings: [
        { id: 'data', tool: { id: 'library.read', version: 1 }, args: {}, fixedArgs: {} },
        { id: 'items', tool: { id: 'warehouse.items', version: 1 }, args: {}, fixedArgs: {} },
      ],
      facts: [],
      blocks: [
        {
          id: 'intro',
          kind: 'text',
          parts: [{ text: 'Independent library and warehouse inventory.' }],
        },
        {
          id: 'visual',
          kind: 'visual',
          layoutIntent: 'auto',
          controls: [],
          elements: [
            {
              id: 'reading',
              component: readingComponent,
              title: 'Library books',
              roles: { value: [{ bindingId: 'data', fieldId: 'value' }] },
              props: {},
            },
            {
              id: 'inventoryTable',
              component: { id: 'ui.table', version: 1 },
              title: 'Warehouse inventory',
              roles: {
                columns: [
                  { bindingId: 'items', fieldId: 'sku' },
                  { bindingId: 'items', fieldId: 'name' },
                  { bindingId: 'items', fieldId: 'stock' },
                ],
              },
              props: {},
            },
          ],
        },
      ],
    };
  },
};

const snapshots = new SqliteControlSnapshotStore(dbPath);
const owner = (principal) => principal.subject;
const controls = new FoundationControlService(catalog, owner, snapshots);
const requestStore = new SqliteRequestJournal(dbPath, {
  maxEvents: 100,
  retentionMs: 24 * 60 * 60 * 1000,
});
const messages = new SqliteConversationStore(requestStore.connectionForConversations());
const fullPolicy = {
  owner,
  scope: async (conversationId, principal) => `${principal.subject}:${conversationId}`,
  response: async (response, principal, signal) => {
    const stored = await controls.read(
      response.responseId,
      principal,
      signal,
      response.revision,
      response.generation,
    );
    if (!isDeepStrictEqual(stored, response)) {
      throw new FoundationError({
        code: 'DATA_FORBIDDEN',
        path: '',
        message: 'Response is unavailable',
      });
    }
  },
  recovery: async (responseId, principal, signal) => {
    await controls.read(responseId, principal, signal);
  },
};
const conversations = new AuthorizedConversations(messages, controls, fullPolicy);
const journal = new AuthorizedRequestJournal(requestStore, fullPolicy);
const backend = new FoundationBackend(catalog, agent, controls, conversations, journal, fullPolicy, {
  workerId: 'consumer-worker-1',
});
const runtime = new FoundationRuntime(catalog);

const precomputedEmbedded = await runtime.ingest(
  {
    schemaVersion: 2,
    capabilitySnapshotId: catalog.snapshot({ subject: 'host-user' }).id,
    bindings: [{ id: 'data', tool: { id: 'library.read', version: 1 }, args: {}, fixedArgs: {} }],
    facts: [],
    blocks: [
      {
        id: 'visual',
        kind: 'visual',
        layoutIntent: 'auto',
        controls: [],
        elements: [
          {
            id: 'reading',
            component: readingComponent,
            title: 'Embedded inventory',
            roles: { value: [{ bindingId: 'data', fieldId: 'value' }] },
            props: {},
          },
        ],
      },
    ],
  },
  {
    data: {
      rows: [{ value: 99 }],
      provenance: {
        sourceId: 'library',
        sourceVersion: '1',
        queryId: `query${randomUUID().replaceAll('-', '')}`,
        executedAt: '2026-01-01T00:00:00Z',
        grain: 'one library reading',
        truncated: false,
        nextCursor: null,
        warnings: [],
      },
    },
  },
  { subject: 'host-user' },
  new AbortController().signal,
  {
    messageId: 'embeddedmessage',
    responseId: `response${randomUUID().replaceAll('-', '')}`,
    revision: 1,
    generation: 0,
  },
);

const readBody = async (req) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};
const sendJson = (res, value, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const sendSse = async (res, stream) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  for await (const event of stream) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
};

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  if (path.startsWith('/api/')) {
    if (req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
      sendJson(res, { error: 'AUTHENTICATION_EXPIRED' }, 401);
      return;
    }
    const principal = { subject: 'host-user' };
    const signal = AbortSignal.timeout(30_000);
    try {
      if (path === '/api/capabilities' && req.method === 'GET') {
        sendJson(res, backend.negotiate(principal));
        return;
      }
      if (path === '/api/embedded' && req.method === 'GET') {
        sendJson(res, precomputedEmbedded);
        return;
      }
      const convMatch = path.match(/^\/api\/conversations\/([\w-]+)$/);
      if (convMatch && req.method === 'GET') {
        sendJson(res, await backend.history(convMatch[1], principal, signal));
        return;
      }
      const respMatch = path.match(/^\/api\/responses\/([\w-]+)$/);
      if (respMatch && req.method === 'GET') {
        sendJson(res, await backend.snapshot(respMatch[1], principal, signal));
        return;
      }
      if (path === '/api/options' && req.method === 'POST') {
        sendJson(res, await backend.options(await readBody(req), principal, signal));
        return;
      }
      if (path === '/api/turns' && req.method === 'POST') {
        await sendSse(res, backend.turn(await readBody(req), principal, signal));
        return;
      }
      if (path === '/api/actions' && req.method === 'POST') {
        await sendSse(res, backend.action(await readBody(req), principal, signal));
        return;
      }
      const cancelMatch = path.match(/^\/api\/requests\/([\w-]+)\/cancel$/);
      if (cancelMatch && req.method === 'POST') {
        sendJson(res, await backend.cancel(cancelMatch[1], principal, signal));
        return;
      }
      const replayMatch = path.match(/^\/api\/requests\/([\w-]+)\/events$/);
      if (replayMatch && req.method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? '-1');
        sendJson(res, await backend.replay(replayMatch[1], after, principal, signal));
        return;
      }
      sendJson(res, { error: 'NOT_FOUND' }, 404);
      return;
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : 'SERVER_ERROR' }, 400);
      return;
    }
  }
  const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
  const file = resolve(buildDir, rel);
  if (!file.startsWith(buildDir + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const content = readFileSync(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
console.log(`CONSUMER_HOST_READY ${JSON.stringify({ port: server.address().port })}`);
process.on('SIGTERM', () => {
  backend.shutdown();
  server.close(() => process.exit(0));
});
