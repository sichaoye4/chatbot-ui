import { z } from 'zod';
import type { DataResult, Element, FieldDefinition } from './foundation.ts';
import { VisualizationKindSchema, VisualizationSemantics } from './visualization.ts';
import {
  validateVisualizationData,
  type VisualizationViewData,
  type VisualizationViewPanel,
} from './visualization-validation.ts';

/** Versioned connector metadata understood by the built-in visualization components. */
export const VISUALIZATION_ANNOTATION = 'ui.visualizationSemantics';
export function visualizationV2Model(
  element: Element,
  result: DataResult,
  fields: FieldDefinition[],
) {
  if (!element.component.id.startsWith('ui.') || element.component.version !== 1)
    throw new Error('Unsupported visualization');
  const component = VisualizationKindSchema.parse(element.component.id.slice(3));
  const refs = Object.values(element.roles).flat();
  if (
    new Set(refs.map((ref) => ref.bindingId)).size !== 1 ||
    Object.values(element.roles).some((items) => items.length !== 1)
  )
    throw new Error('Expected one source and one field per role');
  const metadata = VisualizationSemantics.parse(result.annotations?.[VISUALIZATION_ANNOTATION]);
  if (metadata.grain !== result.provenance.grain) throw new Error('Annotation grain mismatch');
  const mode =
    component === 'stackedBar'
      ? z.enum(['absolute', 'percent']).parse(element.props.mode)
      : 'absolute';
  const panel: VisualizationViewPanel = {
    component,
    title: element.title,
    config: {
      fields: Object.fromEntries(
        Object.entries(element.roles).map(([name, items]) => [name, items[0].fieldId]),
      ),
      mode,
    },
  };
  const data: VisualizationViewData = {
    rows: result.rows,
    fields: fields.map((field) => ({
      name: field.id,
      type: field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'string',
      nullable: field.nullable,
      unit: field.unit,
    })),
    visualization: metadata,
    truncated: result.provenance.truncated || result.provenance.nextCursor !== null,
  };
  validateVisualizationData(panel, data);
  return { panel, data };
}
