// Live held-out DeepSeek evaluation across three domains (10 prompts/domain x 3 repeats = 90 runs).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { CapabilityPlanningAgent } from '../../packages/agent-adapter/foundation.ts';
import { DeepSeekPlanningModel } from '../../packages/agent-adapter/providers/deepseek.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import {
  FoundationError,
  type PlanningAgent,
  type Principal,
  type ResponsePlan,
} from '../../packages/contracts/foundation.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import { CsvRepository } from '../../examples/csv-analytics/index.ts';
import {
  csvFoundationDomain,
  csvFoundationPolicy,
} from '../../examples/csv-analytics/foundation.ts';
import { catalog, principal } from '../fixtures/foundation-domains.ts';

type DomainName = 'commerce' | 'operations-topology' | 'csv.analytics';

type Evaluation = {
  id: string;
  domain: DomainName;
  question: string;
  allowErrorCode?: 'DATA_FORBIDDEN';
  setup: () => { cat: FoundationCatalog; who: Principal };
  verify: (
    plan: ResponsePlan,
    data: Awaited<ReturnType<FoundationRuntime['execute']>>,
    published: Awaited<ReturnType<FoundationRuntime['ingest']>>,
  ) => void;
};

const synthCatalog = () => catalog();
const csvRepo = new CsvRepository('sample_data/training_data_masked_final_1.csv');
const csvCatalog = () => {
  const cat = registerBuiltins(new FoundationCatalog(csvFoundationPolicy));
  cat.registerDomain(csvFoundationDomain(csvRepo));
  return cat;
};
const csvFullPrincipal: Principal = {
  subject: 'heldout-csv-full',
  context: {
    csvIdentity: {
      id: 'heldout-csv-full',
      tenant: 'demo',
      domains: ['payment', 'party', 'kyc'],
      policyEpoch: 1,
    },
  },
};
const csvPaymentOnlyPrincipal: Principal = {
  subject: 'heldout-csv-limited',
  context: {
    csvIdentity: {
      id: 'heldout-csv-limited',
      tenant: 'demo',
      domains: ['payment'],
      policyEpoch: 1,
    },
  },
};

const proseText = (plan: ResponsePlan) =>
  plan.blocks
    .flatMap((block) =>
      block.kind === 'text'
        ? block.parts.flatMap((part) => ('text' in part ? [part.text] : []))
        : block.kind === 'clarification'
          ? [block.question]
          : [],
    )
    .join(' ');

function scope(plan: ResponsePlan, tool: string, expected: Record<string, unknown>) {
  const binding = plan.bindings.find((item) => item.tool.id === tool);
  assert.ok(binding, `Missing ${tool}`);
  for (const [key, value] of Object.entries(expected)) {
    const actual: unknown = binding.fixedArgs[key] ?? binding.args[key];
    assert.deepEqual(actual, value, `Incorrect ${tool}.${key}: got ${JSON.stringify(actual)}`);
  }
  return binding;
}

function assertVisualHasFields(plan: ResponsePlan, bindingId: string, requiredFields: string[]) {
  const elements = plan.blocks.flatMap((block) => (block.kind === 'visual' ? block.elements : []));
  assert.ok(elements.length > 0, 'Expected at least one visual element');
  assert.ok(
    elements.some((element) =>
      requiredFields.every((field) =>
        Object.values(element.roles)
          .flat()
          .some((ref) => ref.bindingId === bindingId && ref.fieldId === field),
      ),
    ),
    `Missing visual with fields ${requiredFields.join(', ')}`,
  );
}

