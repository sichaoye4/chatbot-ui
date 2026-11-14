import { z } from 'zod';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import type { DomainRegistration } from '../../packages/catalog/foundation.ts';
import type {
  DataResult,
  FieldDefinition,
  Policy,
  Principal,
  ResponsePlan,
} from '../../packages/contracts/foundation.ts';

// Contract/execution fixtures, not production plugins or agent examples.
export const principal: Principal = { subject: 'fixture-user', context: { account: 'sample' } };
export const permissivePolicy: Policy = {
  visible: () => true,
  authorize: async () => ({ scopeKey: 'fixture-scope-v1', context: {} }),
};
export const field = (
  id: string,
  type: FieldDefinition['type'],
  role: FieldDefinition['role'],
  unit?: string,
): FieldDefinition => ({
  id,
  label: id,
  type,
  role,
  nullable: false,
  description: `Fixture field ${id}`,
  ...(unit ? { unit } : {}),
  ...(role === 'measure'
    ? { measure: { aggregation: 'tool-owned aggregate', precision: 2, additive: false } }
    : {}),
  ...(['date', 'datetime'].includes(type)
    ? { temporal: { timezone: 'UTC', calendar: 'gregorian', grain: 'day' } }
    : {}),
});
export function result(rows: DataResult['rows'], grain: string): DataResult {
  return {
    rows,
    provenance: {
      sourceId: 'synthetic-fixture',
      sourceVersion: 'fixture-v1',
      queryId: 'fixture-query',
      executedAt: '2026-11-14T00:00:00Z',
      grain,
      truncated: false,
      nextCursor: null,
      warnings: [],
    },
  };
}
export const domains: DomainRegistration[] = [
  {
    ref: { id: 'fixture.operations', version: 1 },
    description: 'Synthetic operations contract fixture',
    semantics: ['Score and ratio are distinct measures. Never combine their units.'],
    tools: [
      {
        ref: { id: 'operations.quality', version: 1 },
        description: 'Recorded daily measures',
        args: z.strictObject({
          area: z.enum(['north', 'south']),
          region: z.enum(['east', 'west']).nullable(),
        }),
        fields: [
          field('date', 'date', 'time'),
          field('score', 'number', 'measure', 'score'),
          field('compliance', 'number', 'measure', 'ratio'),
        ],
        grain: 'one row per day',
        interactive: {
          region: { description: 'Region subset', controls: [{ id: 'ui.select', version: 1 }] },
        },
        execute: async () =>
          result([{ date: '2024-01-01', score: 82, compliance: 0.75 }], 'one row per day'),
      },
    ],
  },
  {
    ref: { id: 'fixture.commerce', version: 1 },
    description: 'Commerce contract fixture',
    semantics: ['Revenue is net of refunds and denominated in USD. Lines are not orders.'],
    tools: [
      {
        ref: { id: 'commerce.revenue', version: 1 },
        description: 'Net revenue by order date',
        args: z.strictObject({
          region: z.enum(['east', 'west']).nullable(),
          period: z.tuple([z.iso.date(), z.iso.date()]).refine(([a, b]) => a <= b),
        }),
        fields: [field('date', 'date', 'time'), field('net', 'number', 'measure', 'currency:USD')],
        grain: 'one row per day',
        interactive: {
          region: { description: 'Region subset', controls: [{ id: 'ui.select', version: 1 }] },
          period: {
            description: 'Inclusive order date interval',
            controls: [{ id: 'ui.dateRange', version: 1 }],
          },
        },
        execute: async (args) => {
          // Independent test expectation: 100 + 50 - 20 = 130; west adds 40.
          const ledger = [
            { date: '2024-01-01', region: 'east', amount: 100 },
            { date: '2024-01-01', region: 'east', amount: 50 },
            { date: '2024-01-01', region: 'east', amount: -20 },
            { date: '2024-01-01', region: 'west', amount: 40 },
          ];
          const [start, end] = args.period as string[];
          const selected = ledger.filter(
            (r) => (!args.region || r.region === args.region) && r.date >= start && r.date <= end,
          );
          return result(
            selected.length
              ? [{ date: '2024-01-01', net: selected.reduce((n, r) => n + r.amount, 0) }]
              : [],
            'one row per day',
          );
        },
      },
    ],
  },
  {
    ref: { id: 'fixture.topology', version: 1 },
    description: 'Topology contract fixture',
    semantics: ['An edge is an observed dependency, not evidence of causation.'],
    tools: [
      {
        ref: { id: 'topology.dependencies', version: 1 },
        description: 'Observed service dependencies',
        args: z.strictObject({}),
        fields: [field('caller', 'string', 'source'), field('callee', 'string', 'target')],
        grain: 'one row per edge',
        interactive: {},
        execute: async () =>
          result(
            [
              { caller: 'gateway', callee: 'orders' },
              { caller: 'orders', callee: 'ledger' },
            ],
            'one row per edge',
          ),
      },
    ],
  },
];
export function catalog(policy = permissivePolicy) {
  const registry = registerBuiltins(new FoundationCatalog(policy));
  for (const domain of domains) registry.registerDomain(domain);
  return registry;
}
export function plan(registry: FoundationCatalog, domain = 1): ResponsePlan {
  const tool = domains[domain].tools[0];
  const fields = tool.fields;
  return {
    schemaVersion: 2,
    capabilitySnapshotId: registry.snapshot(principal).id,
    bindings: [
      {
        id: 'data',
        tool: tool.ref,
        args: domain === 0 ? { region: null } : domain === 1 ? { region: null } : {},
        fixedArgs:
          domain === 0
            ? { area: 'north' }
            : domain === 1
              ? { period: ['2024-01-01', '2024-12-31'] }
              : {},
      },
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
            id: 'values',
            component: { id: 'ui.table', version: 1 },
            title: 'Recorded results',
            roles: { columns: fields.map((f) => ({ bindingId: 'data', fieldId: f.id })) },
            props: {},
          },
        ],
      },
    ],
  };
}
