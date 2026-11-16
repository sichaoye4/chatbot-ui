import { FoundationError, type Principal } from '../contracts/foundation.ts';
import { ProtocolEvent, type MaterializedResponse } from '../contracts/protocol.ts';
import type { SqliteRequestJournal } from './request-journal.ts';

export type JournalPolicy = {
  owner(principal: Principal): string;
  /** Authenticate and authorize conversation access; return a stable policy-epoch/scope token. */
  scope(conversationId: string, principal: Principal, signal: AbortSignal): Promise<string>;
  /** Reauthorize the exact stored generation and compare it to the event's response. */
  response(
    response: MaterializedResponse,
    principal: Principal,
    signal: AbortSignal,
  ): Promise<void>;
  /** Reauthorize the current snapshot before returning an expired-replay recovery reference. */
  recovery(responseId: string, principal: Principal, signal: AbortSignal): Promise<void>;
};
function denied(): never {
  throw new FoundationError({
    code: 'DATA_FORBIDDEN',
    path: '',
    message: 'Request is unavailable',
  });
}

/** Authorization wrapper for the storage journal; never expose the raw journal directly to clients. */
export class AuthorizedRequestJournal {
  constructor(
    private readonly store: SqliteRequestJournal,
    private readonly policy: JournalPolicy,
  ) {}
  private owner(principal: Principal) {
    return this.policy.owner(principal) || denied();
  }
  private async scope(conversationId: string, principal: Principal, signal: AbortSignal) {
    signal.throwIfAborted();
    const scope = await this.policy.scope(conversationId, principal, signal);
    signal.throwIfAborted();
    return scope || denied();
  }
  async begin(
    input: {
      requestId: string;
      conversationId: string;
      messageId: string;
      idempotencyKey: string;
      operation: string;
      fingerprint: string;
      workerId?: string;
      leaseMs?: number;
    },
    principal: Principal,
    signal: AbortSignal,
  ) {
    const scopeKey = await this.scope(input.conversationId, principal, signal);
    if ((await this.scope(input.conversationId, principal, signal)) !== scopeKey) denied();
    return this.store.begin(this.owner(principal), { ...input, scopeKey });
  }
  async beginTurn(
    input: {
      requestId: string;
      conversationId: string;
      messageId: string;
      idempotencyKey: string;
      operation: string;
      fingerprint: string;
      workerId?: string;
      leaseMs?: number;
    },
    text: string,
    principal: Principal,
    signal: AbortSignal,
    userMessageId?: string,
  ) {
    const scopeKey = await this.scope(input.conversationId, principal, signal);
    if ((await this.scope(input.conversationId, principal, signal)) !== scopeKey) denied();
    return this.store.beginTurn(this.owner(principal), { ...input, scopeKey }, text, userMessageId);
  }
  async append(raw: unknown, principal: Principal, signal: AbortSignal) {
    const event = ProtocolEvent.parse(raw);
    const owner = this.owner(principal);
    const request = this.store.metadata(owner, event.requestId) ?? denied();
    if (
      event.conversationId !== request.conversationId ||
      event.messageId !== request.messageId ||
      (event.type === 'response.committed' && event.response.messageId !== request.messageId)
    )
      denied();
    const before = await this.scope(request.conversationId, principal, signal);
    if (before !== request.scopeKey) denied();
    if (event.type === 'response.committed')
      await this.policy.response(event.response, principal, signal);
    if ((await this.scope(request.conversationId, principal, signal)) !== before) denied();
    return this.store.append(owner, event);
  }
  async replay(
    requestId: string,
    afterSequence: number,
    principal: Principal,
    signal: AbortSignal,
  ) {
    const owner = this.owner(principal);
    const request = this.store.metadata(owner, requestId) ?? denied();
    const before = await this.scope(request.conversationId, principal, signal);
    if (before !== request.scopeKey) denied();
    const page = this.store.replay(owner, requestId, afterSequence);
    if (page.kind === 'events') {
      for (const event of page.events)
        if (event.type === 'response.committed')
          await this.policy.response(event.response, principal, signal);
    } else if (page.responseId) await this.policy.recovery(page.responseId, principal, signal);
    if ((await this.scope(request.conversationId, principal, signal)) !== before) denied();
    return page;
  }
  async inspect(requestId: string, principal: Principal, signal: AbortSignal) {
    const request = this.store.metadata(this.owner(principal), requestId) ?? denied();
    const scope = await this.scope(request.conversationId, principal, signal);
    if (scope !== request.scopeKey) denied();
    return {
      requestId: request.requestId,
      conversationId: request.conversationId,
      messageId: request.messageId,
      status: request.status,
    };
  }
  async latest(
    conversationId: string,
    messageId: string,
    principal: Principal,
    signal: AbortSignal,
  ) {
    const request = this.store.latest(this.owner(principal), conversationId, messageId);
    if (!request) return undefined;
    const scope = await this.scope(conversationId, principal, signal);
    if (scope !== request.scopeKey) denied();
    return { requestId: request.requestId, status: request.status };
  }
  async interrupt(requestId: string, principal: Principal, signal: AbortSignal) {
    await this.inspect(requestId, principal, signal);
    return this.store.interrupt(this.owner(principal), requestId);
  }
  async renewLease(
    requestId: string,
    workerId: string,
    leaseMs: number,
    principal: Principal,
    signal: AbortSignal,
  ) {
    await this.inspect(requestId, principal, signal);
    return this.store.renewLease(this.owner(principal), requestId, workerId, leaseMs);
  }
  async requestCancel(requestId: string, principal: Principal, signal: AbortSignal) {
    await this.inspect(requestId, principal, signal);
    return this.store.requestCancel(this.owner(principal), requestId);
  }
  async isCancelRequested(requestId: string, principal: Principal, signal: AbortSignal) {
    await this.inspect(requestId, principal, signal);
    return this.store.isCancelRequested(this.owner(principal), requestId);
  }
}
