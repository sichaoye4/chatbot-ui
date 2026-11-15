import { geographyAssets } from './geography.ts';
import { dateValue } from './calendar.ts';
import {
  visualizationDefinitions,
  VisualizationSemantics,
  type VisualizationKind,
} from './visualization.ts';

export type VisualizationViewPanel = {
  component: VisualizationKind;
  title: string;
  config: { fields: Record<string, string>; mode: 'absolute' | 'percent' };
};
export type VisualizationViewData = {
  rows: Record<string, string | number | boolean | null>[];
  fields: { name: string; type: 'string' | 'number' | 'date'; nullable: boolean; unit?: string }[];
  visualization?: VisualizationSemantics;
  truncated: boolean;
};
type Row = VisualizationViewData['rows'][number];
type FieldMeta = VisualizationViewData['fields'][number];
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function validateVisualizationFields(panel: VisualizationViewPanel, fields: FieldMeta[]) {
  const roles = visualizationDefinitions[panel.component].roles;
  requireValue(
    Object.keys(panel.config.fields).length === Object.keys(roles).length,
    'Unexpected or missing roles',
  );
  for (const [role, type] of Object.entries(roles))
    requireValue(
      fields.some((f) => f.name === panel.config.fields[role] && f.type === type),
      `Invalid ${role} field`,
    );
  const numeric = Object.entries(roles).filter(
    ([role, type]) =>
      type === 'number' &&
      !['count', 'sampleCount', 'order', 'sourceStage', 'targetStage'].includes(role),
  );
  if (panel.component !== 'scatter' && numeric.length > 1) {
    const units = numeric.map(
      ([role]) => fields.find((f) => f.name === panel.config.fields[role])?.unit,
    );
    requireValue(
      !!units[0] && new Set(units).size === 1,
      'Measures must have matching declared units',
    );
  }
  requireValue(
    panel.component === 'stackedBar' || panel.config.mode === 'absolute',
    'Percent mode only supports stacked bars',
  );
}
export function visualizationRows(
  panel: VisualizationViewPanel,
  data: VisualizationViewData,
): Row[] {
  return data.rows.map((row) =>
    Object.fromEntries(
      Object.entries(panel.config.fields).map(([role, field]) => [role, row[field]]),
    ),
  );
}
export function validateVisualizationData(
  panel: VisualizationViewPanel,
  data: VisualizationViewData,
) {
  validateVisualizationFields(panel, data.fields);
  const meta = VisualizationSemantics.parse(data.visualization);
  const kind = panel.component;
  requireValue(
    meta.kind === kind && !data.truncated,
    'Complete result and matching semantics required',
  );
  const rows = visualizationRows(panel, data);
  requireValue(rows.length <= visualizationDefinitions[kind].limit, 'Chart density limit exceeded');
  if (!rows.length) return;
  for (const r of rows)
    for (const [role, type] of Object.entries(visualizationDefinitions[kind].roles)) {
      const value = r[role];
      if (
        kind === 'intervalTrend' &&
        ['estimate', 'lower', 'upper'].includes(role) &&
        value === null
      )
        continue;
      if (kind === 'choropleth' && role === 'value' && value === null) continue;
      if (type === 'number')
        requireValue(typeof value === 'number' && Number.isFinite(value), `Invalid ${role}`);
      else if (type === 'date') dateValue(value);
      else
        requireValue(
          typeof value === 'string' &&
            value.length <= 160 &&
            (value.length > 0 || role === 'parentId'),
          `Invalid ${role}`,
        );
    }
  const unique = (...keys: string[]) =>
    requireValue(
      new Set(rows.map((r) => JSON.stringify(keys.map((k) => r[k])))).size === rows.length,
      'Duplicate coordinates or identifiers',
    );
  const n = (r: Row, key: string) => Number(r[key]);
  const nonnegative = (...keys: string[]) =>
    rows.forEach((r) => keys.forEach((k) => requireValue(n(r, k) >= 0, `Negative ${k}`)));
  const integer = (...keys: string[]) =>
    rows.forEach((r) =>
      keys.forEach((k) => requireValue(Number.isSafeInteger(r[k]), `Noninteger ${k}`)),
    );
  const close = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
  if (kind === 'histogram') {
    requireValue(
      meta.method &&
        meta.included !== undefined &&
        meta.missing !== undefined &&
        meta.outside !== undefined,
      'Bin policy and observation accounting required',
    );
    nonnegative('count');
    integer('count');
    const width = n(rows[0], 'binEnd') - n(rows[0], 'binStart');
    requireValue(
      width > 0 &&
        rows.every(
          (r, i) =>
            close(n(r, 'binEnd') - n(r, 'binStart'), width) &&
            (!i || close(n(rows[i - 1], 'binEnd'), n(r, 'binStart'))),
        ),
      'Bins must be contiguous, ordered and equal width',
    );
    requireValue(
      rows.reduce((s, r) => s + n(r, 'count'), 0) === meta.included,
      'Counts do not reconcile',
    );
  } else if (kind === 'boxPlot') {
    unique('category');
    requireValue(meta.method, 'Quantile and whisker methods required');
    integer('sampleCount');
    rows.forEach((r) => {
      const values = ['lowWhisker', 'q1', 'median', 'q3', 'highWhisker'].map((k) => n(r, k));
      requireValue(
        n(r, 'sampleCount') > 0 && values.every((v, i) => !i || v >= values[i - 1]),
        'Invalid quartiles or sample count',
      );
    });
  } else if (kind === 'scatter') {
    unique('recordId');
    requireValue(
      meta.missing !== undefined && meta.method,
      'Missing-pair and sampling policy required',
    );
  } else if (kind === 'heatmap' || kind === 'choropleth') {
    requireValue(meta.domain && meta.domain[0] < meta.domain[1], 'Fixed color domain required');
    requireValue(
      rows.every(
        (r) =>
          r.value === null ||
          (n(r, 'value') >= meta.domain![0] && n(r, 'value') <= meta.domain![1]),
      ),
      'Value outside color domain',
    );
    if (kind === 'heatmap') {
      unique('row', 'column');
      requireValue(
        new Set(rows.map((r) => r.row)).size <= 20 && new Set(rows.map((r) => r.column)).size <= 24,
        'Matrix too dense',
      );
    } else {
      unique('regionId');
      const asset = geographyAssets[meta.geography ?? ''];
      requireValue(asset && meta.rateDefinition, 'Approved geometry and rate definition required');
      requireValue(
        rows.every((r) => String(r.regionId) in asset.regions),
        'Unmatched region ID',
      );
    }
  } else if (kind === 'bullet') {
    unique('category');
    requireValue(meta.direction && meta.targetSource, 'Target source and direction required');
  } else if (kind === 'groupedBar' || kind === 'stackedBar') {
    unique('category', 'series');
    const categories = new Set(rows.map((r) => r.category)),
      series = new Set(rows.map((r) => r.series));
    requireValue(
      categories.size <= 12 && series.size >= 2 && series.size <= (kind === 'groupedBar' ? 4 : 6),
      'Too many categories or series',
    );
    requireValue(
      rows.length === categories.size * series.size,
      'Every category-series pair must be explicit',
    );
    if (kind === 'stackedBar') {
      nonnegative('value');
      requireValue(meta.completePartition, 'Complete disjoint partitions required');
      if (panel.config.mode === 'percent')
        for (const c of categories)
          requireValue(
            rows.filter((r) => r.category === c).reduce((s, r) => s + n(r, 'value'), 0) > 0,
            'Zero denominator',
          );
    }
  } else if (kind === 'dumbbell') {
    unique('category');
    requireValue(meta.beforeLabel && meta.afterLabel, 'Endpoint labels required');
  } else if (kind === 'waterfall') {
    unique('order');
    requireValue(
      rows[0].kind === 'opening' && rows.at(-1)!.kind === 'closing',
      'Opening and closing required',
    );
    let total = n(rows[0], 'value');
    rows.forEach((r, i) => {
      requireValue(!i || n(r, 'order') > n(rows[i - 1], 'order'), 'Steps must be ordered');
      if (!i) return;
      if (r.kind === 'delta') total += n(r, 'value');
      else {
        requireValue(
          ['subtotal', 'closing'].includes(String(r.kind)) && close(n(r, 'value'), total),
          'Unreconciled waterfall',
        );
        requireValue(r.kind !== 'closing' || i === rows.length - 1, 'Closing must be last');
      }
    });
  } else if (kind === 'intervalTrend') {
    unique('time');
    requireValue(
      meta.interval && meta.method && meta.calendar,
      'Interval and calendar semantics required',
    );
    rows.forEach((r, i) => {
      requireValue(!i || dateValue(r.time) > dateValue(rows[i - 1].time), 'Dates must be ordered');
      if (r.estimate !== null && r.lower !== null && r.upper !== null)
        requireValue(
          n(r, 'lower') <= n(r, 'estimate') && n(r, 'estimate') <= n(r, 'upper'),
          'Reversed bounds',
        );
    });
  } else if (kind === 'timeline') {
    requireValue(meta.calendar, 'Calendar required');
    unique('entity');
    rows.forEach((r) => requireValue(dateValue(r.start) <= dateValue(r.end), 'Reversed interval'));
  } else if (kind === 'treemap') {
    unique('nodeId');
    nonnegative('value');
    const ids = new Map(rows.map((r) => [r.nodeId, r]));
    requireValue(rows.filter((r) => r.parentId === '').length === 1, 'Single root required');
    let leaves = 0;
    rows.forEach((r) => {
      const seen = new Set();
      let node: Row | undefined = r;
      while (node?.parentId !== '') {
        requireValue(node && !seen.has(node.nodeId), 'Missing parent or cycle');
        seen.add(node.nodeId);
        node = ids.get(node.parentId);
      }
      requireValue(seen.size <= 3, 'Hierarchy too deep');
      const children = rows.filter((c) => c.parentId === r.nodeId);
      if (children.length)
        requireValue(
          close(
            n(r, 'value'),
            children.reduce((s, c) => s + n(c, 'value'), 0),
          ),
          'Parent totals must equal children',
        );
      else leaves++;
    });
    requireValue(
      leaves <= 40 &&
        n(
          rows.find((r) => r.parentId === '')!,
          'value',
        ) > 0,
      'Invalid leaf count or root total',
    );
    requireValue(meta.method, 'Leaf aggregation rule required');
  } else if (kind === 'sankey') {
    unique('sourceId', 'targetId');
    nonnegative('value', 'sourceStage', 'targetStage');
    integer('sourceStage', 'targetStage');
    const stages = new Map<string, number>(),
      incoming = new Map<string, number>(),
      outgoing = new Map<string, number>();
    rows.forEach((r) => {
      requireValue(n(r, 'sourceStage') < n(r, 'targetStage'), 'Sankey links must go forward');
      for (const side of ['source', 'target']) {
        const id = String(r[`${side}Id`]),
          stage = n(r, `${side}Stage`);
        requireValue(!stages.has(id) || stages.get(id) === stage, 'Inconsistent node stages');
        stages.set(id, stage);
      }
      incoming.set(String(r.targetId), (incoming.get(String(r.targetId)) ?? 0) + n(r, 'value'));
      outgoing.set(String(r.sourceId), (outgoing.get(String(r.sourceId)) ?? 0) + n(r, 'value'));
    });
    requireValue(stages.size <= 20, 'Too many nodes');
    if (meta.conserved)
      for (const id of stages.keys())
        if (incoming.has(id) && outgoing.has(id))
          requireValue(
            close(incoming.get(id)!, outgoing.get(id)!),
            'Unconserved intermediate flow',
          );
  }
}
