import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import { FoundationControlService } from '../../packages/server-runtime/controls.ts';
import { SqliteControlSnapshotStore } from '../../packages/server-runtime/control-sqlite.ts';
import { SqliteConversationStore } from '../../packages/server-runtime/conversation-store.ts';
import { SqliteRequestJournal } from '../../packages/server-runtime/request-journal.ts';
import { AuthorizedConversations } from '../../packages/server-runtime/authorized-conversations.ts';
import {
  AuthorizedRequestJournal,
  type JournalPolicy,
} from '../../packages/server-runtime/authorized-journal.ts';
import { FoundationBackend } from '../../packages/server-runtime/backend.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import {
  FoundationError,
  type PlanningAgent,
  type ResponsePlan,
} from '../../packages/contracts/foundation.ts';
import { ResponseRenderer } from '../../packages/renderer-openui/foundation.tsx';
import { builtinRegistry } from '../../packages/renderer-openui/builtins.tsx';
import { domains, permissivePolicy, plan, principal } from '../fixtures/foundation-domains.ts';

const signal = () => new AbortController().signal;
function fixtureCatalog() {
  const c = registerBuiltins(new FoundationCatalog(permissivePolicy));
  c.registerOptionResolver({
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
  c.registerDomain({
    ...domain,
    tools: [
      {
        ...tool,
        interactive: {
          ...tool.interactive,
          region: { ...tool.interactive.region, options: { id: 'fixture.regions', version: 1 } },
        },
      },
    ],
  });
  return c;
}
function proposal(c: FoundationCatalog) {
  const candidate = plan(c);
  const block = candidate.blocks[0];
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
  return candidate;
}
function create(path: string, c: FoundationCatalog, agent: PlanningAgent, epoch: () => number) {
  const snapshots = new SqliteControlSnapshotStore(path);
  const store = new SqliteRequestJournal(path, { maxEvents: 20, retentionMs: 60000 });
  const messages = new SqliteConversationStore(store.connectionForConversations());
  const controls = new FoundationControlService(
    c,
    (who) => String(who.context.account ?? ''),
    snapshots,
  );
  const policy: JournalPolicy = {
    owner: (who) => String(who.context.account ?? ''),
    scope: async (_id, who) => (who.subject === principal.subject ? `epoch-${epoch()}` : ''),
    response: async (response, who, abort) => {
      const saved = await controls.read(
        response.responseId,
        who,
        abort,
        response.revision,
        response.generation,
      );
      if (!isDeepStrictEqual(saved, response))
        throw new FoundationError({
          code: 'DATA_FORBIDDEN',
          path: '',
          message: 'Response is unavailable',
        });
    },
    recovery: async (responseId, who, abort) => {
      await controls.read(responseId, who, abort);
    },
  };
  const conversations = new AuthorizedConversations(messages, controls, policy);
  const journal = new AuthorizedRequestJournal(store, policy);
  const backend = new FoundationBackend(c, agent, controls, conversations, journal, policy);
  return {
    backend,
    store,
    close: () => {
      store.close();
      messages.close();
      snapshots.close();
    },
  };
}
async function collect<T>(stream: AsyncIterable<T>) {
  const output: T[] = [];
  for await (const item of stream) output.push(item);
  return output;
}

test('independent source failure yields a sanitized partial response that survives restart and rechecks policy', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'foundation-partial-'));
  const path = join(directory, 'backend.sqlite');
  let revoked = false;
  let sourceAvailable = false;
  let goodExecutions = 0;
  const policy = {
    ...permissivePolicy,
    authorize: async (ref: { id: string }) => {
      if (revoked && ref.id === 'operations.quality')
        throw new FoundationError({ code: 'DATA_FORBIDDEN', path: '', message: 'Revoked' });
      return { scopeKey: 'scope', context: {} };
    },
  };
  const c = registerBuiltins(new FoundationCatalog(policy));
  c.registerDomain({
    ...domains[1],
    tools: [
      {
        ...domains[1].tools[0],
        execute: async (...args) => {
          goodExecutions++;
          return domains[1].tools[0].execute(...args);
        },
      },
    ],
  });
  c.registerDomain({
    ...domains[0],
    tools: [
      {
        ...domains[0].tools[0],
        execute: async () => {
          if (!sourceAvailable) throw new Error('secret source exception');
          return domains[0].tools[0].execute({ area: 'north', region: null }, {}, signal());
        },
      },
    ],
  });
  const candidate = plan(c);
  candidate.bindings.push({
    id: 'broken',
    tool: domains[0].tools[0].ref,
    args: {},
    fixedArgs: { area: 'north', region: null },
  });
  candidate.facts.push(
    { id: 'revenue', field: { bindingId: 'data', fieldId: 'net' }, row: 0, format: 'integer' },
    { id: 'score', field: { bindingId: 'broken', fieldId: 'score' }, row: 0, format: 'integer' },
  );
  candidate.blocks.push({
    id: 'summary',
    kind: 'text',
    parts: [{ factId: 'revenue' }, { text: ' / ' }, { factId: 'score' }],
  });
  const visual = candidate.blocks[0];
  if (visual.kind !== 'visual') throw new Error('Expected visual');
  visual.elements.push({
    id: 'failedview',
    component: { id: 'ui.table', version: 1 },
    title: 'Failed source',
    roles: { columns: [{ bindingId: 'broken', fieldId: 'score' }] },
    props: {},
  });
  let host = create(path, c, { propose: async () => candidate }, () => 1);
  try {
    const events = await collect(
      host.backend.turn(
        {
          conversationId: 'partialconversation',
          messageId: 'partialmessage',
          text: 'Show both sources',
          idempotencyKey: 'partialturn',
          components: host.backend.negotiate(principal).components,
          previous: [],
        },
        principal,
        signal(),
      ),
    );
    const event = events.find((item) => item.type === 'response.committed');
    if (!event || event.type !== 'response.committed')
      throw new Error('Partial response not committed');
    assert.equal(event.response.status, 'partial');
    assert.equal(event.response.datasets.data.status, 'ready');
    assert.equal(event.response.datasets.broken.status, 'failed');
    assert.equal(event.response.facts.revenue.value, '170');
    assert.equal(event.response.facts.score, undefined);
    assert.equal(JSON.stringify(event).includes('secret source exception'), false);
    assert.deepEqual(event.response.operations, [{ id: 'ui.retryBinding', version: 1 }]);
    const html = renderToStaticMarkup(
      createElement(ResponseRenderer, { response: event.response, registry: builtinRegistry }),
    );
    assert.match(html, /170/);
    assert.match(html, /date: 2024-01-01/);
    assert.match(html, /This data source is unavailable/);
    assert.match(html, /Unavailable/);
    assert.doesNotMatch(html, /secret source exception/);
    host.close();
    host = create(path, c, { propose: async () => candidate }, () => 1);
    const history = await host.backend.history('partialconversation', principal, signal());
    assert.deepEqual(history.messages[1].response, event.response);
    const retry = {
      responseId: event.response.responseId,
      revision: 1,
      generation: 0,
      action: { id: 'ui.retryBinding', version: 1 },
      payload: { bindingId: 'broken' },
      idempotencyKey: 'retry1',
    };
    const failed = await collect(host.backend.action(retry, principal, signal()));
    assert.equal(failed.at(-1)?.type, 'request.failed');
    assert.deepEqual(
      (await host.backend.history('partialconversation', principal, signal())).messages[1].response,
      event.response,
    );
    sourceAvailable = true;
    const success = await collect(
      host.backend.action({ ...retry, idempotencyKey: 'retry2' }, principal, signal()),
    );
    const recovered = success.find((item) => item.type === 'response.committed');
    if (!recovered || recovered.type !== 'response.committed')
      throw new Error('Retry not committed');
    assert.equal(recovered.response.status, 'complete');
    assert.equal(recovered.response.generation, 1);
    assert.equal(recovered.response.facts.score.value, '82');
    assert.equal(goodExecutions, 1);
    const replay = await collect(
      host.backend.action({ ...retry, idempotencyKey: 'retry2' }, principal, signal()),
    );
    assert.deepEqual(replay, success);
    const stale = await collect(
      host.backend.action({ ...retry, idempotencyKey: 'retry3' }, principal, signal()),
    );
    assert.equal(stale.at(-1)?.type, 'request.failed');
    revoked = true;
    await assert.rejects(host.backend.history('partialconversation', principal, signal()));
  } finally {
    host.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected temp path');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('partial execution never converts authorization failures or all-source failures into success', async () => {
  for (const error of [
    new FoundationError({ code: 'DATA_FORBIDDEN', path: '', message: 'Denied' }),
    new Error('Source unavailable'),
  ]) {
    const c = registerBuiltins(new FoundationCatalog(permissivePolicy));
    c.registerDomain({
      ...domains[1],
      tools: [
        {
          ...domains[1].tools[0],
          execute: async () => {
            throw error;
          },
        },
      ],
    });
    await assert.rejects(
      new FoundationRuntime(c).execute(plan(c), principal, signal(), undefined, true),
    );
  }
});

