import { VisualizationConfig, VisualizationSemantics } from './visualization.ts';
import { z } from 'zod';

export const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const Field = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
export const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const Filters = z
  .strictObject({
    domain: z.enum(['kyc', 'payment', 'party']).nullable().optional(),
    system: z.string().max(80).nullable().optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable()
      .optional(),
    month: Month.nullable().optional(),
    startMonth: Month.optional(),
    endMonth: Month.optional(),
  })
  .refine(
    (v) => !v.startMonth || !v.endMonth || v.startMonth <= v.endMonth,
    'Month range is reversed',
  );
export type Filters = z.infer<typeof Filters>;
export const FilterKeys = [
  'domain',
  'system',
  'country',
  'month',
  'startMonth',
  'endMonth',
] as const;
const base = {
  id: Id,
  componentVersion: z.literal(1),
  title: z.string().min(1).max(160),
  bindingId: Id,
  importance: z.enum(['primary', 'supporting']),
};
export const Panel = z.discriminatedUnion('component', [
  z.strictObject({ ...base, component: z.literal('histogram'), config: VisualizationConfig }),
  z.strictObject({ ...base, component: z.literal('boxPlot'), config: VisualizationConfig }),
  z.strictObject({ ...base, component: z.literal('scatter'), config: VisualizationConfig }),
  z.strictObject({ ...base, component: z.literal('heatmap'), config: VisualizationConfig }),
  z.strictObject({ ...base, component: z.literal('bullet'), config: VisualizationConfig }),
  z.strictObject({ ...base, component: z.literal('groupedBar'), config: VisualizationConfig }),
  z.strictObject({ ...base, component: z.literal('stackedBar'), config: VisualizationConfig }),
  z.strictObject({ ...base, component: z.literal('dumbbell'), config: VisualizationConfig }),
  z.strictObject({ ...base, component: z.literal('waterfall'), config: VisualizationConfig }),
  z.strictObject({ ...base, component: z.literal('intervalTrend'), config: VisualizationConfig }),
  z.strictObject({ ...base, component: z.literal('timeline'), config: VisualizationConfig }),
  z.strictObject({ ...base, component: z.literal('treemap'), config: VisualizationConfig }),
  z.strictObject({ ...base, component: z.literal('sankey'), config: VisualizationConfig }),
  z.strictObject({ ...base, component: z.literal('choropleth'), config: VisualizationConfig }),
  z.strictObject({
    ...base,
    component: z.literal('gantt'),
    config: z.strictObject({
      taskIdField: Field,
      labelField: Field,
      startField: Field,
      endField: Field,
      progressField: Field,
      dependenciesField: Field,
      kindField: Field,
    }),
  }),
  z.strictObject({
    ...base,
    component: z.literal('flowchart'),
    config: z.strictObject({
      idField: Field,
      labelField: Field,
      kindField: Field,
      sourceField: Field,
      targetField: Field,
      direction: z.enum(['LR', 'TB']),
    }),
  }),
  z.strictObject({
    ...base,
    component: z.literal('burndown'),
    config: z.strictObject({
      timeField: Field,
      actualField: Field,
      referenceField: Field,
      mode: z.enum(['burndown', 'burnup']),
    }),
  }),
  z.strictObject({
    ...base,
    component: z.literal('cumulativeFlow'),
    config: z.strictObject({
      timeField: Field,
      stageFields: z
        .array(Field)
        .min(2)
        .max(6)
        .refine((v) => new Set(v).size === v.length, 'Duplicate stages'),
    }),
  }),
  z.strictObject({
    ...base,
    component: z.literal('metric'),
    config: z.strictObject({
      valueField: Field,
      format: z.enum(['integer', 'decimal', 'percent']),
    }),
  }),
  z.strictObject({
    ...base,
    component: z.literal('trend'),
    config: z.strictObject({ xField: Field, yField: Field }),
  }),
  z.strictObject({
    ...base,
    component: z.literal('comparison'),
    config: z.strictObject({ categoryField: Field, valueField: Field }),
  }),
  z.strictObject({
    ...base,
    component: z.literal('pie'),
    config: z.strictObject({ categoryField: Field, valueField: Field }),
  }),
  z.strictObject({
    ...base,
    component: z.literal('table'),
    config: z.strictObject({ columns: z.array(Field).min(1).max(25) }),
  }),
  z.strictObject({
    ...base,
    component: z.literal('relationship'),
    config: z.strictObject({ nodeIdField: Field, sourceField: Field, targetField: Field }),
  }),
]);
export type Panel = z.infer<typeof Panel>;
export const Binding = z.strictObject({
  id: Id,
  toolId: z.string().regex(/^[a-z]+\.[a-zA-Z]+$/),
  args: z.record(z.string(), z.unknown()),
  filterMap: z.record(Id, Field),
});
export const Plan = z
  .strictObject({
    schemaVersion: z.literal(1),
    title: z.string().min(1).max(160),
    layoutIntent: z.enum(['auto', 'overview', 'comparison', 'investigation']),
    panels: z.array(Panel).min(1).max(6),
    bindings: z.array(Binding).min(1).max(6),
    filters: z
      .array(
        z.strictObject({
          id: Id,
          type: z.literal('select'),
          label: z.string().max(80),
          optionsSource: z.string().max(100),
          defaultValue: z.string().max(80).nullable(),
        }),
      )
      .max(6),
    dataMode: z.enum(['snapshot', 'live']),
  })
  .superRefine((plan, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    for (const list of [plan.panels, plan.bindings, plan.filters])
      if (new Set(list.map((x) => x.id)).size !== list.length) issue('Duplicate IDs');
    for (const panel of plan.panels)
      if (!plan.bindings.some((b) => b.id === panel.bindingId)) issue('Missing binding');
    for (const b of plan.bindings) {
      if (!plan.panels.some((p) => p.bindingId === b.id)) issue('Unused binding');
      for (const f of Object.keys(b.filterMap))
        if (!plan.filters.some((x) => x.id === f)) issue('Unknown filter');
    }
    if (new TextEncoder().encode(JSON.stringify(plan)).length > 65536) issue('Plan exceeds 64KB');
  });
