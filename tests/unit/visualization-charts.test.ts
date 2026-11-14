import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VisualizationChart } from '../../packages/ui-kit/visualization-charts.tsx';
import {
  visualizationDataset,
  visualizationPlan,
  visualizationTools,
  withVisualizationDemo,
} from '../../examples/data-visualization/index.ts';
import {
  visualizationKinds,
  type VisualizationKind,
} from '../../packages/contracts/visualization.ts';
import {
  validateVisualizationData,
  type VisualizationPanel,
} from '../../packages/contracts/visualization-model.ts';
import { Catalog } from '../../packages/catalog/index.ts';
import { DatasetSchema, Plan } from '../../packages/contracts/index.ts';
import { QueryRuntime } from '../../packages/server-runtime/queries.ts';
import { compilePanel } from '../../packages/renderer-openui/index.tsx';
import { layout } from '../../packages/layout/index.ts';
const principal = { id: 'tester', tenant: 'demo', domains: ['kyc'], policyEpoch: 1 };
test('all-zero histogram bins have zero visual height', () => {
  const data = visualizationDataset('histogram');
  data.rows.forEach((row) => {
    row.count = 0;
  });
  data.visualization!.included = 0;
  const panel = visualizationPlan(['histogram']).panels[0] as VisualizationPanel;
  const markup = renderToStaticMarkup(createElement(VisualizationChart, { panel, data }));
  assert.equal((markup.match(/height="0"/g) ?? []).length, 5);
});
for (const kind of visualizationKinds)
  test(`${kind}: authorized result, contract, compile, empty and invalid result`, () => {
    const plan = visualizationPlan([kind]),
      catalog = new Catalog(visualizationTools());
    assert.deepEqual(catalog.validate(plan, principal), Plan.parse(plan));
    const data = new QueryRuntime(catalog).binding(plan, kind, {}, principal);
    DatasetSchema.parse(data);
    const panel = plan.panels[0] as VisualizationPanel;
    validateVisualizationData(panel, data);
    assert.match(compilePanel(panel), /Corporate/);
    assert.equal(layout(plan.panels, 320)[0].span, 12);
    assert.doesNotThrow(() => validateVisualizationData(panel, { ...data, rows: [] }));
    assert.throws(() => validateVisualizationData(panel, { ...data, truncated: true }));
    assert.throws(() => validateVisualizationData(panel, { ...data, visualization: undefined }));
    const invalid = structuredClone(data);
    const numeric = invalid.fields.find((f) => f.type === 'number');
    if (numeric) {
      invalid.rows[0][numeric.name] = Infinity;
      assert.throws(() => validateVisualizationData(panel, invalid));
    }
    const bad = structuredClone(plan);
    (bad.panels[0] as VisualizationPanel).config.fields.invented = 'secret';
    assert.throws(() => catalog.validate(bad, principal));
    assert.throws(() => catalog.validate(plan, { ...principal, revoked: true }));
    assert.throws(() =>
      new Catalog(visualizationTools().map((t) => ({ ...t, visualizationViews: [] }))).validate(
        plan,
        principal,
      ),
    );
  });
test('semantic boundaries reject misleading chart interpretations', () => {
  const reject = (
    kind: VisualizationKind,
    change: (data: ReturnType<typeof visualizationDataset>) => void,
  ) => {
    const d = visualizationDataset(kind);
    change(d);
    assert.throws(
      () => validateVisualizationData(visualizationPlan([kind]).panels[0] as VisualizationPanel, d),
      kind,
    );
  };
  reject('histogram', (d) => {
    d.rows[1].binEnd = 23;
  });
  reject('histogram', (d) => {
    d.visualization!.included = 1;
  });
  reject('boxPlot', (d) => {
    d.rows[0].median = 100;
  });
  reject('scatter', (d) => {
    d.rows[1].recordId = d.rows[0].recordId;
  });
  reject('heatmap', (d) => {
    d.rows.push(d.rows[0]);
  });
  reject('bullet', (d) => {
    delete d.visualization!.targetSource;
  });
  reject('groupedBar', (d) => {
    d.rows.pop();
  });
  reject('stackedBar', (d) => {
    d.rows[0].value = -1;
  });
  reject('stackedBar', (d) => {
    d.visualization!.completePartition = false;
  });
  reject('dumbbell', (d) => {
    delete d.visualization!.beforeLabel;
  });
  reject('waterfall', (d) => {
    d.rows.at(-1)!.value = 999;
  });
  reject('intervalTrend', (d) => {
    d.rows[0].lower = 100;
  });
  reject('timeline', (d) => {
    d.rows[0].end = '2026-02-30';
  });
  reject('treemap', (d) => {
    d.rows[1].parentId = 'a1';
  });
  reject('treemap', (d) => {
    d.rows[0].value = 101;
  });
  reject('sankey', (d) => {
    d.rows[0].targetStage = 0;
  });
  reject('sankey', (d) => {
    d.rows[0].value = 100;
  });
  reject('choropleth', (d) => {
    d.rows[0].regionId = 'UNKNOWN';
  });
  reject('choropleth', (d) => {
    d.visualization!.geography = 'unapproved';
  });
  const percent = visualizationPlan(['stackedBar'], true).panels[0] as VisualizationPanel,
    d = visualizationDataset('stackedBar');
  d.rows.forEach((r) => {
    r.value = 0;
  });
  assert.throws(() => validateVisualizationData(percent, d));
});
test('signed values, null gaps, zero counts and fixed color domains remain valid', () => {
  for (const kind of ['bullet', 'dumbbell', 'groupedBar'] as const) {
    const d = visualizationDataset(kind);
    const field = kind === 'bullet' ? 'actual' : kind === 'dumbbell' ? 'before' : 'value';
    d.rows[0][field] = -10;
    validateVisualizationData(visualizationPlan([kind]).panels[0] as VisualizationPanel, d);
  }
  const d = visualizationDataset('intervalTrend');
  d.rows[2].estimate = null;
  d.rows[2].lower = null;
  d.rows[2].upper = null;
  validateVisualizationData(
    visualizationPlan(['intervalTrend']).panels[0] as VisualizationPanel,
    d,
  );
});
test('demo router requires explicit synthetic intent and honors six-panel ceiling', async () => {
  const agent = withVisualizationDemo({
    mode: 'test',
    calls: [],
    async run() {
      return { kind: 'explain', reason: 'delegate' };
    },
  });
  const context = {
    principal,
    queries: new QueryRuntime(new Catalog(visualizationTools())),
    signal: new AbortController().signal,
  };
  assert.deepEqual(await agent.run({ ...context, text: 'Show my histogram' }), {
    kind: 'explain',
    reason: 'visualization-data-required',
  });
  for (const text of [
    'Show a visualization demo',
    'Show a comparison visualization demo',
    'Show a specialized visualization demo',
  ]) {
    const result = await agent.run({ ...context, text });
    assert.equal(result.kind, 'visual');
    if (result.kind === 'visual') assert.ok(result.plan.panels.length <= 6);
  }
});
