import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import { FoundationError } from '../../packages/contracts/foundation.ts';
import { catalog, permissivePolicy, plan, principal } from '../fixtures/foundation-domains.ts';

test('generic execution materializes commerce facts and topology data without domain routing', async () => {
  const c = catalog();
  const runtime = new FoundationRuntime(c);
  const p = plan(c);
  p.bindings[0].args.region = 'east';
  p.facts.push({
    id: 'total',
    field: { bindingId: 'data', fieldId: 'net' },
    row: 0,
    format: 'decimal',
  });
  p.blocks.push({
    id: 'summary',
    kind: 'text',
    parts: [{ text: 'Net revenue: ' }, { factId: 'total' }],
  });
  const value = await runtime.execute(p, principal, new AbortController().signal);
  assert.equal(value.facts.total, '130');
  assert.equal(value.datasets.data.provenance.sourceVersion, 'fixture-v1');
  const graph = await runtime.execute(plan(c, 2), principal, new AbortController().signal);
  assert.deepEqual(graph.datasets.data.rows, [
    { caller: 'gateway', callee: 'orders' },
    { caller: 'orders', callee: 'ledger' },
  ]);
});
test('execution authorizes arguments before querying and rejects a changed scope before publication', async () => {
  let calls = 0;
  const c = catalog({
    ...permissivePolicy,
    authorize: async () => {
      calls++;
      return { scopeKey: `epoch-${calls}`, context: {} };
    },
  });
  await assert.rejects(
    new FoundationRuntime(c).execute(plan(c), principal, new AbortController().signal),
    /DATA_FORBIDDEN/,
  );
  assert.equal(calls, 2);
  const denied = catalog({
    ...permissivePolicy,
    authorize: async () => {
      throw new FoundationError({
        code: 'DATA_FORBIDDEN',
        path: '',
        message: 'Denied by fixture policy',
      });
    },
  });
  await assert.rejects(
    new FoundationRuntime(denied).execute(plan(denied), principal, new AbortController().signal),
    /DATA_FORBIDDEN/,
  );
});
test('host agent receives registered capabilities and structured bounded repair feedback', async () => {
  const c = catalog();
  const runtime = new FoundationRuntime(c);
  let attempts = 0;
  const p = await runtime.plan(
    {
      propose: async (context) => {
        attempts++;
        assert.ok(JSON.stringify(context.capabilities).includes('commerce.revenue'));
        if (attempts === 1) return { invalid: true };
        assert.equal(context.feedback[0].code, 'SCHEMA_INVALID');
        return plan(c);
      },
    },
    'An unseen phrasing',
    principal,
    new AbortController().signal,
  );
  assert.equal(p.schemaVersion, 2);
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(
    runtime.plan(
      {
        propose: async () => {
          attempts++;
          return {};
        },
      },
      'x',
      principal,
      new AbortController().signal,
    ),
    /SCHEMA_INVALID/,
  );
  assert.equal(attempts, 2);
});
test('cancellation prevents planner/query work and absent facts fail without invented values', async () => {
  const c = catalog();
  const runtime = new FoundationRuntime(c);
  const aborted = AbortSignal.abort();
  let called = false;
  await assert.rejects(
    runtime.plan(
      {
        propose: async () => {
          called = true;
          return plan(c);
        },
      },
      'x',
      principal,
      aborted,
    ),
  );
  assert.equal(called, false);
  const p = plan(c);
  p.bindings[0].fixedArgs.period = ['2030-01-01', '2030-12-31'];
  p.facts.push({
    id: 'absent',
    field: { bindingId: 'data', fieldId: 'net' },
    row: 0,
    format: 'decimal',
  });
  p.blocks.push({ id: 'summary', kind: 'text', parts: [{ factId: 'absent' }] });
  await assert.rejects(
    runtime.execute(p, principal, new AbortController().signal),
    /RESULT_INVALID/,
  );
});
