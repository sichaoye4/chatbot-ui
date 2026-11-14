import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pieModel, percent } from '../../packages/ui-kit/pie-model.ts';
import { CsvRepository } from '../../examples/csv-analytics/index.ts';
import { csvPlan } from '../../examples/csv-analytics/plans.ts';
import { Catalog } from '../../packages/catalog/index.ts';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import {
  csvFoundationDomain,
  csvFoundationPolicy,
} from '../../examples/csv-analytics/foundation.ts';
const principal = {
  id: 'test',
  tenant: 'test',
  domains: ['kyc', 'payment', 'party'],
  policyEpoch: 1,
};

test('pie percentages use the sum of category values and remain domain independent', () => {
  const model = pieModel(
    [
      { team: 'A', amount: 3 },
      { team: 'B', amount: 1 },
    ],
    'team',
    'amount',
  );
  assert.ok(model.ok);
  assert.equal(model.total, 4);
  assert.deepEqual(
    model.slices.map((slice) => percent(slice.share)),
    ['75.00%', '25.00%'],
  );
  const single = pieModel([{ team: 'A', amount: 1 }], 'team', 'amount');
  assert.ok(single.ok);
  assert.equal(single.slices[0].share, 1);
});
test('pie refuses misleading denominators rather than substituting another chart', () => {
  for (const rows of [
    [],
    [{ c: 'A', n: 0 }],
    [{ c: 'A', n: -1 }],
    [{ c: 'A', n: null }],
    [
      { c: 'A', n: 1 },
      { c: 'A', n: 2 },
    ],
  ])
    assert.equal(pieModel(rows, 'c', 'n').ok, false);
  assert.equal(pieModel([{ c: 'A', n: 3 }], 'c', 'n', true).ok, false);
});
test('CSV record partition validates in both protocols and matches independent source totals', () => {
  const repo = new CsvRepository('sample_data/training_data_masked_final_1.csv');
  const catalog = new Catalog(repo.tools());
  const plan = catalog.validate(csvPlan('pie'), principal);
  assert.equal(plan.panels[0].component, 'pie');
  const data = repo.countByDomain({}, principal);
  const model = pieModel(data.rows, 'domain', 'record_count');
  assert.ok(model.ok);
  assert.equal(model.total, 3509);
  assert.deepEqual(
    Object.fromEntries(model.slices.map((slice) => [slice.label, percent(slice.share)])),
    { kyc: '29.61%', party: '25.36%', payment: '45.03%' },
  );
  const invalid = csvPlan('pie');
  invalid.bindings[0].toolId = 'csv.records';
  const panel = invalid.panels[0];
  if (panel.component !== 'pie') throw new Error();
  panel.config.valueField = 'src_chg';
  assert.throws(() => catalog.validate(invalid, principal), /PIE_REQUIRES_PARTITION/);
  const c = registerBuiltins(new FoundationCatalog(csvFoundationPolicy));
  c.registerDomain(csvFoundationDomain(repo));
  const p = { subject: 'test', context: { csvIdentity: principal } };
  c.validate(
    {
      schemaVersion: 2,
      capabilitySnapshotId: c.snapshot(p).id,
      bindings: [
        { id: 'data', tool: { id: 'csv.countByDomain', version: 1 }, args: {}, fixedArgs: {} },
      ],
      facts: [],
      blocks: [
        {
          id: 'answer',
          kind: 'visual',
          layoutIntent: 'auto',
          controls: [],
          elements: [
            {
              id: 'pie',
              component: { id: 'ui.pie', version: 1 },
              title: 'Share',
              props: {},
              roles: {
                category: [{ bindingId: 'data', fieldId: 'domain' }],
                value: [{ bindingId: 'data', fieldId: 'record_count' }],
              },
            },
          ],
        },
      ],
    },
    p,
  );
});
