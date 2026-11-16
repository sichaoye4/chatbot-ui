import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MaterializedResponse, ProtocolEvent } from '../../packages/contracts/protocol.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import {
  initialFoundationState,
  interruptFoundationRequest,
  reduceFoundationEvent,
} from '../../packages/client-runtime/foundation.ts';
import {
  catalog,
  permissivePolicy,
  plan,
  principal,
  result,
} from '../fixtures/foundation-domains.ts';

const identity = { messageId: 'message1', responseId: 'response1', revision: 1, generation: 0 };
const signal = () => new AbortController().signal;

test('independent precomputed result is published with descriptors, grounded facts and provenance', async () => {
  const c = catalog();
  const p = plan(c);
  p.facts.push({
    id: 'netFact',
    field: { bindingId: 'data', fieldId: 'net' },
    row: 0,
    format: 'decimal',
  });
  p.blocks.push({ id: 'summary', kind: 'text', parts: [{ factId: 'netFact' }] });
  const runtime = new FoundationRuntime(c);
  const response = await runtime.ingest(
    p,
    { data: result([{ date: '2024-01-01', net: 130 }], 'one row per day') },
    principal,
    signal(),
    identity,
  );
  assert.equal(response.facts.netFact.value, '130');
  assert.equal(response.bindingDescriptors[0].fields[1].unit, 'currency:USD');
  assert.equal(
    MaterializedResponse.parse(JSON.parse(JSON.stringify(response))).responseId,
    'response1',
  );
  assert.equal(
    ProtocolEvent.parse({
      protocolVersion: 2,
      eventId: 'event1',
      requestId: 'request1',
      sequence: 1,
      conversationId: 'conversation1',
      messageId: 'message1',
      type: 'response.committed',
      response,
    }).type,
    'response.committed',
  );
  assert.equal(MaterializedResponse.safeParse({ ...response, datasets: {} }).success, false);
});

test('normalized events preserve the last committed generation on stale, interrupted and cancelled updates', async () => {
  const c = catalog();
  const response = await new FoundationRuntime(c).ingest(
    plan(c),
    { data: result([{ date: '2024-01-01', net: 130 }], 'one row per day') },
    principal,
    signal(),
    identity,
  );
  const base = {
    protocolVersion: 2,
    requestId: 'request1',
    conversationId: 'conversation1',
    messageId: 'message1',
  } as const;
  let state = reduceFoundationEvent(initialFoundationState, {
    ...base,
    type: 'request.started',
    eventId: 'event1',
    sequence: 0,
  });
  state = reduceFoundationEvent(state, {
    ...base,
    type: 'plan.accepted',
    eventId: 'event_plan',
    sequence: 1,
    responseId: 'response1',
    revision: 1,
    generation: 1,
    bindingIds: ['data', 'extra'],
  });
  assert.equal(state.response, undefined);
  assert.equal(state.staged?.bindings.data.status, 'pending');
  state = reduceFoundationEvent(state, {
    ...base,
    type: 'binding.ready',
    eventId: 'event_ready',
    sequence: 2,
    responseId: 'response1',
    revision: 1,
    generation: 1,
    bindingId: 'data',
    rowCount: 1,
    truncated: false,
  });
  state = reduceFoundationEvent(state, {
    ...base,
    type: 'binding.failed',
    eventId: 'event_fail',
    sequence: 3,
    responseId: 'response1',
    revision: 1,
    generation: 1,
    bindingId: 'extra',
    diagnostic: { code: 'SOURCE_FAILURE', message: 'Failed', retryable: true },
  });
  assert.equal(state.response, undefined);
  assert.equal(state.staged?.bindings.data.status, 'ready');
  assert.equal(state.staged?.bindings.extra.status, 'failed');
  state = reduceFoundationEvent(state, {
    ...base,
    type: 'response.committed',
    eventId: 'event2',
    sequence: 4,
    response,
  });
  assert.equal(state.staged, undefined);
  const duplicate = reduceFoundationEvent(state, {
    ...base,
    type: 'response.committed',
    eventId: 'event2',
    sequence: 4,
    response,
  });
  assert.strictEqual(duplicate, state);
  state = reduceFoundationEvent(state, {
    ...base,
    type: 'response.committed',
    eventId: 'event3',
    sequence: 5,
    response: { ...response, responseId: 'other' },
  });
  assert.equal(state.response?.responseId, 'response1');
  assert.equal(interruptFoundationRequest(state).status, 'interrupted');
  assert.equal(interruptFoundationRequest(state).staged, undefined);
  state = reduceFoundationEvent(state, {
    ...base,
    type: 'request.cancelled',
    eventId: 'event4',
    sequence: 6,
  });
  assert.equal(state.status, 'cancelled');
  assert.equal(state.staged, undefined);
  assert.equal(state.response?.generation, 0);
  assert.strictEqual(
    reduceFoundationEvent(state, {
      ...base,
      type: 'request.completed',
      eventId: 'event5',
      sequence: 7,
    }),
    state,
  );
});

test('ingestion rejects extra or invalid results, budget violations and revoked authorization', async () => {
  const c = catalog();
  const runtime = new FoundationRuntime(c);
  const p = plan(c);
  await assert.rejects(
    runtime.ingest(
      p,
      { data: result([{ date: '2024-01-01', net: 'bad' }], 'one row per day') },
      principal,
      signal(),
      identity,
    ),
    /RESULT_INVALID/,
  );
  await assert.rejects(
    runtime.ingest(p, { extra: {} }, principal, signal(), identity),
    /RESULT_INVALID/,
  );
  await assert.rejects(
    runtime.ingest(
      p,
      {
        data: result(
          Array.from({ length: 2001 }, () => ({ date: '2024-01-01', net: 1 })),
          'one row per day',
        ),
      },
      principal,
      signal(),
      identity,
    ),
    /BUDGET_EXCEEDED/,
  );
  let calls = 0;
  const restricted = catalog({
    ...permissivePolicy,
    authorize: async () => ({ scopeKey: String(++calls), context: {} }),
  });
  await assert.rejects(
    new FoundationRuntime(restricted).ingest(
      plan(restricted),
      { data: result([{ date: '2024-01-01', net: 1 }], 'one row per day') },
      principal,
      signal(),
      identity,
    ),
    /DATA_FORBIDDEN/,
  );
});

test('planner capabilities and validation use the installed component intersection', async () => {
  const c = catalog();
  const allowed = [{ id: 'ui.trend', version: 1 }];
  const snapshot = c.snapshot(principal, allowed);
  assert.deepEqual(
    snapshot.components.map((component) => component.ref),
    allowed,
  );
  const candidate = plan(c);
  candidate.capabilitySnapshotId = snapshot.id;
  assert.throws(() => c.validate(candidate, principal, allowed), /CAPABILITY_UNAVAILABLE/);
  const runtime = new FoundationRuntime(c);
  let observed = false;
  await assert.rejects(
    runtime.plan(
      {
        propose: async (context) => {
          observed = true;
          assert.deepEqual(
            (context.capabilities as typeof snapshot).components.map((component) => component.ref),
            allowed,
          );
          return candidate;
        },
      },
      'show data',
      principal,
      signal(),
      undefined,
      0,
      allowed,
    ),
    /CAPABILITY_UNAVAILABLE/,
  );
  assert.equal(observed, true);
});
