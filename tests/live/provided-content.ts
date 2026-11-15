import { DeepSeekAgent } from '../../examples/csv-analytics/legacy-agent.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createApplication } from '../../apps/reference-server/server.ts';
import type { Artifact, Event } from '../../packages/contracts/index.ts';
const app = createApplication({ database: ':memory:', mode: 'deepseek' });
const principal = { id: 'live-test', tenant: 'test', domains: ['demo'], policyEpoch: 1 };
mkdirSync('artifacts/provided-content', { recursive: true });
try {
  for (const [name, text, dates] of [
    [
      'banking-12',
      readFileSync('tests/fixtures/banking-project-12-month.md', 'utf8'),
      ['2027-02-28', '2027-04-30', '2027-06-30', '2027-10-31', '2027-12-31'],
    ],
    [
      'banking-18',
      readFileSync('tests/fixtures/banking-project-timeline.md', 'utf8'),
      ['2027-03-31', '2027-06-30', '2027-09-30', '2028-01-31', '2028-04-30', '2028-06-30'],
    ],
    [
      'ordinary-chart',
      'Visualize these recorded order counts as a bar chart: North 12, South 7, West 9. Keep it compact.',
      [],
    ],
  ] as const) {
    if (process.env.LIVE_CASE && process.env.LIVE_CASE !== name) continue;
    const events: Event[] = [];
    const before = app.service.agent.calls.length;
    await app.service.turn(
      { conversationId: name, idempotencyKey: 'first', text },
      principal,
      (e) => events.push(e),
    );
    const artifact = events.find((e) => e.type === 'artifact.settled')?.payload as
      { artifact: Artifact } | undefined;
    const calls = app.service.agent.calls.slice(before);
    writeFileSync(
      `artifacts/provided-content/${name}.json`,
      JSON.stringify(
        { calls, validationErrors: (app.service.agent as DeepSeekAgent).validationErrors, events },
        null,
        2,
      ),
    );
    assert.ok(calls.length > 0, 'Must call the LLM rather than a parser/demo router');
    assert.equal(events.at(-1)?.type, 'request.completed', JSON.stringify(events.at(-1)));
    assert.ok(artifact, 'Must produce a useful visualization');
    assert.ok(artifact.artifact.plan.bindings.every((b) => b.toolId === 'provided.data'));
    const datasets = Object.values(artifact.artifact.datasets);
    assert.ok(datasets.every((d) => d.status === 'ready'));
    const rows = datasets.flatMap((d) => (d.status === 'ready' ? d.data.rows : []));
    for (const date of dates)
      assert.ok(JSON.stringify(rows).includes(date), `Missing milestone ${date}`);
    console.log(
      JSON.stringify({
        name,
        calls: calls.length,
        panels: artifact.artifact.plan.panels.map((p) => p.component),
        rows: rows.length,
        status: 'passed',
      }),
    );
  }
} finally {
  await app.close();
}
