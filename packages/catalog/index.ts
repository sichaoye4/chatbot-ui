import { visualizationDefinitions, type VisualizationKind } from '../contracts/visualization.ts';
import {
  isVisualizationPanel,
  validateVisualizationFields,
} from '../contracts/visualization-model.ts';
import { z } from 'zod';
import { AppError, Plan, type FieldMeta, type Dataset } from '../contracts/index.ts';

export type Principal = {
  id: string;
  tenant: string;
  domains: string[];
  policyEpoch: number;
  revoked?: boolean;
};
export type Tool = {
  id: string;
  description: string;
  args: z.ZodType;
  fields: FieldMeta[];
  execute: (args: Record<string, unknown>, principal: Principal) => Dataset;
  visualizationViews?: VisualizationKind[];
  aggregate?: boolean;
  partitions?: { categoryField: string; valueField: string }[];
  projectViews?: ('gantt' | 'flowchart' | 'burndown' | 'cumulativeFlow')[];
};
export const components = {
  ...(Object.fromEntries(
    Object.entries(visualizationDefinitions).map(([key, d]) => [
      key,
      {
        minWidth: d.width,
        minHeight: d.height,
        description: `Validated ${key}; requires trusted visualization semantics and complete mapped roles.`,
      },
    ]),
  ) as Record<VisualizationKind, { minWidth: number; minHeight: number; description: string }>),
  gantt: {
    minWidth: 600,
    minHeight: 400,
    description:
      'Project schedule: dated tasks, milestones, progress ratios and finish-to-start dependencies. Complete task data required.',
  },
  flowchart: {
    minWidth: 600,
    minHeight: 400,
    description:
      'Process nodes and labeled directed edges, decisions, branches and loops. Explicit node/edge rows required.',
  },
  burndown: {
    minWidth: 400,
    minHeight: 320,
    description:
      'Dated remaining work against supplied ideal, or completed work against scope in burnup mode. Matching units required.',
  },
  cumulativeFlow: {
    minWidth: 440,
    minHeight: 360,
    description:
      'Stacked counts of mutually exclusive workflow states by date. Complete state snapshots required.',
  },
  metric: { minWidth: 220, minHeight: 144, description: 'One registered aggregate value' },
  trend: {
    minWidth: 380,
    minHeight: 320,
    description: 'Temporal change; never fill absent observations with zero',
  },
  comparison: { minWidth: 360, minHeight: 320, description: 'Bounded categorical comparison' },
  pie: {
    minWidth: 320,
    minHeight: 360,
    description:
      'Part-to-whole percentages of a complete, nonnegative, mutually exclusive category partition. Honor an explicit pie-chart request; never substitute a bar chart silently.',
  },
  table: {
    minWidth: 580,
    minHeight: 360,
    description: 'Precise authorized records with pagination',
  },
  relationship: {
    minWidth: 600,
    minHeight: 400,
    description: 'Actual entity relationships, bounded to 100 nodes and 200 edges',
  },
} as const;

