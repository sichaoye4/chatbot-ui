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

test('multi-binding execution and ingestion reauthorize every source immediately before publication', async () => {
  function changingCatalog() {
    let calls = 0;
    let epoch = 1;
    return catalog({
      ...permissivePolicy,
      authorize: async () => {
        const current = epoch;
        if (++calls === 4) epoch = 2;
        return { scopeKey: `epoch-${current}`, context: {} };
      },
    });
  }
  function twoBindings(c: ReturnType<typeof catalog>) {
    const candidate = plan(c);
    const binding = structuredClone(candidate.bindings[0]);
    binding.id = 'other';
    candidate.bindings.push(binding);
    const block = candidate.blocks[0];
    if (block.kind !== 'visual') throw new Error('Expected visual');
    const element = structuredClone(block.elements[0]);
    element.id = 'otherChart';
    for (const refs of Object.values(element.roles))
      for (const ref of refs) ref.bindingId = 'other';
    block.elements.push(element);
    return candidate;
  }
  const executionCatalog = changingCatalog();
  await assert.rejects(
    new FoundationRuntime(executionCatalog).execute(
      twoBindings(executionCatalog),
      principal,
      new AbortController().signal,
    ),
    /DATA_FORBIDDEN/,
  );
  const ingestionCatalog = changingCatalog();
  const candidate = twoBindings(ingestionCatalog);
  const data = {
    rows: [{ date: '2024-01-01', net: 170 }],
    provenance: {
      sourceId: 'fixture',
      sourceVersion: '1',
      queryId: 'query1',
      executedAt: '2026-01-01T00:00:00Z',
      grain: 'one row per day',
      truncated: false,
      nextCursor: null,
      warnings: [],
    },
  };
  await assert.rejects(
    new FoundationRuntime(ingestionCatalog).ingest(
      candidate,
      { data, other: data },
      principal,
      new AbortController().signal,
      { messageId: 'message1', responseId: 'response1', revision: 1, generation: 0 },
    ),
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

test('rejects ungrounded literal prose numbers and finer-grain rows misstated as annual or additive totals, allowing repair', async () => {
  const c = catalog();
  const runtime = new FoundationRuntime(c);
  const literalNumberPlan = plan(c);
  literalNumberPlan.blocks.push({
    id: 'summary',
    kind: 'text',
    parts: [{ text: 'Net revenue in 2024 reached $130.' }],
  });
  assert.throws(() => c.validate(literalNumberPlan, principal), /SEMANTIC_INVALID/);

  const buildGrainPlan = (text: string) => {
    const p = plan(c);
    p.facts.push({
      id: 'netFact',
      field: { bindingId: 'data', fieldId: 'net' },
      row: 0,
      format: 'decimal',
    });
    p.blocks.push({
      id: 'summary',
      kind: 'text',
      parts: [{ text }, { factId: 'netFact' }],
    });
    return p;
  };

  // Pre-execution validation catches explicit annual total claims on daily grain and repairs in plan()
  let attempts = 0;
  const repaired = await runtime.plan(
    {
      propose: async (context) => {
        attempts++;
        if (attempts === 1) return buildGrainPlan('Annual total net revenue for 2024: ');
        assert.ok(context.feedback?.some((d) => d.code === 'SEMANTIC_INVALID'));
        return buildGrainPlan('Daily net revenue recorded on 2024-01-01: ');
      },
    },
    'Show 2024 net revenue',
    principal,
    new AbortController().signal,
  );
  assert.equal(attempts, 2);
  const exec = await runtime.execute(repaired, principal, new AbortController().signal);
  assert.equal(exec.facts.netFact, '170');

  // Post-execution check rejects calling a 1-row daily result over a full-year period an unqualified total
  await assert.rejects(
    runtime.execute(
      buildGrainPlan('Total net revenue for the period: '),
      principal,
      new AbortController().signal,
    ),
    /SEMANTIC_INVALID/,
  );

  // Fixture commerce.revenue net measure is marked additive: false -> rejects sum claim
  assert.throws(
    () => c.validate(buildGrainPlan('Combined total net revenue: '), principal),
    /SEMANTIC_INVALID/,
  );
});
