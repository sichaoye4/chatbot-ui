import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekAgent } from '../../examples/csv-analytics/legacy-agent.ts';
import { providedDataTool } from '../../packages/server-runtime/provided-data.ts';
import { Catalog } from '../../packages/catalog/index.ts';
import { QueryRuntime } from '../../packages/server-runtime/queries.ts';
import { visualizationTools } from '../../examples/data-visualization/index.ts';
import { createApplication } from '../../apps/reference-server/server.ts';
import type { Event, Plan } from '../../packages/contracts/index.ts';
const principal = { id: 'test', tenant: 'test', domains: ['demo'], policyEpoch: 1 };
const plan: Plan = {
  schemaVersion: 1,
  title: 'Supplied order counts',
  layoutIntent: 'auto',
  filters: [],
  dataMode: 'snapshot',
  panels: [
    {
      id: 'orders',
      bindingId: 'orders',
      component: 'comparison',
      componentVersion: 1,
      title: 'Orders by region',
      importance: 'primary',
      config: { categoryField: 'region', valueField: 'orders' },
    },
  ],
  bindings: [
    {
      id: 'orders',
      toolId: 'provided.data',
      filterMap: {},
      args: {
        origin: 'user-provided',
        notes: [],
        fields: [
          { name: 'region', type: 'string', nullable: false },
          { name: 'orders', type: 'number', nullable: false },
        ],
        rows: [
          { region: 'North', orders: 12 },
          { region: 'South', orders: 7 },
        ],
      },
    },
  ],
};
const queries = new QueryRuntime(new Catalog([providedDataTool(), ...visualizationTools()]));
const context = {
  text: 'Show North 12, South 7 as a chart; availability demonstrated.',
  principal,
  queries,
  signal: new AbortController().signal,
};
function output(value: unknown, reasoning = 'fixture reasoning') {
  return new Response(
    JSON.stringify({
      model: 'fixture',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: reasoning,
            tool_calls: [
              {
                id: 'call1',
                type: 'function',
                function: { name: 'present_response', arguments: JSON.stringify(value) },
              },
            ],
          },
        },
      ],
    }),
  );
}

test('direct LLM receives original content, thinking and provided-data schema without demo tools', async () => {
  let called = 0;
  const agent = new DeepSeekAgent(
    async (_url, init) => {
      called++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.thinking.type, 'enabled');
      assert.ok(body.messages.some((m: { content: string }) => m.content?.includes(context.text)));
      assert.ok(
        body.tools.some((t: { function: { name: string } }) => t.function.name === 'provided_data'),
      );
      assert.ok(
        body.tools.every(
          (t: { function: { name: string } }) => !t.function.name.startsWith('viz_'),
        ),
      );
      return output({ kind: 'visual', plan });
    },
    () => 'fixture',
  );
  assert.deepEqual(await agent.run(context), { kind: 'visual', plan });
  assert.equal(called, 1);
  assert.equal(queries.binding(plan, 'orders', {}, principal).rows[0].orders, 12);
});

test('schema failures are sent to the model for repair with reasoning preserved', async () => {
  let called = 0;
  const agent = new DeepSeekAgent(
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (++called === 1) return output({ kind: 'visual', plan: { ...plan, panels: [] } });
      assert.equal(
        body.messages.find((m: { role: string }) => m.role === 'assistant').reasoning_content,
        'fixture reasoning',
      );
      assert.ok(body.messages.some((m: { role: string }) => m.role === 'tool'));
      return output({ kind: 'visual', plan });
    },
    () => 'fixture',
  );
  assert.equal((await agent.run(context)).kind, 'visual');
  assert.equal(called, 2);
});

test('model can ask for clarification and failed generation persists an actionable retry response', async () => {
  const agent = new DeepSeekAgent(
    async () =>
      output({ kind: 'clarification', text: 'Please provide the missing dates and retry.' }),
    () => 'fixture',
  );
  assert.equal((await agent.run(context)).kind, 'clarification');
  const app = createApplication({ database: ':memory:' });
  app.service.agent = new DeepSeekAgent(
    async () => output({ kind: 'visual', plan: {} }),
    () => 'fixture',
  );
  const events: Event[] = [];
  try {
    await app.service.turn(
      { conversationId: 'failure', text: context.text, idempotencyKey: 'first' },
      principal,
      (e) => events.push(e),
    );
    assert.equal(events.at(-1)?.type, 'request.failed');
    assert.ok(!events.some((e) => e.type === 'artifact.committed'));
    assert.match(
      JSON.stringify(app.store.conversation('failure', principal).messages),
      /Please retry/,
    );
  } finally {
    await app.close();
  }
});