export class Catalog {
  readonly version = '1';
  constructor(public tools: Tool[]) {}
  permitted(principal: Principal) {
    return principal.revoked || principal.domains.length === 0 ? [] : this.tools;
  }
  tool(id: string, principal: Principal) {
    const tool = this.permitted(principal).find((t) => t.id === id);
    if (!tool) throw new AppError('DATA_FORBIDDEN', 403);
    return tool;
  }
  validate(candidate: unknown, principal: Principal) {
    const plan = Plan.parse(candidate);
    for (const filter of plan.filters)
      if (!plan.bindings.some((b) => filter.id in b.filterMap)) throw new AppError('PLAN_INVALID');
    for (const binding of plan.bindings) {
      const tool = this.tool(binding.toolId, principal);
      tool.args.parse(binding.args);
      for (const [filter, arg] of Object.entries(binding.filterMap)) {
        const def = plan.filters.find((f) => f.id === filter)!;
        if (
          def.optionsSource !== `csv.${arg}` ||
          def.id !== arg ||
          !['domain', 'system', 'country', 'month'].includes(arg)
        )
          throw new AppError('PLAN_INVALID');
        // Filters can only override declared query arguments, never identity.
        tool.args.parse({ ...binding.args, [arg]: def.defaultValue });
      }
      for (const panel of plan.panels.filter((p) => p.bindingId === binding.id)) {
        if (
          ['gantt', 'flowchart', 'burndown', 'cumulativeFlow'].includes(panel.component) &&
          !tool.projectViews?.some((view) => view === panel.component)
        )
          throw new AppError('PROJECT_SEMANTICS_REQUIRED');
        const field = (name: string, type?: string) => {
          const meta = tool.fields.find((f) => f.name === name);
          if (!meta || (type && meta.type !== type)) throw new AppError('PLAN_INVALID');
          return meta;
        };
        if (isVisualizationPanel(panel)) {
          if (!tool.visualizationViews?.includes(panel.component))
            throw new AppError('VISUALIZATION_SEMANTICS_REQUIRED');
          validateVisualizationFields(panel, tool.fields);
        } else if (panel.component === 'metric') {
          if (!tool.aggregate) throw new AppError('PLAN_INVALID');
          const meta = field(panel.config.valueField, 'number');
          if ((panel.config.format === 'percent') !== (meta.unit === 'ratio'))
            throw new AppError('PLAN_INVALID');
        } else if (panel.component === 'trend') {
          field(panel.config.xField, 'date');
          field(panel.config.yField, 'number');
        } else if (panel.component === 'comparison' || panel.component === 'pie') {
          field(panel.config.categoryField, 'string');
          field(panel.config.valueField, 'number');
          if (
            panel.component === 'pie' &&
            !tool.partitions?.some(
              (partition) =>
                partition.categoryField === panel.config.categoryField &&
                partition.valueField === panel.config.valueField,
            )
          )
            throw new AppError('PIE_REQUIRES_PARTITION');
        } else if (panel.component === 'gantt') {
          for (const name of [
            panel.config.taskIdField,
            panel.config.labelField,
            panel.config.dependenciesField,
            panel.config.kindField,
          ])
            field(name, 'string');
          field(panel.config.startField, 'date');
          field(panel.config.endField, 'date');
          if (field(panel.config.progressField, 'number').unit !== 'ratio')
            throw new AppError('PLAN_INVALID');
        } else if (panel.component === 'flowchart') {
          for (const name of [
            panel.config.idField,
            panel.config.labelField,
            panel.config.kindField,
            panel.config.sourceField,
            panel.config.targetField,
          ])
            field(name, 'string');
        } else if (panel.component === 'burndown' || panel.component === 'cumulativeFlow') {
          field(panel.config.timeField, 'date');
          const names =
            panel.component === 'burndown'
              ? [panel.config.actualField, panel.config.referenceField]
              : panel.config.stageFields;
          const units = names.map((name) => field(name, 'number').unit);
          if (!units[0] || new Set(units).size !== 1) throw new AppError('PLAN_INVALID');
        } else if (panel.component === 'table')
          panel.config.columns.forEach((c) => {
            field(c);
            if (Array.isArray(binding.args.columns) && !binding.args.columns.includes(c))
              throw new AppError('PLAN_INVALID');
          });
        else throw new AppError('COMPONENT_NOT_ENABLED');
      }
    }
    return plan;
  }
  descriptions(principal: Principal) {
    return this.permitted(principal).map((t) => ({
      id: t.id,
      description: t.description,
      fields: t.fields,
      partitions: t.partitions ?? [],
      projectViews: t.projectViews ?? [],
      visualizationViews: t.visualizationViews ?? [],
      arguments: z.toJSONSchema(t.args),
    }));
  }
}
