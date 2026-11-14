import type { Artifact, Dataset } from '../../packages/contracts/index.ts';
import { pieModel, percent } from '../../packages/ui-kit/pie-model.ts';
import type { Response } from '../../packages/agent-adapter/index.ts';
import { explanations } from './legacy-agent.ts';

const labels: Record<string, string> = {
  record_count: 'Source records',
  distinct_systems: 'Distinct systems',
  sla_mean: 'Unweighted mean of recorded SLA rates',
  sla_observations: 'SLA observations',
  missing_transfer_size: 'Missing transfer-team-size values',
};
function format(field: string, value: unknown) {
  if (value === null) return 'Unavailable';
  return field === 'sla_mean'
    ? `${(Number(value) * 100).toFixed(2)}%`
    : Number(value).toLocaleString('en-US');
}
export function facts(response: Extract<Response, { kind: 'facts' }>, data: Dataset) {
  if (response.toolId === 'csv.countByDomain')
    return (
      data.rows
        .map((r) => `${r.domain}: ${format('record_count', r.record_count)} source records`)
        .join('\n') || 'No source records match these filters.'
    );
  if (response.toolId === 'csv.records')
    return data.observationCount
      ? `${data.observationCount.toLocaleString('en-US')} source records match these filters.`
      : 'No source records match these filters.';
  return (
    response.fields
      .map((field) => `${labels[field]}: ${format(field, data.rows[0]?.[field])}`)
      .join('\n') +
    (response.fields.includes('sla_mean')
      ? `\nDenominator: ${data.observationCount.toLocaleString('en-US')} source records, unweighted.`
      : '')
  );
}
export const csvPresentation = {
  facts,
  visual(artifact: Artifact) {
    return artifact.plan.panels
      .map((panel) => {
        if (panel.component !== 'pie') return `${panel.title}.`;
        const state = artifact.datasets[panel.bindingId];
        if (state?.status !== 'ready') return `${panel.title}: data is not available.`;
        const model = pieModel(
          state.data.rows,
          panel.config.categoryField,
          panel.config.valueField,
          state.data.truncated,
        );
        if (!model.ok) return model.reason;
        const summary = model.slices
          .map(
            (slice) =>
              `${slice.label}: ${percent(slice.share)} (${slice.value.toLocaleString('en-US')})`,
          )
          .join('; ');
        return (
          `${panel.title} — ${model.total.toLocaleString('en-US')} total: ${summary}.` +
          (panel.config.valueField === 'record_count'
            ? ' Counts represent source records (CSV rows), not distinct source systems.'
            : '')
        );
      })
      .join('\n');
  },
  explain(reason: string) {
    if (!Object.hasOwn(explanations, reason)) throw new Error('UNKNOWN_EXPLANATION');
    return explanations[reason as keyof typeof explanations];
  },
};