function assertTableWithFields(
  plan: ResponsePlan,
  data: Awaited<ReturnType<FoundationRuntime['execute']>>,
  tool: string,
  requiredFields: string[],
  rowPredicate?: (row: Record<string, unknown>) => boolean,
) {
  const binding = plan.bindings.find((item) => item.tool.id === tool);
  assert.ok(binding, `Missing binding for ${tool}`);
  const elements = plan.blocks.flatMap((block) => (block.kind === 'visual' ? block.elements : []));
  assert.ok(
    elements.some(
      (element) =>
        element.component.id === 'ui.table' &&
        requiredFields.every((field) =>
          Object.values(element.roles)
            .flat()
            .some((ref) => ref.bindingId === binding.id && ref.fieldId === field),
        ),
    ),
    `Missing ui.table for ${tool} (${requiredFields.join(', ')})`,
  );
  if (rowPredicate) {
    assert.ok(
      data.datasets[binding.id].rows.some(rowPredicate),
      `Expected matching row in ${tool}`,
    );
  }
}

function assertGroundedFact(
  plan: ResponsePlan,
  data: Awaited<ReturnType<FoundationRuntime['execute']>>,
  field: string,
  expectedValue: number,
) {
  const fact = plan.facts.find((f) => f.field.fieldId === field);
  assert.ok(fact, `Expected grounded fact for ${field}`);
  assert.equal(data.datasets[fact.field.bindingId].rows[fact.row][field], expectedValue);
}

function assertUnavailableNoNumbers(plan: ResponsePlan, requireZeroBindings = false) {
  if (requireZeroBindings) {
    assert.equal(plan.bindings.length, 0, 'Unsupported query must not bind unrelated tools');
  }
  assert.equal(
    plan.facts.length,
    0,
    'Unsupported or wrong-grain query must not emit grounded facts',
  );
  const prose = proseText(plan);
  assert.doesNotMatch(
    prose.replace(/\b(?:\d{4}(?:-\d{2}-\d{2})?|12[- ]month(?:s)?)\b/gi, ''),
    /\d/,
    `Unavailable answer must not include fabricated numbers: ${prose}`,
  );
  assert.match(
    prose,
    /unavailable|not available|cannot|can['’]t|not (?:a|an|available|provided|supported)|no (?:annual|yearly|total|salary|employee|data|information|ticket|payroll|incident|profit|margin)|do not|don['’]t|lack|only.*(?:daily|day|unweighted|observation)/i,
    `Expected explicit unavailability/limitation explanation, got: ${prose}`,
  );
}

