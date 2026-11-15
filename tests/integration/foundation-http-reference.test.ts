import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../../apps/reference-server/server.ts';
import { FoundationHttpClient } from '../../packages/client-runtime/http.ts';
import type { PlanningAgent } from '../../packages/contracts/foundation.ts';

const signal = () => new AbortController().signal;
async function collect<T>(stream: AsyncIterable<T>) {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}
test('reference HTTP v2 restores and replays a scoped CSV control update after server restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'foundation-http-'));
  const database = join(directory, 'app.sqlite');
  let calls = 0;
  const agent: PlanningAgent = {
    propose: async (context) => {
      calls++;
      return {
        schemaVersion: 2,
        capabilitySnapshotId: (context.capabilities as { id: string }).id,
        bindings: [
          {
            id: 'records',
            tool: { id: 'csv.summary', version: 1 },
            args: { country: null },
            fixedArgs: { domain: 'payment' },
          },
        ],
        facts: [
          {
            id: 'count',
            field: { bindingId: 'records', fieldId: 'record_count' },
            row: 0,
            format: 'integer',
          },
        ],
        blocks: [
          { id: 'text', kind: 'text', parts: [{ factId: 'count' }, { text: ' observations.' }] },
          {
            id: 'visual',
            kind: 'visual',
            layoutIntent: 'auto',
            elements: [
              {
                id: 'metric',
                component: { id: 'ui.metric', version: 1 },
                title: 'Observations',
                roles: { value: [{ bindingId: 'records', fieldId: 'record_count' }] },
                props: {},
              },
            ],
            controls: [
              {
                id: 'country',
                control: { id: 'ui.select', version: 1 },
                label: 'Country',
                purpose: 'Filter by country',
                scopeMode: 'within-answer',
                targets: [{ bindingId: 'records', argument: 'country' }],
                initialValue: null,
                dependsOn: [],
              },
            ],
          },
        ],
      };
    },
  };
  let app = createApplication({ database, testToken: 'test-only', foundationAgent: agent });
  async function start() {
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }
  try {
    let base = await start();
    let client = new FoundationHttpClient(`${base}/api/v2`);
    const capabilities = await client.negotiate(signal());
    assert.equal(capabilities.history && capabilities.replay && capabilities.cancellation, true);
    const input = {
      conversationId: 'conversation1',
      messageId: 'message1',
      text: 'Count payment observations',
      idempotencyKey: 'turn1',
      components: capabilities.components,
      previous: [],
    };
    const turn = await collect(client.sendTurn(input, signal()));
    assert.deepEqual(
      turn.map((item) => item.type),
      ['request.started', 'response.committed', 'request.completed'],
    );
    const initial = turn.find((item) => item.type === 'response.committed');
    if (!initial || initial.type !== 'response.committed') throw new Error('No response');
    assert.equal(initial.response.facts.count.value, '1,580');
    const responseId = initial.response.responseId;
    const choices = await client.resolveOptions(
      { responseId, revision: 1, generation: 0, controlId: 'country' },
      signal(),
    );
    assert.ok(choices.options.length > 0);
    const selected = choices.options[0].value;
    const action = {
      responseId,
      revision: 1,
      generation: 0,
      action: { id: 'ui.setControl', version: 1 },
      payload: { controlId: 'country', value: selected },
      idempotencyKey: 'action1',
    };
    const updates = await collect(client.dispatchAction(action, signal()));
    const updated = updates.find((item) => item.type === 'response.committed');
    if (!updated || updated.type !== 'response.committed') throw new Error('No update');
    assert.equal(updated.response.generation, 1);
    assert.equal(updated.response.plan.bindings[0].fixedArgs.domain, 'payment');
    assert.equal(updated.response.plan.bindings[0].args.country, selected);
    assert.equal(
      (await client.getConversation('conversation1', signal())).messages[1].response?.generation,
      1,
    );
    const oldRequestId = turn[0].requestId;
    await app.close();
    app = createApplication({ database, testToken: 'test-only', foundationAgent: agent });
    base = await start();
    client = new FoundationHttpClient(`${base}/api/v2`);
    assert.equal(
      (await client.getConversation('conversation1', signal())).messages[1].response?.generation,
      1,
    );
    const replay = await client.resumeRequest(oldRequestId, -1, signal());
    assert.equal(replay.kind, 'events');
    if (replay.kind === 'events') assert.deepEqual(replay.events, turn);
    assert.deepEqual(await collect(client.sendTurn(input, signal())), turn);
    assert.deepEqual(await collect(client.dispatchAction(action, signal())), updates);
    assert.equal(calls, 1);
    const forbidden = await fetch(`${base}/api/v2/responses/${responseId}`, {
      headers: { 'x-test-token': 'test-only', 'x-test-principal': 'limited' },
    });
    assert.equal(forbidden.status, 403);
    const revoked = await fetch(`${base}/api/testing/revoke`, {
      method: 'POST',
      headers: { 'x-test-token': 'test-only', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(revoked.status, 200);
    assert.equal(
      (await fetch(`${base}/api/v2/requests/${oldRequestId}/events?after=-1`)).status,
      403,
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
