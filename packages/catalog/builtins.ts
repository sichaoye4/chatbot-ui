import { visualizationDefinitions } from '../contracts/visualization.ts';
import { VISUALIZATION_ANNOTATION, visualizationV2Model } from '../contracts/visualization-v2.ts';
import { pieModel } from '../contracts/pie-data.ts';
import { projectV2Model } from '../contracts/project-v2.ts';
import { z } from 'zod';
import { InputValue, LocalId } from '../contracts/foundation.ts';
import type {
  ActionRegistration,
  ComponentRegistration,
  ControlRegistration,
  FoundationCatalog,
} from './foundation.ts';

const emptyProps = z.strictObject({});
const validateProjectResult: NonNullable<ComponentRegistration['validateResult']> = (
  element,
  datasets,
  fields,
) => {
  const binding = Object.values(element.roles).flat()[0].bindingId;
  projectV2Model(element, datasets[binding], fields[binding]);
};
export const componentDefinitions: ComponentRegistration[] = [
  ...Object.entries(visualizationDefinitions).map(([kind, d]): ComponentRegistration => ({
    ref: { id: `ui.${kind}`, version: 1 },
    description: `${kind} with trusted tool-supplied semantics and bounded density`,
    guidance: {
      useWhen: 'A complete authorized result supplies every role and the documented semantics',
      avoidWhen: 'Missing semantics, incompatible units or truncated results',
      alternatives: ['ui.table'],
    },
    props:
      kind === 'stackedBar'
        ? z.strictObject({ mode: z.enum(['absolute', 'percent']) })
        : emptyProps,
    singleBinding: true,
    requiredAnnotations: [VISUALIZATION_ANNOTATION],
    validateResult: (element, datasets, fields) => {
      const binding = Object.values(element.roles).flat()[0].bindingId;
      visualizationV2Model(element, datasets[binding], fields[binding]);
    },
    layout: { minWidth: d.width, minHeight: d.height },
    roles: Object.fromEntries(
      Object.entries(d.roles).map(([role, type]) => [role, { types: [type], min: 1, max: 1 }]),
    ),
    validate: (_element, fields) => {
      const measured = Object.entries(d.roles).filter(
        ([role, type]) =>
          type === 'number' &&
          !['count', 'sampleCount', 'order', 'sourceStage', 'targetStage'].includes(role),
      );
      const units = measured.map(([role]) => fields[role][0].unit);
      return kind !== 'scatter' && measured.length > 1 && (!units[0] || new Set(units).size !== 1)
        ? ['Measures require matching units and grain']
        : [];
    },
  })),
  {
    ref: { id: 'ui.gantt', version: 1 },
    validateResult: validateProjectResult,
    description: 'Project tasks, milestones, progress and finish-to-start dependencies',
    guidance: {
      useWhen: 'A tool provides complete dated tasks and explicit dependencies',
      avoidWhen: 'Missing schedules, dependency cycles or inferred completion',
      alternatives: ['ui.table'],
    },
    props: emptyProps,
    singleBinding: true,
    layout: { minWidth: 600, minHeight: 400 },
    roles: {
      taskId: { types: ['string'], roles: ['identifier'], min: 1, max: 1 },
      label: { types: ['string'], min: 1, max: 1 },
      start: { types: ['date'], roles: ['time'], min: 1, max: 1 },
      end: { types: ['date'], roles: ['time'], min: 1, max: 1 },
      progress: { types: ['number'], roles: ['measure'], min: 1, max: 1 },
      dependencies: { types: ['string'], min: 1, max: 1 },
      kind: { types: ['string'], min: 1, max: 1 },
    },
    validate: (_e, fields) =>
      fields.progress[0].unit === 'ratio' ? [] : ['Progress must be a ratio'],
  },
  {
    ref: { id: 'ui.flowchart', version: 1 },
    validateResult: validateProjectResult,
    description: 'Typed process nodes and directed edges, including decisions and feedback loops',
    guidance: {
      useWhen: 'An authorized tool supplies explicit process nodes and edges',
      avoidWhen: 'Only quantities or unstructured prose are available',
      alternatives: ['ui.table'],
    },
    props: z.strictObject({ direction: z.enum(['LR', 'TB']) }),
    singleBinding: true,
    layout: { minWidth: 600, minHeight: 400 },
    roles: {
      id: { types: ['string'], roles: ['identifier'], min: 1, max: 1 },
      label: { types: ['string'], min: 1, max: 1 },
      kind: { types: ['string'], min: 1, max: 1 },
      source: { types: ['string'], roles: ['source'], min: 1, max: 1 },
      target: { types: ['string'], roles: ['target'], min: 1, max: 1 },
    },
  },
  {
    ref: { id: 'ui.burndown', version: 1 },
    validateResult: validateProjectResult,
    description: 'Remaining work against supplied ideal, or completed work against scope',
    guidance: {
      useWhen: 'Dated work observations have a trusted ideal or scope series',
      avoidWhen: 'Units differ or a reference would have to be invented',
      alternatives: ['ui.trend', 'ui.table'],
    },
    props: z.strictObject({ mode: z.enum(['burndown', 'burnup']) }),
    singleBinding: true,
    layout: { minWidth: 400, minHeight: 320 },
    roles: {
      time: { types: ['date'], roles: ['time'], min: 1, max: 1 },
      actual: { types: ['number'], roles: ['measure'], min: 1, max: 1 },
      reference: { types: ['number'], roles: ['measure'], min: 1, max: 1 },
    },
    validate: (_e, fields) =>
      fields.actual[0].unit === fields.reference[0].unit
        ? []
        : ['Actual and reference units must match'],
  },
  {
    ref: { id: 'ui.cumulativeFlow', version: 1 },
    validateResult: validateProjectResult,
    description: 'Complete mutually exclusive workflow-state counts by date',
    guidance: {
      useWhen: 'A tool supplies complete state snapshots; each item occupies exactly one state',
      avoidWhen: 'Overlapping states, missing counts or incompatible units',
      alternatives: ['ui.trend', 'ui.table'],
    },
    props: emptyProps,
    singleBinding: true,
    layout: { minWidth: 440, minHeight: 360 },
    roles: {
      time: { types: ['date'], roles: ['time'], min: 1, max: 1 },
      stages: {
        types: ['number'],
        roles: ['measure'],
        min: 2,
        max: 6,
        sameUnit: true,
        sameGrain: true,
      },
    },
  },
  {
    ref: { id: 'ui.metric', version: 1 },
    description: 'One aggregate value',
    guidance: {
      useWhen: 'A single result needs emphasis',
      avoidWhen: 'A series or many records need comparison',
      alternatives: ['ui.table', 'text'],
    },
    props: emptyProps,
    singleBinding: true,
    layout: { minWidth: 220, minHeight: 144 },
    roles: { value: { types: ['number'], roles: ['measure'], min: 1, max: 1 } },
  },
  {
    ref: { id: 'ui.trend', version: 1 },
    description: 'Observed values over time',
    guidance: {
      useWhen: 'Show temporal change at the declared grain',
      avoidWhen: 'No temporal dimension or incompatible units on one axis',
      alternatives: ['ui.comparison', 'ui.table'],
    },
    props: emptyProps,
    singleBinding: true,
    layout: { minWidth: 380, minHeight: 320 },
    roles: {
      time: { types: ['date', 'datetime'], roles: ['time'], min: 1, max: 1 },
      values: {
        types: ['number'],
        roles: ['measure'],
        min: 1,
        max: 6,
        sameUnit: true,
        sameGrain: true,
      },
    },
  },
  {
    ref: { id: 'ui.comparison', version: 1 },
    description: 'Compare categories',
    guidance: {
      useWhen: 'Compare one measure across a bounded set of categories',
      avoidWhen: 'A continuous time trend or incompatible grains',
      alternatives: ['ui.trend', 'ui.table'],
    },
    props: emptyProps,
    singleBinding: true,
    layout: { minWidth: 360, minHeight: 320 },
    roles: {
      category: { types: ['string', 'boolean'], roles: ['dimension'], min: 1, max: 1 },
      value: { types: ['number'], roles: ['measure'], min: 1, max: 1 },
    },
  },
  {
    ref: { id: 'ui.pie', version: 1 },
    description: 'Category shares of a complete whole, as percentages',
    guidance: {
      useWhen:
        'The user requests a pie chart or part-to-whole shares across a small mutually exclusive category partition',
      avoidWhen:
        'Overlapping categories, negative/missing values, zero totals, truncated results, or more than twelve categories',
      alternatives: ['ui.comparison', 'ui.table'],
    },
    props: emptyProps,
    singleBinding: true,
    partitionRoles: { category: 'category', value: 'value' },
    validateResult: (element, datasets) => {
      const category = element.roles.category[0];
      const value = element.roles.value[0];
      const data = datasets[category.bindingId];
      if (!data.rows.length) return;
      const model = pieModel(
        data.rows,
        category.fieldId,
        value.fieldId,
        data.provenance.truncated || data.provenance.nextCursor !== null,
      );
      if (!model.ok) throw new Error('Invalid partition');
    },
    layout: { minWidth: 320, minHeight: 360 },
    roles: {
      category: { types: ['string'], roles: ['dimension'], min: 1, max: 1 },
      value: { types: ['number'], roles: ['measure'], min: 1, max: 1 },
    },
  },
  {
    ref: { id: 'ui.table', version: 1 },
    description: 'Exact result values',
    guidance: {
      useWhen: 'Inspect precise records or heterogeneous columns',
      avoidWhen: 'A large table obscures a simple single fact',
      alternatives: ['text', 'ui.metric'],
    },
    props: emptyProps,
    singleBinding: true,
    layout: { minWidth: 580, minHeight: 360 },
    roles: {
      columns: { types: ['string', 'number', 'boolean', 'date', 'datetime'], min: 1, max: 25 },
    },
  },
];
export const controlDefinitions: ControlRegistration[] = [
  {
    ref: { id: 'ui.select', version: 1 },
    description: 'Choose one permitted value; null means all permitted values',
    guidance: {
      useWhen: 'Explore one discrete dimension',
      avoidWhen: 'The question fixes this dimension without requesting scope changes',
      alternatives: ['ui.multiSelect'],
    },
    value: z.string().max(160).nullable(),
  },
  {
    ref: { id: 'ui.multiSelect', version: 1 },
    description: 'Choose a nonempty set of permitted values; null means all permitted values',
    guidance: {
      useWhen: 'Compare a selected subset',
      avoidWhen: 'Only one value is meaningful',
      alternatives: ['ui.select'],
    },
    value: z
      .array(z.string().max(160))
      .min(1)
      .max(100)
      .refine((v) => new Set(v).size === v.length)
      .nullable(),
  },
  {
    ref: { id: 'ui.dateRange', version: 1 },
    description: 'Inclusive start and end dates in declared dataset calendar',
    guidance: {
      useWhen: 'Explore a time window',
      avoidWhen: 'The source exposes no compatible temporal predicate',
      alternatives: [],
    },
    value: z
      .tuple([z.iso.date(), z.iso.date()])
      .refine(([start, end]) => start <= end, 'Reversed date range'),
  },
];
export const actionDefinitions: ActionRegistration[] = [
  {
    ref: { id: 'ui.setControl', version: 1 },
    description: 'Update an answer control or fork a scope-changing control into a new revision',
    payload: z.strictObject({
      controlId: LocalId,
      value: InputValue,
      newMessageId: LocalId.optional(),
      userMessageId: LocalId.optional(),
    }),
    sideEffects: 'revision',
  },
  {
    ref: { id: 'ui.retryBinding', version: 1 },
    description: 'Retry a failed data binding without disturbing successful siblings',
    payload: z.strictObject({ bindingId: LocalId }),
    sideEffects: 'read-only-query',
  },
  {
    ref: { id: 'ui.sort', version: 1 },
    description: 'Sort a binding result by a permitted field and invalidate incompatible cursors',
    payload: z.strictObject({
      bindingId: LocalId,
      fieldId: LocalId,
      direction: z.enum(['asc', 'desc']),
    }),
    sideEffects: 'read-only-query',
    eligible: (plan, principal, catalog) =>
      plan.bindings.some((binding) => {
        try {
          return !!catalog.tool(binding.tool, principal).sorting;
        } catch {
          return false;
        }
      }),
  },
  {
    ref: { id: 'ui.paginate', version: 1 },
    description: 'Request another authorized page cursor for a paginated binding',
    payload: z.strictObject({
      bindingId: LocalId,
      cursor: z.string().max(2048).nullable(),
    }),
    sideEffects: 'read-only-query',
    eligible: (plan, principal, catalog) =>
      plan.bindings.some((binding) => {
        try {
          return !!catalog.tool(binding.tool, principal).pagination;
        } catch {
          return false;
        }
      }),
  },
  {
    ref: { id: 'ui.refresh', version: 1 },
    description: 'Refresh one or all refreshable bindings within current authorized scope',
    payload: z.strictObject({ bindingId: LocalId.optional() }),
    sideEffects: 'read-only-query',
    eligible: (plan, principal, catalog) =>
      plan.bindings.some((binding) => {
        try {
          return catalog.tool(binding.tool, principal).refreshable === true;
        } catch {
          return false;
        }
      }),
  },
];
export function registerBuiltins(catalog: FoundationCatalog) {
  for (const component of componentDefinitions) catalog.registerComponent(component);
  for (const control of controlDefinitions) catalog.registerControl(control);
  for (const action of actionDefinitions) catalog.registerAction(action);
  return catalog;
}
