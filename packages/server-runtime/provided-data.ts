import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DatasetSchema, Field, type Dataset } from '../contracts/index.ts';
import { visualizationDefinitions, VisualizationSemantics } from '../contracts/visualization.ts';
import type { Tool } from '../catalog/index.ts';

/** A bounded data snapshot authored by the model from the user's content, not a text parser. */
export const ProvidedData = z
  .strictObject({
    rows: DatasetSchema.shape.rows,
    fields: DatasetSchema.shape.fields,
    origin: z.enum(['user-provided', 'generated-example']),
    notes: z.array(z.string().max(1000)).max(10),
    visualization: VisualizationSemantics.optional(),
    partitions: z
      .array(z.strictObject({ categoryField: Field, valueField: Field }))
      .max(10)
      .optional(),
  })
  .superRefine((data, ctx) => {
    const names = data.fields.map((f) => f.name);
    if (new Set(names).size !== names.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate fields' });
    for (const row of data.rows) {
      if (Object.keys(row).some((key) => !names.includes(key)))
        ctx.addIssue({ code: 'custom', message: 'Undeclared row field' });
      for (const field of data.fields) {
        const value = row[field.name];
        const valid =
          value === null
            ? field.nullable
            : field.type === 'number'
              ? typeof value === 'number' && Number.isFinite(value)
              : typeof value === 'string' &&
                (field.type !== 'date' || /^\d{4}-\d{2}-\d{2}$/.test(value));
        if (!valid) ctx.addIssue({ code: 'custom', message: `Invalid value for ${field.name}` });
      }
    }
  });

export function providedDataTool(): Tool {
  return {
    id: 'provided.data',
    description:
      'Materialize data you extract from the current user message, or an explicitly requested generated example. Supply rows and field metadata directly in binding args. No required input prose format. Choose any compatible registered component. Preserve supplied facts; use null for unknown progress, and explain date-window assumptions in notes. Never substitute demo rows. Do not need to call this tool before present_response: final bindings are validated and executed by the host.',
    args: ProvidedData,
    fields: [],
    aggregate: true,
    projectViews: ['gantt', 'flowchart', 'burndown', 'cumulativeFlow'],
    visualizationViews: Object.keys(visualizationDefinitions) as Tool['visualizationViews'],
    describeArgs(input) {
      const data = ProvidedData.parse(input);
      return { fields: data.fields, partitions: data.partitions ?? [] };
    },
    execute(input): Dataset {
      const data = ProvidedData.parse(input);
      return {
        rows: data.rows,
        fields: data.fields,
        ...(data.visualization ? { visualization: data.visualization } : {}),
        sourceId:
          data.origin === 'user-provided' ? 'user-provided-content' : 'model-generated-example',
        sourceHash: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
        queryVersion: '1',
        queryId: 'provided-data',
        args: input,
        observationCount: data.rows.length,
        asOf: 'Response snapshot',
        truncated: false,
        nextCursor: null,
        warnings: [
          data.origin === 'user-provided'
            ? 'Model-structured from your supplied content; review extracted values.'
            : 'Generated example requested by the user; not measured business data.',
          ...data.notes,
        ],
      };
    },
  };
}
