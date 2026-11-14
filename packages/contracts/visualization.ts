import { z } from 'zod';

// One shared definition drives legacy contracts, catalog descriptors and field validation.
export const visualizationDefinitions = {
  histogram: {
    roles: { binStart: 'number', binEnd: 'number', count: 'number' },
    width: 380,
    height: 320,
    limit: 40,
  },
  boxPlot: {
    roles: {
      category: 'string',
      lowWhisker: 'number',
      q1: 'number',
      median: 'number',
      q3: 'number',
      highWhisker: 'number',
      sampleCount: 'number',
    },
    width: 440,
    height: 360,
    limit: 12,
  },
  scatter: {
    roles: { x: 'number', y: 'number', recordId: 'string' },
    width: 400,
    height: 360,
    limit: 500,
  },
  heatmap: {
    roles: { row: 'string', column: 'string', value: 'number' },
    width: 600,
    height: 400,
    limit: 480,
  },
  bullet: {
    roles: { category: 'string', actual: 'number', target: 'number' },
    width: 320,
    height: 240,
    limit: 8,
  },
  groupedBar: {
    roles: { category: 'string', series: 'string', value: 'number' },
    width: 440,
    height: 360,
    limit: 48,
  },
  stackedBar: {
    roles: { category: 'string', series: 'string', value: 'number' },
    width: 440,
    height: 360,
    limit: 72,
  },
  dumbbell: {
    roles: { category: 'string', before: 'number', after: 'number' },
    width: 440,
    height: 360,
    limit: 12,
  },
  waterfall: {
    roles: { step: 'string', order: 'number', kind: 'string', value: 'number' },
    width: 600,
    height: 360,
    limit: 16,
  },
  intervalTrend: {
    roles: { time: 'date', estimate: 'number', lower: 'number', upper: 'number' },
    width: 440,
    height: 360,
    limit: 240,
  },
  timeline: {
    roles: { entity: 'string', start: 'date', end: 'date' },
    width: 600,
    height: 400,
    limit: 20,
  },
  treemap: {
    roles: { nodeId: 'string', parentId: 'string', label: 'string', value: 'number' },
    width: 600,
    height: 400,
    limit: 61,
  },
  sankey: {
    roles: {
      sourceId: 'string',
      targetId: 'string',
      sourceStage: 'number',
      targetStage: 'number',
      value: 'number',
    },
    width: 640,
    height: 440,
    limit: 40,
  },
  choropleth: {
    roles: { regionId: 'string', value: 'number' },
    width: 600,
    height: 400,
    limit: 250,
  },
} as const;
export type VisualizationKind = keyof typeof visualizationDefinitions;
export const visualizationKinds = Object.keys(visualizationDefinitions) as VisualizationKind[];
export const VisualizationKindSchema = z.enum(visualizationKinds);
const field = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
export const VisualizationConfig = z.strictObject({
  fields: z.record(z.string(), field),
  mode: z.enum(['absolute', 'percent']).default('absolute'),
});
export type VisualizationConfig = z.infer<typeof VisualizationConfig>;
// These declarations belong to authorized tool results, never to model-authored panel props.
export const VisualizationSemantics = z.strictObject({
  kind: VisualizationKindSchema,
  grain: z.string().min(1).max(200),
  note: z.string().min(1).max(1000),
  method: z.string().min(1).max(200).optional(),
  included: z.number().int().nonnegative().optional(),
  missing: z.number().int().nonnegative().optional(),
  outside: z.number().int().nonnegative().optional(),
  completePartition: z.boolean().optional(),
  direction: z.enum(['higher', 'lower']).optional(),
  targetSource: z.string().min(1).max(200).optional(),
  beforeLabel: z.string().min(1).max(80).optional(),
  afterLabel: z.string().min(1).max(80).optional(),
  interval: z.string().min(1).max(200).optional(),
  calendar: z.literal('UTC Gregorian dates').optional(),
  geography: z.string().max(80).optional(),
  rateDefinition: z.string().min(1).max(200).optional(),
  domain: z.tuple([z.number().finite(), z.number().finite()]).optional(),
  conserved: z.boolean().optional(),
});
export type VisualizationSemantics = z.infer<typeof VisualizationSemantics>;
