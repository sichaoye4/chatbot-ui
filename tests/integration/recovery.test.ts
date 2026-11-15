import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../packages/server-runtime/store.ts';
import { Event } from '../../packages/contracts/index.ts';
import { createApplication } from '../../apps/reference-server/server.ts';
const p = { id: 'demo', tenant: 'demo', domains: ['kyc', 'party', 'payment'], policyEpoch: 1 };
test('bounded replay signals expiry, keeps monotonic sequence and authorizes request status', () => {
  const store = new Store(':memory:');
  try {
    const r = store.start('chat', 'turn', 'fingerprint', p);
    for (let i = 0; i < 205; i++) store.append(r.id, 'assistant.text.delta', { text: 'chunk' });
    assert.throws(() => store.events(r.id, p, 0), /REPLAY_EXPIRED/);
    assert.equal(store.events(r.id, p, 5).length, 200);
    assert.equal(store.events(r.id, p, 204)[0].sequence, 205);
    assert.throws(() => store.request(r.id, { ...p, tenant: 'elsewhere' }), /DATA_FORBIDDEN/);
  } finally {
    store.close();
  }
});
test('schema rejects malformed event payloads and incomplete artifact context', () => {
  const base = { protocolVersion: 1, eventId: 'event', requestId: 'request', sequence: 1 };
  assert.throws(() =>
    Event.parse({ ...base, type: 'assistant.text.delta', payload: { text: { script: 'bad' } } }),
  );
  assert.throws(() =>
    Event.parse({
      ...base,
      type: 'dataset.failed',
      payload: { bindingId: 'data', code: 'SOURCE_TIMEOUT' },
    }),
  );
});
test('cancelled execution reaches a terminal state without replacing prior artifact', async () => {
  const app = createApplication({ database: ':memory:' });
  try {
    app.service.fault = { tool: 'csv.monthlySla', delayMs: 50 };
    let id = '';
    const events: Event[] = [];
    const task = app.service.turn(
      { conversationId: 'chat', text: 'Show monthly SLA', idempotencyKey: 'cancel' },
      p,
      (e) => {
        events.push(e);
        if (e.type === 'request.started') id = e.requestId;
      },
    );
    app.service.running.get(id)!.abort();
    await task;
    assert.equal(events.at(-1)!.type, 'request.failed');
    assert.equal((events.at(-1)!.payload as { code: string }).code, 'REQUEST_CANCELLED');
    assert.equal(app.store.request(id, p).status, 'failed');
  } finally {
    await app.close();
  }
});
