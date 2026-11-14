import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dateValue,
  flowModel,
  ganttModel,
  projectSeries,
  isProjectPanel,
  validateProjectData,
} from '../../packages/contracts/project-model.ts';
import {
  projectPlan,
  projectTools,
  withProjectDemo,
} from '../../examples/project-management/index.ts';
import { Catalog } from '../../packages/catalog/index.ts';
import { QueryRuntime } from '../../packages/server-runtime/queries.ts';
import { layout } from '../../packages/layout/index.ts';
import { compilePanel } from '../../packages/renderer-openui/index.tsx';
const principal = { id: 'test', tenant: 'test', domains: ['demo'], policyEpoch: 1 };
const runtime = new QueryRuntime(new Catalog(projectTools()));

test('all project forms validate, execute and compile through the real v1 adapter', () => {
  for (const kind of [
    'gantt',
    'flowchart',
    'burndown',
    'burnup',
    'cumulativeFlow',
    'overview',
  ] as const) {
    const plan = runtime.catalog.validate(projectPlan(kind), principal);
    for (const panel of plan.panels) {
      assert.ok(isProjectPanel(panel));
      const data = runtime.binding(plan, panel.bindingId, {}, principal);
      validateProjectData(panel, data);
      assert.match(compilePanel(panel), /Corporate/);
      assert.throws(
        () => validateProjectData(panel, { ...data, truncated: true }),
        /complete result/,
      );
    }
    assert.ok(layout(plan.panels, 320).every((p) => p.span === 12));
  }
  assert.throws(
    () => runtime.catalog.validate(projectPlan('gantt'), { ...principal, revoked: true }),
    /DATA_FORBIDDEN/,
  );
  const unsupported = projectTools().map((t) => ({ ...t, projectViews: undefined }));
  assert.throws(
    () => new Catalog(unsupported).validate(projectPlan('gantt'), principal),
    /PROJECT_SEMANTICS_REQUIRED/,
  );
});
test('Gantt validates dates, dependency graph and progress without guessing schedules', () => {
  const panel = projectPlan('gantt').panels[0];
  if (panel.component !== 'gantt') throw Error();
  const data = runtime.binding(projectPlan('gantt'), 'schedule', {}, principal);
  assert.equal(ganttModel(data.rows, panel.config).at(-1)!.kind, 'milestone');
  for (const patch of [
    { start: '2026-02-30' },
    { end: '2020-01-01' },
    { progress: 1.1 },
    { dependencies: 'missing' },
    { dependencies: 'release' },
  ]) {
    const rows = structuredClone(data.rows);
    Object.assign(rows[0], patch);
    assert.throws(() => ganttModel(rows, panel.config));
  }
  assert.throws(() => dateValue('2026-11'), /calendar date/);
});
test('flowchart handles branching, self loops and cycles deterministically; rejects dangling edges', () => {
  const panel = projectPlan('flowchart').panels[0];
  if (panel.component !== 'flowchart') throw Error();
  const data = runtime.binding(projectPlan('flowchart'), 'workflow', {}, principal);
  const model = flowModel(data.rows, panel.config);
  assert.equal(model.nodes.length, 7);
  assert.ok(model.edges.some((e) => e.feedback));
  assert.deepEqual(model, flowModel(data.rows, panel.config));
  const rows = [
    ...data.rows,
    { id: 'loop', kind: 'edge', label: 'Retry', source: 'start', target: 'start' },
  ];
  assert.ok(flowModel(rows, panel.config).edges.at(-1)!.feedback);
  assert.throws(
    () =>
      flowModel(
        [...data.rows, { id: 'bad', kind: 'edge', label: '', source: 'start', target: 'unknown' }],
        panel.config,
      ),
    /unknown node/,
  );
  assert.throws(() => flowModel([...data.rows, data.rows[0]], panel.config), /unique/);
});
test('work charts sort dates, keep missing actuals as gaps and reject incomplete state counts', () => {
  const plan = projectPlan('burndown'),
    panel = plan.panels[0];
  if (panel.component !== 'burndown') throw Error();
  const data = runtime.binding(plan, 'work', {}, principal);
  const rows = structuredClone(data.rows).reverse();
  rows[0].remaining = null;
  const series = projectSeries(rows, panel.config);
  assert.equal(series.points.at(-1)!.values[0], null);
  assert.throws(() => projectSeries([...rows, rows[0]], panel.config), /Duplicate dates/);
  const cf = projectPlan('cumulativeFlow').panels[0];
  if (cf.component !== 'cumulativeFlow') throw Error();
  rows[0].done = null;
  assert.throws(() => projectSeries(rows, cf.config), /nonnegative/);
  rows[0].done = 0.5;
  assert.throws(() => projectSeries(rows, cf.config), /integer/);
});
test('synthetic demo routing is explicit and never claims to read real project data', async () => {
  const delegate = {
    mode: 'test',
    calls: [],
    async run() {
      return { kind: 'explain' as const, reason: 'delegate' };
    },
  };
  const agent = withProjectDemo(delegate),
    base = { principal, queries: runtime, signal: new AbortController().signal };
  assert.equal((await agent.run({ ...base, text: 'Show a flowchart demo' })).kind, 'visual');
  assert.deepEqual(await agent.run({ ...base, text: 'Show my Gantt' }), {
    kind: 'explain',
    reason: 'project-data-required',
  });
  assert.deepEqual(await agent.run({ ...base, text: 'SLA summary' }), {
    kind: 'explain',
    reason: 'delegate',
  });
});
