import { z } from 'zod';
import type {
  ComponentRegistration,
  ControlRegistration,
  FoundationCatalog,
} from './foundation.ts';

const emptyProps = z.strictObject({});
export const componentDefinitions: ComponentRegistration[] = [
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
export function registerBuiltins(catalog: FoundationCatalog) {
  for (const component of componentDefinitions) catalog.registerComponent(component);
  for (const control of controlDefinitions) catalog.registerControl(control);
  return catalog;
}
