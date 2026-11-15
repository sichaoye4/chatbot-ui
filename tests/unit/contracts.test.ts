import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plan } from '../../packages/contracts/index.ts';
import { Catalog } from '../../packages/catalog/index.ts';
import { CsvRepository } from '../../examples/csv-analytics/index.ts';
import { csvPlan } from '../../examples/csv-analytics/plans.ts';
const p = { id: 'demo', tenant: 'a', domains: ['kyc', 'payment', 'party'], policyEpoch: 1 };
const catalog = new Catalog(
  new CsvRepository('sample_data/training_data_masked_final_1.csv').tools(),
);
for (let n = 1; n <= 6; n++)
  test(`valid count ${n}`, () => {
    const plan = csvPlan('overview');
    plan.panels = plan.panels.slice(0, n);
    plan.bindings = plan.bindings.filter((b) => plan.panels.some((p) => p.bindingId === b.id));
    assert.equal(catalog.validate(plan, p).panels.length, n);
  });
test('reject zero, seven, duplicate IDs, unknown fields, missing/unused bindings', () => {
  const plan = csvPlan('overview');
  assert.throws(() => Plan.parse({ ...plan, panels: [] }));
  assert.throws(() =>
    Plan.parse({ ...plan, panels: [...plan.panels, { ...plan.panels[0], id: 'seventh' }] }),
  );
  assert.throws(() => Plan.parse({ ...plan, tenant: 'evil' }));
  assert.throws(() => Plan.parse({ ...plan, bindings: [] }));
  assert.throws(() => Plan.parse({ ...plan, panels: [plan.panels[0], plan.panels[0]] }));
});
test('semantic validator rejects incorrect field roles and invented tools', () => {
  const plan = csvPlan('trend');
  assert.throws(() =>
    catalog.validate(
      { ...plan, panels: [{ ...plan.panels[0], config: { xField: 'sla_mean', yField: 'month' } }] },
      p,
    ),
  );
  assert.throws(() =>
    catalog.validate({ ...plan, bindings: [{ ...plan.bindings[0], toolId: 'evil.query' }] }, p),
  );
  assert.throws(() =>
    catalog.validate(
      { ...plan, bindings: [{ ...plan.bindings[0], filterMap: { domain: 'tenant' } }] },
      p,
    ),
  );
});

test('message groups partition panels without dropping, duplicating or inventing panels', () => {
  const plan = csvPlan('overview');
  const messages = plan.panels.map((panel) => ({ id: panel.id, panelIds: [panel.id] }));
  assert.equal(Plan.parse({ ...plan, messages }).messages?.length, plan.panels.length);
  for (const invalid of [
    messages.slice(1),
    [...messages, messages[0]],
    [{ id: 'bad', panelIds: ['unknown'] }],
  ])
    assert.throws(() => Plan.parse({ ...plan, messages: invalid }));
});
