import { dateValue } from './calendar.ts';
export type ProjectViewData = {
  rows: Record<string, string | number | boolean | null>[];
  fields: { name: string; type: 'string' | 'number' | 'date'; nullable: boolean; unit?: string }[];
  truncated: boolean;
};
type Row = ProjectViewData['rows'][number];
type Base = { title: string };
export type ProjectViewPanel =
  | (Base & {
      component: 'gantt';
      config: {
        taskIdField: string;
        labelField: string;
        startField: string;
        endField: string;
        progressField: string;
        dependenciesField: string;
        kindField: string;
      };
    })
  | (Base & {
      component: 'flowchart';
      config: {
        idField: string;
        labelField: string;
        kindField: string;
        sourceField: string;
        targetField: string;
        direction: 'LR' | 'TB';
      };
    })
  | (Base & {
      component: 'burndown';
      config: {
        timeField: string;
        actualField: string;
        referenceField: string;
        mode: 'burndown' | 'burnup';
      };
    })
  | (Base & { component: 'cumulativeFlow'; config: { timeField: string; stageFields: string[] } });
const fail = (message: string): never => {
  throw new Error(message);
};
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160)
    return fail('Labels and IDs must contain 1–160 characters.');
  return value;
}
function numeric(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    return fail('Expected a finite nonnegative value.');
  return value;
}
export function ganttModel(
  rows: Row[],
  c: Extract<ProjectViewPanel, { component: 'gantt' }>['config'],
) {
  if (rows.length > 40) fail('Gantt supports up to 40 tasks; narrow the project scope.');
  const tasks = rows.map((r) => {
    const id = label(r[c.taskIdField]),
      name = label(r[c.labelField]);
    const start = dateValue(r[c.startField]),
      end = dateValue(r[c.endField]);
    const progress = r[c.progressField] === null ? null : numeric(r[c.progressField]);
    const kind = r[c.kindField];
    if (
      !['task', 'milestone'].includes(String(kind)) ||
      end < start ||
      (progress !== null && progress > 1) ||
      (kind === 'milestone' && start !== end)
    )
      fail('Invalid task dates, kind or progress ratio.');
    const raw = r[c.dependenciesField];
    if (typeof raw !== 'string' || raw.length > 4000)
      fail('Dependencies must be a comma-separated ID list.');
    const dependencies = (raw as string)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (new Set(dependencies).size !== dependencies.length) fail('Duplicate task dependency.');
    return { id, name, start, end, progress, kind, dependencies };
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (byId.size !== tasks.length) fail('Task IDs must be unique.');
  const visiting = new Set<string>(),
    done = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) fail('Schedule dependencies contain a cycle.');
    if (done.has(id)) return;
    const task = byId.get(id);
    if (!task) return fail('A dependency refers to an unknown task.');
    visiting.add(id);
    task.dependencies.forEach(visit);
    visiting.delete(id);
    done.add(id);
  }
  tasks.forEach((t) => visit(t.id));
  return tasks;
}
export function flowModel(
  rows: Row[],
  c: Extract<ProjectViewPanel, { component: 'flowchart' }>['config'],
) {
  const nodes: { id: string; label: string; kind: string }[] = [];
  const edges: { id: string; label: string; source: string; target: string }[] = [];
  for (const r of rows) {
    const id = label(r[c.idField]),
      kind = String(r[c.kindField]);
    if (kind === 'edge') {
      const text = r[c.labelField];
      if (typeof text !== 'string' || text.length > 160) fail('Invalid branch label.');
      edges.push({
        id,
        label: text as string,
        source: label(r[c.sourceField]),
        target: label(r[c.targetField]),
      });
    } else {
      if (!['start', 'end', 'process', 'decision'].includes(kind))
        fail('Unknown flowchart node kind.');
      nodes.push({ id, label: label(r[c.labelField]), kind });
    }
  }
  if (!nodes.length || nodes.length > 40 || edges.length > 80)
    fail('Flowcharts require 1–40 nodes and at most 80 edges.');
  if (new Set(rows.map((r) => r[c.idField])).size !== rows.length)
    fail('Diagram row IDs must be unique.');
  const ids = new Set(nodes.map((n) => n.id));
  if (edges.some((e) => !ids.has(e.source) || !ids.has(e.target)))
    fail('An edge refers to an unknown node.');
  // DFS marks feedback edges, then longest-path ranks on the remaining DAG.
  const back = new Set<string>(),
    active = new Set<string>(),
    visited = new Set<string>(),
    order: string[] = [];
  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    for (const e of edges.filter((e) => e.source === id)) {
      if (active.has(e.target)) back.add(e.id);
      else visit(e.target);
    }
    active.delete(id);
    order.push(id);
  }
  nodes.forEach((n) => visit(n.id));
  const ranks = new Map(nodes.map((n) => [n.id, 0]));
  for (const id of order.reverse())
    for (const e of edges.filter((e) => e.source === id && !back.has(e.id)))
      ranks.set(e.target, Math.max(ranks.get(e.target)!, ranks.get(id)! + 1));
  const slots = new Map<number, number>();
  return {
    nodes: nodes.map((n) => {
      const rank = ranks.get(n.id)!,
        slot = slots.get(rank) ?? 0;
      slots.set(rank, slot + 1);
      return { ...n, rank, slot };
    }),
    edges: edges.map((e) => ({ ...e, feedback: back.has(e.id) })),
  };
}
export function projectSeries(
  rows: Row[],
  c: Extract<ProjectViewPanel, { component: 'burndown' | 'cumulativeFlow' }>['config'],
) {
  if (rows.length > 366) fail('Limit the chart to 366 dated observations.');
  const fields = 'stageFields' in c ? c.stageFields : [c.actualField, c.referenceField];
  const points = rows
    .map((r) => ({
      time: dateValue(r[c.timeField]),
      values: fields.map((f) => (r[f] === null && !('stageFields' in c) ? null : numeric(r[f]))),
    }))
    .sort((a, b) => a.time - b.time);
  if (new Set(points.map((p) => p.time)).size !== points.length)
    fail('Duplicate dates require an explicit aggregation.');
  if ('stageFields' in c && points.some((p) => p.values.some((v) => !Number.isInteger(v))))
    fail('Workflow snapshots require integer counts.');
  return { fields, points };
}
export function validateProjectData(
  panel: ProjectViewPanel,
  data: Pick<ProjectViewData, 'rows' | 'truncated'>,
) {
  if (data.truncated) fail('A complete result is required; narrow the project scope.');
  if (!data.rows.length) return;
  if (panel.component === 'gantt') ganttModel(data.rows, panel.config);
  else if (panel.component === 'flowchart') flowModel(data.rows, panel.config);
  else projectSeries(data.rows, panel.config);
}
