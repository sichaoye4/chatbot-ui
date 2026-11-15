import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Catalog } from '../../packages/catalog/index.ts';
import { QueryRuntime } from '../../packages/server-runtime/queries.ts';
import { Turn } from '../../packages/contracts/index.ts';
import {
  parseSuppliedSchedule,
  suppliedSchedulePlan,
  suppliedScheduleTool,
  withSuppliedSchedule,
} from '../../examples/project-management/supplied-schedule.ts';
const source = readFileSync('tests/fixtures/banking-project-timeline.md', 'utf8');
const principal = { id: 'test', tenant: 'test', domains: ['demo'], policyEpoch: 1 };

test('the pasted 18-month plan is accepted and all phases, tasks and milestone dates are preserved', () => {
  assert.ok(source.length > 4000);
  Turn.parse({ conversationId: 'timeline', idempotencyKey: 'first', text: source });
  const { overview, detail } = parseSuppliedSchedule(source);
  assert.equal(overview.length, 12);
  assert.equal(detail.length, 37);
  assert.deepEqual(
    overview.filter((r) => r.kind === 'milestone').map((r) => r.start),
    ['2027-03-31', '2027-06-30', '2027-09-30', '2028-01-31', '2028-04-30', '2028-06-30'],
  );
  assert.equal(
    detail.find((r) => String(r.label).includes('service-specific database'))?.start,
    '2028-02-01',
  );
  assert.equal(
    detail.find((r) => String(r.label).includes('service-specific database'))?.end,
    '2028-03-31',
  );
  assert.ok([...overview, ...detail].every((r) => r.progress === null && r.dependencies === ''));
  const runtime = new QueryRuntime(new Catalog([suppliedScheduleTool()]));
  const plan = runtime.catalog.validate(suppliedSchedulePlan(source), principal);
  assert.equal(plan.messages?.length, 2);
  for (const b of plan.bindings) {
    const result = runtime.binding(plan, b.id, {}, principal);
    assert.equal(result.sourceId, 'user-supplied-project-schedule');
    assert.equal(result.truncated, false);
  }
  assert.throws(() => runtime.binding(plan, 'overview', {}, { ...principal, revoked: true }));
});

test('invalid or unsupported schedules clarify instead of silently losing tasks or fabricating dates', async () => {
  for (const bad of [
    source.replace('31 March 2027', '31 February 2027'),
    source.replace('M1–M2:', 'M1/M2:'),
    source.replace('M4:', 'M40:'),
    source.replace('18 Months', '19 Months'),
  ])
    assert.throws(() => parseSuppliedSchedule(bad));
  const agent = withSuppliedSchedule({
    mode: 'fixture',
    calls: [],
    run: async () => {
      throw Error('Must not fall through to CSV/demo');
    },
  });
  const context = {
    text: source,
    queries: new QueryRuntime(new Catalog([suppliedScheduleTool()])),
    principal,
    signal: new AbortController().signal,
  };
  assert.equal((await agent.run(context)).kind, 'visual');
  assert.deepEqual(
    await agent.run({ ...context, text: source.replace('31 March 2027', '31 February 2027') }),
    { kind: 'explain', reason: 'supplied-schedule-invalid' },
  );
});
