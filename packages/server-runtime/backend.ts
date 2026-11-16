import { createHash, randomUUID } from 'node:crypto';
import {
  FoundationError,
  type PlanningAgent,
  type Principal,
  type ResponsePlan,
} from '../contracts/foundation.ts';
import {
  BackendAction,
  ConversationSnapshot,
  ProtocolEvent,
  TurnRequest,
  type ProtocolEvent as Event,
} from '../contracts/protocol.ts';
import { FoundationCatalog } from '../catalog/foundation.ts';
import { FoundationRuntime } from './foundation.ts';
import { FoundationControlService } from './controls.ts';
import { AuthorizedConversations } from './authorized-conversations.ts';
import { AuthorizedRequestJournal, type JournalPolicy } from './authorized-journal.ts';

const id = (prefix: string) => `${prefix}${randomUUID().replaceAll('-', '')}`;
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const fingerprint = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const safeMessage = 'The request could not be completed. Please try again.';

/** Provider-independent orchestration. HTTP, identity and storage are supplied by the host. */
export class FoundationBackend {
  private readonly runtime: FoundationRuntime;
  private readonly active = new Map<string, AbortController>();
  private readonly workerId: string;
  private readonly leaseMs: number;
  private stopping = false;
  constructor(
    private readonly catalog: FoundationCatalog,
    private readonly agent: PlanningAgent,
    private readonly controls: FoundationControlService,
    private readonly conversations: AuthorizedConversations,
    private readonly journal: AuthorizedRequestJournal,
    private readonly policy: JournalPolicy,
    config: { workerId?: string; leaseMs?: number; maxSteps?: number } = {},
  ) {
    this.runtime = new FoundationRuntime(catalog);
    this.workerId = config.workerId ?? id('worker');
    this.leaseMs = config.leaseMs ?? 30_000;
  }
  private startLeaseHeartbeat(
    requestId: string,
    principal: Principal,
    controller: AbortController,
  ) {
    const intervalMs = Math.max(25, Math.min(5000, Math.floor(this.leaseMs / 3)));
    const timer = setInterval(() => {
      if (controller.signal.aborted) return;
      void this.journal
        .renewLease(requestId, this.workerId, this.leaseMs, principal, new AbortController().signal)
        .then((res) => {
          if (res.cancelRequested) controller.abort();
        })
        .catch(() => {});
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
  private async checkRemoteCancel(
    requestId: string,
    principal: Principal,
    controller: AbortController,
  ) {
    if (controller.signal.aborted) return;
    if (
      await this.journal
        .isCancelRequested(requestId, principal, new AbortController().signal)
        .catch(() => false)
    )
      controller.abort();
  }
  private key(principal: Principal, requestId: string) {
    return JSON.stringify([this.policy.owner(principal), requestId]);
  }
  shutdown() {
    this.stopping = true;
    for (const controller of this.active.values()) controller.abort();
  }
  negotiate(principal: Principal) {
    const snap = this.catalog.snapshot(principal);
    return {
      protocolVersion: 2 as const,
      components: snap.components.map((item) => item.ref),
      operations: snap.actions.map((item) => item.ref),
      history: true,
      replay: true,
      cancellation: true,
    };
  }
  async history(conversationId: string, principal: Principal, signal: AbortSignal) {
    const snapshot = await this.conversations.history(conversationId, principal, signal);
    const messages = [];
    for (const message of snapshot.messages) {
      const latest =
        message.role === 'assistant'
          ? await this.journal.latest(conversationId, message.id, principal, signal)
          : undefined;
      messages.push({
        ...message,
        ...(latest && ['pending', 'running', 'interrupted'].includes(latest.status)
          ? { interruptedRequest: latest }
          : {}),
      });
    }
    await this.conversations.history(conversationId, principal, signal);
    return ConversationSnapshot.parse({ conversationId, messages });
  }
  async snapshot(responseId: string, principal: Principal, signal: AbortSignal) {
    await this.conversations.locate(responseId, principal, signal);
    return this.controls.read(responseId, principal, signal);
  }
  options(input: unknown, principal: Principal, signal: AbortSignal) {
    return this.controls.resolveOptions(input, principal, signal);
  }
  replay(requestId: string, afterSequence: number, principal: Principal, signal: AbortSignal) {
    return this.journal.replay(requestId, afterSequence, principal, signal);
  }
  async cancel(requestId: string, principal: Principal, signal: AbortSignal) {
    await this.journal.inspect(requestId, principal, signal);
    const dbRequested = await this.journal.requestCancel(requestId, principal, signal);
    const controller = this.active.get(this.key(principal, requestId));
    if (controller) controller.abort();
    return { accepted: !!controller || dbRequested };
  }
  private async *existing(requestId: string, principal: Principal, signal: AbortSignal) {
    const page = await this.journal.replay(requestId, -1, principal, signal);
    if (page.kind === 'expired') throw new Error('REPLAY_EXPIRED');
    for (const event of page.events) yield event;
  }
  private async previous(input: TurnRequest, principal: Principal, signal: AbortSignal) {
    let previous: ResponsePlan | undefined;
    for (const ref of input.previous) {
      const location = await this.conversations.locate(ref.responseId, principal, signal);
      if (location.conversationId !== input.conversationId)
        throw new FoundationError({
          code: 'DATA_FORBIDDEN',
          path: '',
          message: 'Prior response is unavailable',
        });
      previous = (
        await this.controls.read(ref.responseId, principal, signal, ref.revision, ref.generation)
      ).plan;
    }
    let choice:
      { responseId: string; blockId: string; choiceId: string; label: string } | undefined;
    if (input.choice) {
      const location = await this.conversations.locate(input.choice.responseId, principal, signal);
      if (location.conversationId !== input.conversationId)
        throw new FoundationError({
          code: 'DATA_FORBIDDEN',
          path: '',
          message: 'Clarification is unavailable',
        });
      const response = await this.controls.read(input.choice.responseId, principal, signal);
      const block = response.plan.blocks.find(
        (item) => item.kind === 'clarification' && item.id === input.choice!.blockId,
      );
      const selected =
        block?.kind === 'clarification'
          ? block.choices.find((item) => item.id === input.choice!.choiceId)
          : undefined;
      if (!selected || selected.label !== input.text)
        throw new FoundationError({
          code: 'SCHEMA_INVALID',
          path: '',
          message: 'Clarification choice is invalid',
        });
      choice = { ...input.choice, label: selected.label };
      previous = response.plan;
    }
    return { previous, choice };
  }
  async *turn(raw: unknown, principal: Principal, signal: AbortSignal): AsyncIterable<Event> {
    if (this.stopping) throw new Error('BACKEND_STOPPED');
    const input = TurnRequest.parse(raw);
    if (new TextEncoder().encode(JSON.stringify(input)).length > this.catalog.limits.maxBytes)
      throw new FoundationError({
        code: 'BUDGET_EXCEEDED',
        path: '',
        message: 'Request is too large',
      });
    const requestId = id('request');
    const begin = await this.journal.beginTurn(
      {
        requestId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        idempotencyKey: input.idempotencyKey,
        operation: 'turn',
        fingerprint: fingerprint(input),
        workerId: this.workerId,
        leaseMs: this.leaseMs,
      },
      input.text,
      principal,
      signal,
    );
    if (begin.kind === 'existing') {
      yield* this.existing(begin.request.requestId, principal, signal);
      return;
    }
    const controller = new AbortController();
    if (this.stopping) controller.abort();
    const execution = AbortSignal.any([signal, controller.signal]);
    this.active.set(this.key(principal, requestId), controller);
    const stopHeartbeat = this.startLeaseHeartbeat(requestId, principal, controller);
    const base = {
      protocolVersion: 2 as const,
      requestId,
      conversationId: input.conversationId,
      messageId: input.messageId,
    };
    let sequence = 0;
    let committed = false;
    let startedPublished = false;
    let terminal = false;
    const make = (payload: object) =>
      ProtocolEvent.parse({ ...base, eventId: id('event'), sequence: sequence++, ...payload });
    try {
      const started = make({ type: 'request.started' });
      await this.journal.append(started, principal, execution);
      startedPublished = true;
      yield started;
      const context = await this.previous(input, principal, execution);
      const plan = await this.runtime.plan(
        this.agent,
        input.text,
        principal,
        execution,
        context.previous,
        1,
        input.components,
        context.choice,
      );
      const responseId = id('response');
      const accepted = make({
        type: 'plan.accepted',
        responseId,
        revision: 1,
        generation: 0,
        bindingIds: plan.bindings.map((b) => b.id),
      });
      await this.journal.append(accepted, principal, execution);
      yield accepted;
      const queued: Event[] = [];
      let notify: (() => void) | null = null;
      let execDone = false;
      let execError: unknown;
      const pushBindingEvent = async (
        payload:
          | { type: 'binding.pending'; bindingId: string }
          | { type: 'binding.ready'; bindingId: string; rowCount: number; truncated: boolean }
          | { type: 'binding.failed'; bindingId: string; message: string },
      ) => {
        const event = make(
          payload.type === 'binding.failed'
            ? {
                type: 'binding.failed',
                responseId,
                revision: 1,
                generation: 0,
                bindingId: payload.bindingId,
                diagnostic: {
                  code: 'SOURCE_FAILURE',
                  targetId: payload.bindingId,
                  message: payload.message,
                  retryable: true,
                },
              }
            : { ...payload, responseId, revision: 1, generation: 0 },
        );
        await this.journal.append(event, principal, execution);
        queued.push(event);
        notify?.();
        notify = null;
      };
      const execPromise = this.runtime
        .execute(plan, principal, execution, input.components, true, pushBindingEvent)
        .then(
          (res) => {
            execDone = true;
            notify?.();
            notify = null;
            return res;
          },
          (err) => {
            execDone = true;
            execError = err;
            notify?.();
            notify = null;
            throw err;
          },
        );
      while (!execDone || queued.length > 0) {
        if (queued.length > 0) {
          yield queued.shift()!;
        } else {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      }
      if (execError) throw execError;
      const result = await execPromise;
      const materialized = await this.runtime.ingest(
        plan,
        result.datasets,
        principal,
        execution,
        { messageId: input.messageId, responseId, revision: 1, generation: 0 },
        input.components,
        result.failedBindings,
      );
      await this.checkRemoteCancel(requestId, principal, controller);
      execution.throwIfAborted();
      const response = await this.controls.attach(materialized, principal, execution, {
        enableControls: true,
        components: input.components,
      });
      committed = true;
      // A cancellation after the durable snapshot commit is too late to revoke that commit.
      const publication = new AbortController().signal;
      await this.conversations.attach(
        input.conversationId,
        input.messageId,
        response.responseId,
        principal,
        publication,
      );
      const update = make({ type: 'response.committed', response });
      await this.journal.append(update, principal, publication);
      const completed = make({ type: 'request.completed' });
      await this.journal.append(completed, principal, publication);
      terminal = true;
      yield update;
      yield completed;
    } catch (error) {
      if (committed || !startedPublished) throw error;
      const publication = new AbortController().signal;
      const cancelled = execution.aborted;
      const message = cancelled ? 'Request cancelled.' : safeMessage;
      await this.conversations.failure(
        input.conversationId,
        input.messageId,
        message,
        principal,
        publication,
      );
      const failed = make(
        cancelled
          ? { type: 'request.cancelled' }
          : {
              type: 'request.failed',
              diagnostic: {
                code: error instanceof FoundationError ? error.diagnostic.code : 'SOURCE_FAILURE',
                message,
                retryable: true,
              },
            },
      );
      await this.journal.append(failed, principal, publication);
      terminal = true;
      yield failed;
    } finally {
      stopHeartbeat();
      this.active.delete(this.key(principal, requestId));
      if (!terminal)
        await this.journal
          .interrupt(requestId, principal, new AbortController().signal)
          .catch(() => {});
    }
  }
  async *action(raw: unknown, principal: Principal, signal: AbortSignal): AsyncIterable<Event> {
    if (this.stopping) throw new Error('BACKEND_STOPPED');
    const input = BackendAction.parse(raw);
    if (new TextEncoder().encode(JSON.stringify(input)).length > this.catalog.limits.maxBytes)
      throw new FoundationError({
        code: 'BUDGET_EXCEEDED',
        path: '',
        message: 'Request is too large',
      });
    const actionReg = this.catalog.action(input.action, principal);
    if (!actionReg.payload.safeParse(input.payload).success)
      throw new FoundationError({
        code: 'SCHEMA_INVALID',
        path: 'payload',
        message: 'Invalid action payload',
      });
    const location = await this.conversations.locate(input.responseId, principal, signal);
    let scopeChange:
      | { controlLabel: string; text: string; newMessageId: string; userMessageId?: string }
      | undefined;
    if (input.action.id === 'ui.setControl' && input.action.version === 1) {
      const baseSnapshot = await this.controls.read(input.responseId, principal, signal);
      const control = baseSnapshot.plan.blocks
        .flatMap((block) => (block.kind === 'visual' ? block.controls : []))
        .find((item) => item.id === input.payload.controlId);
      if (control?.scopeMode === 'change-answer') {
        const newMessageId = input.payload.newMessageId;
        if (typeof newMessageId !== 'string' || !newMessageId)
          throw new FoundationError({
            code: 'CAPABILITY_UNAVAILABLE',
            path: control.id,
            message: 'Changing answer scope requires a new message ID',
          });
        const val = input.payload.value;
        const valText =
          val === null ? 'all permitted values' : Array.isArray(val) ? val.join(', ') : String(val);
        scopeChange = {
          controlLabel: control.label,
          text: `Scope change (${control.label}): ${valText}`,
          newMessageId,
          ...(typeof input.payload.userMessageId === 'string'
            ? { userMessageId: input.payload.userMessageId }
            : {}),
        };
      }
    }
    const targetLocation = scopeChange
      ? { conversationId: location.conversationId, messageId: scopeChange.newMessageId }
      : location;
    const requestId = id('request');
    const begin = scopeChange
      ? await this.journal.beginTurn(
          {
            requestId,
            ...targetLocation,
            idempotencyKey: input.idempotencyKey,
            operation: 'control',
            fingerprint: fingerprint(input),
            workerId: this.workerId,
            leaseMs: this.leaseMs,
          },
          scopeChange.text,
          principal,
          signal,
          scopeChange.userMessageId,
        )
      : await this.journal.begin(
          {
            requestId,
            ...targetLocation,
            idempotencyKey: input.idempotencyKey,
            operation: 'control',
            fingerprint: fingerprint(input),
            workerId: this.workerId,
            leaseMs: this.leaseMs,
          },
          principal,
          signal,
        );
    if (begin.kind === 'existing') {
      yield* this.existing(begin.request.requestId, principal, signal);
      return;
    }
    const controller = new AbortController();
    if (this.stopping) controller.abort();
    const execution = AbortSignal.any([signal, controller.signal]);
    this.active.set(this.key(principal, requestId), controller);
    const stopHeartbeat = this.startLeaseHeartbeat(requestId, principal, controller);
    const base = { protocolVersion: 2 as const, requestId, ...targetLocation };
    let sequence = 0;
    let committed = false;
    let startedPublished = false;
    let terminal = false;
    const make = (payload: object) =>
      ProtocolEvent.parse({ ...base, eventId: id('event'), sequence: sequence++, ...payload });
    try {
      const started = make({ type: 'request.started' });
      await this.journal.append(started, principal, execution);
      startedPublished = true;
      yield started;
      const response =
        input.action.id === 'ui.retryBinding' && input.action.version === 1
          ? await this.controls.retry(
              {
                responseId: input.responseId,
                revision: input.revision,
                generation: input.generation,
                bindingId: input.payload.bindingId,
                idempotencyKey: input.idempotencyKey,
              },
              principal,
              execution,
            )
          : input.action.id === 'ui.setControl' && input.action.version === 1
            ? await this.controls.change(
                {
                  responseId: input.responseId,
                  revision: input.revision,
                  generation: input.generation,
                  controlId: input.payload.controlId,
                  value: input.payload.value,
                  idempotencyKey: input.idempotencyKey,
                  ...(scopeChange ? { newMessageId: scopeChange.newMessageId } : {}),
                  ...(scopeChange?.userMessageId
                    ? { userMessageId: scopeChange.userMessageId }
                    : {}),
                },
                principal,
                execution,
              )
            : await this.controls.performAction(input, principal, execution);
      committed = true;
      const publication = new AbortController().signal;
      if (scopeChange) {
        await this.conversations.attach(
          targetLocation.conversationId,
          targetLocation.messageId,
          response.responseId,
          principal,
          publication,
        );
      }
      const update = make({ type: 'response.committed', response });
      await this.journal.append(update, principal, publication);
      const completed = make({ type: 'request.completed' });
      await this.journal.append(completed, principal, publication);
      terminal = true;
      yield update;
      yield completed;
    } catch (error) {
      if (committed || !startedPublished) throw error;
      const publication = new AbortController().signal;
      const cancelled = execution.aborted;
      const message = cancelled ? 'Request cancelled.' : safeMessage;
      if (scopeChange) {
        await this.conversations.failure(
          targetLocation.conversationId,
          targetLocation.messageId,
          message,
          principal,
          publication,
        );
      }
      const failed = make(
        cancelled
          ? { type: 'request.cancelled' }
          : {
              type: 'request.failed',
              diagnostic: {
                code: error instanceof FoundationError ? error.diagnostic.code : 'SOURCE_FAILURE',
                message,
                retryable: true,
              },
            },
      );
      await this.journal.append(failed, principal, publication);
      terminal = true;
      yield failed;
    } finally {
      stopHeartbeat();
      this.active.delete(this.key(principal, requestId));
      if (!terminal)
        await this.journal
          .interrupt(requestId, principal, new AbortController().signal)
          .catch(() => {});
    }
  }
}
