import {
  AppError,
  type Artifact,
  type Event,
  type Action,
  type Dataset,
  type Filters,
} from '../contracts/index.ts';
import type { Agent, Response } from '../agent-adapter/index.ts';
import type { Principal } from '../catalog/index.ts';
import { Store } from './store.ts';
import { QueryRuntime } from './queries.ts';

export type LegacyPresentation = {
  visual(artifact: Artifact): string;
  facts(response: Extract<Response, { kind: 'facts' }>, data: Dataset): string;
  explain(reason: string): string;
};
export class ChatService {
  running = new Map<string, AbortController>();
  fault: { tool?: string; delayMs?: number; fail?: boolean } = {};
  constructor(
    public store: Store,
    public queries: QueryRuntime,
    public agent: Agent,
    public sourceHash: string,
    public presentation: LegacyPresentation,
  ) {}
  async resolve(
    artifact: Artifact,
    p: Principal,
    emit?: (type: Event['type'], payload: unknown, a?: Artifact) => void,
    signal?: AbortSignal,
  ) {
    const candidate = structuredClone(artifact);
    candidate.datasets = {};
    // Up to four concurrent bindings, with one atomic generation barrier.
    const pending = [...artifact.plan.bindings];
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (pending.length) {
          const b = pending.shift()!;
          emit?.('dataset.started', { bindingId: b.id }, artifact);
          try {
            if (signal?.aborted) throw new AppError('REQUEST_CANCELLED');
            if (this.fault.tool === b.toolId) {
              if (this.fault.delayMs) await new Promise((r) => setTimeout(r, this.fault.delayMs));
              if (this.fault.fail) throw new AppError('SOURCE_TIMEOUT', 504);
            }
            if (signal?.aborted) throw new AppError('REQUEST_CANCELLED');
            const data = this.queries.binding(artifact.plan, b.id, artifact.filters, p);
            candidate.datasets[b.id] = { status: 'ready', data };
            emit?.('dataset.ready', { bindingId: b.id, data }, artifact);
          } catch (e) {
            candidate.datasets[b.id] = {
              status: 'error',
              code: e instanceof AppError ? e.code : 'SOURCE_FAILED',
            };
            emit?.(
              'dataset.failed',
              { bindingId: b.id, code: (candidate.datasets[b.id] as { code: string }).code },
              artifact,
            );
          }
        }
      }),
    );
    if (signal?.aborted) throw new AppError('REQUEST_CANCELLED');
    const accepted = this.store.update(candidate);
    if (accepted) {
      this.store.retainSnapshot(candidate);
      emit?.(
        'artifact.settled',
        {
          artifact: candidate,
          partial: Object.values(candidate.datasets).some((d) => d.status === 'error'),
        },
        candidate,
      );
    }
    return accepted ? candidate : this.store.artifact(artifact.artifactId, p);
  }
  async turn(
    input: {
      conversationId: string;
      text: string;
      idempotencyKey: string;
      artifactId?: string;
      baseRevision?: number;
    },
    p: Principal,
    onEvent: (e: Event) => void,
  ) {
    const request = this.store.start(
      input.conversationId,
      input.idempotencyKey,
      JSON.stringify(input),
      p,
    );
    if (request.existing) {
      for (const event of this.store.events(request.id, p)) onEvent(event);
      return request.id;
    }
    const controller = new AbortController();
    this.running.set(request.id, controller);
    const deadline = setTimeout(() => controller.abort(), 120000);
    const emit = (type: Event['type'], payload: unknown, a?: Artifact) =>
      onEvent(this.store.append(request.id, type, payload, a));
    this.store.message(input.conversationId, 'user', input.text);
    emit('request.started', { requestId: request.id });
    try {
      const previous = input.artifactId ? this.store.artifact(input.artifactId, p) : undefined;
      if (previous && previous.revision !== input.baseRevision)
        throw new AppError('REVISION_CONFLICT', 409);
      const response = await this.agent.run({
        text: input.text,
        previous,
        principal: p,
        queries: this.queries,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      let text: string;
      let artifact: Artifact | undefined;
      let evidence: unknown;
      if (response.kind === 'visual') {
        const plan = this.queries.catalog.validate(response.plan, p);
        artifact = this.store.commit(input.conversationId, plan, this.sourceHash, p, previous);
        emit('artifact.committed', { artifact }, artifact);
        artifact = await this.resolve(artifact, p, emit, controller.signal);
        text = this.presentation.visual(artifact);
        if (Object.values(artifact.datasets).some((d) => d.status === 'error'))
          text = 'Analysis is partially available. Retry the failed source to complete this view.';
      } else if (response.kind === 'facts') {
        const data = this.queries.run(response.toolId, response.args, p);
        text = this.presentation.facts(response, data);
        evidence = {
          sourceId: data.sourceId,
          sourceHash: data.sourceHash,
          queryId: data.queryId,
          args: data.args,
        };
      } else text = this.presentation.explain(response.reason);
      this.store.message(input.conversationId, 'assistant', text, artifact, evidence);
      emit('assistant.text.delta', { text, evidence });
      emit('request.completed', {});
      this.store.finish(request.id, 'completed');
    } catch (e) {
      const code = controller.signal.aborted
        ? 'REQUEST_CANCELLED'
        : e instanceof AppError
          ? e.code
          : 'REQUEST_FAILED';
      emit('request.failed', { code });
      this.store.finish(request.id, 'failed');
    } finally {
      clearTimeout(deadline);
      this.running.delete(request.id);
    }
    return request.id;
  }
  async action(id: string, baseRevision: number, action: Action, p: Principal) {
    const artifact = this.store.artifact(id, p);
    if (artifact.revision !== baseRevision) throw new AppError('REVISION_CONFLICT', 409);
    if (artifact.sourceHash !== this.sourceHash) throw new AppError('SNAPSHOT_EXPIRED', 410);
    if (action.type === 'saveView') {
      this.store.save(artifact);
      return artifact;
    }
    if (action.type === 'sortTable' || action.type === 'nextPage') {
      const panel = artifact.plan.panels.find((x) => x.id === action.panelId);
      if (!panel || panel.component !== 'table') throw new AppError('ACTION_INVALID');
      if (action.type === 'sortTable' && !panel.config.columns.includes(action.field))
        throw new AppError('ACTION_INVALID');
      const state = artifact.datasets[panel.bindingId];
      const previous = state?.status === 'ready' ? state.data.args : {};
      const overrides: Record<string, unknown> = { ...previous };
      delete overrides.cursor;
      if (action.type === 'sortTable') {
        overrides.sort = action.field;
        overrides.direction = action.direction;
      } else overrides.cursor = action.cursor;
      artifact.datasets[panel.bindingId] = {
        status: 'ready',
        data: this.queries.binding(artifact.plan, panel.bindingId, artifact.filters, p, overrides),
      };
      this.store.update(artifact);
      return artifact;
    }
    if (action.type === 'setFilter') {
      const candidate = { ...artifact, filters: { ...artifact.filters, ...action.filters } };
      for (const [key, value] of Object.entries(action.filters)) {
        if (!artifact.plan.filters.some((f) => f.id === key)) throw new AppError('FILTER_INVALID');
        if (value !== null && !this.filterOptions(candidate, p)[key]?.includes(value!))
          throw new AppError('FILTER_INVALID');
      }
      artifact.filters = { ...artifact.filters, ...action.filters };
    }
    artifact.generationId++;
    this.store.update(artifact);
    return this.resolve(artifact, p);
  }
  filterOptions(artifact: Artifact, p: Principal): Record<string, string[]> {
    return Object.fromEntries(
      artifact.plan.filters.map((filter) => {
        const binding = artifact.plan.bindings.find((b) => filter.id in b.filterMap)!;
        const args: Record<string, unknown> = {};
        for (const key of ['domain', 'system', 'country', 'month', 'startMonth', 'endMonth'])
          if (key in binding.args) args[key] = binding.args[key];
        for (const [id, arg] of Object.entries(binding.filterMap))
          if (id in artifact.filters) args[arg] = artifact.filters[id as keyof Filters];
        const field = binding.filterMap[filter.id];
        delete args[field];
        const data = this.queries.run('csv.filterOptions', { ...args, field }, p);
        return [filter.id, data.rows.map((r) => String(r.value))];
      }),
    );
  }
}
