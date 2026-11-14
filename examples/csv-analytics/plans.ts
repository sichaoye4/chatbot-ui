import type { Plan, Panel, Filters } from '../../packages/contracts/index.ts';

export function csvPlan(
  kind: 'trend' | 'comparison' | 'pie' | 'two' | 'overview' | 'table',
  args: Filters = {},
  previous?: Plan,
  interactiveFields: Array<'domain' | 'country' | 'system' | 'month'> = [],
): Plan {
  const panels: Panel[] = [];
  const bindings: Plan['bindings'] = [];
  const add = (id: string, toolId: string, panel: Panel) => {
    if (!bindings.some((b) => b.id === id))
      bindings.push({
        id,
        toolId,
        args: { ...args },
        filterMap: Object.fromEntries(interactiveFields.map((f) => [f, f])),
      });
    panels.push(panel);
  };
  const common = { componentVersion: 1 as const, importance: 'supporting' as const };
  if (['trend', 'two', 'overview'].includes(kind))
    add('monthly', 'csv.monthlySla', {
      ...common,
      id: 'monthly-sla',
      component: 'trend',
      importance: 'primary',
      title: 'Monthly unweighted mean of recorded SLA rates',
      bindingId: 'monthly',
      config: { xField: 'month', yField: 'sla_mean' },
    });
  if (['comparison', 'pie', 'two', 'overview'].includes(kind))
    add('domains', 'csv.countByDomain', {
      ...common,
      id: 'domain-counts',
      component: kind === 'pie' ? 'pie' : 'comparison',
      title: kind === 'pie' ? 'Share of source records by domain' : 'Source records by domain',
      bindingId: 'domains',
      config: { categoryField: 'domain', valueField: 'record_count' },
    });
  if (kind === 'overview')
    for (const [id, title, format] of [
      ['record_count', 'Source records', 'integer'],
      ['distinct_systems', 'Distinct systems', 'integer'],
      ['sla_mean', 'Unweighted mean of recorded SLA rates', 'percent'],
    ] as const)
      add('summary', 'csv.summary', {
        ...common,
        id,
        component: 'metric',
        title,
        bindingId: 'summary',
        config: { valueField: id, format },
      });
  if (kind === 'overview' || kind === 'table')
    add('records', 'csv.records', {
      ...common,
      id: 'source-records',
      component: 'table',
      title: 'Underlying source records',
      bindingId: 'records',
      config: { columns: ['domain', 'system', 'ctry_iso_cde', 'month_id', 'sla_met_rate'] },
    });
  if (previous) {
    for (const panel of panels) {
      const old = previous.panels.find(
        (p) =>
          p.component === panel.component &&
          JSON.stringify(p.config) === JSON.stringify(panel.config),
      );
      if (old) panel.id = old.id;
    }
  }
  return {
    schemaVersion: 1,
    title: 'CSV operations analysis',
    layoutIntent: kind === 'overview' ? 'overview' : 'auto',
    panels,
    bindings,
    filters: interactiveFields.map((id) => ({
      id,
      type: 'select',
      label: id[0].toUpperCase() + id.slice(1),
      optionsSource: `csv.${id}`,
      defaultValue: args[id] ?? null,
    })),
    dataMode: 'snapshot',
  };
}
export function addRecords(previous: Plan): Plan {
  const args = previous.bindings[0].args as Filters;
  const table = csvPlan(
    'table',
    args,
    undefined,
    previous.filters.map((f) => f.id as 'domain' | 'country' | 'system' | 'month'),
  );
  return {
    ...previous,
    panels: [...previous.panels, ...table.panels],
    bindings: [...previous.bindings, ...table.bindings],
  };
}

export function qualityPlan(
  args: Filters,
  fields: string[] = ['avg_comp_mean', 'data_ctrl_score_mean', 'sla_mean'],
  interactiveFields: Array<'domain' | 'country' | 'system' | 'month'> = [],
): Plan {
  const plan = csvPlan('trend', args, undefined, interactiveFields);
  plan.title = 'Data quality trends';
  plan.bindings[0].toolId = 'csv.monthlyQuality';
  const labels: Record<string, string> = {
    avg_comp_mean: 'Mean recorded avg_comp',
    data_ctrl_score_mean: 'Mean recorded data_ctrl_score',
    sla_mean: 'Unweighted mean of recorded SLA rates',
  };
  plan.panels = fields.map((field) => ({
    id: `trend-${field}`,
    component: 'trend',
    componentVersion: 1,
    title: labels[field],
    bindingId: 'monthly',
    importance: 'primary',
    config: { xField: 'month', yField: field },
  }));
  return plan;
}
