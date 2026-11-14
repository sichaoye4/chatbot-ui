import {
  isVisualizationPanel,
  validateVisualizationData,
} from '../contracts/visualization-model.ts';
import { randomUUID } from 'node:crypto';
import { AppError, type Dataset, type Filters, type Plan } from '../contracts/index.ts';
import { Catalog, type Principal } from '../catalog/index.ts';
import { isProjectPanel, validateProjectData } from '../contracts/project-model.ts';

export class QueryRuntime {
  cache = new Map<string, Dataset>();
  executions: {
    queryId: string;
    toolId: string;
    tenant: string;
    scope: string[];
    cacheHit: boolean;
  }[] = [];
  constructor(public catalog: Catalog) {}
  run(toolId: string, input: Record<string, unknown>, principal: Principal): Dataset {
    // Reauthorize even on hits; policy epoch and effective scope are part of the key.
    const tool = this.catalog.tool(toolId, principal);
    const args = tool.args.parse(input) as Record<string, unknown>;
    if (args.domain && !principal.domains.includes(String(args.domain)))
      throw new AppError('DATA_FORBIDDEN', 403);
    const key = JSON.stringify({
      principal,
      args: Object.fromEntries(Object.entries(args).sort()),
      toolId,
      version: '1',
    });
    const hit = this.cache.get(key);
    const queryId = randomUUID();
    const result = hit ?? tool.execute(args, principal);
    if (!hit) this.cache.set(key, structuredClone(result));
    this.executions.push({
      queryId,
      toolId,
      tenant: principal.tenant,
      scope: [...principal.domains],
      cacheHit: !!hit,
    });
    return { ...structuredClone(result), queryId };
  }
  binding(
    plan: Plan,
    bindingId: string,
    filters: Filters,
    principal: Principal,
    overrides: Record<string, unknown> = {},
  ) {
    const binding = plan.bindings.find((b) => b.id === bindingId);
    if (!binding) throw new AppError('PLAN_INVALID');
    const args = { ...binding.args, ...overrides };
    for (const [id, arg] of Object.entries(binding.filterMap))
      if (id in filters) args[arg] = filters[id as keyof Filters];
    const result = this.run(binding.toolId, args, principal);
    for (const panel of plan.panels.filter((p) => p.bindingId === bindingId)) {
      if (isVisualizationPanel(panel)) {
        try {
          validateVisualizationData(panel, result);
        } catch {
          throw new AppError('VISUALIZATION_DATA_INVALID');
        }
      }
      if (isProjectPanel(panel)) {
        try {
          validateProjectData(panel, result);
        } catch {
          throw new AppError('PROJECT_DATA_INVALID');
        }
      }
    }
    return result;
  }
}
