import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../packages/server-runtime/store.ts';
import { csvPlan } from '../../examples/csv-analytics/plans.ts';
import { createApplication } from '../../apps/reference-server/server.ts';
import type { Event } from '../../packages/contracts/index.ts';
const p = { id: 'demo', tenant: 'demo', domains: ['kyc', 'party', 'payment'], policyEpoch: 1 };
test('durable immutable revisions, optimistic conflicts, ownership and idempotency', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csv-store-'));
  const path = join(dir, 'test.sqlite');
  let store = new Store(path);
  try {
    store.conversation('chat', p, true);
    const a = store.commit('chat', csvPlan('trend'), 'hash', p);
    assert.equal(a.revision, 1);
    const b = store.commit('chat', csvPlan('overview'), 'hash', p, a);
    assert.equal(b.revision, 2);
    assert.throws(() => store.commit('chat', csvPlan('trend'), 'hash', p, a));
    assert.throws(() => store.artifact(a.artifactId, { ...p, tenant: 'other' }));
    assert.throws(() => store.conversation('chat', { ...p, domains: ['kyc'], policyEpoch: 2 }));
    assert.equal(store.start('chat', 'key', 'body', p).existing, false);
    assert.equal(store.start('chat', 'key', 'body', p).existing, true);
    assert.throws(() => store.start('chat', 'key', 'different', p));
    store.close();
    store = new Store(path);
    assert.equal(store.artifact(a.artifactId, p, 1).plan.panels.length, 1);
    assert.equal(store.artifact(a.artifactId, p).plan.panels.length, 6);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('HTTP turn streams actual CSV facts, restores conversation and rejects cross-scope reads', async () => {
  const app = createApplication({ database: ':memory:', testToken: 'test-only' });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(base + '/api/chat/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'integration',
        idempotencyKey: 'one',
        text: 'How many source records are in the file?',
      }),
    });
    const events = (await res.text())
      .split('\n')
      .filter((x) => x.startsWith('data: '))
      .map((x) => JSON.parse(x.slice(6)) as Event);
    assert.equal(events[0].type, 'request.started');
    assert.equal(events.at(-1)?.type, 'request.completed');
    assert.match(JSON.stringify(events), /3,509/);
    assert.equal(app.service.queries.executions.length, 1);
    assert.equal(app.service.agent.calls.length, 0);
    const restored = await (await fetch(base + '/api/conversations/integration')).json();
    assert.equal(restored.messages.length, 2);
    assert.equal(
      (
        await fetch(base + '/api/conversations/integration', {
          headers: { 'x-test-token': 'test-only', 'x-test-principal': 'limited' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + '/api/chat/turns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
          body: '{}',
        })
      ).status,
      403,
    );
  } finally {
    await app.close();
  }
});
test('one to two to six panels, deduplicated metrics, filters without agent, generation barrier and failures', async () => {
  const app = createApplication({ database: ':memory:' });
  const service = app.service;
  try {
    let artifact: ReturnType<Store['artifact']> | undefined;
    for (const [index, text] of [
      'Show monthly unweighted mean SLA rate and source-record counts by domain. Include a domain filter.',
      'Add source-record count, distinct-system count, unweighted mean SLA rate, and the underlying records.',
    ].entries()) {
      const events: Event[] = [];
      await service.turn(
        {
          conversationId: 'chat',
          text,
          idempotencyKey: `turn${index}`,
          ...(artifact ? { artifactId: artifact.artifactId, baseRevision: artifact.revision } : {}),
        },
        p,
        (e) => events.push(e),
      );
      assert.equal(events.at(-1)?.type, 'request.completed');
      artifact = (
        events.find((e) => e.type === 'artifact.settled')!.payload as { artifact: typeof artifact }
      ).artifact!;
    }
    assert.equal(artifact!.plan.panels.length, 6);
    const history = app.store.conversation('chat', p).messages as unknown as {
      visual?: typeof artifact;
    }[];
    assert.deepEqual(
      history.filter((m) => m.visual).map((m) => m.visual!.plan.panels.length),
      [2, 6],
    );
    assert.equal(service.queries.executions.filter((q) => q.toolId === 'csv.summary').length, 1);
    const filtered = await service.action(
      artifact!.artifactId,
      artifact!.revision,
      { type: 'setFilter', filters: { domain: 'kyc' } },
      p,
    );
    const summary = filtered.datasets.summary;
    assert.equal(summary.status, 'ready');
    if (summary.status === 'ready') assert.equal(summary.data.rows[0].record_count, 1039);
    service.fault = { tool: 'csv.countByDomain', fail: true };
    const partial = await service.action(
      filtered.artifactId,
      filtered.revision,
      { type: 'refresh' },
      p,
    );
    assert.equal(partial.datasets.domains.status, 'error');
    assert.equal(partial.datasets.summary.status, 'ready');
    service.fault = { tool: 'csv.monthlySla', delayMs: 80 };
    const old = service.action(
      filtered.artifactId,
      filtered.revision,
      { type: 'setFilter', filters: { domain: 'payment' } },
      p,
    );
    const latest = service.action(
      filtered.artifactId,
      filtered.revision,
      { type: 'setFilter', filters: { domain: 'kyc' } },
      p,
    );
    await Promise.all([old, latest]);
    assert.equal(app.store.artifact(filtered.artifactId, p).filters.domain, 'kyc');
  } finally {
    await app.close();
  }
});
