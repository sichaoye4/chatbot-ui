import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CsvRepository, SOURCE_HASH } from '../../examples/csv-analytics/index.ts';
import { Catalog, type Principal } from '../../packages/catalog/index.ts';
import { QueryRuntime } from '../../packages/server-runtime/queries.ts';
const expected = JSON.parse(readFileSync('tests/oracles/csv-expected.json', 'utf8'));
const repo = new CsvRepository('sample_data/training_data_masked_final_1.csv', SOURCE_HASH);
const p: Principal = {
  id: 'demo',
  tenant: 'a',
  domains: ['kyc', 'party', 'payment'],
  policyEpoch: 1,
};
test('canonical source matches independent decimal oracle and preserves all rows', () => {
  assert.equal(repo.rows.length, 3509);
  assert.equal(new Set(repo.rows.map((r) => r.rowId)).size, 3509);
  for (const [args, golden] of [
    [{}, expected.all],
    [{ domain: 'kyc' }, expected.kyc],
  ] as const) {
    const row = repo.summary(args, p).rows[0];
    for (const key of Object.keys(golden))
      if (key === 'sla_mean') assert.ok(Math.abs(Number(row[key]) - Number(golden[key])) < 1e-12);
      else assert.equal(row[key], golden[key]);
  }
});
test('domain counts and monthly means match independently computed expectations', () => {
  assert.deepEqual(
    Object.fromEntries(repo.countByDomain({}, p).rows.map((r) => [r.domain, r.record_count])),
    expected.domainCounts,
  );
  for (const [args, golden] of [
    [{}, expected.monthly],
    [{ domain: 'kyc' }, expected.kycMonthly],
  ] as const) {
    const rows = repo.monthly(args, p).rows;
    assert.equal(rows.length, golden.length);
    rows.forEach((r, i) => {
      assert.equal(r.month, golden[i].month);
      assert.equal(r.sla_observations, golden[i].sla_observations);
      assert.ok(Math.abs(Number(r.sla_mean) - Number(golden[i].sla_mean)) < 1e-12);
    });
  }
});
test('G04 preserves missing April as null, not zero', () =>
  assert.deepEqual(
    repo.monthly(
      { domain: 'kyc', system: 'DSU', country: 'AE', startMonth: '2023-03', endMonth: '2023-06' },
      p,
    ).rows,
    [
      { month: '2023-03', sla_mean: 0.58, sla_observations: 1 },
      { month: '2023-04', sla_mean: null, sla_observations: 0 },
      { month: '2023-05', sla_mean: 0.52, sla_observations: 1 },
      { month: '2023-06', sla_mean: 0.53, sla_observations: 1 },
    ],
  ));
test('empty successful queries, repeated source keys and nulls retain meaning', () => {
  assert.equal(repo.records({ month: '2026-01' }, p).rows.length, 0);
  assert.equal(
    repo.summary({ domain: 'kyc', system: 'DSU', country: 'AE' }, p).rows[0].record_count,
    26,
  );
  assert.equal(repo.rows.filter((r) => r.xfer_team_size === null).length, 189);
  assert.equal(repo.rows.filter((r) => r.data_team_size === null).length, 120);
});
test('pagination is stable and cursor cannot cross filter or authorization scope', () => {
  const first = repo.records({ domain: 'kyc' }, p),
    second = repo.records({ domain: 'kyc', cursor: first.nextCursor! }, p);
  assert.equal(first.rows.length, 50);
  assert.equal(second.rows.length, 50);
  assert.equal(new Set([...first.rows, ...second.rows].map((r) => r.rowId)).size, 100);
  assert.throws(() => repo.records({ domain: 'payment', cursor: first.nextCursor! }, p));
  assert.throws(() =>
    repo.records({ domain: 'kyc', cursor: first.nextCursor! }, { ...p, tenant: 'other' }),
  );
  assert.throws(() => repo.records({ limit: 201 }, p));
});
test('policy is enforced before cache hit and scope change invalidates cache', () => {
  const q = new QueryRuntime(new Catalog(repo.tools()));
  q.run('csv.summary', {}, p);
  q.run('csv.summary', {}, p);
  assert.equal(q.executions[1].cacheHit, true);
  const scoped = { ...p, domains: ['kyc'], policyEpoch: 2 };
  assert.equal(q.run('csv.summary', {}, scoped).rows[0].record_count, 1039);
  assert.throws(() => q.run('csv.summary', { domain: 'payment' }, scoped));
  assert.throws(() => q.run('csv.summary', {}, { ...p, revoked: true }));
});
