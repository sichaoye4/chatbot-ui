import { providedDataTool } from '../../packages/server-runtime/provided-data.ts';
import { suppliedScheduleTool } from '../../examples/project-management/supplied-schedule.ts';
import {
  visualizationTools,
  withVisualizationDemo,
} from '../../examples/data-visualization/index.ts';
import { createHmac, timingSafeEqual } from 'node:crypto';
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
import { projectTools, withProjectDemo } from '../../examples/project-management/index.ts';
import { createCsvFoundationBackend } from '../../examples/csv-analytics/reference-v2.ts';
import {
  FoundationError,
  LocalId as ProtocolLocalId,
  type PlanningAgent,
  type Principal as FoundationPrincipal,
} from '../../packages/contracts/foundation.ts';
import { BackendAction, OptionQuery, TurnRequest } from '../../packages/contracts/protocol.ts';

const AuthClaims = z.strictObject({
  id: z.string().min(1).max(160),
  tenant: z.string().min(1).max(160),
  domains: z.array(z.string().min(1).max(80)).max(20),
  policyEpoch: z.number().int().positive(),
  revoked: z.boolean().optional(),
  exp: z.number().int().positive(),
});
export function signAuthToken(
  principal: Principal,
  secret: string,
  ttlMs = 3_600_000,
  now = Date.now(),
) {
  if (!secret || secret.length < 16) throw new Error('Auth secret must be at least 16 characters');
  const payload = Buffer.from(
    JSON.stringify(
      AuthClaims.parse({
        id: principal.id,
        tenant: principal.tenant,
        domains: principal.domains,
        policyEpoch: principal.policyEpoch,
        ...(principal.revoked !== undefined ? { revoked: principal.revoked } : {}),
        exp: now + ttlMs,
      }),
    ),
    'utf8',
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
export function verifyAuthToken(
  token: string,
  secret: string,
  now = Date.now(),
): Principal | undefined {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1] || !secret) return undefined;
  const expected = createHmac('sha256', secret).update(parts[0]).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(parts[1], 'base64url');
  } catch {
    return undefined;
  }
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return undefined;
  try {
    const claims = AuthClaims.parse(
      JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
    );
    if (claims.exp <= now) return undefined;
    return {
      id: claims.id,
      tenant: claims.tenant,
      domains: claims.domains,
      policyEpoch: claims.policyEpoch,
      ...(claims.revoked !== undefined ? { revoked: claims.revoked } : {}),
    };
  } catch {
    return undefined;
  }
}
function bearerOrCookieToken(req: IncomingMessage) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = req.headers.cookie;
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'agy_auth') return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function createApplication(
  options: {
    database?: string;
    mode?: 'deepseek' | 'deterministic';
    testToken?: string;
    staticDir?: string;
    foundationAgent?: PlanningAgent;
    authSecret?: string;
    authenticate?: (req: IncomingMessage) => Promise<Principal | undefined> | Principal | undefined;
    workerId?: string;
    leaseMs?: number;
    multiWorker?: boolean;
    retentionMs?: number;
  } = {},
) {
  const repo = new CsvRepository(
    resolve('sample_data/training_data_masked_final_1.csv'),
    SOURCE_HASH,
  );
  const foundation = createCsvFoundationBackend(
    repo,
    options.database ?? '.runtime/chat.sqlite',
    options.mode ?? 'deterministic',
    options.foundationAgent,
    {
      workerId: options.workerId,
      leaseMs: options.leaseMs,
      multiWorker: options.multiWorker,
      retentionMs: options.retentionMs,
    },
  );
  const store = new Store(options.database ?? '.runtime/chat.sqlite');
  const queries = new QueryRuntime(
    new Catalog([
      ...repo.tools(),
      ...projectTools(),
      ...visualizationTools(),
      suppliedScheduleTool(),
      providedDataTool(),
    ]),
  );
  const agent =
    options.mode === 'deepseek'
      ? new DeepSeekAgent()
      : withVisualizationDemo(withProjectDemo(new DeterministicAgent()));
  const presentation = {
    ...csvPresentation,
    explain(reason: string) {
      if (reason === 'supplied-schedule-invalid')
        return 'I found your supplied project schedule, but could not safely interpret all its dates. Use Project Duration: N Months (Month YYYY – Month YYYY), phase headings with (Months 1–3), M1–M2: task bullets, and Milestone MS1 — Name (31 March 2027). Check dates and phase boundaries. Each view supports up to 40 tasks/milestones; split larger schedules into smaller requests. I have not substituted demo data.';
      if (reason === 'visualization-data-required')
        return 'This source does not supply the required statistical, partition or geographic semantics. Try a histogram demo, comparison visualization demo, or specialized visualization demo.';
      return reason === 'project-data-required'
        ? 'This source has no project schedules or workflow definitions. Try “Show a Gantt demo”, “Show a flowchart demo”, or “Show a project management demo” for clearly labeled synthetic examples.'
        : csvPresentation.explain(reason);
    },
    visual(artifact: Parameters<typeof csvPresentation.visual>[0]) {
      if (artifact.plan.bindings.some((b) => b.toolId === 'provided.data'))
        return (
          artifact.plan.title +
          '. Review the source notes for assumptions and any missing information.'
        );
      if (artifact.plan.bindings.some((b) => b.toolId === 'project.suppliedSchedule'))
        return 'Here is your supplied project plan: a phase and milestone overview, followed by the detailed task schedule in a separate message. Dates are planned targets. Month-only tasks span their stated calendar months; progress and dependency links were not supplied. Risks, deliverables and success metrics remain context rather than measured project status.';
      if (artifact.plan.bindings.some((b) => b.toolId.startsWith('viz.')))
        return 'Synthetic visualization demonstration. Inspect the charts and underlying values below; these are not connected business records.';
      return artifact.plan.bindings.some((b) => b.toolId.startsWith('pm.'))
        ? 'Synthetic project demonstration — not your connected project data. Inspect tasks, decisions, branches and dated work observations below.'
        : csvPresentation.visual(artifact);
    },
  };
  const service = new ChatService(store, queries, agent, SOURCE_HASH, presentation);
  const principals: Record<string, Principal> = {
    demo: { id: 'demo', tenant: 'demo', domains: ['kyc', 'party', 'payment'], policyEpoch: 1 },
    limited: { id: 'limited', tenant: 'restricted', domains: ['kyc'], policyEpoch: 1 },
  };
  const revokedSubjects = new Set<string>();
  const epochOffsets = new Map<string, number>();
  const configuredAuthSecret = options.authSecret ?? process.env.CHATBOT_AUTH_SECRET;
  const hostAuthEnabled = Boolean(options.authenticate || configuredAuthSecret);
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
  let inFlight = 0;
  const drained = new Set<() => void>();
  const server = createServer(async (req, res) => {
    inFlight++;
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
      if (path === '/api/ready') {
        json(res, { ready: true, mode: agent.mode, sourceHash: SOURCE_HASH });
        return;
      }
      let resolvedPrincipal: Principal | undefined;
      if (options.authenticate) {
        resolvedPrincipal = await options.authenticate(req);
      } else if (configuredAuthSecret) {
        const token = bearerOrCookieToken(req);
        if (token) resolvedPrincipal = verifyAuthToken(token, configuredAuthSecret);
      } else {
        resolvedPrincipal =
          testAuthorized && req.headers['x-test-principal'] === 'limited'
            ? principals.limited
            : principals.demo;
      }
      if (path.startsWith('/api/') && !resolvedPrincipal)
        throw new AppError('AUTHENTICATION_EXPIRED', 401);
      const basePrincipal = resolvedPrincipal ?? principals.demo;
      const p: Principal = {
        ...basePrincipal,
        policyEpoch: basePrincipal.policyEpoch + (epochOffsets.get(basePrincipal.id) ?? 0),
        revoked: Boolean(basePrincipal.revoked) || revokedSubjects.has(basePrincipal.id),
      };
      if (path.startsWith('/api/') && p.revoked) throw new AppError('DATA_FORBIDDEN', 403);
      if (req.method === 'POST') {
        let limit = limits.get(p.id);
        if (!limit || Date.now() - limit.start > 60000) {
          limit = { start: Date.now(), count: 0 };
          limits.set(p.id, limit);
        }
        if (++limit.count > 120) throw new AppError('RATE_LIMITED', 429);
      }
      if (path === '/api/session') {
        json(res, {
          mode: agent.mode,
          identityMode: hostAuthEnabled ? 'host-authenticated' : 'local-single-user-demo',
          domainOptions: p.domains,
          sourceHash: SOURCE_HASH,
        });
        return;
      }
      if (path.startsWith('/api/v2/')) {
        // The host owns identity; retaining the principal reference permits revocation checks during a request.
        const principal: FoundationPrincipal = { subject: p.id, context: { csvIdentity: p } };
        const signal = AbortSignal.timeout(180000);
        if (path === '/api/v2/capabilities' && req.method === 'GET') {
          json(res, foundation.backend.negotiate(principal));
          return;
        }
        const conversationV2 = path.match(/^\/api\/v2\/conversations\/([\w-]+)$/);
        if (conversationV2 && req.method === 'GET') {
          json(
            res,
            await foundation.backend.history(
              ProtocolLocalId.parse(conversationV2[1]),
              principal,
              signal,
            ),
          );
          return;
        }
        const snapshotV2 = path.match(/^\/api\/v2\/responses\/([\w-]+)$/);
        if (snapshotV2 && req.method === 'GET') {
          json(
            res,
            await foundation.backend.snapshot(
              ProtocolLocalId.parse(snapshotV2[1]),
              principal,
              signal,
            ),
          );
          return;
        }
        const requestV2 = path.match(/^\/api\/v2\/requests\/([\w-]+)\/(events|cancel)$/);
        if (requestV2 && requestV2[2] === 'events' && req.method === 'GET') {
          json(
            res,
            await foundation.backend.replay(
              ProtocolLocalId.parse(requestV2[1]),
              Number(url.searchParams.get('after') ?? '-1'),
              principal,
              signal,
            ),
          );
          return;
        }
        if (requestV2 && requestV2[2] === 'cancel' && req.method === 'POST') {
          await body(req);
          json(
            res,
            await foundation.backend.cancel(ProtocolLocalId.parse(requestV2[1]), principal, signal),
          );
          return;
        }
        if (path === '/api/v2/options' && req.method === 'POST') {
          json(
            res,
            await foundation.backend.options(OptionQuery.parse(await body(req)), principal, signal),
          );
          return;
        }
        if ((path === '/api/v2/turns' || path === '/api/v2/actions') && req.method === 'POST') {
          const input = await body(req);
          const events =
            path === '/api/v2/turns'
              ? foundation.backend.turn(TurnRequest.parse(input), principal, signal)
              : foundation.backend.action(BackendAction.parse(input), principal, signal);
          const iterator = events[Symbol.asyncIterator]();
          const first = await iterator.next();
          if (first.done) throw new AppError('STREAM_INTERRUPTED', 409);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          });
          try {
            if (!res.destroyed)
              res.write(`id: ${first.value.sequence}\ndata: ${JSON.stringify(first.value)}\n\n`);
            for (;;) {
              const next = await iterator.next();
              if (next.done) break;
              if (!res.destroyed)
                res.write(`id: ${next.value.sequence}\ndata: ${JSON.stringify(next.value)}\n\n`);
            }
          } finally {
            await iterator.return?.();
          }
          res.end();
          return;
        }
        throw new AppError('NOT_FOUND', 404);
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
      if (path === '/api/testing/v2/telemetry' && testAuthorized) {
        json(res, { modelCalls: foundation.provider?.calls.length ?? 0 });
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
        revokedSubjects.add(p.id);
        epochOffsets.set(p.id, (epochOffsets.get(p.id) ?? 0) + 1);
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
      const known =
        error instanceof Error &&
        [
          'DATA_FORBIDDEN',
          'IDEMPOTENCY_CONFLICT',
          'REPLAY_EXPIRED',
          'REPLAY_CURSOR_INVALID',
          'MESSAGE_CONFLICT',
        ].includes(error.message)
          ? error.message
          : undefined;
      const code =
        error instanceof AppError
          ? error.code
          : error instanceof FoundationError
            ? error.diagnostic.code
            : known
              ? known
              : error instanceof z.ZodError
                ? 'VALIDATION_FAILED'
                : 'INTERNAL_ERROR';
      if (!res.headersSent && !res.destroyed)
        json(
          res,
          { error: code },
          error instanceof AppError
            ? error.status
            : error instanceof FoundationError
              ? error.diagnostic.code === 'DATA_FORBIDDEN'
                ? 403
                : 409
              : known
                ? known === 'DATA_FORBIDDEN'
                  ? 403
                  : known === 'REPLAY_EXPIRED'
                    ? 410
                    : known === 'REPLAY_CURSOR_INVALID'
                      ? 400
                      : 409
                : error instanceof z.ZodError
                  ? 400
                  : 500,
        );
      else if (!res.destroyed) res.end();
    } finally {
      inFlight--;
      if (!inFlight) {
        for (const resolve of drained) resolve();
        drained.clear();
      }
    }
  });
  return {
    server,
    store,
    repo,
    service,
    purgeRetention: foundation.purgeRetention,
    close: async () => {
      const closing = server.listening
        ? new Promise<void>((done, reject) => server.close((e) => (e ? reject(e) : done())))
        : Promise.resolve();
      for (const c of service.running.values()) c.abort();
      foundation.backend.shutdown();
      await closing;
      if (inFlight) await new Promise<void>((resolve) => drained.add(resolve));
      foundation.close();
      store.close();
    },
  };
}
