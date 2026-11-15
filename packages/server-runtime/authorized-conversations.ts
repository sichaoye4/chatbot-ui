import { FoundationError, type Principal } from '../contracts/foundation.ts';
import { ConversationSnapshot } from '../contracts/protocol.ts';
import type { JournalPolicy } from './authorized-journal.ts';
import type { FoundationControlService } from './controls.ts';
import type { SqliteConversationStore } from './conversation-store.ts';

function denied(): never {
  throw new FoundationError({
    code: 'DATA_FORBIDDEN',
    path: '',
    message: 'Conversation is unavailable',
  });
}
/** Host policy owns identity and conversation access; every restored response is independently reauthorized. */
export class AuthorizedConversations {
  constructor(
    private readonly store: SqliteConversationStore,
    private readonly controls: FoundationControlService,
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
  async prepare(
    input: {
      conversationId: string;
      requestId: string;
      userMessageId: string;
      assistantMessageId: string;
      text: string;
    },
    principal: Principal,
    signal: AbortSignal,
  ) {
    const scopeKey = await this.scope(input.conversationId, principal, signal);
    if ((await this.scope(input.conversationId, principal, signal)) !== scopeKey) denied();
    this.store.prepareTurn(this.owner(principal), { ...input, scopeKey });
  }
  async attach(
    conversationId: string,
    messageId: string,
    responseId: string,
    principal: Principal,
    signal: AbortSignal,
  ) {
    const scopeKey = await this.scope(conversationId, principal, signal);
    const response = await this.controls.read(responseId, principal, signal);
    if (
      response.messageId !== messageId ||
      (await this.scope(conversationId, principal, signal)) !== scopeKey
    )
      denied();
    this.store.attach(this.owner(principal), conversationId, messageId, responseId, scopeKey);
  }
  async failure(
    conversationId: string,
    messageId: string,
    text: string,
    principal: Principal,
    signal: AbortSignal,
  ) {
    const scopeKey = await this.scope(conversationId, principal, signal);
    if ((await this.scope(conversationId, principal, signal)) !== scopeKey) denied();
    this.store.setAssistantText(this.owner(principal), conversationId, messageId, text, scopeKey);
  }
  async history(conversationId: string, principal: Principal, signal: AbortSignal) {
    const scopeKey = await this.scope(conversationId, principal, signal);
    const rows = this.store.history(this.owner(principal), conversationId, scopeKey);
    const messages = [];
    for (const row of rows)
      messages.push({
        id: row.id,
        role: row.role,
        text: row.text,
        ...(row.responseId
          ? { response: await this.controls.read(row.responseId, principal, signal) }
          : {}),
      });
    if ((await this.scope(conversationId, principal, signal)) !== scopeKey) denied();
    return ConversationSnapshot.parse({ conversationId, messages });
  }
  async locate(responseId: string, principal: Principal, signal: AbortSignal) {
    const result = this.store.locate(this.owner(principal), responseId) ?? denied();
    const scopeKey = await this.scope(result.conversationId, principal, signal);
    this.store.requireScope(this.owner(principal), result.conversationId, scopeKey);
    await this.controls.read(responseId, principal, signal);
    if ((await this.scope(result.conversationId, principal, signal)) !== scopeKey) denied();
    return result;
  }
}