const cases: Evaluation[] = [
  // --- Domain 1: commerce (10 cases) ---
  {
    id: 'commerce-east-jan1-fact',
    domain: 'commerce',
    question:
      'What was net revenue for the east region on 2024-01-01? State that single day value in text.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan, data) {
      scope(plan, 'commerce.revenue', { region: 'east', period: ['2024-01-01', '2024-01-01'] });
      assertGroundedFact(plan, data, 'net', 130);
    },
  },
  {
    id: 'commerce-west-jan1-fact',
    domain: 'commerce',
    question: 'Give me west region net revenue specifically for 2024-01-01 in text.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan, data) {
      scope(plan, 'commerce.revenue', { region: 'west', period: ['2024-01-01', '2024-01-01'] });
      assertGroundedFact(plan, data, 'net', 40);
    },
  },
  {
    id: 'commerce-east-2024-table',
    domain: 'commerce',
    question: 'Show a table of daily net revenue for the east region during 2024, including dates.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan, data) {
      scope(plan, 'commerce.revenue', { region: 'east', period: ['2024-01-01', '2024-12-31'] });
      assertTableWithFields(
        plan,
        data,
        'commerce.revenue',
        ['date', 'net'],
        (r) => r.date === '2024-01-01' && r.net === 130,
      );
    },
  },
  {
    id: 'commerce-west-2024-table',
    domain: 'commerce',
    question: 'List daily west-region net revenue for 2024 in a table with dates.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan, data) {
      scope(plan, 'commerce.revenue', { region: 'west', period: ['2024-01-01', '2024-12-31'] });
      assertTableWithFields(
        plan,
        data,
        'commerce.revenue',
        ['date', 'net'],
        (r) => r.date === '2024-01-01' && r.net === 40,
      );
    },
  },
  {
    id: 'commerce-east-q1-table',
    domain: 'commerce',
    question: 'Display daily east region net revenue from 2024-01-01 to 2024-03-31 in a table.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan, data) {
      scope(plan, 'commerce.revenue', { region: 'east', period: ['2024-01-01', '2024-03-31'] });
      assertTableWithFields(plan, data, 'commerce.revenue', ['date', 'net']);
    },
  },
  {
    id: 'commerce-region-control',
    domain: 'commerce',
    question: 'Plot daily net revenue during 2024 and give me a control to switch regions.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan) {
      scope(plan, 'commerce.revenue', { period: ['2024-01-01', '2024-12-31'] });
      const controls = plan.blocks.flatMap((b) => (b.kind === 'visual' ? b.controls : []));
      assert.ok(
        controls.some((c) => c.targets.some((t) => t.argument === 'region')),
        'Expected region control',
      );
      assertVisualHasFields(plan, plan.bindings[0].id, ['date', 'net']);
    },
  },
  {
    id: 'commerce-period-control',
    domain: 'commerce',
    question:
      'Show east region daily net revenue in 2024 with a date range control so I can adjust the period.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan) {
      const binding = plan.bindings.find((b) => b.tool.id === 'commerce.revenue');
      assert.ok(binding, 'Expected commerce.revenue binding');
      assert.equal(binding.fixedArgs.region ?? binding.args.region, 'east');
      const controls = plan.blocks.flatMap((b) => (b.kind === 'visual' ? b.controls : []));
      assert.ok(
        controls.some((c) => c.targets.some((t) => t.argument === 'period')),
        'Expected period control',
      );
    },
  },
  {
    id: 'commerce-grain-trap-annual-total',
    domain: 'commerce',
    question:
      'What was the total net revenue for the west region over all of 2024? If an annual total is unavailable, explain that.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan) {
      assertUnavailableNoNumbers(plan, false);
    },
  },
  {
    id: 'commerce-unsupported-margin',
    domain: 'commerce',
    question:
      'What is the gross profit margin percentage for the east region in 2024? Say so if unavailable.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan) {
      assertUnavailableNoNumbers(plan, false);
    },
  },
  {
    id: 'commerce-unsupported-payroll',
    domain: 'commerce',
    question: 'How much did we spend on sales team bonuses in 2024? Say so if unavailable.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan) {
      assertUnavailableNoNumbers(plan, true);
    },
  },

  // --- Domain 2: operations & topology (10 cases) ---
  {
    id: 'ops-north-score-fact',
    domain: 'operations-topology',
    question:
      'What was the recorded daily quality score for the north area on 2024-01-01? State it in text.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan, data) {
      scope(plan, 'operations.quality', { area: 'north' });
      assertGroundedFact(plan, data, 'score', 82);
    },
  },
  {
    id: 'ops-north-compliance-fact',
    domain: 'operations-topology',
    question: 'Report the recorded compliance ratio for north area on 2024-01-01 in text.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan, data) {
      scope(plan, 'operations.quality', { area: 'north' });
      assertGroundedFact(plan, data, 'compliance', 0.75);
    },
  },
  {
    id: 'ops-north-score-table',
    domain: 'operations-topology',
    question:
      'Show a table of the recorded daily quality score for the north area, including dates.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan, data) {
      scope(plan, 'operations.quality', { area: 'north' });
      assertTableWithFields(
        plan,
        data,
        'operations.quality',
        ['date', 'score'],
        (r) => r.date === '2024-01-01' && r.score === 82,
      );
    },
  },
  {
    id: 'ops-north-compliance-table',
    domain: 'operations-topology',
    question: 'Show recorded north-area compliance ratios by day in a table with dates.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan, data) {
      scope(plan, 'operations.quality', { area: 'north' });
      assertTableWithFields(
        plan,
        data,
        'operations.quality',
        ['date', 'compliance'],
        (r) => r.date === '2024-01-01' && r.compliance === 0.75,
      );
    },
  },
  {
    id: 'ops-region-control',
    domain: 'operations-topology',
    question: 'Show north-area daily quality scores and give me a region filter control.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan) {
      scope(plan, 'operations.quality', { area: 'north' });
      const controls = plan.blocks.flatMap((b) => (b.kind === 'visual' ? b.controls : []));
      assert.ok(
        controls.some((c) => c.targets.some((t) => t.argument === 'region')),
        'Expected region control',
      );
    },
  },
  {
    id: 'topology-table',
    domain: 'operations-topology',
    question: 'Show a table of observed service dependencies with caller and callee.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan, data) {
      scope(plan, 'topology.dependencies', {});
      assertTableWithFields(
        plan,
        data,
        'topology.dependencies',
        ['caller', 'callee'],
        (r) => r.caller === 'gateway' && r.callee === 'orders',
      );
    },
  },
  {
    id: 'topology-edges-all',
    domain: 'operations-topology',
    question: 'List every service dependency pair from the topology source in a table.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan, data) {
      const binding = scope(plan, 'topology.dependencies', {});
      assertTableWithFields(plan, data, 'topology.dependencies', ['caller', 'callee']);
      assert.deepEqual(data.datasets[binding.id].rows, [
        { caller: 'gateway', callee: 'orders' },
        { caller: 'orders', callee: 'ledger' },
      ]);
    },
  },
  {
    id: 'topology-flowchart-or-table',
    domain: 'operations-topology',
    question: 'Show all service dependencies so I can see both gateway and orders connections.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan, data) {
      const binding = scope(plan, 'topology.dependencies', {});
      assert.ok(
        data.datasets[binding.id].rows.some((r) => r.caller === 'orders' && r.callee === 'ledger'),
      );
      assertVisualHasFields(plan, binding.id, ['caller', 'callee']);
    },
  },
  {
    id: 'ops-grain-trap-annual-compliance',
    domain: 'operations-topology',
    question:
      'What was the total cumulative incident count for the north area across the year? If unavailable, say so.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan) {
      assertUnavailableNoNumbers(plan, false);
    },
  },
  {
    id: 'ops-unsupported-salaries',
    domain: 'operations-topology',
    question: 'What is the average employee salary? If the data is unavailable, say so.',
    setup: () => ({ cat: synthCatalog(), who: principal }),
    verify(plan) {
      assertUnavailableNoNumbers(plan, true);
    },
  },

  // --- Domain 3: csv.analytics (10 cases) ---
  {
    id: 'csv-party-count',
    domain: 'csv.analytics',
    question: 'How many recorded observations belong to party? Answer with the count in text.',
    setup: () => ({ cat: csvCatalog(), who: csvFullPrincipal }),
    verify(plan, data) {
      scope(plan, 'csv.summary', { domain: 'party' });
      assertGroundedFact(plan, data, 'record_count', 890);
    },
  },
  {
    id: 'csv-kyc-distinct-systems',
    domain: 'csv.analytics',
    question: 'How many distinct systems are observed in the kyc domain? Answer in text.',
    setup: () => ({ cat: csvCatalog(), who: csvFullPrincipal }),
    verify(plan, data) {
      scope(plan, 'csv.summary', { domain: 'kyc' });
      assertGroundedFact(plan, data, 'distinct_systems', 3);
    },
  },
  {
    id: 'csv-kyc-missing-transfer-size',
    domain: 'csv.analytics',
    question: 'How many kyc observations have a missing transfer team size? Answer with the count.',
    setup: () => ({ cat: csvCatalog(), who: csvFullPrincipal }),
    verify(plan, data) {
      scope(plan, 'csv.summary', { domain: 'kyc' });
      assertGroundedFact(plan, data, 'missing_transfer_size', 46);
    },
  },
  {
    id: 'csv-counts-by-domain-table',
    domain: 'csv.analytics',
    question: 'Compare observation counts across all permitted domains in a table.',
    setup: () => ({ cat: csvCatalog(), who: csvFullPrincipal }),
    verify(plan, data) {
      const binding = plan.bindings.find((b) => b.tool.id === 'csv.countByDomain');
      assert.ok(binding, 'Expected csv.countByDomain binding');
      assertVisualHasFields(plan, binding.id, ['domain', 'record_count']);
      assert.ok(
        data.datasets[binding.id].rows.some((r) => r.domain === 'party' && r.record_count === 890),
      );
    },
  },
  {
    id: 'csv-payment-monthly-quality',
    domain: 'csv.analytics',
    question:
      'Show the monthly trends of payment data quality metrics (average completeness, control score, and SLA met rate) during 2024.',
    setup: () => ({ cat: csvCatalog(), who: csvFullPrincipal }),
    verify(plan) {
      const binding = scope(plan, 'csv.monthlyQuality', {
        domain: 'payment',
        startMonth: '2024-01',
        endMonth: '2024-12',
      });
      assertVisualHasFields(plan, binding.id, [
        'avg_comp_mean',
        'data_ctrl_score_mean',
        'sla_mean',
      ]);
    },
  },
  {
    id: 'csv-party-monthly-sla',
    domain: 'csv.analytics',
    question: 'Show monthly SLA met rate trends for party across 2024.',
    setup: () => ({ cat: csvCatalog(), who: csvFullPrincipal }),
    verify(plan) {
      const binding = plan.bindings.find(
        (b) => b.tool.id === 'csv.monthlySla' || b.tool.id === 'csv.monthlyQuality',
      );
      assert.ok(binding, 'Expected monthly SLA binding');
      assert.equal(binding.fixedArgs.domain ?? binding.args.domain, 'party');
      assertVisualHasFields(plan, binding.id, ['month', 'sla_mean']);
    },
  },
  {
    id: 'csv-payment-records-table',
    domain: 'csv.analytics',
    question:
      'Show individual source records for payment in a table with rowId, system, and sla_met_rate.',
    setup: () => ({ cat: csvCatalog(), who: csvFullPrincipal }),
    verify(plan, data) {
      scope(plan, 'csv.records', { domain: 'payment' });
      assertTableWithFields(plan, data, 'csv.records', ['rowId', 'system', 'sla_met_rate']);
    },
  },
  {
    id: 'csv-grain-trap-weighted-tickets',
    domain: 'csv.analytics',
    question:
      'What is the ticket-weighted SLA rate for the payment domain? If weighted ticket denominators are unavailable, explain why without giving a number.',
    setup: () => ({ cat: csvCatalog(), who: csvFullPrincipal }),
    verify(plan) {
      assertUnavailableNoNumbers(plan, false);
    },
  },
  {
    id: 'csv-restricted-kyc-blocked',
    domain: 'csv.analytics',
    question:
      'How many observations exist in the kyc domain? If kyc data is unavailable or unauthorized for my account, state that.',
    allowErrorCode: 'DATA_FORBIDDEN',
    setup: () => ({ cat: csvCatalog(), who: csvPaymentOnlyPrincipal }),
    verify(plan, data) {
      assert.ok(
        plan.bindings.every((b) => {
          const dom = b.fixedArgs.domain ?? b.args.domain;
          return dom !== 'kyc';
        }),
        'Restricted principal must never query kyc domain',
      );
      for (const ds of Object.values(data.datasets)) {
        for (const row of ds.rows) {
          assert.notEqual(row.record_count, 1039, 'Must never leak kyc count 1039');
        }
      }
      assertUnavailableNoNumbers(plan, false);
    },
  },
  {
    id: 'csv-unsupported-payroll',
    domain: 'csv.analytics',
    question:
      'What is the total payroll expense across all payment teams? If unavailable, explain clearly.',
    setup: () => ({ cat: csvCatalog(), who: csvFullPrincipal }),
    verify(plan) {
      assertUnavailableNoNumbers(plan, true);
    },
  },
];

