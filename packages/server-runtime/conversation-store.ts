import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { LocalId } from '../contracts/foundation.ts';

const Turn = z.strictObject({
  conversationId: LocalId,
  requestId: LocalId,
  userMessageId: LocalId,
  assistantMessageId: LocalId,
  text: z.string().min(1).max(16000),
  scopeKey: z.string().min(1).max(16000),
});
export type StoredMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  responseId?: string;
};
export function initializeConversationDatabase(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS v2_conversations(owner TEXT NOT NULL, conversation_id TEXT NOT NULL, scope_key TEXT NOT NULL, PRIMARY KEY(owner,conversation_id));
      CREATE TABLE IF NOT EXISTS v2_messages(position INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, request_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL, response_id TEXT, UNIQUE(owner,conversation_id,message_id), UNIQUE(owner,conversation_id,request_id,role), FOREIGN KEY(owner,conversation_id) REFERENCES v2_conversations(owner,conversation_id));
      CREATE UNIQUE INDEX IF NOT EXISTS v2_message_response ON v2_messages(owner,response_id) WHERE response_id IS NOT NULL;`);
}
/** Caller owns the surrounding SQLite transaction. */
export function prepareTurnInTransaction(db: DatabaseSync, owner: string, raw: unknown) {
  if (!owner) throw new Error('CONVERSATION_OWNER_REQUIRED');
  const input = Turn.parse(raw);
  if (input.userMessageId === input.assistantMessageId) throw new Error('MESSAGE_CONFLICT');
  db.prepare('INSERT OR IGNORE INTO v2_conversations VALUES(?,?,?)').run(
    owner,
    input.conversationId,
    input.scopeKey,
  );
  const scope = db
    .prepare('SELECT scope_key FROM v2_conversations WHERE owner=? AND conversation_id=?')
    .get(owner, input.conversationId);
  if (!scope || scope.scope_key !== input.scopeKey) throw new Error('DATA_FORBIDDEN');
  const insert = db.prepare(
    'INSERT OR IGNORE INTO v2_messages(owner,conversation_id,message_id,request_id,role,text,response_id) VALUES(?,?,?,?,?,?,NULL)',
  );
  insert.run(owner, input.conversationId, input.userMessageId, input.requestId, 'user', input.text);
  insert.run(
    owner,
    input.conversationId,
    input.assistantMessageId,
    input.requestId,
    'assistant',
    '',
  );
  const rows = db
    .prepare(
      'SELECT message_id,role,text FROM v2_messages WHERE owner=? AND conversation_id=? AND request_id=?',
    )
    .all(owner, input.conversationId, input.requestId);
  if (
    rows.length !== 2 ||
    !rows.some(
      (row) =>
        row.role === 'user' && row.message_id === input.userMessageId && row.text === input.text,
    ) ||
    !rows.some((row) => row.role === 'assistant' && row.message_id === input.assistantMessageId)
  )
    throw new Error('MESSAGE_CONFLICT');
}

/** Reference storage; callers must authenticate and recheck policy before exposing any result. */
export class SqliteConversationStore {
  private readonly db: DatabaseSync;
  private readonly ownsConnection: boolean;
  constructor(path: string | DatabaseSync) {
    this.ownsConnection = typeof path === 'string';
    if (typeof path === 'string' && path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true });
    this.db = typeof path === 'string' ? new DatabaseSync(path) : path;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    initializeConversationDatabase(this.db);
  }
  close() {
    if (this.ownsConnection) this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  prepareTurn(owner: string, raw: unknown) {
    this.transaction(() => prepareTurnInTransaction(this.db, owner, raw));
  }
  attach(
    owner: string,
    conversationId: string,
    messageId: string,
    responseId: string,
    scopeKey: string,
  ) {
    LocalId.parse(conversationId);
    LocalId.parse(messageId);
    LocalId.parse(responseId);
    return this.transaction(() => {
      const scope = this.db
        .prepare('SELECT scope_key FROM v2_conversations WHERE owner=? AND conversation_id=?')
        .get(owner, conversationId);
      if (!scope || scope.scope_key !== scopeKey) throw new Error('DATA_FORBIDDEN');
      const updated = this.db
        .prepare(
          "UPDATE v2_messages SET response_id=? WHERE owner=? AND conversation_id=? AND message_id=? AND role='assistant' AND (response_id IS NULL OR response_id=?)",
        )
        .run(responseId, owner, conversationId, messageId, responseId);
      if (!updated.changes) throw new Error('MESSAGE_CONFLICT');
    });
  }
  setAssistantText(
    owner: string,
    conversationId: string,
    messageId: string,
    text: string,
    scopeKey: string,
  ) {
    LocalId.parse(conversationId);
    LocalId.parse(messageId);
    z.string().max(16000).parse(text);
    this.transaction(() => {
      const scope = this.db
        .prepare('SELECT scope_key FROM v2_conversations WHERE owner=? AND conversation_id=?')
        .get(owner, conversationId);
      if (!scope || scope.scope_key !== scopeKey) throw new Error('DATA_FORBIDDEN');
      const updated = this.db
        .prepare(
          "UPDATE v2_messages SET text=? WHERE owner=? AND conversation_id=? AND message_id=? AND role='assistant' AND response_id IS NULL",
        )
        .run(text, owner, conversationId, messageId);
      if (!updated.changes) throw new Error('MESSAGE_CONFLICT');
    });
  }
  history(owner: string, conversationId: string, scopeKey: string): StoredMessage[] {
    LocalId.parse(conversationId);
    const scope = this.db
      .prepare('SELECT scope_key FROM v2_conversations WHERE owner=? AND conversation_id=?')
      .get(owner, conversationId);
    if (!scope) return [];
    if (scope.scope_key !== scopeKey) throw new Error('DATA_FORBIDDEN');
    return this.db
      .prepare(
        'SELECT message_id,role,text,response_id FROM v2_messages WHERE owner=? AND conversation_id=? ORDER BY position',
      )
      .all(owner, conversationId)
      .map((row) => ({
        id: LocalId.parse(row.message_id),
        role: z.enum(['user', 'assistant']).parse(row.role),
        text: z.string().max(16000).parse(row.text),
        ...(row.response_id === null ? {} : { responseId: LocalId.parse(row.response_id) }),
      }));
  }
  requireScope(owner: string, conversationId: string, scopeKey: string) {
    const row = this.db
      .prepare('SELECT scope_key FROM v2_conversations WHERE owner=? AND conversation_id=?')
      .get(owner, conversationId);
    if (!row || row.scope_key !== scopeKey) throw new Error('DATA_FORBIDDEN');
  }
  locate(owner: string, responseId: string) {
    LocalId.parse(responseId);
    const row = this.db
      .prepare('SELECT conversation_id,message_id FROM v2_messages WHERE owner=? AND response_id=?')
      .get(owner, responseId);
    return row
      ? {
          conversationId: LocalId.parse(row.conversation_id),
          messageId: LocalId.parse(row.message_id),
        }
      : undefined;
  }
}
