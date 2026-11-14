import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Agent } from '../../packages/agent-adapter/index.ts';
import type { Tool } from '../../packages/catalog/index.ts';
import type { Dataset, Plan, Row } from '../../packages/contracts/index.ts';
import {
  visualizationDefinitions,
  visualizationKinds,
  type VisualizationKind,
  type VisualizationSemantics,
} from '../../packages/contracts/visualization.ts';

const fixtures: Record<
  VisualizationKind,
  { rows: Row[]; semantics: Partial<VisualizationSemantics> }
> = {
  histogram: {
    rows: [4, 9, 15, 10, 2].map((count, i) => ({ binStart: i * 10, binEnd: (i + 1) * 10, count })),
    semantics: {
      method: 'Equal-width bins; final upper boundary included',
      included: 40,
      missing: 2,
      outside: 0,
    },
  },
  boxPlot: {
    rows: ['Team A', 'Team B', 'Team C'].map((category, i) => ({
      category,
      lowWhisker: 2 + i,
      q1: 5 + i,
      median: 8 + i,
      q3: 12 + i,
      highWhisker: 17 + i,
      sampleCount: 30,
    })),
    semantics: { method: 'Supplied quartiles; Tukey 1.5 IQR whiskers; outliers omitted' },
  },
  scatter: {
    rows: Array.from({ length: 20 }, (_, i) => ({
      recordId: `Case ${i + 1}`,
      x: i + 2,
      y: 10 + i * 2 + (i % 3) * 5,
    })),
    semantics: { method: 'All joined observations shown; no regression', missing: 0 },
  },
  heatmap: {
    rows: ['Design', 'Build', 'Review'].flatMap((row, i) =>
      ['Mon', 'Tue', 'Wed', 'Thu'].map((column, j) => ({
        row,
        column,
        value: (i * 3 + j * 2) % 10,
      })),
    ),
    semantics: { domain: [0, 10] },
  },
  bullet: {
    rows: [
      { category: 'Resolution', actual: 72, target: 80 },
      { category: 'Coverage', actual: 88, target: 85 },
    ],
    semantics: { direction: 'higher', targetSource: 'Synthetic quarterly objectives' },
  },
  groupedBar: {
    rows: ['North', 'South', 'West'].flatMap((category, i) =>
      ['Current', 'Prior'].map((series, j) => ({ category, series, value: 20 + i * 8 - j * 5 })),
    ),
    semantics: {},
  },
  stackedBar: {
    rows: ['North', 'South', 'West'].flatMap((category, i) =>
      ['Done', 'Active', 'Queued'].map((series, j) => ({
        category,
        series,
        value: 12 + i * 4 + j * 3,
      })),
    ),
    semantics: { completePartition: true },
  },
  dumbbell: {
    rows: [
      { category: 'Response time', before: 32, after: 21 },
      { category: 'Review time', before: 18, after: 24 },
    ],
    semantics: { beforeLabel: 'Prior period', afterLabel: 'Current period' },
  },
  waterfall: {
    rows: [
      { step: 'Opening', order: 0, kind: 'opening', value: 100 },
      { step: 'New work', order: 1, kind: 'delta', value: 45 },
      { step: 'Completed', order: 2, kind: 'delta', value: -30 },
      { step: 'Subtotal', order: 3, kind: 'subtotal', value: 115 },
      { step: 'Removed', order: 4, kind: 'delta', value: -15 },
      { step: 'Closing', order: 5, kind: 'closing', value: 100 },
    ],
    semantics: {},
  },
  intervalTrend: {
    rows: [10, 14, 12, 18, 21, 23].map((estimate, i) => ({
      time: `2026-11-${String(i + 1).padStart(2, '0')}`,
      estimate,
      lower: estimate - 4,
      upper: estimate + 5,
    })),
    semantics: {
      calendar: 'UTC Gregorian dates',
      method: 'Supplied model quantiles; synthetic forecast for all dates',
      interval: '90% prediction interval (5th–95th percentile)',
    },
  },
  timeline: {
    rows: [
      { entity: 'Discovery', start: '2026-11-01', end: '2026-11-05' },
      { entity: 'Implementation', start: '2026-11-04', end: '2026-11-12' },
      { entity: 'Release milestone', start: '2026-11-13', end: '2026-11-13' },
    ],
    semantics: { calendar: 'UTC Gregorian dates' },
  },
  treemap: {
    rows: [
      { nodeId: 'root', parentId: '', label: 'Portfolio', value: 100 },
      { nodeId: 'a', parentId: 'root', label: 'Platform', value: 60 },
      { nodeId: 'b', parentId: 'root', label: 'Experience', value: 40 },
      { nodeId: 'a1', parentId: 'a', label: 'Core', value: 35 },
      { nodeId: 'a2', parentId: 'a', label: 'Services', value: 25 },
      { nodeId: 'b1', parentId: 'b', label: 'Web', value: 25 },
      { nodeId: 'b2', parentId: 'b', label: 'Mobile', value: 15 },
    ],
    semantics: {
      method: 'Leaf weights sum to parent totals; slice-and-dice layout; all leaves included',
    },
  },
  sankey: {
    rows: [
      { sourceId: 'Requests', targetId: 'Review', sourceStage: 0, targetStage: 1, value: 60 },
      { sourceId: 'Requests', targetId: 'Self-service', sourceStage: 0, targetStage: 1, value: 40 },
      { sourceId: 'Review', targetId: 'Resolved', sourceStage: 1, targetStage: 2, value: 45 },
      { sourceId: 'Review', targetId: 'Escalated', sourceStage: 1, targetStage: 2, value: 15 },
      { sourceId: 'Self-service', targetId: 'Resolved', sourceStage: 1, targetStage: 2, value: 40 },
    ],
    semantics: {
      conserved: true,
      method:
        'Conserved intermediate stages; Requests is the source; Resolved and Escalated are sinks',
    },
  },
  choropleth: {
    rows: [
      { regionId: 'NW', value: 35 },
      { regionId: 'NE', value: 70 },
      { regionId: 'SW', value: 55 },
      { regionId: 'SE', value: null },
    ],
    semantics: {
      domain: [0, 100],
      geography: 'synthetic-districts-v1',
      rateDefinition:
        'Synthetic completion percentage; same period and eligible-item denominator definition',
    },
  },
};
export function visualizationDataset(kind: VisualizationKind): Dataset {
  const fixture = fixtures[kind];
  return {
    rows: structuredClone(fixture.rows),
    fields: Object.entries(visualizationDefinitions[kind].roles).map(([name, type]) => ({
      name,
      type,
      nullable: (kind === 'choropleth' && name === 'value') || kind === 'intervalTrend',
      ...(type === 'number'
        ? {
            unit: ['count', 'sampleCount'].includes(name)
              ? 'observations'
              : ['order', 'sourceStage', 'targetStage'].includes(name)
                ? 'index'
                : kind === 'choropleth'
                  ? 'percent'
                  : 'demo units',
          }
        : {}),
    })),
    visualization: {
      kind,
      grain: 'One synthetic observation per declared chart key',
      note: 'Synthetic demonstration only. No connected business records.',
      ...fixture.semantics,
    },
    sourceId: 'synthetic-visualization-demo',
    sourceHash: createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),
    queryVersion: '1',
    queryId: 'visualization-demo',
    args: {},
    observationCount: fixture.rows.length,
    asOf: '2026-11-15T00:00:00Z',
    truncated: false,
    nextCursor: null,
    warnings: ['Synthetic demonstration data. Geography is fictional.'],
  };
}
export function visualizationTools(): Tool[] {
  return visualizationKinds.map((kind) => ({
    id: `viz.${kind}`,
    description: `Synthetic ${kind} example with supplied visualization semantics. Only use for explicit demos.`,
    args: z.strictObject({}),
    fields: visualizationDataset(kind).fields,
    visualizationViews: [kind],
    execute: () => visualizationDataset(kind),
  }));
}
export function visualizationPlan(kinds: VisualizationKind[], percent = false): Plan {
  return {
    schemaVersion: 1,
    title: 'Synthetic data visualization demo',
    layoutIntent: 'auto',
    panels: kinds.map((kind) => ({
      id: kind,
      bindingId: kind,
      component: kind,
      componentVersion: 1,
      title: `Demo · ${kind.replace(/([A-Z])/g, ' $1').toLowerCase()}`,
      importance: 'primary',
      config: {
        fields: Object.fromEntries(
          Object.keys(visualizationDefinitions[kind].roles).map((role) => [role, role]),
        ),
        mode: percent && kind === 'stackedBar' ? 'percent' : 'absolute',
      },
    })),
    bindings: kinds.map((kind) => ({ id: kind, toolId: `viz.${kind}`, args: {}, filterMap: {} })),
    filters: [],
    dataMode: 'snapshot',
  };
}
export function withVisualizationDemo(delegate: Agent): Agent {
  return {
    get mode() {
      return delegate.mode;
    },
    get calls() {
      return delegate.calls;
    },
    async run(context) {
      const text = context.text.toLowerCase().replace(/[- ]/g, '');
      const kinds = visualizationKinds.filter((kind) => text.includes(kind.toLowerCase()));
      const gallery = /visualization|chartgallery/.test(text);
      if ((kinds.length || gallery) && /demo|sample|example/.test(text))
        return {
          kind: 'visual',
          plan: visualizationPlan(
            kinds.length
              ? kinds.slice(0, 6)
              : /special/.test(text)
                ? ['timeline', 'treemap', 'sankey', 'choropleth']
                : /comparison/.test(text)
                  ? [
                      'groupedBar',
                      'stackedBar',
                      'dumbbell',
                      'boxPlot',
                      'waterfall',
                      'intervalTrend',
                    ]
                  : ['histogram', 'scatter', 'heatmap', 'bullet'],
            /percent/.test(text),
          ),
        };
      if (kinds.length) return { kind: 'explain', reason: 'visualization-data-required' };
      return delegate.run(context);
    },
  };
}