test('backend commits and replays a conversation and action across SQLite restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'foundation-backend-'));
  const path = join(directory, 'backend.sqlite');
  let epoch = 1;
  let calls = 0;
  const c = fixtureCatalog();
  const agent: PlanningAgent = {
    propose: async () => {
      calls++;
      return proposal(c);
    },
  };
  let host = create(path, c, agent, () => epoch);
  try {
    const input = {
      conversationId: 'conversation1',
      messageId: 'message1',
      text: 'Show revenue',
      idempotencyKey: 'turn1',
      components: host.backend.negotiate(principal).components,
      previous: [],
    };
    const events = await collect(host.backend.turn(input, principal, signal()));
    assert.deepEqual(
      events.map((item) => item.type),
      [
        'request.started',
        'plan.accepted',
        'binding.pending',
        'binding.ready',
        'response.committed',
        'request.completed',
      ],
    );
    const committed = events.find((item) => item.type === 'response.committed');
    if (!committed || committed.type !== 'response.committed') throw new Error('Missing response');
    const response = committed.response;
    assert.equal(
      response.datasets.data.status === 'ready' && response.datasets.data.result.rows[0].net,
      170,
    );
    const action = {
      responseId: response.responseId,
      revision: 1,
      generation: 0,
      action: { id: 'ui.setControl', version: 1 },
      payload: { controlId: 'region', value: 'east' },
      idempotencyKey: 'action1',
    };
    const actionEvents = await collect(host.backend.action(action, principal, signal()));
    const updated = actionEvents.find((item) => item.type === 'response.committed');
    if (!updated || updated.type !== 'response.committed') throw new Error('Missing update');
    assert.equal(updated.response.generation, 1);
    assert.equal(
      updated.response.datasets.data.status === 'ready' &&
        updated.response.datasets.data.result.rows[0].net,
      130,
    );
    assert.equal(
      (await host.backend.history('conversation1', principal, signal())).messages[1].response
        ?.generation,
      1,
    );
    const originalRequest = events[0].requestId;
    host.close();
    const restarted = fixtureCatalog();
    host = create(
      path,
      restarted,
      {
        propose: async () => {
          calls++;
          throw new Error('Should not plan a duplicate');
        },
      },
      () => epoch,
    );
    assert.equal(host.store.interruptRunning(), 0);
    assert.equal(
      (await host.backend.history('conversation1', principal, signal())).messages[1].response
        ?.generation,
      1,
    );
    const replay = await host.backend.replay(originalRequest, -1, principal, signal());
    assert.equal(replay.kind, 'events');
    if (replay.kind === 'events') assert.deepEqual(replay.events, events);
    assert.deepEqual(await collect(host.backend.turn(input, principal, signal())), events);
    assert.deepEqual(await collect(host.backend.action(action, principal, signal())), actionEvents);
    assert.equal(calls, 1);
    await assert.rejects(
      collect(
        host.backend.action(
          { ...action, payload: { controlId: 'region', value: 'west' } },
          principal,
          signal(),
        ),
      ),
      /IDEMPOTENCY_CONFLICT/,
    );
    epoch = 2;
    await assert.rejects(
      host.backend.history('conversation1', principal, signal()),
      /DATA_FORBIDDEN/,
    );
    await assert.rejects(
      host.backend.replay(originalRequest, -1, principal, signal()),
      /DATA_FORBIDDEN/,
    );
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('backend cancellation produces a terminal event and abandoned consumers become interrupted', async () => {
  const c = fixtureCatalog();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const agent: PlanningAgent = {
    propose: async ({ signal: abort }) => {
      started();
      return new Promise((_resolve, reject) =>
        abort.addEventListener('abort', () => reject(abort.reason), { once: true }),
      );
    },
  };
  const host = create(':memory:', c, agent, () => 1);
  try {
    const input = {
      conversationId: 'conversation1',
      messageId: 'message1',
      text: 'Wait',
      idempotencyKey: 'turn1',
      components: host.backend.negotiate(principal).components,
      previous: [],
    };
    const iterator = host.backend.turn(input, principal, signal())[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error('Missing start');
    const next = iterator.next();
    await entered;
    assert.equal(
      (await host.backend.cancel(first.value.requestId, principal, signal())).accepted,
      true,
    );
    const terminal = await next;
    assert.equal(!terminal.done && terminal.value.type, 'request.cancelled');
    await iterator.next();
    assert.equal(
      (await host.backend.history('conversation1', principal, signal())).messages[1].text,
      'Request cancelled.',
    );
    const other = host.backend
      .turn({ ...input, messageId: 'message2', idempotencyKey: 'turn2' }, principal, signal())
      [Symbol.asyncIterator]();
    const begun = await other.next();
    if (begun.done) throw new Error('Missing start');
    await other.return?.();
    const replay = await host.backend.replay(begun.value.requestId, -1, principal, signal());
    assert.equal(replay.status, 'interrupted');
    const history = await host.backend.history('conversation1', principal, signal());
    assert.deepEqual(history.messages.at(-1)?.interruptedRequest, {
      requestId: begun.value.requestId,
      status: 'interrupted',
    });
  } finally {
    host.close();
  }
});

test('clarification choices are verified against an authorized response and reach the planner as typed context', async () => {
  const c = fixtureCatalog();
  let calls = 0;
  const agent: PlanningAgent = {
    propose: async (context) => {
      calls++;
      if (!context.choice)
        return {
          schemaVersion: 2,
          capabilitySnapshotId: (context.capabilities as { id: string }).id,
          bindings: [],
          facts: [],
          blocks: [
            {
              id: 'question',
              kind: 'clarification',
              question: 'Which view?',
              choices: [{ id: 'daily', label: 'Daily' }],
            },
          ],
        };
      assert.equal(context.choice.choiceId, 'daily');
      assert.equal(context.previous?.blocks[0].kind, 'clarification');
      return {
        schemaVersion: 2,
        capabilitySnapshotId: (context.capabilities as { id: string }).id,
        bindings: [],
        facts: [],
        blocks: [{ id: 'answer', kind: 'text', parts: [{ text: 'Daily selected.' }] }],
      };
    },
  };
  const host = create(':memory:', c, agent, () => 1);
  try {
    const components = host.backend.negotiate(principal).components;
    const first = await collect(
      host.backend.turn(
        {
          conversationId: 'conversation1',
          messageId: 'message1',
          text: 'Explore',
          idempotencyKey: 'turn1',
          components,
          previous: [],
        },
        principal,
        signal(),
      ),
    );
    const clarification = first.find((item) => item.type === 'response.committed');
    if (!clarification || clarification.type !== 'response.committed')
      throw new Error('Missing clarification');
    const choice = {
      responseId: clarification.response.responseId,
      blockId: 'question',
      choiceId: 'daily',
    };
    const second = await collect(
      host.backend.turn(
        {
          conversationId: 'conversation1',
          messageId: 'message2',
          text: 'Daily',
          idempotencyKey: 'turn2',
          components,
          previous: [],
          choice,
        },
        principal,
        signal(),
      ),
    );
    assert.equal(second.at(-1)?.type, 'request.completed');
    assert.equal(calls, 2);
    const invalid = await collect(
      host.backend.turn(
        {
          conversationId: 'conversation1',
          messageId: 'message3',
          text: 'Invented',
          idempotencyKey: 'turn3',
          components,
          previous: [],
          choice,
        },
        principal,
        signal(),
      ),
    );
    const failure = invalid.at(-1);
    assert.equal(failure?.type, 'request.failed');
    if (failure?.type === 'request.failed') assert.equal(failure.diagnostic.code, 'SCHEMA_INVALID');
    assert.equal(calls, 2);
  } finally {
    host.close();
  }
});

test('multi-binding sequential retry recovers independent failures without re-executing healthy bindings', async () => {
  let failOps = true;
  let failAudit = true;
  let goodCalls = 0;
  const c = registerBuiltins(new FoundationCatalog(permissivePolicy));
  c.registerDomain({
    ...domains[1],
    tools: [
      {
        ...domains[1].tools[0],
        execute: async (...args) => {
          goodCalls++;
          return domains[1].tools[0].execute(...args);
        },
      },
    ],
  });
  c.registerDomain({
    ...domains[0],
    tools: [
      {
        ...domains[0].tools[0],
        execute: async () => {
          if (failOps) throw new Error('ops down');
          return domains[0].tools[0].execute({ area: 'north', region: null }, {}, signal());
        },
      },
    ],
  });
  c.registerDomain({
    ref: { id: 'audit.domain', version: 1 },
    description: 'Audit domain',
    semantics: ['Audit'],
    tools: [
      {
        ref: { id: 'audit.check', version: 1 },
        description: 'Audit check',
        args: z.strictObject({}),
        fields: [
          {
            id: 'checks',
            label: 'Checks',
            description: 'Audit check count',
            type: 'number',
            role: 'measure',
            nullable: false,
            unit: 'count',
            measure: { aggregation: 'count', precision: 0, additive: true },
          },
        ],
        grain: 'one row per audit summary',
        interactive: {},
        execute: async () => {
          if (failAudit) throw new Error('audit down');
          return {
            rows: [{ checks: 9 }],
            provenance: {
              sourceId: 'audit',
              sourceVersion: 'v1',
              queryId: 'qa',
              executedAt: new Date().toISOString(),
              sourceAsOf: new Date().toISOString(),
              grain: 'one row per audit summary',
              truncated: false,
              nextCursor: null,
              warnings: [],
            },
          };
        },
      },
    ],
  });
  const candidate = plan(c);
  candidate.bindings.push(
    {
      id: 'ops',
      tool: domains[0].tools[0].ref,
      args: {},
      fixedArgs: { area: 'north', region: null },
    },
    { id: 'audit', tool: { id: 'audit.check', version: 1 }, args: {}, fixedArgs: {} },
  );
  const visual = candidate.blocks[0];
  if (visual.kind !== 'visual') throw new Error('Expected visual');
  visual.elements.push(
    {
      id: 'opsTbl',
      component: { id: 'ui.table', version: 1 },
      title: 'Ops',
      roles: { columns: [{ bindingId: 'ops', fieldId: 'score' }] },
      props: {},
    },
    {
      id: 'auditTbl',
      component: { id: 'ui.table', version: 1 },
      title: 'Audit',
      roles: { columns: [{ bindingId: 'audit', fieldId: 'checks' }] },
      props: {},
    },
  );
  const host = create(':memory:', c, { propose: async () => candidate }, () => 1);
  try {
    const initialEvents = await collect(
      host.backend.turn(
        {
          conversationId: 'multi1',
          messageId: 'msg1',
          text: 'Show all',
          idempotencyKey: 'turn_multi',
          components: host.backend.negotiate(principal).components,
          previous: [],
        },
        principal,
        signal(),
      ),
    );
    const r0 = initialEvents.find((e) => e.type === 'response.committed');
    assert.ok(r0?.type === 'response.committed');
    assert.equal(r0.response.status, 'partial');
    assert.equal(r0.response.datasets.ops.status, 'failed');
    assert.equal(r0.response.datasets.audit.status, 'failed');
    assert.equal(goodCalls, 1);

    failOps = false;
    const retryOpsEvents = await collect(
      host.backend.action(
        {
          responseId: r0.response.responseId,
          revision: 1,
          generation: 0,
          action: { id: 'ui.retryBinding', version: 1 },
          payload: { bindingId: 'ops' },
          idempotencyKey: 'retry_ops',
        },
        principal,
        signal(),
      ),
    );
    const r1 = retryOpsEvents.find((e) => e.type === 'response.committed');
    assert.ok(r1?.type === 'response.committed');
    assert.equal(r1.response.status, 'partial');
    assert.equal(r1.response.datasets.ops.status, 'ready');
    assert.equal(r1.response.datasets.audit.status, 'failed');
    assert.equal(goodCalls, 1);

    failAudit = false;
    const retryAuditEvents = await collect(
      host.backend.action(
        {
          responseId: r1.response.responseId,
          revision: 1,
          generation: 1,
          action: { id: 'ui.retryBinding', version: 1 },
          payload: { bindingId: 'audit' },
          idempotencyKey: 'retry_audit',
        },
        principal,
        signal(),
      ),
    );
    const r2 = retryAuditEvents.find((e) => e.type === 'response.committed');
    assert.ok(r2?.type === 'response.committed');
    assert.equal(r2.response.status, 'complete');
    assert.equal(r2.response.generation, 2);
    assert.equal(goodCalls, 1);
  } finally {
    host.close();
  }
});

test('change-answer control action persists new message and immutable revision across SQLite restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'foundation-scope-'));
  const path = join(directory, 'scope.sqlite');
  const buildCatalog = () => fixtureCatalog();
  let c = buildCatalog();
  const basePlan = proposal(c);
  const scopePlan: ResponsePlan = {
    ...basePlan,
    blocks: basePlan.blocks.map((block) =>
      block.kind === 'visual'
        ? {
            ...block,
            controls: block.controls.map((ctrl) => ({
              ...ctrl,
              scopeMode: 'change-answer' as const,
            })),
          }
        : block,
    ),
  };
  let host = create(path, c, { propose: async () => scopePlan }, () => 1);
  try {
    const turnEvents = await collect(
      host.backend.turn(
        {
          conversationId: 'conv_scope',
          messageId: 'm1',
          text: 'Initial view',
          idempotencyKey: 't1',
          components: host.backend.negotiate(principal).components,
          previous: [],
        },
        principal,
        signal(),
      ),
    );
    const committed0 = turnEvents.find((e) => e.type === 'response.committed');
    assert.ok(committed0?.type === 'response.committed');
    const actionEvents = await collect(
      host.backend.action(
        {
          responseId: committed0.response.responseId,
          revision: 1,
          generation: 0,
          action: { id: 'ui.setControl', version: 1 },
          payload: { controlId: 'region', value: 'east', newMessageId: 'm2', userMessageId: 'u2' },
          idempotencyKey: 'scope_change_1',
        },
        principal,
        signal(),
      ),
    );
    const committed1 = actionEvents.find((e) => e.type === 'response.committed');
    assert.ok(committed1?.type === 'response.committed');
    assert.notEqual(committed1.response.responseId, committed0.response.responseId);
    assert.equal(committed1.response.revision, 2);
    assert.equal(committed1.response.generation, 0);
    assert.equal(committed1.response.messageId, 'm2');

    host.close();
    c = buildCatalog();
    host = create(path, c, { propose: async () => scopePlan }, () => 1);
    const restored = await host.backend.history('conv_scope', principal, signal());
    assert.equal(restored.messages.length, 4);
    assert.equal(restored.messages[1].response?.revision, 1);
    assert.equal(restored.messages[2].role, 'user');
    assert.equal(restored.messages[2].id, 'u2');
    assert.equal(restored.messages[3].response?.revision, 2);
    assert.equal(restored.messages[3].response?.responseId, committed1.response.responseId);
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