export type Plan = z.infer<typeof Plan>;
export type Row = Record<string, string | number | boolean | null>;
export type FieldMeta = {
  name: string;
  type: 'string' | 'number' | 'date';
  nullable: boolean;
  unit?: string;
};
export type Dataset = {
  visualization?: import('./visualization.ts').VisualizationSemantics;
  rows: Row[];
  fields: FieldMeta[];
  sourceId: string;
  sourceHash: string;
  queryVersion: string;
  queryId: string;
  args: Record<string, unknown>;
  observationCount: number;
  asOf: string;
  truncated: boolean;
  nextCursor: string | null;
  warnings: string[];
};
export type DatasetState =
  { status: 'ready'; data: Dataset } | { status: 'loading' } | { status: 'error'; code: string };
export type Artifact = {
  artifactId: string;
  revision: number;
  plan: Plan;
  catalogVersion: string;
  adapterVersion: string;
  sourceHash: string;
  generationId: number;
  filters: Filters;
  datasets: Record<string, DatasetState>;
};
export const DatasetSchema = z.strictObject({
  visualization: VisualizationSemantics.optional(),
  rows: z
    .array(z.record(Field, z.union([z.string(), z.number().finite(), z.boolean(), z.null()])))
    .max(2000),
  fields: z
    .array(
      z.strictObject({
        name: Field,
        type: z.enum(['string', 'number', 'date']),
        nullable: z.boolean(),
        unit: z.string().optional(),
      }),
    )
    .max(100),
  sourceId: z.string().max(160),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  queryVersion: z.string().max(40),
  queryId: z.string().max(80),
  args: z.record(z.string(), z.unknown()),
  observationCount: z.number().int().nonnegative(),
  asOf: z.string().max(80),
  truncated: z.boolean(),
  nextCursor: z.string().max(2048).nullable(),
  warnings: z.array(z.string().max(1000)).max(20),
});
export const ArtifactSchema = z.strictObject({
  artifactId: Id,
  revision: z.number().int().positive(),
  plan: Plan,
  catalogVersion: z.string().max(40),
  adapterVersion: z.string().max(80),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  generationId: z.number().int().nonnegative(),
  filters: Filters,
  datasets: z.record(
    Id,
    z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('loading') }),
      z.strictObject({ status: z.literal('error'), code: z.string().max(80) }),
      z.strictObject({ status: z.literal('ready'), data: DatasetSchema }),
    ]),
  ),
});
export const EventType = z.enum([
  'request.started',
  'assistant.text.delta',
  'artifact.committed',
  'dataset.started',
  'dataset.ready',
  'dataset.failed',
  'artifact.settled',
  'request.completed',
  'request.failed',
]);
export const Event = z
  .strictObject({
    protocolVersion: z.literal(1),
    eventId: Id,
    requestId: Id,
    sequence: z.number().int().positive(),
    type: EventType,
    artifactId: Id.optional(),
    revision: z.number().int().positive().optional(),
    generationId: z.number().int().nonnegative().optional(),
    payload: z.unknown(),
  })
  .superRefine((event, ctx) => {
    const schemas: Record<string, z.ZodType> = {
      'request.started': z.strictObject({ requestId: Id }),
      'assistant.text.delta': z.strictObject({
        text: z.string().max(16000),
        evidence: z
          .strictObject({
            sourceId: z.string(),
            sourceHash: z.string(),
            queryId: z.string(),
            args: z.record(z.string(), z.unknown()),
          })
          .optional(),
      }),
      'artifact.committed': z.strictObject({ artifact: ArtifactSchema }),
      'artifact.settled': z.strictObject({ artifact: ArtifactSchema, partial: z.boolean() }),
      'dataset.started': z.strictObject({ bindingId: Id }),
      'dataset.ready': z.strictObject({ bindingId: Id, data: DatasetSchema }),
      'dataset.failed': z.strictObject({ bindingId: Id, code: z.string().max(80) }),
      'request.failed': z.strictObject({ code: z.string().max(80) }),
      'request.completed': z.strictObject({}),
    };
    const result = schemas[event.type].safeParse(event.payload);
    if (!result.success) ctx.addIssue({ code: 'custom', message: 'Invalid event payload' });
    if (event.type.startsWith('artifact.') || event.type.startsWith('dataset.'))
      if (!event.artifactId || !event.revision || event.generationId === undefined)
        ctx.addIssue({
          code: 'custom',
          message: 'Artifact event requires revision and generation context',
        });
  });
export type Event = z.infer<typeof Event>;
export const Turn = z.strictObject({
  conversationId: Id,
  text: z.string().min(1).max(4000),
  idempotencyKey: Id,
  artifactId: Id.optional(),
  baseRevision: z.number().int().positive().optional(),
});
export const Action = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('setFilter'), filters: Filters }),
  z.strictObject({ type: z.literal('refresh') }),
  z.strictObject({ type: z.literal('saveView') }),
  z.strictObject({
    type: z.literal('sortTable'),
    panelId: Id,
    field: Field,
    direction: z.enum(['asc', 'desc']),
  }),
  z.strictObject({ type: z.literal('nextPage'), panelId: Id, cursor: z.string().max(2048) }),
]);
export type Action = z.infer<typeof Action>;
export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
