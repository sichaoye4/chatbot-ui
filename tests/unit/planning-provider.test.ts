import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityPlanningAgent } from '../../packages/agent-adapter/foundation.ts';
import { DeepSeekPlanningModel } from '../../packages/agent-adapter/providers/deepseek.ts';
import { catalog, plan, principal } from '../fixtures/foundation-domains.ts';

test('provider-independent planner supplies schema and registered guidance, not domain templates', async () => {
  const c = catalog();
  const agent = new CapabilityPlanningAgent({
    complete: async (input) => {
      assert.match(input.instructions, /scopeMode=change-answer/);
      assert.doesNotMatch(input.instructions, /payment|sla_met_rate|csv\./);
      assert.ok(input.schema);
      assert.match(input.context, /commerce.revenue/);
      return plan(c);
    },
  });
  assert.deepEqual(
    await agent.propose({
      question: 'Explore revenue',
      capabilities: c.snapshot(principal),
      signal: new AbortController().signal,
      feedback: [],
    }),
    plan(c),
  );
});
test('DeepSeek transport handles structured output without owning planning decisions', async () => {
  let called = false;
  const transport = new DeepSeekPlanningModel(
    { baseUrl: 'https://api.deepseek.com', model: 'fixture-model', key: () => 'fixture-only' },
    async (_url, init) => {
      called = true;
      const request = JSON.parse(String(init?.body));
      assert.equal(request.tools[0].function.name, 'present_response');
      assert.equal(request.messages[0].content, 'capability guidance');
      return new Response(
        JSON.stringify({
          model: 'returned-model',
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: 'present_response', arguments: '{"schemaVersion":2}' } },
                ],
              },
            },
          ],
        }),
      );
    },
  );
  assert.deepEqual(
    await transport.complete({
      instructions: 'capability guidance',
      context: '{}',
      schema: {},
      signal: new AbortController().signal,
    }),
    { schemaVersion: 2 },
  );
  assert.equal(called, true);
  assert.equal(transport.calls[0].returnedModel, 'returned-model');
});
