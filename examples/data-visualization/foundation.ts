import { z } from 'zod';
import type { DomainRegistration } from '../../packages/catalog/foundation.ts';
import type { FieldDefinition } from '../../packages/contracts/foundation.ts';
import {
  VisualizationSemantics,
  visualizationKinds,
} from '../../packages/contracts/visualization.ts';
import { VISUALIZATION_ANNOTATION } from '../../packages/contracts/visualization-v2.ts';
import { visualizationDataset } from './index.ts';

/** Explicitly synthetic connector demonstrating registrations; it does not expose business data. */
export function syntheticVisualizationDomain(): DomainRegistration {
  return {
    ref: { id: 'synthetic.visualizations', version: 1 },
    description: 'Synthetic chart examples, not connected business data',
    semantics: [
      'These values and the geography are fictional demonstrations. Use only when a synthetic chart example is requested.',
    ],
    tools: visualizationKinds.map((kind) => {
      const sample = visualizationDataset(kind);
      const metadata = VisualizationSemantics.parse(sample.visualization);
      const fields: FieldDefinition[] = sample.fields.map((field) => ({
        id: field.name,
        label: field.name,
        type: field.type,
        role: field.type === 'number' ? 'measure' : field.type === 'date' ? 'time' : 'dimension',
        nullable: field.nullable,
        ...(field.nullable ? { nullMeaning: 'No synthetic observation was supplied' } : {}),
        description: `Synthetic ${field.name}`,
        ...(field.type === 'number'
          ? {
              unit: field.unit ?? 'items',
              measure: {
                aggregation: 'Precomputed synthetic value',
                precision: 4,
                additive: false,
              },
            }
          : {}),
        ...(field.type === 'date'
          ? { temporal: { timezone: 'UTC', calendar: 'gregorian', grain: 'day' } }
          : {}),
      }));
      return {
        ref: { id: `synthetic.${kind}`, version: 1 },
        description: `Synthetic ${kind} example`,
        args: z.strictObject({}),
        fields,
        grain: metadata.grain,
        interactive: {},
        resultAnnotations: { [VISUALIZATION_ANNOTATION]: VisualizationSemantics },
        resultViews: [{ id: `ui.${kind}`, version: 1 }],
        execute: async (_args, _context, signal) => {
          signal.throwIfAborted();
          const dataset = visualizationDataset(kind);
          return {
            rows: dataset.rows,
            annotations: {
              [VISUALIZATION_ANNOTATION]: VisualizationSemantics.parse(dataset.visualization),
            },
            provenance: {
              sourceId: dataset.sourceId,
              sourceVersion: dataset.sourceHash,
              queryId: dataset.queryId,
              executedAt: dataset.asOf,
              grain: metadata.grain,
              truncated: dataset.truncated,
              nextCursor: dataset.nextCursor,
              warnings: dataset.warnings,
            },
          };
        },
      };
    }),
  };
}
