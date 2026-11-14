import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { z } from 'zod';
import { AppError, Action, Turn, Plan, Id } from '../../packages/contracts/index.ts';
import { Catalog, type Principal } from '../../packages/catalog/index.ts';
import { Store } from '../../packages/server-runtime/store.ts';
import { QueryRuntime } from '../../packages/server-runtime/queries.ts';
import { ChatService } from '../../packages/server-runtime/service.ts';
import { DeepSeekAgent, DeterministicAgent } from '../../examples/csv-analytics/legacy-agent.ts';
import { csvPresentation } from '../../examples/csv-analytics/presentation.ts';
import { CsvRepository, SOURCE_HASH } from '../../examples/csv-analytics/index.ts';

export function createApplication(
  options: {
    database?: string;
    mode?: 'deepseek' | 'deterministic';
    testToken?: string;
    staticDir?: string;
  } = {},
) {
  const repo = new CsvRepository(
    resolve('sample_data/training_data_masked_final_1.csv'),
    SOURCE_HASH,
  );
  const store = new Store(options.database ?? '.runtime/chat.sqlite');
  const queries = new QueryRuntime(new Catalog(repo.tools()));
  const agent = options.mode === 'deepseek' ? new DeepSeekAgent() : new DeterministicAgent();
  const service = new ChatService(store, queries, agent, SOURCE_HASH, csvPresentation);
  const principals: Record<string, Principal> = {
    demo: { id: 'demo', tenant: 'demo', domains: ['kyc', 'party', 'payment'], policyEpoch: 1 },
    limited: { id: 'limited', tenant: 'restricted', domains: ['kyc'], policyEpoch: 1 },
  };
  const json = (res: ServerResponse, value: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const body = async (req: IncomingMessage) => {
    if (!req.headers['content-type']?.startsWith('application/json'))
      throw new AppError('CONTENT_TYPE_REQUIRED', 415);
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 65536) throw new AppError('REQUEST_TOO_LARGE', 413);
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new AppError('JSON_INVALID');
    }
  };
  const limits = new Map<string, { start: number; count: number }>();
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    );
    try {
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new AppError('HOST_FORBIDDEN', 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`)
        throw new AppError('ORIGIN_FORBIDDEN', 403);
      const url = new URL(req.url ?? '/', `http://${host}`);
      const path = url.pathname;
      const testAuthorized =
        !!options.testToken && req.headers['x-test-token'] === options.testToken;
      const p =
        testAuthorized && req.headers['x-test-principal'] === 'limited'
          ? principals.limited
          : principals.demo;
      if (path.startsWith('/api/') && p.revoked) throw new AppError('DATA_FORBIDDEN', 403);
      if (req.method === 'POST') {
        let limit = limits.get(p.id);
        if (!limit || Date.now() - limit.start > 60000) {
          limit = { start: Date.now(), count: 0 };
          limits.set(p.id, limit);
        }
        if (++limit.count > 120) throw new AppError('RATE_LIMITED', 429);
      }
      if (path === '/api/ready') {
        json(res, { ready: true, mode: agent.mode, sourceHash: SOURCE_HASH });
        return;
      }
      if (path === '/api/session') {
        json(res, {
          mode: agent.mode,
          identityMode: 'local-single-user-demo',
          domainOptions: p.domains,
          sourceHash: SOURCE_HASH,
        });
        return;
      }
      if (path === '/api/chat/turns' && req.method === 'POST') {
        const input = Turn.parse(await body(req));
        // Reject ownership/idempotency errors before opening a stream where possible.
        store.conversation(input.conversationId, p, true);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        await service.turn(input, p, (event) => {
          if (!res.destroyed)
            res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        res.end();
        return;
      }
      const conversation = path.match(/^\/api\/conversations\/([\w-]+)$/);
      if (conversation) {
        json(res, store.conversation(conversation[1], p, req.method === 'POST'));
        return;
      }
      const artifact = path.match(/^\/api\/artifacts\/([\w-]+)(?:\/(actions|filter-options))?$/);
      if (artifact) {
        if (artifact[2] === 'filter-options' && req.method === 'GET') {
          json(res, service.filterOptions(store.artifact(artifact[1], p), p));
        } else if (artifact[2] === 'actions' && req.method === 'POST') {
          const input = z
            .strictObject({ baseRevision: z.number().int().positive(), action: Action })
            .parse(await body(req));
          json(res, await service.action(artifact[1], input.baseRevision, input.action, p));
        } else if (req.method === 'GET') {
          const a = store.artifact(
            artifact[1],
            p,
            url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined,
          );
          if (a.sourceHash !== SOURCE_HASH) throw new AppError('SNAPSHOT_EXPIRED', 410);
          json(res, a);
        } else throw new AppError('METHOD_NOT_ALLOWED', 405);
        return;
      }
      const request = path.match(/^\/api\/requests\/([\w-]+)(?:\/(events|cancel))?$/);
      if (request) {
        const r = store.request(request[1], p);
        if (request[2] === 'cancel' && req.method === 'POST') {
          service.running.get(request[1])?.abort();
          json(res, { cancelled: true });
        } else if (request[2] === 'events') {
          const after = Number(url.searchParams.get('after') ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new AppError('CURSOR_INVALID');
          json(res, { events: store.events(request[1], p, after), status: r.status });
        } else json(res, { status: r.status, conversationId: r.conversation });
        return;
      }
      if (path === '/api/records' && req.method === 'GET') {
        json(res, repo.record(url.searchParams.get('id') ?? '', p));
        return;
      }
      if (path === '/api/testing/telemetry' && testAuthorized) {
        json(res, { modelCalls: agent.calls, queries: queries.executions });
        return;
      }
      if (path === '/api/testing/fault' && testAuthorized && req.method === 'POST') {
        service.fault = z
          .strictObject({
            tool: z.string().optional(),
            delayMs: z.number().max(5000).optional(),
            fail: z.boolean().optional(),
          })
          .parse(await body(req));
        json(res, { ok: true });
        return;
      }
      if (path === '/api/testing/plan' && testAuthorized && req.method === 'POST') {
        const input = z.strictObject({ conversationId: Id, plan: Plan }).parse(await body(req));
        store.conversation(input.conversationId, p, true);
        const plan = queries.catalog.validate(input.plan, p);
        const a = store.commit(input.conversationId, plan, SOURCE_HASH, p);
        const settled = await service.resolve(a, p);
        store.message(
          input.conversationId,
          'assistant',
          'Here is the requested analysis.',
          settled,
        );
        json(res, settled);
        return;
      }
      if (path === '/api/testing/revoke' && testAuthorized && req.method === 'POST') {
        principals.demo.revoked = true;
        principals.demo.policyEpoch++;
        json(res, { ok: true });
        return;
      }
      if (path.startsWith('/api/')) throw new AppError('NOT_FOUND', 404);
      const root = resolve(options.staticDir ?? 'dist/client');
      let file = resolve(root, '.' + decodeURIComponent(path));
      if (file !== root && !file.startsWith(root + sep)) throw new AppError('NOT_FOUND', 404);
      if (path === '/' || !extname(path)) file = resolve(root, 'index.html');
      if (!existsSync(file)) throw new AppError('NOT_FOUND', 404);
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
      };
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    } catch (error) {
      const code =
        error instanceof AppError
          ? error.code
          : error instanceof z.ZodError
            ? 'VALIDATION_FAILED'
            : 'INTERNAL_ERROR';
      if (!res.headersSent)
        json(
          res,
          { error: code },
          error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500,
        );
      else res.end();
    }
  });
  return {
    server,
    store,
    repo,
    service,
    close: async () => {
      for (const c of service.running.values()) c.abort();
      await new Promise<void>((done, reject) => server.close((e) => (e ? reject(e) : done())));
      store.close();
    },
  };
}
