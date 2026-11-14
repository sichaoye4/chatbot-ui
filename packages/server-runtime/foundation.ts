import { FoundationCatalog } from '../catalog/foundation.ts';
import {
  FoundationError,
  type Arguments,
  type DataResult,
  type Diagnostic,
  type PlanningAgent,
  type Principal,
  type ResponsePlan,
} from '../contracts/foundation.ts';

/** Initial execution seam. Persistence/event/action migration remains separate. */
export class FoundationRuntime {
  constructor(readonly catalog: FoundationCatalog) {}
  async execute(candidate: unknown, principal: Principal, signal: AbortSignal) {
    signal.throwIfAborted();
    const plan = this.catalog.validate(candidate, principal);
    const datasets: Record<string, DataResult> = {};
    for (const binding of plan.bindings) {
      signal.throwIfAborted();
      const tool = this.catalog.tool(binding.tool, principal);
      const args: Arguments = tool.args.parse({ ...binding.args, ...binding.fixedArgs });
      const authorization = await this.catalog.policy.authorize(tool.ref, args, principal);
      signal.throwIfAborted();
      const result = await tool.execute(args, authorization.context, signal);
      signal.throwIfAborted();
      // Reauthorize before returning data if permissions changed while the tool ran.
      const current = await this.catalog.policy.authorize(tool.ref, args, principal);
      if (current.scopeKey !== authorization.scopeKey)
        throw new FoundationError({
          code: 'DATA_FORBIDDEN',
          path: binding.id,
          message: 'Authorization changed during execution',
        });
      datasets[binding.id] = this.catalog.validateResult(tool.ref, result, principal);
    }
    const facts: Record<string, string> = {};
    for (const fact of plan.facts) {
      const value = datasets[fact.field.bindingId].rows[fact.row]?.[fact.field.fieldId];
      if (value === undefined)
        throw new FoundationError({
          code: 'RESULT_INVALID',
          path: fact.id,
          message: 'Requested fact is absent from result',
        });
      facts[fact.id] =
        value === null
          ? 'Unavailable'
          : fact.format === 'raw'
            ? String(value)
            : new Intl.NumberFormat(
                'en-US',
                fact.format === 'percent'
                  ? { style: 'percent', maximumFractionDigits: 2 }
                  : { maximumFractionDigits: fact.format === 'integer' ? 0 : 4 },
              ).format(Number(value));
    }
    return { plan, datasets, facts };
  }
  async plan(
    agent: PlanningAgent,
    question: string,
    principal: Principal,
    signal: AbortSignal,
    previous?: ResponsePlan,
    maxRepairs = 1,
  ): Promise<ResponsePlan> {
    if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 3)
      throw new Error('Invalid repair budget');
    let feedback: Diagnostic[] = [];
    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      signal.throwIfAborted();
      const candidate = await agent.propose({
        question,
        previous,
        capabilities: this.catalog.snapshot(principal),
        signal,
        feedback,
      });
      signal.throwIfAborted();
      try {
        return this.catalog.validate(candidate, principal);
      } catch (error) {
        if (!(error instanceof FoundationError) || attempt === maxRepairs) throw error;
        feedback = [error.diagnostic];
      }
    }
    throw new Error('Unreachable');
  }
}
