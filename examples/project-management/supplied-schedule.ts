import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Agent } from '../../packages/agent-adapter/index.ts';
import type { Tool } from '../../packages/catalog/index.ts';
import type { Dataset, Plan, Row } from '../../packages/contracts/index.ts';
import { dateValue, ganttModel } from '../../packages/contracts/project-model.ts';
import { projectPlan } from './index.ts';

const months = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const config = projectPlan('gantt').panels[0];
if (config.component !== 'gantt') throw new Error('Expected schedule configuration');
const ganttConfig = config.config;
const argsSchema = z.strictObject({
  sourceText: z.string().min(1).max(16000),
  view: z.enum(['overview', 'detail']),
});
const fields: Dataset['fields'] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'label', type: 'string', nullable: false },
  { name: 'start', type: 'date', nullable: false },
  { name: 'end', type: 'date', nullable: false },
  { name: 'progress', type: 'number', unit: 'ratio', nullable: true },
  { name: 'dependencies', type: 'string', nullable: false },
  { name: 'kind', type: 'string', nullable: false },
];

/** Parse explicit month-index schedules only. Never infer completion or dependency edges from prose. */
export function parseSuppliedSchedule(sourceText: string) {
  const text = sourceText.replace(/\r/g, '').replace(/\*\*/g, '');
  const duration = text.match(
    /Project Duration:\s*(\d+)\s*Months?\s*\(([A-Za-z]+)\s+(\d{4})\s*[–—-]\s*([A-Za-z]+)\s+(\d{4})\)/i,
  );
  if (!duration) throw new Error('Supply Project Duration: N Months (Month YYYY – Month YYYY).');
  const first = months.indexOf(duration[2].toLowerCase());
  const last = months.indexOf(duration[4].toLowerCase());
  const year = Number(duration[3]),
    count = Number(duration[1]);
  if (
    first < 0 ||
    last < 0 ||
    count < 1 ||
    count > 120 ||
    year < 1900 ||
    year > 2100 ||
    (Number(duration[5]) - year) * 12 + last - first + 1 !== count
  )
    throw new Error('Project duration and calendar endpoints disagree.');
  const monthDate = (index: number, end: boolean) => {
    if (index < 1 || index > count) throw new Error('Month index is outside the project duration.');
    return new Date(Date.UTC(year, first + index - (end ? 0 : 1), end ? 0 : 1))
      .toISOString()
      .slice(0, 10);
  };
  const phases = [
    ...text.matchAll(
      /^#{1,6}\s+Phase\s+(\d+):\s*(.+?)\s*\(Months?\s+(\d+)(?:\s*[–—-]\s*(\d+))?\)\s*$/gim,
    ),
  ];
  if (!phases.length || phases.length !== [...text.matchAll(/^#{1,6}\s+Phase\s+/gim)].length)
    throw new Error('Supply a month range for each phase.');
  const overview: Row[] = [],
    detail: Row[] = [];
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i],
      from = Number(phase[3]),
      to = Number(phase[4] ?? phase[3]);
    if (from > to) throw new Error('Phase month range is reversed.');
    const row = (id: string, label: string, start: string, end: string, kind = 'task'): Row => ({
      id,
      label,
      start,
      end,
      kind,
      progress: null,
      dependencies: '',
    });
    overview.push(
      row(
        `phase${phase[1]}`,
        `Phase ${phase[1]}: ${phase[2]}`,
        monthDate(from, false),
        monthDate(to, true),
      ),
    );
    const section = text.slice(phase.index! + phase[0].length, phases[i + 1]?.index ?? text.length);
    const tasks = [...section.matchAll(/^\s*[-*]\s+M(\d+)(?:\s*[–—-]\s*M?(\d+))?:\s*(.+)\s*$/gim)];
    if (!tasks.length || tasks.length !== [...section.matchAll(/^\s*[-*]\s+M\d/gim)].length)
      throw new Error('Supply M1 or M1–M2 ranges for each scheduled task.');
    for (const [j, task] of tasks.entries()) {
      const a = Number(task[1]),
        b = Number(task[2] ?? task[1]);
      if (a < from || b > to || a > b) throw new Error('Task dates fall outside their phase.');
      detail.push(
        row(
          `phase${phase[1]}task${j + 1}`,
          task[3].trim(),
          monthDate(a, false),
          monthDate(b, true),
        ),
      );
    }
    const milestones = [
      ...section.matchAll(
        /^Milestone\s+(\w+)\s*[–—-]\s*(.+?)\s*\((\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\)\s*$/gim,
      ),
    ];
    if (milestones.length !== [...section.matchAll(/^Milestone\s+/gim)].length)
      throw new Error('Supply an exact calendar date for each milestone.');
    for (const m of milestones) {
      const month = months.indexOf(m[4].toLowerCase());
      if (month < 0) throw new Error('Unknown milestone month.');
      const date = `${m[5]}-${String(month + 1).padStart(2, '0')}-${m[3].padStart(2, '0')}`;
      dateValue(date);
      if (date < monthDate(from, false) || date > monthDate(to, true))
        throw new Error('Milestone falls outside its phase.');
      const milestone = row(m[1], `${m[1]}: ${m[2]}`, date, date, 'milestone');
      overview.push(milestone);
      detail.push(milestone);
    }
  }
  ganttModel(overview, ganttConfig);
  ganttModel(detail, ganttConfig);
  return { overview, detail };
}

export function suppliedScheduleTool(): Tool {
  return {
    id: 'project.suppliedSchedule',
    description:
      'Visualize a schedule supplied in the user message. Accepts Project Duration and Phase month ranges, M1–M2 task bullets and exact milestone dates. Returns planned dates, never actual progress. Do not substitute synthetic demo data.',
    args: argsSchema,
    fields,
    projectViews: ['gantt'],
    execute(input) {
      const args = argsSchema.parse(input);
      const rows = parseSuppliedSchedule(args.sourceText)[args.view];
      return {
        rows,
        fields,
        sourceId: 'user-supplied-project-schedule',
        sourceHash: createHash('sha256').update(args.sourceText).digest('hex'),
        queryVersion: '1',
        queryId: 'supplied-schedule',
        args,
        observationCount: rows.length,
        asOf: 'User-supplied plan; not live project status',
        truncated: false,
        nextCursor: null,
        warnings: [
          'Month-only task ranges use the first and last calendar day of the stated months; these are planning windows, not exact task dates.',
          'Completion and task dependencies were not supplied. No progress or dependency links are inferred.',
        ],
      };
    },
  };
}

export function suppliedSchedulePlan(sourceText: string): Plan {
  parseSuppliedSchedule(sourceText);
  return {
    schemaVersion: 1,
    title: 'Your project timeline and milestones',
    layoutIntent: 'investigation',
    panels: ['overview', 'detail'].map((view) => ({
      ...config,
      id: view,
      bindingId: view,
      title:
        view === 'overview'
          ? 'Phase overview and milestone targets'
          : 'Detailed task schedule and milestones',
    })),
    bindings: ['overview', 'detail'].map((view) => ({
      id: view,
      toolId: 'project.suppliedSchedule',
      args: { sourceText, view },
      filterMap: {},
    })),
    messages: [
      { id: 'overview', panelIds: ['overview'] },
      { id: 'detail', panelIds: ['detail'] },
    ],
    filters: [],
    dataMode: 'snapshot',
  };
}

/** Run before demo routers so pasted project data is never classified as synthetic data. */
export function withSuppliedSchedule(delegate: Agent): Agent {
  return {
    get mode() {
      return delegate.mode;
    },
    get calls() {
      return delegate.calls;
    },
    async run(context) {
      if (/Project Duration:/i.test(context.text) && /^#{1,6}\s+Phase\s+/im.test(context.text)) {
        try {
          return { kind: 'visual', plan: suppliedSchedulePlan(context.text) };
        } catch {
          return { kind: 'explain', reason: 'supplied-schedule-invalid' };
        }
      }
      return delegate.run(context);
    },
  };
}