const repeats = Math.max(1, Number(process.env.HELDOUT_REPEATS ?? '3'));
const concurrency = Math.max(1, Number(process.env.HELDOUT_CONCURRENCY ?? '6'));

type RunItem = { caseItem: Evaluation; repeat: number; index: number };
const queue: RunItem[] = [];
for (let r = 1; r <= repeats; r++) {
  for (const caseItem of cases) {
    queue.push({ caseItem, repeat: r, index: queue.length });
  }
}

const directory = `artifacts/foundation/heldout-${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(directory, { recursive: true });
const results = new Array<Record<string, unknown>>(queue.length);
let cursor = 0;

async function worker() {
  for (;;) {
    const idx = cursor++;
    if (idx >= queue.length) return;
    const { caseItem, repeat } = queue[idx];
    const provider = new DeepSeekPlanningModel();
    const planner = new CapabilityPlanningAgent(provider);
    const { cat, who } = caseItem.setup();
    const runtime = new FoundationRuntime(cat);
    const attempts: { feedbackCodes: string[] }[] = [];
    const recording: PlanningAgent = {
      propose: async (context) => {
        attempts.push({ feedbackCodes: context.feedback.map((entry) => entry.code) });
        return planner.propose(context);
      },
    };
    let status = 'passed';
    let error: string | undefined;
    try {
      const signal = AbortSignal.timeout(180000);
      const plan = await runtime.plan(recording, caseItem.question, who, signal);
      const data = await runtime.execute(plan, who, signal);
      const response = await runtime.ingest(plan, data.datasets, who, signal, {
        messageId: `msg_${caseItem.id}_${repeat}`,
        responseId: `resp_${caseItem.id}_${repeat}`,
        revision: 1,
        generation: 0,
      });
      caseItem.verify(plan, data, response);
    } catch (cause) {
      if (
        caseItem.allowErrorCode &&
        cause instanceof FoundationError &&
        cause.diagnostic.code === caseItem.allowErrorCode
      ) {
        status = 'passed';
      } else {
        status = 'failed';
        error = cause instanceof Error ? cause.message : 'Unknown evaluation error';
      }
    }
    results[idx] = {
      id: caseItem.id,
      domain: caseItem.domain,
      repeat,
      status,
      error,
      attempts,
      calls: provider.calls,
    };
    console.log(
      `[${idx + 1}/${queue.length}] ${status.toUpperCase()} ${caseItem.id} (r${repeat})${error ? ` — ${error}` : ''}`,
    );
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));

const passed = results.filter((r) => r.status === 'passed').length;
const total = results.length;
const passRate = total ? passed / total : 0;
const byDomain = Object.fromEntries(
  (['commerce', 'operations-topology', 'csv.analytics'] as DomainName[]).map((d) => {
    const subset = results.filter((r) => r.domain === d);
    const ok = subset.filter((r) => r.status === 'passed').length;
    return [
      d,
      { passed: ok, total: subset.length, passRate: Number((ok / subset.length).toFixed(4)) },
    ];
  }),
);
const summary = {
  recordedAt: new Date().toISOString(),
  casesPerDomain: 10,
  repeats,
  totalRuns: total,
  passed,
  failed: total - passed,
  passRate: Number(passRate.toFixed(4)),
  targetPassRate: 0.95,
  byDomain,
  runs: results,
};

writeFileSync(`${directory}/heldout.json`, JSON.stringify(summary, null, 2));
writeFileSync('artifacts/foundation/heldout-90-latest.json', JSON.stringify(summary, null, 2));
console.log(
  `\nHeld-out summary: ${passed}/${total} (${(passRate * 100).toFixed(1)}%) passed across 3 domains. Evidence: ${directory}/heldout.json`,
);
assert.ok(
  passRate >= 0.95,
  `Held-out pass rate ${(passRate * 100).toFixed(1)}% below 95% threshold`,
);
