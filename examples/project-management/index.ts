import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Dataset, FieldMeta, Panel, Plan, Row } from '../../packages/contracts/index.ts';
import type { Tool } from '../../packages/catalog/index.ts';
import type { Agent } from '../../packages/agent-adapter/index.ts';

// Deliberately fictional, immutable observations. Never relabel these as connected project data.
const schedule: Row[] = [
  {
    id: 'brief',
    label: 'Project brief',
    start: '2026-11-02',
    end: '2026-11-04',
    progress: 1,
    dependencies: '',
    kind: 'task',
  },
  {
    id: 'design',
    label: 'Design & review',
    start: '2026-11-04',
    end: '2026-11-09',
    progress: 1,
    dependencies: 'brief',
    kind: 'task',
  },
  {
    id: 'build',
    label: 'Implementation',
    start: '2026-11-09',
    end: '2026-11-19',
    progress: 0.55,
    dependencies: 'design',
    kind: 'task',
  },
  {
    id: 'docs',
    label: 'Documentation',
    start: '2026-11-09',
    end: '2026-11-18',
    progress: 0.4,
    dependencies: 'design',
    kind: 'task',
  },
  {
    id: 'qa',
    label: 'Validation',
    start: '2026-11-19',
    end: '2026-11-23',
    progress: 0,
    dependencies: 'build,docs',
    kind: 'task',
  },
  {
    id: 'release',
    label: 'Release milestone',
    start: '2026-11-23',
    end: '2026-11-23',
    progress: 0,
    dependencies: 'qa',
    kind: 'milestone',
  },
];
const workflow: Row[] = [
  ...[
    ['start', 'Request received', 'start'],
    ['triage', 'Triage request', 'process'],
    ['approve', 'Approved?', 'decision'],
    ['build', 'Deliver change', 'process'],
    ['review', 'Review outcome', 'process'],
    ['revise', 'Revise request', 'process'],
    ['end', 'Complete', 'end'],
  ].map(([id, label, kind]) => ({ id, label, kind, source: null, target: null })),
  ...[
    ['start', 'triage', ''],
    ['triage', 'approve', ''],
    ['approve', 'build', 'Yes'],
    ['approve', 'revise', 'No'],
    ['revise', 'triage', 'Resubmit'],
    ['build', 'review', ''],
    ['review', 'end', 'Accepted'],
    ['review', 'build', 'Rework'],
  ].map(([source, target, label], i) => ({ id: `edge${i}`, label, kind: 'edge', source, target })),
];
const work: Row[] = [
  {
    date: '2026-11-02',
    remaining: 40,
    ideal: 40,
    completed: 0,
    scope: 40,
    done: 0,
    active: 4,
    queued: 16,
  },
  {
    date: '2026-11-04',
    remaining: 36,
    ideal: 32,
    completed: 4,
    scope: 40,
    done: 2,
    active: 6,
    queued: 12,
  },
  {
    date: '2026-11-06',
    remaining: 30,
    ideal: 24,
    completed: 10,
    scope: 40,
    done: 5,
    active: 6,
    queued: 9,
  },
  {
    date: '2026-11-08',
    remaining: 32,
    ideal: 16,
    completed: 16,
    scope: 48,
    done: 8,
    active: 8,
    queued: 8,
  },
  {
    date: '2026-11-10',
    remaining: 22,
    ideal: 8,
    completed: 26,
    scope: 48,
    done: 13,
    active: 7,
    queued: 4,
  },
  {
    date: '2026-11-12',
    remaining: 8,
    ideal: 0,
    completed: 40,
    scope: 48,
    done: 20,
    active: 4,
    queued: 0,
  },
];
const field = (name: string, type: FieldMeta['type'] = 'string', unit?: string): FieldMeta => ({
  name,
  type,
  nullable: false,
  ...(unit ? { unit } : {}),
});
const definitions = [
  {
    id: 'pm.schedule',
    rows: schedule,
    fields: [
      field('id'),
      field('label'),
      field('start', 'date'),
      field('end', 'date'),
      field('progress', 'number', 'ratio'),
      field('dependencies'),
      field('kind'),
    ],
    projectViews: ['gantt'] as Tool['projectViews'],
    description:
      'Synthetic project schedule. Calendar-date endpoints, comma-separated finish-to-start predecessor IDs, task/milestone kind and completion ratio.',
  },
  {
    id: 'pm.workflow',
    rows: workflow,
    fields: [
      field('id'),
      field('label'),
      field('kind'),
      { ...field('source'), nullable: true },
      { ...field('target'), nullable: true },
    ],
    projectViews: ['flowchart'] as Tool['projectViews'],
    description:
      'Synthetic approval workflow. Node rows: start/end/process/decision; edge rows: kind=edge with source/target IDs and branch label. Loops are intentional.',
  },
  {
    id: 'pm.work',
    rows: work,
    fields: [
      field('date', 'date'),
      ...['remaining', 'ideal', 'completed', 'scope'].map((n) =>
        field(n, 'number', 'story points'),
      ),
      ...['done', 'active', 'queued'].map((n) => field(n, 'number', 'items')),
    ],
    projectViews: ['burndown', 'cumulativeFlow'] as Tool['projectViews'],
    description:
      'Synthetic sprint snapshots. Remaining/ideal/completed/scope are story points; done/active/queued are complete, mutually exclusive item counts, ordered bottom to top. Scope increases during the sprint. Ideal is supplied, not a forecast.',
  },
];
export function projectTools(): Tool[] {
  return definitions.map((d) => ({
    id: d.id,
    description: d.description,
    fields: d.fields,
    projectViews: d.projectViews,
    args: z.strictObject({}),
    execute: () =>
      ({
        rows: structuredClone(d.rows),
        fields: d.fields,
        sourceId: 'synthetic-project-demo',
        sourceHash: createHash('sha256').update(JSON.stringify(d.rows)).digest('hex'),
        queryVersion: '1',
        queryId: 'project-demo',
        args: {},
        observationCount: d.rows.length,
        asOf: '2026-11-14T00:00:00Z',
        truncated: false,
        nextCursor: null,
        warnings: ['Synthetic demonstration data — not a connected project.'],
      }) satisfies Dataset,
  }));
}
export function projectPlan(
  kind: 'gantt' | 'flowchart' | 'burndown' | 'burnup' | 'cumulativeFlow' | 'overview',
): Plan {
  const base = { componentVersion: 1 as const, importance: 'primary' as const };
  const panels: Panel[] = [
    {
      ...base,
      id: 'schedule',
      bindingId: 'schedule',
      component: 'gantt',
      title: 'Demo · Delivery schedule',
      config: {
        taskIdField: 'id',
        labelField: 'label',
        startField: 'start',
        endField: 'end',
        progressField: 'progress',
        dependenciesField: 'dependencies',
        kindField: 'kind',
      },
    },
    {
      ...base,
      id: 'workflow',
      bindingId: 'workflow',
      component: 'flowchart',
      title: 'Demo · Approval workflow',
      config: {
        idField: 'id',
        labelField: 'label',
        kindField: 'kind',
        sourceField: 'source',
        targetField: 'target',
        direction: 'LR',
      },
    },
    {
      ...base,
      id: 'progress',
      bindingId: 'work',
      component: 'burndown',
      title: `Demo · ${kind === 'burnup' ? 'Sprint burnup' : 'Sprint burndown'}`,
      config: {
        timeField: 'date',
        actualField: kind === 'burnup' ? 'completed' : 'remaining',
        referenceField: kind === 'burnup' ? 'scope' : 'ideal',
        mode: kind === 'burnup' ? 'burnup' : 'burndown',
      },
    },
    {
      ...base,
      id: 'flow',
      bindingId: 'work',
      component: 'cumulativeFlow',
      title: 'Demo · Cumulative workflow',
      config: { timeField: 'date', stageFields: ['done', 'active', 'queued'] },
    },
  ];
  const selected =
    kind === 'overview'
      ? panels
      : panels.filter((p) => p.component === (kind === 'burnup' ? 'burndown' : kind));
  return {
    schemaVersion: 1,
    title: 'Synthetic project management demo',
    layoutIntent: 'auto',
    panels: selected,
    bindings: [...new Set(selected.map((p) => p.bindingId))].map((id) => ({
      id,
      toolId: `pm.${id}`,
      args: {},
      filterMap: {},
    })),
    filters: [],
    dataMode: 'snapshot',
  };
}
export function withProjectDemo(delegate: Agent): Agent {
  return {
    get mode() {
      return delegate.mode;
    },
    get calls() {
      return delegate.calls;
    },
    async run(context) {
      const text = context.text.toLowerCase();
      if (
        /\b(demo|sample|example)\b/.test(text) &&
        /gantt|flow\s?chart|burn\s?(down|up)|cumulative flow|project management/.test(text)
      ) {
        const kind = /overview|project management/.test(text)
          ? 'overview'
          : /gantt/.test(text)
            ? 'gantt'
            : /flow\s?chart/.test(text)
              ? 'flowchart'
              : /cumulative/.test(text)
                ? 'cumulativeFlow'
                : /burn\s?up/.test(text)
                  ? 'burnup'
                  : 'burndown';
        const plan = projectPlan(kind);
        if (/standalone|separate messages/.test(text))
          plan.messages = plan.panels.map((panel) => ({ id: panel.id, panelIds: [panel.id] }));
        return { kind: 'visual', plan };
      }
      if (/gantt|flow\s?chart|burn\s?(down|up)|cumulative flow/.test(text))
        return { kind: 'explain', reason: 'project-data-required' };
      return delegate.run(context);
    },
  };
}
