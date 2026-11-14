import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CsvRepository } from '../../examples/csv-analytics/index.ts';
import { csvPlan, qualityPlan, addRecords } from '../../examples/csv-analytics/plans.ts';
import { createApplication } from '../../apps/reference-server/server.ts';
const p = { id: 'demo', tenant: 'demo', domains: ['payment', 'kyc', 'party'], policyEpoch: 1 };
test('fixed scope creates no controls; explicit country filter is the only override', () => {
  const args = { domain: 'payment' as const, startMonth: '2024-01', endMonth: '2024-12' };
  const fixed = qualityPlan(args);
  assert.equal(fixed.panels.length, 3);
  assert.deepEqual(fixed.filters, []);
  assert.deepEqual(fixed.bindings[0].filterMap, {});
  const interactive = qualityPlan(args, undefined, ['country']);
  assert.deepEqual(
    interactive.filters.map((f) => f.id),
    ['country'],
  );
  assert.deepEqual(addRecords(interactive).bindings.at(-1)!.filterMap, { country: 'country' });
  assert.deepEqual(csvPlan('overview').filters, []);
});
test('three monthly quality metrics agree with independent Decimal oracle', () => {
  const expected = JSON.parse(
    readFileSync('tests/oracles/csv-expected.json', 'utf8'),
  ).paymentQuality2024;
  const repo = new CsvRepository('sample_data/training_data_masked_final_1.csv');
  const data = repo.monthlyQuality(
    { domain: 'payment', startMonth: '2024-01', endMonth: '2024-12' },
    p,
  );
  assert.equal(data.rows.length, 12);
  data.rows.forEach((row, i) => {
    assert.equal(row.month, expected[i].month);
    for (const [out, input] of [
      ['avg_comp_mean', 'avg_comp'],
      ['data_ctrl_score_mean', 'data_ctrl_score'],
      ['sla_mean', 'sla_met_rate'],
    ])
      assert.ok(Math.abs(Number(row[out]) - Number(expected[i][input])) < 1e-10);
  });
});
test('options stay within fixed scope; undeclared filter changes cannot broaden the query', async () => {
  const app = createApplication({ database: ':memory:' });
  try {
    app.store.conversation('dynamic', p, true);
    const plan = qualityPlan(
      { domain: 'payment', startMonth: '2024-01', endMonth: '2024-12' },
      undefined,
      ['country'],
    );
    let a = app.store.commit('dynamic', plan, app.repo.sourceHash, p);
    a = await app.service.resolve(a, p);
    const options = app.service.filterOptions(a, p);
    assert.deepEqual(Object.keys(options), ['country']);
    assert.ok(options.country.includes('HK'));
    await assert.rejects(
      () =>
        app.service.action(
          a.artifactId,
          a.revision,
          { type: 'setFilter', filters: { domain: 'kyc' } },
          p,
        ),
      /FILTER_INVALID/,
    );
    await assert.rejects(
      () =>
        app.service.action(
          a.artifactId,
          a.revision,
          { type: 'setFilter', filters: { country: 'ZZ' } },
          p,
        ),
      /FILTER_INVALID/,
    );
    const changed = await app.service.action(
      a.artifactId,
      a.revision,
      { type: 'setFilter', filters: { country: 'HK' } },
      p,
    );
    const d = changed.datasets.monthly;
    assert.equal(d.status, 'ready');
    if (d.status === 'ready') {
      assert.equal(d.data.args.domain, 'payment');
      assert.equal(d.data.args.startMonth, '2024-01');
    }
    const next = app.store.commit(
      'dynamic',
      qualityPlan({ domain: 'payment', startMonth: '2024-01', endMonth: '2024-12' }),
      app.repo.sourceHash,
      p,
      changed,
    );
    assert.deepEqual(next.filters, {});
  } finally {
    app.store.close();
  }
});
