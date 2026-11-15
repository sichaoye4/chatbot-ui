import { FoundationCatalog } from '../catalog/foundation.ts';
import { z } from 'zod';
import {
  FoundationError,
  LocalId,
  type Arguments,
  type CapabilityRef,
  type Control,
  type Principal,
  type ResponsePlan,
} from '../contracts/foundation.ts';
import {
  ControlChange,
  MaterializedResponse,
  OptionPage,
  OptionQuery,
} from '../contracts/protocol.ts';
import { FoundationRuntime } from './foundation.ts';
import {
  MemoryControlSnapshotStore,
  type ControlSnapshotStore,
  type StoredControlSnapshot,
} from './control-store.ts';

const SET_CONTROL: CapabilityRef = { id: 'ui.setControl', version: 1 };
const RETRY: CapabilityRef = { id: 'ui.retryBinding', version: 1 };
const Retry = z.strictObject({
  responseId: LocalId,
  revision: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
  bindingId: LocalId,
  idempotencyKey: LocalId,
});
type Snapshot = StoredControlSnapshot;
type Pending = { fingerprint: string; result: Promise<Snapshot> };
function fail(code: FoundationError['diagnostic']['code'], path: string, message: string): never {
  throw new FoundationError({ code, path, message });
}
const controls = (plan: ResponsePlan) =>
  plan.blocks.flatMap((block) => (block.kind === 'visual' ? block.controls : []));

