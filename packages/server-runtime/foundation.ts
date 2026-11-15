import { FoundationCatalog } from '../catalog/foundation.ts';
import {
  FoundationError,
  type Arguments,
  type CapabilityRef,
  type DataResult,
  type Diagnostic,
  type PlanningAgent,
  type Principal,
  type ResponsePlan,
} from '../contracts/foundation.ts';
import { MaterializedResponse } from '../contracts/protocol.ts';

/** Initial execution seam. Persistence/event/action migration remains separate. */
export class FoundationRuntime {
  constructor(readonly catalog: FoundationCatalog) {}
  private scopeIdentity(scope: string, tool: CapabilityRef, principal: Principal) {
    return this.catalog.policy.visibleField
      ? JSON.stringify([scope, this.catalog.fields(tool, principal).map((field) => field.id)])
      : scope;
  }
  private async reauthorize(
    plan: ResponsePlan,
    scopes: Record<string, string>,
    principal: Principal,
    signal: AbortSignal,
    clientComponents?: CapabilityRef[],
  ) {
    this.catalog.validate(plan, principal, clientComponents);
    for (const binding of plan.bindings) {
      signal.throwIfAborted();
      const tool = this.catalog.tool(binding.tool, principal);
      const args = tool.args.parse({ ...binding.args, ...binding.fixedArgs });
      const current = await this.catalog.policy.authorize(tool.ref, args, principal);
      if (this.scopeIdentity(current.scopeKey, tool.ref, principal) !== scopes[binding.id])
        throw new FoundationError({
          code: 'DATA_FORBIDDEN',
          path: binding.id,
          message: 'Authorization changed before publication',
        });
    }
    signal.throwIfAborted();
  }
  async execute(
    candidate: unknown,
    principal: Principal,
    signal: AbortSignal,
    clientComponents?: CapabilityRef[],
    allowPartial = false,
  ) {
    signal.throwIfAborted();
    const plan = this.catalog.validate(candidate, principal, clientComponents);
    const datasets: Record<string, DataResult> = {};
    const scopes: Record<string, string> = {};
    const failedBindings: string[] = [];
    for (const binding of plan.bindings) {
      signal.throwIfAborted();
      const tool = this.catalog.tool(binding.tool, principal);
      const args: Arguments = tool.args.parse({ ...binding.args, ...binding.fixedArgs });
      const authorization = await this.catalog.policy.authorize(tool.ref, args, principal);
      scopes[binding.id] = this.scopeIdentity(authorization.scopeKey, tool.ref, principal);
      signal.throwIfAborted();
      let result: unknown;
      try {
        result = await tool.execute(args, authorization.context, signal);
      } catch (error) {
        signal.throwIfAborted();
        // Policy, validation and cancellation failures must never become partial data.
        if (!allowPartial || error instanceof FoundationError) throw error;
        failedBindings.push(binding.id);
        continue;
      }
      signal.throwIfAborted();
      // Reauthorize before returning data if permissions changed while the tool ran.
      const current = await this.catalog.policy.authorize(tool.ref, args, principal);
      if (this.scopeIdentity(current.scopeKey, tool.ref, principal) !== scopes[binding.id])
        throw new FoundationError({
          code: 'DATA_FORBIDDEN',
          path: binding.id,
          message: 'Authorization changed during execution',
        });
      datasets[binding.id] = this.catalog.validateResult(tool.ref, result, principal);
    }
    await this.reauthorize(plan, scopes, principal, signal, clientComponents);
    if (failedBindings.length && failedBindings.length === plan.bindings.length)
      throw new Error('All data sources failed');
    this.validateAvailableResults(plan, datasets, principal);
    const facts = this.formatFacts(plan, datasets);
    return { plan, datasets, facts, failedBindings };
  }
  private validateAvailableResults(
    plan: ResponsePlan,
    datasets: Record<string, DataResult>,
    principal: Principal,
  ) {
    const available = {
      ...plan,
      blocks: plan.blocks.map((block) =>
        block.kind !== 'visual'
          ? block
          : {
              ...block,
              elements: block.elements.filter((element) =>
                Object.values(element.roles)
                  .flat()
                  .every((ref) => datasets[ref.bindingId]),
              ),
            },
      ),
    };
    this.catalog.validatePresentationResults(available, datasets, principal);
  }
  private formatFacts(plan: ResponsePlan, datasets: Record<string, DataResult>) {
    const facts: Record<string, string> = {};
    for (const fact of plan.facts) {
      if (!datasets[fact.field.bindingId]) continue;
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
    return facts;
  }
  /** Publish host-supplied query results only after the same policy and projection checks as execution. */
  async ingest(
    candidate: unknown,
    supplied: Record<string, unknown>,
    principal: Principal,
    signal: AbortSignal,
    identity: { messageId: string; responseId: string; revision: number; generation: number },
    clientComponents?: CapabilityRef[],
    failedBindings: string[] = [],
  ) {
    signal.throwIfAborted();
    const plan = this.catalog.validate(candidate, principal, clientComponents);
    if (failedBindings.length && failedBindings.length === plan.bindings.length)
      throw new FoundationError({
        code: 'RESULT_INVALID',
        path: '',
        message: 'A partial response requires a successful binding',
      });
    const keys = Object.keys(supplied);
    if (
      new Set(failedBindings).size !== failedBindings.length ||
      keys.length + failedBindings.length !== plan.bindings.length ||
      [...keys, ...failedBindings].some((id) => !plan.bindings.some((b) => b.id === id)) ||
      keys.some((id) => failedBindings.includes(id))
    )
      throw new FoundationError({
        code: 'RESULT_INVALID',
        path: '',
        message: 'Results must match plan bindings',
      });
    const datasets: Record<string, DataResult> = {};
    const scopes: Record<string, string> = {};
    const descriptors = [];
    for (const binding of plan.bindings) {
      signal.throwIfAborted();
      const tool = this.catalog.tool(binding.tool, principal);
      const args = tool.args.parse({ ...binding.args, ...binding.fixedArgs });
      const before = await this.catalog.policy.authorize(tool.ref, args, principal);
      scopes[binding.id] = this.scopeIdentity(before.scopeKey, tool.ref, principal);
      signal.throwIfAborted();
      descriptors.push({
        bindingId: binding.id,
        source: tool.ref,
        fields: this.catalog.fields(tool.ref, principal),
        grain: tool.grain,
      });
      if (failedBindings.includes(binding.id)) continue;
      let bytes: number;
      try {
        bytes = new TextEncoder().encode(JSON.stringify(supplied[binding.id])).length;
      } catch {
        throw new FoundationError({
          code: 'RESULT_INVALID',
          path: binding.id,
          message: 'Result must be JSON',
        });
      }
      if (bytes > this.catalog.limits.maxBytes)
        throw new FoundationError({
          code: 'BUDGET_EXCEEDED',
          path: binding.id,
          message: 'Result exceeds byte budget',
        });
      datasets[binding.id] = this.catalog.validateResult(tool.ref, supplied[binding.id], principal);
      const after = await this.catalog.policy.authorize(tool.ref, args, principal);
      signal.throwIfAborted();
      if (this.scopeIdentity(after.scopeKey, tool.ref, principal) !== scopes[binding.id])
        throw new FoundationError({
          code: 'DATA_FORBIDDEN',
          path: binding.id,
          message: 'Authorization changed during ingestion',
        });
    }
    await this.reauthorize(plan, scopes, principal, signal, clientComponents);
    this.validateAvailableResults(plan, datasets, principal);
    const values = this.formatFacts(plan, datasets);
    return MaterializedResponse.parse({
      protocolVersion: 2,
      ...identity,
      plan,
      bindingDescriptors: descriptors,
      datasets: Object.fromEntries(
        plan.bindings.map(({ id }) => [
          id,
          datasets[id]
            ? { status: 'ready', result: datasets[id] }
            : {
                status: 'failed',
                diagnostic: {
                  code: 'SOURCE_FAILURE',
                  message: 'This data source is unavailable.',
                  retryable: true,
                  targetId: id,
                },
              },
        ]),
      ),
      facts: Object.fromEntries(
        plan.facts
          .filter((fact) => values[fact.id] !== undefined)
          .map((fact) => [
            fact.id,
            { value: values[fact.id], field: fact.field, row: fact.row, format: fact.format },
          ]),
      ),
      operations: [],
      status: failedBindings.length ? 'partial' : 'complete',
      diagnostics: [],
    });
  }
  async plan(
    agent: PlanningAgent,
    question: string,
    principal: Principal,
    signal: AbortSignal,
    previous?: ResponsePlan,
    maxRepairs = 1,
    clientComponents?: CapabilityRef[],
    choice?: { responseId: string; blockId: string; choiceId: string; label: string },
  ): Promise<ResponsePlan> {
    if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 3)
      throw new Error('Invalid repair budget');
    let feedback: Diagnostic[] = [];
    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      signal.throwIfAborted();
      const candidate = await agent.propose({
        question,
        previous,
        capabilities: this.catalog.snapshot(principal, clientComponents),
        signal,
        feedback,
        choice,
      });
      signal.throwIfAborted();
      try {
        return this.catalog.validate(candidate, principal, clientComponents);
      } catch (error) {
        if (!(error instanceof FoundationError) || attempt === maxRepairs) throw error;
        feedback = [error.diagnostic];
      }
    }
    throw new Error('Unreachable');
  }
}
