// Manual baseline capture only. Tests never regenerate this frozen compatibility fixture.
import { writeFileSync } from 'node:fs';
import { ArtifactSchema } from '../packages/contracts/index.ts';
import { csvPlan } from '../examples/csv-analytics/plans.ts';
const first = {
  artifactId: 'legacy_artifact',
  revision: 1,
  generationId: 1,
  plan: csvPlan('trend'),
  sourceHash: '0'.repeat(64),
  catalogVersion: '1',
  adapterVersion: 'openui-1.1.1',
  filters: {},
  datasets: {},
};
const second = { ...first, revision: 2, generationId: 2, plan: csvPlan('two') };
// Intentionally synthetic values: this fixture records persistence shape, not CSV truth.
for (const artifact of [first, second]) {
  artifact.datasets = Object.fromEntries(
    artifact.plan.bindings.map((b) => [
      b.id,
      {
        status: 'ready',
        data: {
          rows:
            b.toolId === 'csv.monthlySla'
              ? [{ month: '2024-01', sla_mean: 0.5 }]
              : [{ domain: 'payment', record_count: 2 }],
          fields:
            b.toolId === 'csv.monthlySla'
              ? [
                  { name: 'month', type: 'date', nullable: false },
                  { name: 'sla_mean', type: 'number', nullable: true, unit: 'ratio' },
                ]
              : [
                  { name: 'domain', type: 'string', nullable: false },
                  { name: 'record_count', type: 'number', nullable: false },
                ],
          sourceId: 'synthetic-legacy-fixture',
          sourceHash: artifact.sourceHash,
          queryVersion: '1',
          queryId: 'legacy_query',
          args: b.args,
          observationCount: 2,
          asOf: '2026-11-14T00:00:00Z',
          truncated: false,
          nextCursor: null,
          warnings: [],
        },
      },
    ]),
  );
  ArtifactSchema.parse(artifact);
}
writeFileSync(
  'tests/fixtures/v1-conversation.json',
  JSON.stringify(
    {
      description:
        'Frozen v1 storage compatibility baseline; synthetic values, not analytical evidence.',
      principal: {
        id: 'legacy_user',
        tenant: 'legacy_tenant',
        domains: ['payment'],
        policyEpoch: 1,
      },
      conversationId: 'legacy_chat',
      revisions: [first, second],
    },
    null,
    2,
  ) + '\n',
);