/** Hosts choose an atomic store and a principal-to-owner scope; the default store is in memory. */
export class FoundationControlService {
  private readonly requests = new Map<string, Pending>();
  private readonly runtime: FoundationRuntime;
  constructor(
    readonly catalog: FoundationCatalog,
    private readonly ownerKey: (principal: Principal) => string,
    private readonly store: ControlSnapshotStore = new MemoryControlSnapshotStore(),
  ) {
    this.runtime = new FoundationRuntime(catalog);
  }
  private owner(principal: Principal) {
    const owner = this.ownerKey(principal);
    if (!owner) fail('DATA_FORBIDDEN', '', 'Owner scope is unavailable');
    return owner;
  }
  private getCurrent(principal: Principal, responseId: string) {
    const snapshot = this.store.current(this.owner(principal), responseId);
    if (!snapshot) fail('DATA_FORBIDDEN', '', 'Response is unavailable');
    return snapshot;
  }
  private async scopes(plan: ResponsePlan, principal: Principal, signal: AbortSignal) {
    const scopes: Record<string, string> = {};
    for (const binding of plan.bindings) {
      signal.throwIfAborted();
      const tool = this.catalog.tool(binding.tool, principal);
      const args = tool.args.parse({ ...binding.args, ...binding.fixedArgs });
      scopes[binding.id] = (
        await this.catalog.policy.authorize(tool.ref, args, principal)
      ).scopeKey;
    }
    signal.throwIfAborted();
    return scopes;
  }
  private async authorize(snapshot: Snapshot, principal: Principal, signal: AbortSignal) {
    this.catalog.validate(snapshot.response.plan, principal, snapshot.components);
    const current = await this.scopes(snapshot.response.plan, principal, signal);
    if (JSON.stringify(current) !== JSON.stringify(snapshot.scopes))
      fail('DATA_FORBIDDEN', '', 'Response authorization changed');
  }
  private actionable(control: Control, plan: ResponsePlan, principal: Principal) {
    if (
      control.scopeMode !== 'within-answer' ||
      control.control.version !== 1 ||
      !['ui.select', 'ui.multiSelect', 'ui.dateRange'].includes(control.control.id)
    )
      return false;
    if (control.control.id === 'ui.dateRange') return true;
    return control.targets.every((target) => {
      const binding = plan.bindings.find((item) => item.id === target.bindingId)!;
      const options = this.catalog.tool(binding.tool, principal).interactive[target.argument]
        ?.options;
      if (!options) return false;
      try {
        this.catalog.optionResolver(options, principal);
        return true;
      } catch {
        return false;
      }
    });
  }
  /** Host explicitly opts an executable source into interaction; static imports remain read-only by default. */
  async attach(
    raw: unknown,
    principal: Principal,
    signal: AbortSignal,
    options: { enableControls: boolean; components?: CapabilityRef[] },
  ) {
    const response = MaterializedResponse.parse(raw);
    if (
      !['complete', 'partial'].includes(response.status) ||
      Object.values(response.datasets).some((state) => state.status === 'pending')
    )
      fail('RESULT_INVALID', '', 'A settled snapshot is required');
    const failedBindings = Object.entries(response.datasets)
      .filter(([, state]) => state.status === 'failed')
      .map(([id]) => id);
    if ((response.status === 'partial') !== failedBindings.length > 0)
      fail('RESULT_INVALID', '', 'Snapshot status does not match its results');
    const supplied = Object.fromEntries(
      Object.entries(response.datasets)
        .filter(([, state]) => state.status === 'ready')
        .map(([id, state]) => [id, state.status === 'ready' ? state.result : undefined]),
    );
    const scopesBefore = await this.scopes(response.plan, principal, signal);
    const checked = await this.runtime.ingest(
      response.plan,
      supplied,
      principal,
      signal,
      {
        messageId: response.messageId,
        responseId: response.responseId,
        revision: response.revision,
        generation: response.generation,
      },
      options.components,
      failedBindings,
    );
    const scopesAfter = await this.scopes(checked.plan, principal, signal);
    if (JSON.stringify(scopesBefore) !== JSON.stringify(scopesAfter))
      fail('DATA_FORBIDDEN', '', 'Authorization changed while attaching response');
    const snapshot: Snapshot = {
      response: {
        ...checked,
        operations:
          checked.status === 'partial' && options.enableControls
            ? [RETRY]
            : checked.status === 'complete' &&
                options.enableControls &&
                controls(checked.plan).some((control) =>
                  this.actionable(control, checked.plan, principal),
                )
              ? [SET_CONTROL]
              : [],
      },
      scopes: scopesAfter,
      components: options.components && structuredClone(options.components),
    };
    signal.throwIfAborted();
    if (!this.store.create(this.owner(principal), snapshot))
      fail('REVISION_CONFLICT', '', 'Response already exists');
    return structuredClone(snapshot.response);
  }
  async read(
    responseId: string,
    principal: Principal,
    signal: AbortSignal,
    revision?: number,
    generation?: number,
  ) {
    const snapshot =
      revision === undefined && generation === undefined
        ? this.store.current(this.owner(principal), responseId)
        : revision !== undefined && generation !== undefined
          ? this.store.version(this.owner(principal), responseId, revision, generation)
          : undefined;
    if (!snapshot) fail('DATA_FORBIDDEN', '', 'Response is unavailable');
    await this.authorize(snapshot, principal, signal);
    return structuredClone(snapshot.response);
  }
  private async current(
    principal: Principal,
    input: { responseId: string; revision: number; generation: number },
    signal: AbortSignal,
  ) {
    const snapshot = this.getCurrent(principal, input.responseId);
    await this.authorize(snapshot, principal, signal);
    const latest = this.getCurrent(principal, input.responseId);
    if (
      latest.response.revision !== snapshot.response.revision ||
      latest.response.generation !== snapshot.response.generation ||
      snapshot.response.revision !== input.revision ||
      snapshot.response.generation !== input.generation
    )
      fail('REVISION_CONFLICT', '', 'Response has changed; reload before retrying');
    return snapshot;
  }
  private findControl(plan: ResponsePlan, id: string) {
    return (
      controls(plan).find((item) => item.id === id) ??
      fail('CAPABILITY_UNAVAILABLE', id, 'Control is unavailable')
    );
  }
  private async target(
    control: Control,
    plan: ResponsePlan,
    target: Control['targets'][number],
    principal: Principal,
    signal: AbortSignal,
  ) {
    const binding = plan.bindings.find((item) => item.id === target.bindingId)!;
    const tool = this.catalog.tool(binding.tool, principal);
    const capability = tool.interactive[target.argument];
    if (!capability?.options) fail('CAPABILITY_UNAVAILABLE', control.id, 'Options are unavailable');
    const resolver = this.catalog.optionResolver(capability.options, principal);
    const args: Arguments = tool.args.parse({ ...binding.args, ...binding.fixedArgs });
    const scopeArgs = { ...args };
    delete scopeArgs[target.argument];
    const toolAuth = await this.catalog.policy.authorize(tool.ref, args, principal);
    const optionAuth = await this.catalog.policy.authorize(resolver.ref, args, principal);
    signal.throwIfAborted();
    return { tool, resolver, args, scopeArgs, toolAuth, optionAuth, argument: target.argument };
  }
  private async recheckTarget(
    target: Awaited<ReturnType<FoundationControlService['target']>>,
    principal: Principal,
    signal: AbortSignal,
  ) {
    const toolAuth = await this.catalog.policy.authorize(target.tool.ref, target.args, principal);
    const optionAuth = await this.catalog.policy.authorize(
      target.resolver.ref,
      target.args,
      principal,
    );
    signal.throwIfAborted();
    if (
      toolAuth.scopeKey !== target.toolAuth.scopeKey ||
      optionAuth.scopeKey !== target.optionAuth.scopeKey
    )
      fail('DATA_FORBIDDEN', '', 'Authorization changed during option resolution');
  }
  async resolveOptions(raw: unknown, principal: Principal, signal: AbortSignal) {
    const input = OptionQuery.parse(raw);
    const base = await this.current(principal, input, signal);
    await this.authorize(base, principal, signal);
    const plan = base.response.plan;
    const control = this.findControl(plan, input.controlId);
    if (
      !base.response.operations.some(
        (operation) => operation.id === SET_CONTROL.id && operation.version === SET_CONTROL.version,
      ) ||
      !this.actionable(control, plan, principal)
    )
      fail('CAPABILITY_UNAVAILABLE', control.id, 'This control is read-only');
    if (
      !['ui.select', 'ui.multiSelect'].includes(control.control.id) ||
      control.control.version !== 1
    )
      fail('CAPABILITY_UNAVAILABLE', control.id, 'Options are unavailable for this control');
    const pages: OptionPage[] = [];
    for (const item of control.targets) {
      const target = await this.target(control, plan, item, principal, signal);
      const page = OptionPage.parse(
        await target.resolver.resolve({
          scopeArgs: target.scopeArgs,
          argument: target.argument,
          context: target.optionAuth.context,
          search: input.search,
          cursor: input.cursor,
          signal,
        }),
      );
      await this.recheckTarget(target, principal, signal);
      pages.push(page);
    }
    if (pages.length > 1 && (input.cursor || pages.some((page) => page.nextCursor)))
      fail(
        'CAPABILITY_UNAVAILABLE',
        control.id,
        'Paginated options across multiple sources are unavailable',
      );
    const first = pages[0];
    const output =
      pages.length === 1
        ? first
        : {
            options: first.options.filter((option) =>
              pages
                .slice(1)
                .every((page) => page.options.some((other) => other.value === option.value)),
            ),
            nextCursor: null,
          };
    await this.authorize(base, principal, signal);
    await this.current(principal, input, signal);
    return OptionPage.parse(output);
  }
  private async validateSelections(plan: ResponsePlan, principal: Principal, signal: AbortSignal) {
    for (const control of controls(plan)) {
      this.catalog.control(control.control, principal).value.parse(control.initialValue);
      if (!['ui.select', 'ui.multiSelect'].includes(control.control.id)) continue;
      const values =
        control.initialValue === null
          ? []
          : Array.isArray(control.initialValue)
            ? control.initialValue
            : [control.initialValue];
      for (const item of control.targets) {
        const target = await this.target(control, plan, item, principal, signal);
        for (const value of values) {
          if (
            typeof value !== 'string' ||
            !(await target.resolver.accepts({
              value,
              scopeArgs: target.scopeArgs,
              argument: target.argument,
              context: target.optionAuth.context,
              signal,
            }))
          )
            fail('SCOPE_CONFLICT', control.id, 'Selection is unavailable in the current scope');
        }
        await this.recheckTarget(target, principal, signal);
      }
    }
  }
  async change(raw: unknown, principal: Principal, signal: AbortSignal) {
    const input = ControlChange.parse(raw);
    const current = this.getCurrent(principal, input.responseId);
    await this.authorize(current, principal, signal);
    const owner = this.owner(principal);
    const requestKey = JSON.stringify([owner, input.idempotencyKey]);
    const fingerprint = JSON.stringify(input);
    const stored = this.store.request(owner, input.idempotencyKey);
    if (stored) {
      if (stored.fingerprint !== fingerprint)
        fail('IDEMPOTENCY_CONFLICT', '', 'Idempotency key was used for another request');
      await this.authorize(stored.snapshot, principal, signal);
      return structuredClone(stored.snapshot.response);
    }
    const existing = this.requests.get(requestKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        fail('IDEMPOTENCY_CONFLICT', '', 'Idempotency key was used for another request');
      const snapshot = await existing.result;
      await this.authorize(snapshot, principal, signal);
      return structuredClone(snapshot.response);
    }
    const result = this.apply(input, principal, signal, owner, fingerprint);
    this.requests.set(requestKey, { fingerprint, result });
    try {
      const snapshot = await result;
      return structuredClone(snapshot.response);
    } catch (error) {
      this.requests.delete(requestKey);
      // Another coordinator may have committed this key between our first lookup and CAS.
      const committed = this.store.request(owner, input.idempotencyKey);
      if (committed) {
        if (committed.fingerprint !== fingerprint)
          fail('IDEMPOTENCY_CONFLICT', '', 'Idempotency key was used for another request');
        await this.authorize(committed.snapshot, principal, signal);
        return structuredClone(committed.snapshot.response);
      }
      throw error;
    }
  }
  /** Retry exactly one failed binding. Existing successful data remains an immutable snapshot. */
  async retry(raw: unknown, principal: Principal, signal: AbortSignal) {
    const input = Retry.parse(raw);
    const owner = this.owner(principal);
    const fingerprint = JSON.stringify({ action: RETRY, ...input });
    const previous = this.store.request(owner, input.idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        fail('IDEMPOTENCY_CONFLICT', '', 'Idempotency key was used for another request');
      await this.authorize(previous.snapshot, principal, signal);
      return structuredClone(previous.snapshot.response);
    }
    const requestKey = JSON.stringify([owner, input.idempotencyKey]);
    const existing = this.requests.get(requestKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        fail('IDEMPOTENCY_CONFLICT', '', 'Idempotency key was used for another request');
      const snapshot = await existing.result;
      await this.authorize(snapshot, principal, signal);
      return structuredClone(snapshot.response);
    }
    const result = this.applyRetry(input, principal, signal, owner, fingerprint);
    this.requests.set(requestKey, { fingerprint, result });
    try {
      return structuredClone((await result).response);
    } catch (error) {
      this.requests.delete(requestKey);
      const committed = this.store.request(owner, input.idempotencyKey);
      if (committed) {
        if (committed.fingerprint !== fingerprint)
          fail('IDEMPOTENCY_CONFLICT', '', 'Idempotency key was used for another request');
        await this.authorize(committed.snapshot, principal, signal);
        return structuredClone(committed.snapshot.response);
      }
      throw error;
    }
  }
  private async applyRetry(
    input: z.infer<typeof Retry>,
    principal: Principal,
    signal: AbortSignal,
    owner: string,
    fingerprint: string,
  ): Promise<Snapshot> {
    const base = await this.current(principal, input, signal);
    if (
      !base.response.operations.some(
        (operation) => operation.id === RETRY.id && operation.version === RETRY.version,
      )
    )
      fail('CAPABILITY_UNAVAILABLE', '', 'Retry is unavailable');
    if (base.response.datasets[input.bindingId]?.status !== 'failed')
      fail('CAPABILITY_UNAVAILABLE', input.bindingId, 'Only a failed data source can be retried');
    const binding = base.response.plan.bindings.find((item) => item.id === input.bindingId)!;
    const tool = this.catalog.tool(binding.tool, principal);
    const args = tool.args.parse({ ...binding.args, ...binding.fixedArgs });
    const before = await this.catalog.policy.authorize(tool.ref, args, principal);
    signal.throwIfAborted();
    const result = await tool.execute(args, before.context, signal);
    signal.throwIfAborted();
    const after = await this.catalog.policy.authorize(tool.ref, args, principal);
    if (before.scopeKey !== after.scopeKey || before.scopeKey !== base.scopes[input.bindingId])
      fail('DATA_FORBIDDEN', input.bindingId, 'Authorization changed during retry');
    const supplied = Object.fromEntries(
      Object.entries(base.response.datasets).flatMap(([id, state]) =>
        state.status === 'ready' ? [[id, state.result]] : [],
      ),
    );
    supplied[input.bindingId] = this.catalog.validateResult(tool.ref, result, principal);
    const failed = Object.entries(base.response.datasets)
      .filter(([id, state]) => id !== input.bindingId && state.status === 'failed')
      .map(([id]) => id);
    const response = await this.runtime.ingest(
      base.response.plan,
      supplied,
      principal,
      signal,
      {
        messageId: base.response.messageId,
        responseId: base.response.responseId,
        revision: base.response.revision,
        generation: base.response.generation + 1,
      },
      base.components,
      failed,
    );
    await this.authorize(base, principal, signal);
    const scopes = await this.scopes(response.plan, principal, signal);
    if (JSON.stringify(scopes) !== JSON.stringify(base.scopes))
      fail('DATA_FORBIDDEN', '', 'Authorization changed during retry');
    response.operations =
      response.status === 'partial'
        ? [RETRY]
        : controls(response.plan).some((control) =>
              this.actionable(control, response.plan, principal),
            )
          ? [SET_CONTROL]
          : [];
    signal.throwIfAborted();
    const committed = this.store.commit({
      owner,
      responseId: input.responseId,
      baseRevision: input.revision,
      baseGeneration: input.generation,
      idempotencyKey: input.idempotencyKey,
      fingerprint,
      snapshot: { response, scopes, components: base.components },
    });
    if (committed.kind === 'conflict')
      fail('REVISION_CONFLICT', '', 'Response changed during retry');
    if (committed.kind === 'idempotency-conflict')
      fail('IDEMPOTENCY_CONFLICT', '', 'Idempotency key was used for another request');
    if (committed.kind === 'replayed') await this.authorize(committed.snapshot, principal, signal);
    return committed.snapshot;
  }
  private async apply(
    input: ControlChange,
    principal: Principal,
    signal: AbortSignal,
    owner: string,
    fingerprint: string,
  ): Promise<Snapshot> {
    const base = await this.current(principal, input, signal);
    await this.authorize(base, principal, signal);
    if (
      !base.response.operations.some(
        (operation) => operation.id === SET_CONTROL.id && operation.version === SET_CONTROL.version,
      )
    )
      fail('CAPABILITY_UNAVAILABLE', '', 'This response is read-only');
    const plan = structuredClone(base.response.plan);
    const control = this.findControl(plan, input.controlId);
    if (control.scopeMode !== 'within-answer' || input.newMessageId)
      fail('CAPABILITY_UNAVAILABLE', control.id, 'Changing answer scope requires a new answer');
    if (!this.actionable(control, plan, principal))
      fail('CAPABILITY_UNAVAILABLE', control.id, 'This control is unavailable');
    const registration = this.catalog.control(control.control, principal);
    if (!registration.value.safeParse(input.value).success)
      fail('SCHEMA_INVALID', control.id, 'Invalid control value');
    control.initialValue = input.value;
    for (const target of control.targets) {
      const binding = plan.bindings.find((item) => item.id === target.bindingId)!;
      if (Object.hasOwn(binding.fixedArgs, target.argument))
        fail('SCOPE_CONFLICT', control.id, 'Fixed answer scope cannot be edited');
      binding.args[target.argument] = input.value;
    }
    const validated = this.catalog.validate(plan, principal, base.components);
    await this.validateSelections(validated, principal, signal);
    const scopeBefore = await this.scopes(validated, principal, signal);
    const result = await this.runtime.execute(validated, principal, signal, base.components);
    const next = await this.runtime.ingest(
      validated,
      result.datasets,
      principal,
      signal,
      {
        messageId: base.response.messageId,
        responseId: base.response.responseId,
        revision: base.response.revision,
        generation: base.response.generation + 1,
      },
      base.components,
    );
    const scopeAfter = await this.scopes(validated, principal, signal);
    if (JSON.stringify(scopeBefore) !== JSON.stringify(scopeAfter))
      fail('DATA_FORBIDDEN', '', 'Authorization changed while updating response');
    await this.authorize(base, principal, signal);
    signal.throwIfAborted();
    const snapshot: Snapshot = {
      response: { ...next, operations: base.response.operations },
      scopes: scopeAfter,
      components: base.components,
    };
    const committed = this.store.commit({
      owner,
      responseId: input.responseId,
      baseRevision: input.revision,
      baseGeneration: input.generation,
      idempotencyKey: input.idempotencyKey,
      fingerprint,
      snapshot,
    });
    if (committed.kind === 'conflict')
      fail('REVISION_CONFLICT', '', 'Response changed during execution');
    if (committed.kind === 'idempotency-conflict')
      fail('IDEMPOTENCY_CONFLICT', '', 'Idempotency key was used for another request');
    if (committed.kind === 'replayed') await this.authorize(committed.snapshot, principal, signal);
    return committed.snapshot;
  }
}
