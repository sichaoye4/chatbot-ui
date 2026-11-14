// Explicit opt-in live backend test. No browser coverage is claimed by this script.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { CapabilityPlanningAgent } from '../../packages/agent-adapter/foundation.ts';
import { DeepSeekPlanningModel } from '../../packages/agent-adapter/providers/deepseek.ts';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import { CsvRepository } from '../../examples/csv-analytics/index.ts';
import {
  csvFoundationDomain,
  csvFoundationPolicy,
} from '../../examples/csv-analytics/foundation.ts';
import { catalog, principal } from '../fixtures/foundation-domains.ts';

const provider = new DeepSeekPlanningModel();
const agent = new CapabilityPlanningAgent(provider);
const csv = registerBuiltins(new FoundationCatalog(csvFoundationPolicy));
csv.registerDomain(
  csvFoundationDomain(new CsvRepository('sample_data/training_data_masked_final_1.csv')),
);
const csvPrincipal = {
  subject: 'live-test',
  context: {
    csvIdentity: {
      id: 'live-test',
      tenant: 'demo',
      domains: ['payment', 'party', 'kyc'],
      policyEpoch: 1,
    },
  },
};
const cases = [
  {
    catalog: csv,
    principal: csvPrincipal,
    question: 'How many recorded observations belong to payment? Answer with the count.',
    expected: 1580,
    field: 'record_count',
  },
  {
    catalog: catalog(),
    principal,
    question: 'What is net revenue for the east region during 2024? Give the total as text.',
    expected: 130,
    field: 'net',
  },
];
const evidence = [];
for (const item of cases) {
  const runtime = new FoundationRuntime(item.catalog);
  const signal = AbortSignal.timeout(180000);
  const candidate = await runtime.plan(agent, item.question, item.principal, signal);
  const output = await runtime.execute(candidate, item.principal, signal);
  const grounded = candidate.facts.filter((fact) => fact.field.fieldId === item.field);
  assert.ok(grounded.length > 0, 'Expected a grounded numerical fact');
  assert.equal(
    output.datasets[grounded[0].field.bindingId].rows[grounded[0].row][item.field],
    item.expected,
  );
  assert.ok(candidate.blocks.some((block) => block.kind === 'text'));
  evidence.push({ question: item.question, plan: candidate, facts: output.facts });
  console.log(`PASS: ${item.question}`);
}
const path = `artifacts/foundation/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(path, { recursive: true });
for (const item of [
  {
    catalog: csv,
    principal: csvPrincipal,
    question: 'Show the trends of payment data quality during 2024.',
    kind: 'quality',
  },
  {
    catalog: catalog(),
    principal,
    question: 'Plot daily net revenue during 2024 and let me choose the region.',
    kind: 'exploration',
  },
]) {
  const runtime = new FoundationRuntime(item.catalog);
  const signal = AbortSignal.timeout(180000);
  const candidate = await runtime.plan(agent, item.question, item.principal, signal);
  const output = await runtime.execute(candidate, item.principal, signal);
  writeFileSync(`${path}/candidate-${item.kind}.json`, JSON.stringify(candidate, null, 2));
  const visuals = candidate.blocks.filter((block) => block.kind === 'visual');
  assert.ok(visuals.length > 0);
  const fields = new Set(
    visuals.flatMap((block) =>
      block.elements.flatMap((element) =>
        Object.values(element.roles)
          .flat()
          .map((field) => field.fieldId),
      ),
    ),
  );
  if (item.kind === 'quality') {
    for (const measure of ['avg_comp_mean', 'data_ctrl_score_mean', 'sla_mean'])
      assert.ok(fields.has(measure), `Missing requested measure: ${measure}`);
    assert.equal(visuals.flatMap((block) => block.controls).length, 0);
    for (const binding of candidate.bindings) {
      assert.equal(binding.fixedArgs.domain, 'payment');
      assert.equal(binding.fixedArgs.startMonth, '2024-01');
      assert.equal(binding.fixedArgs.endMonth, '2024-12');
    }
  } else {
    assert.ok(fields.has('net'));
    const controls = visuals.flatMap((block) => block.controls);
    assert.ok(
      controls.some((control) => control.targets.some((target) => target.argument === 'region')),
    );
    assert.ok(
      controls.every((control) => control.targets.every((target) => target.argument === 'region')),
    );
    for (const binding of candidate.bindings)
      assert.deepEqual(binding.fixedArgs.period, ['2024-01-01', '2024-12-31']);
  }
  evidence.push({ question: item.question, plan: candidate, facts: output.facts });
  console.log(`PASS: ${item.question}`);
}
mkdirSync(path, { recursive: true });
writeFileSync(
  `${path}/live-backend.json`,
  JSON.stringify(
    { scope: 'Live backend only; reference UI remains v1', calls: provider.calls, cases: evidence },
    null,
    2,
  ),
);
console.log(`Evidence: ${path}/live-backend.json`);
