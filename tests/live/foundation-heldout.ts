// Opt-in exploratory evaluation. Synthetic domains only; no source rows are sent to the model.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { CapabilityPlanningAgent } from '../../packages/agent-adapter/foundation.ts';
import { DeepSeekPlanningModel } from '../../packages/agent-adapter/providers/deepseek.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import type { PlanningAgent, ResponsePlan } from '../../packages/contracts/foundation.ts';
import { catalog, principal } from '../fixtures/foundation-domains.ts';

type Evaluation = {
  id: string;
  question: string;
  verify: (plan: ResponsePlan, data: Awaited<ReturnType<FoundationRuntime['execute']>>) => void;
};
function expectedDailyTable(
  plan: ResponsePlan,
  data: Awaited<ReturnType<FoundationRuntime['execute']>>,
  tool: string,
  field: string,
  value: number,
) {
  const binding = plan.bindings.find((item) => item.tool.id === tool)!;
  const elements = plan.blocks.flatMap((block) => (block.kind === 'visual' ? block.elements : []));
  assert.ok(
    elements.some(
      (element) =>
        element.component.id === 'ui.table' &&
        ['date', field].every((column) =>
          Object.values(element.roles)
            .flat()
            .some((ref) => ref.bindingId === binding.id && ref.fieldId === column),
        ),
    ),
    `Missing daily ${field} table`,
  );
  assert.ok(
    data.datasets[binding.id].rows.some((row) => row.date === '2024-01-01' && row[field] === value),
  );
}
function scope(plan: ResponsePlan, tool: string, expected: Record<string, unknown>) {
  const binding = plan.bindings.find((item) => item.tool.id === tool);
  assert.ok(binding, `Missing ${tool}`);
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(binding.fixedArgs[key], value, `Incorrect fixed ${key}`);
}
const cases: Evaluation[] = [
  {
    id: 'commerce-east',
    question: 'Show a table of daily net revenue for the east region during 2024, including dates.',
    verify(plan, data) {
      scope(plan, 'commerce.revenue', { region: 'east', period: ['2024-01-01', '2024-12-31'] });
      expectedDailyTable(plan, data, 'commerce.revenue', 'net', 130);
    },
  },
  {
    id: 'commerce-west',
    question: 'List daily west-region net revenue for 2024 in a table with dates.',
    verify(plan, data) {
      scope(plan, 'commerce.revenue', { region: 'west', period: ['2024-01-01', '2024-12-31'] });
      expectedDailyTable(plan, data, 'commerce.revenue', 'net', 40);
    },
  },
  {
    id: 'operations-score',
    question:
      'Show a table of the recorded daily quality score for the north area, including dates.',
    verify(plan, data) {
      scope(plan, 'operations.quality', { area: 'north' });
      expectedDailyTable(plan, data, 'operations.quality', 'score', 82);
    },
  },
  {
    id: 'operations-compliance',
    question: 'Show recorded north-area compliance ratios by day in a table with dates.',
    verify(plan, data) {
      scope(plan, 'operations.quality', { area: 'north' });
      expectedDailyTable(plan, data, 'operations.quality', 'compliance', 0.75);
    },
  },
  {
    id: 'unavailable-annual-total',
    question:
      'What was the total net revenue for the west region over all of 2024? If an annual total is unavailable, explain that.',
    verify(plan) {
      assert.equal(plan.facts.length, 0, 'A daily row must not be presented as an annual total');
      const prose = plan.blocks
        .flatMap((block) =>
          block.kind === 'text'
            ? block.parts.flatMap((part) => ('text' in part ? [part.text] : []))
            : block.kind === 'clarification'
              ? [block.question]
              : [],
        )
        .join(' ');
      assert.doesNotMatch(
        prose.replace(/\b\d{4}(?:-\d{2}-\d{2})?\b/g, ''),
        /\d/,
        'Unsupported annual totals must not include numerical claims',
      );
      assert.match(
        prose,
        /unavailable|not available|cannot|can't|not (?:a|an|available|provided)|no (?:annual|yearly|total)|do not|don't|lack|only.*(?:daily|day)/i,
      );
    },
  },
  {
    id: 'topology-table',
    question: 'Show a table of observed service dependencies with caller and callee.',
    verify(plan, data) {
      scope(plan, 'topology.dependencies', {});
      const elements = plan.blocks.flatMap((block) =>
        block.kind === 'visual' ? block.elements : [],
      );
      assert.ok(
        elements.some(
          (element) =>
            element.component.id === 'ui.table' &&
            ['caller', 'callee'].every((field) =>
              Object.values(element.roles)
                .flat()
                .some((ref) => ref.fieldId === field),
            ),
        ),
      );
      const binding = plan.bindings.find((item) => item.tool.id === 'topology.dependencies')!;
      assert.deepEqual(data.datasets[binding.id].rows, [
        { caller: 'gateway', callee: 'orders' },
        { caller: 'orders', callee: 'ledger' },
      ]);
    },
  },
  {
    id: 'unsupported-salaries',
    question: 'What is the average employee salary? If the data is unavailable, say so.',
    verify(plan) {
      assert.equal(plan.bindings.length, 0, 'An unrelated source must not be used as salary data');
      const prose = plan.blocks
        .flatMap((block) =>
          block.kind === 'text'
            ? block.parts.flatMap((part) => ('text' in part ? [part.text] : []))
            : block.kind === 'clarification'
              ? [block.question]
              : [],
        )
        .join(' ');
      assert.doesNotMatch(prose, /\d/, 'Unavailable salaries must not include numerical claims');
      assert.match(
        prose,
        /unavailable|not available|cannot|can't|no (?:salary|employee|data|information)|do not have|don't have|lack/i,
      );
    },
  },
];
const directory = `artifacts/foundation/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(directory, { recursive: true });
const report: unknown[] = [];
for (const item of cases) {
  const provider = new DeepSeekPlanningModel();
  const planner = new CapabilityPlanningAgent(provider);
  const runtime = new FoundationRuntime(catalog());
  const attempts: { feedbackCodes: string[]; candidate?: unknown }[] = [];
  const recording: PlanningAgent = {
    propose: async (context) => {
      const record: { feedbackCodes: string[]; candidate?: unknown } = {
        feedbackCodes: context.feedback.map((entry) => entry.code),
      };
      attempts.push(record);
      record.candidate = await planner.propose(context);
      return record.candidate;
    },
  };
  let status = 'passed';
  let error: string | undefined;
  let response: unknown;
  try {
    const signal = AbortSignal.timeout(180000);
    const plan = await runtime.plan(recording, item.question, principal, signal);
    const data = await runtime.execute(plan, principal, signal);
    response = await runtime.ingest(plan, data.datasets, principal, signal, {
      messageId: 'message1',
      responseId: 'response1',
      revision: 1,
      generation: 0,
    });
    item.verify(plan, data);
  } catch (cause) {
    status = 'failed';
    error = cause instanceof Error ? cause.message : 'Unknown evaluation error';
    process.exitCode = 1;
  }
  report.push({
    id: item.id,
    question: item.question,
    status,
    error,
    attempts,
    calls: provider.calls,
    response,
  });
  writeFileSync(
    `${directory}/heldout.json`,
    JSON.stringify(
      { fixture: 'synthetic; exploratory, one run per question', cases: report },
      null,
      2,
    ),
  );
  console.log(`${status.toUpperCase()}: ${item.id}${error ? ` — ${error}` : ''}`);
}
console.log(`Evidence: ${directory}/heldout.json`);
