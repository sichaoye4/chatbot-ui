import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { LocalId } from '../contracts/foundation.ts';
import {
  ProtocolEvent,
  ReplayResult,
  RequestStatus,
  type ProtocolEvent as Event,
} from '../contracts/protocol.ts';
import { initializeConversationDatabase, prepareTurnInTransaction } from './conversation-store.ts';

const BeginRequest = z.strictObject({
  requestId: LocalId,
  conversationId: LocalId,
  messageId: LocalId,
  idempotencyKey: LocalId,
  operation: z.string().min(1).max(160),
  fingerprint: z.string().min(1).max(1000),
  scopeKey: z.string().min(1).max(16000),
  workerId: z.string().max(160).optional(),
  leaseMs: z.number().int().positive().max(3_600_000).optional(),
});
export type JournalRequest = z.infer<typeof BeginRequest> & {
  status: z.infer<typeof RequestStatus>;
  lastSequence: number;
  responseId?: string;
  cancelRequested?: boolean;
};
/** Storage only: callers must authorize the owner, conversation and every response before replay. */
export class SqliteRequestJournal {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly options: { maxEvents: number; retentionMs: number; now?: () => number },
  ) {
    if (
      !Number.isSafeInteger(options.maxEvents) ||
      options.maxEvents < 1 ||
      options.maxEvents > 1000 ||
      !Number.isSafeInteger(options.retentionMs) ||
      options.retentionMs < 1
    )
      throw new Error('Invalid journal retention');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS v2_journal_requests(owner TEXT NOT NULL, request_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, idem TEXT NOT NULL, operation TEXT NOT NULL, fingerprint TEXT NOT NULL, scope_key TEXT NOT NULL, status TEXT NOT NULL, last_sequence INTEGER NOT NULL, floor_sequence INTEGER NOT NULL, updated_at INTEGER NOT NULL, response_id TEXT, worker_id TEXT NOT NULL DEFAULT '', lease_expires_at INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,request_id), UNIQUE(owner,idem));
      CREATE TABLE IF NOT EXISTS v2_journal_events(owner TEXT NOT NULL, request_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner,request_id,sequence), UNIQUE(owner,event_id), FOREIGN KEY(owner,request_id) REFERENCES v2_journal_requests(owner,request_id));`);
    const columns = new Set(
      this.db
        .prepare('PRAGMA table_info(v2_journal_requests)')
        .all()
        .map((c) => String((c as { name: unknown }).name)),
    );
    if (!columns.has('worker_id'))
      this.db.exec("ALTER TABLE v2_journal_requests ADD COLUMN worker_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has('lease_expires_at'))
      this.db.exec(
        'ALTER TABLE v2_journal_requests ADD COLUMN lease_expires_at INTEGER NOT NULL DEFAULT 0',
      );
    if (!columns.has('cancel_requested'))
      this.db.exec(
        'ALTER TABLE v2_journal_requests ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0',
      );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS v2_journal_event_ids(owner TEXT NOT NULL, event_id TEXT NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY(owner,event_id), FOREIGN KEY(owner,request_id) REFERENCES v2_journal_requests(owner,request_id));',
    );
    this.db.exec(
      'INSERT OR IGNORE INTO v2_journal_event_ids(owner,event_id,request_id) SELECT owner,event_id,request_id FROM v2_journal_events',
    );
    initializeConversationDatabase(this.db);
  }
  close() {
    this.db.close();
  }
  /** A conversation store borrowing this connection shares atomic turn creation, including :memory:. */
  connectionForConversations() {
    return this.db;
  }
  private now() {
    return (this.options.now ?? Date.now)();
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
  private row(owner: string, requestId: string) {
    return this.db
      .prepare('SELECT * FROM v2_journal_requests WHERE owner=? AND request_id=?')
      .get(owner, requestId);
  }
  private parse(row: Record<string, unknown>): JournalRequest {
    try {
      return {
        ...BeginRequest.parse({
          requestId: row.request_id,
          conversationId: row.conversation_id,
          messageId: row.message_id,
          idempotencyKey: row.idem,
          operation: row.operation,
          fingerprint: row.fingerprint,
          scopeKey: row.scope_key,
        }),
        status: RequestStatus.parse(row.status),
        lastSequence: z.number().int().min(-1).parse(row.last_sequence),
        ...(row.response_id == null ? {} : { responseId: LocalId.parse(row.response_id) }),
      };
    } catch {
      throw new Error('JOURNAL_CORRUPT');
    }
  }
  begin(owner: string, raw: unknown): { kind: 'created' | 'existing'; request: JournalRequest } {
    if (!owner) throw new Error('JOURNAL_OWNER_REQUIRED');
    const input = BeginRequest.parse(raw);
    return this.transaction(() => this.beginInTransaction(owner, input));
  }
  beginTurn(
    owner: string,
    raw: unknown,
    text: string,
    userMessageId?: string,
  ): { kind: 'created' | 'existing'; request: JournalRequest } {
    if (!owner) throw new Error('JOURNAL_OWNER_REQUIRED');
    const input = BeginRequest.parse(raw);
    return this.transaction(() => {
      const result = this.beginInTransaction(owner, input);
      prepareTurnInTransaction(
        this.db,
        owner,
        {
          conversationId: input.conversationId,
          requestId: result.request.requestId,
          userMessageId: userMessageId ?? `user${result.request.requestId}`,
          assistantMessageId: input.messageId,
          text,
          scopeKey: input.scopeKey,
        },
        this.now(),
      );
      return result;
    });
  }
  private beginInTransaction(
    owner: string,
    input: z.infer<typeof BeginRequest>,
  ): { kind: 'created' | 'existing'; request: JournalRequest } {
    const existing = this.db
      .prepare('SELECT * FROM v2_journal_requests WHERE owner=? AND idem=?')
      .get(owner, input.idempotencyKey);
    if (existing) {
      const request = this.parse(existing);
      if (
        request.fingerprint !== input.fingerprint ||
        request.operation !== input.operation ||
        request.conversationId !== input.conversationId ||
        request.messageId !== input.messageId ||
        request.scopeKey !== input.scopeKey
      )
        throw new Error('IDEMPOTENCY_CONFLICT');
      return { kind: 'existing', request };
    }
    if (this.row(owner, input.requestId)) throw new Error('REQUEST_CONFLICT');
    this.db
      .prepare('INSERT INTO v2_journal_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        owner,
        input.requestId,
        input.conversationId,
        input.messageId,
        input.idempotencyKey,
        input.operation,
        input.fingerprint,
        input.scopeKey,
        'pending',
        -1,
        0,
        this.now(),
        null,
        input.workerId ?? '',
        input.leaseMs ? this.now() + input.leaseMs : 0,
        0,
      );
    return { kind: 'created', request: { ...input, status: 'pending', lastSequence: -1 } };
  }
  metadata(owner: string, requestId: string) {
    const row = this.row(owner, requestId);
    return row ? this.parse(row) : undefined;
  }
  latest(owner: string, conversationId: string, messageId: string) {
    const row = this.db
      .prepare(
        'SELECT * FROM v2_journal_requests WHERE owner=? AND conversation_id=? AND message_id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(owner, conversationId, messageId);
    return row ? this.parse(row) : undefined;
  }
  append(owner: string, raw: unknown): JournalRequest {
    const event = ProtocolEvent.parse(raw);
    return this.transaction(() => {
      const row = this.row(owner, event.requestId);
      if (!row) throw new Error('REQUEST_UNAVAILABLE');
      const request = this.parse(row);
      if (
        request.conversationId !== event.conversationId ||
        request.messageId !== event.messageId ||
        (event.type === 'response.committed' && event.response.messageId !== event.messageId)
      )
        throw new Error('EVENT_TARGET_MISMATCH');
      if (event.sequence !== request.lastSequence + 1) throw new Error('EVENT_SEQUENCE_INVALID');
      if (
        (request.status === 'pending' && event.type !== 'request.started') ||
        (request.status !== 'pending' && request.status !== 'running') ||
        (request.status === 'running' && event.type === 'request.started')
      )
        throw new Error('EVENT_LIFECYCLE_INVALID');
      if (event.type === 'response.committed' && request.responseId)
        throw new Error('EVENT_LIFECYCLE_INVALID');
      if (
        this.db
          .prepare('SELECT 1 FROM v2_journal_event_ids WHERE owner=? AND event_id=?')
          .get(owner, event.eventId)
      )
        throw new Error('EVENT_DUPLICATE');
      const status =
        event.type === 'request.completed'
          ? 'completed'
          : event.type === 'request.failed'
            ? 'failed'
            : event.type === 'request.cancelled'
              ? 'cancelled'
              : 'running';
      const responseId =
        event.type === 'response.committed' ? event.response.responseId : request.responseId;
      this.db
        .prepare('INSERT INTO v2_journal_event_ids VALUES(?,?,?)')
        .run(owner, event.eventId, event.requestId);
      this.db
        .prepare('INSERT INTO v2_journal_events VALUES(?,?,?,?,?)')
        .run(owner, event.requestId, event.sequence, event.eventId, JSON.stringify(event));
      const floor = Math.max(
        Number(row.floor_sequence),
        event.sequence - this.options.maxEvents + 1,
        this.now() - Number(row.updated_at) > this.options.retentionMs ? event.sequence : 0,
      );
      this.db
        .prepare('DELETE FROM v2_journal_events WHERE owner=? AND request_id=? AND sequence<?')
        .run(owner, event.requestId, floor);
      this.db
        .prepare(
          'UPDATE v2_journal_requests SET status=?, last_sequence=?, floor_sequence=?, updated_at=?, response_id=? WHERE owner=? AND request_id=?',
        )
        .run(status, event.sequence, floor, this.now(), responseId ?? null, owner, event.requestId);
      return {
        ...request,
        status,
        lastSequence: event.sequence,
        ...(responseId ? { responseId } : {}),
      };
    });
  }
  replay(owner: string, requestId: string, afterSequence: number): ReplayResult {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < -1)
      throw new Error('REPLAY_CURSOR_INVALID');
    const row = this.row(owner, requestId);
    if (!row) throw new Error('REQUEST_UNAVAILABLE');
    const request = this.parse(row);
    if (afterSequence > request.lastSequence) throw new Error('REPLAY_CURSOR_INVALID');
    if (
      afterSequence < Number(row.floor_sequence) - 1 ||
      this.now() - Number(row.updated_at) > this.options.retentionMs
    )
      return ReplayResult.parse({
        kind: 'expired',
        status: request.status,
        ...(request.responseId ? { responseId: request.responseId } : {}),
      });
    const records = this.db
      .prepare(
        'SELECT body FROM v2_journal_events WHERE owner=? AND request_id=? AND sequence>? ORDER BY sequence',
      )
      .all(owner, requestId, afterSequence);
    let events: Event[];
    try {
      events = records.map((record) => ProtocolEvent.parse(JSON.parse(String(record.body))));
    } catch {
      throw new Error('JOURNAL_CORRUPT');
    }
    if (
      events.some(
        (event, index) =>
          event.requestId !== requestId ||
          event.conversationId !== request.conversationId ||
          event.messageId !== request.messageId ||
          event.sequence !== afterSequence + index + 1,
      ) ||
      (afterSequence < request.lastSequence && events.at(-1)?.sequence !== request.lastSequence)
    )
      throw new Error('JOURNAL_CORRUPT');
    return ReplayResult.parse({ kind: 'events', status: request.status, events });
  }
  /** Only call during exclusive single-process startup, never while another worker owns requests. */
  interruptRunning() {
    return Number(
      this.db
        .prepare(
          "UPDATE v2_journal_requests SET status='interrupted' WHERE status IN ('pending','running')",
        )
        .run().changes,
    );
  }
  interrupt(owner: string, requestId: string) {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE v2_journal_requests SET status='interrupted', updated_at=? WHERE owner=? AND request_id=? AND status IN ('pending','running')",
          )
          .run(this.now(), owner, requestId).changes,
      ) === 1
    );
  }
  /** Multi-worker safe: interrupt only requests whose worker lease has expired. */
  interruptStaleLeases() {
    const now = this.now();
    return Number(
      this.db
        .prepare(
          "UPDATE v2_journal_requests SET status='interrupted', updated_at=? WHERE status IN ('pending','running') AND lease_expires_at > 0 AND lease_expires_at < ?",
        )
        .run(now, now).changes,
    );
  }
  renewLease(owner: string, requestId: string, workerId: string, leaseMs: number) {
    const now = this.now();
    return this.transaction(() => {
      const updated = this.db
        .prepare(
          "UPDATE v2_journal_requests SET lease_expires_at=?, updated_at=? WHERE owner=? AND request_id=? AND worker_id=? AND status IN ('pending','running')",
        )
        .run(now + leaseMs, now, owner, requestId, workerId);
      const row = this.row(owner, requestId) as Record<string, unknown> | undefined;
      return {
        active: Number(updated.changes) === 1,
        cancelRequested: row ? Number(row.cancel_requested) === 1 : false,
      };
    });
  }
  requestCancel(owner: string, requestId: string) {
    const now = this.now();
    return this.transaction(() => {
      const updated = this.db
        .prepare(
          "UPDATE v2_journal_requests SET cancel_requested=1, updated_at=? WHERE owner=? AND request_id=? AND status IN ('pending','running')",
        )
        .run(now, owner, requestId);
      if (Number(updated.changes) === 1) return true;
      const row = this.row(owner, requestId) as Record<string, unknown> | undefined;
      return Boolean(
        row &&
        (row.status === 'pending' || row.status === 'running') &&
        Number(row.cancel_requested) === 1,
      );
    });
  }
  isCancelRequested(owner: string, requestId: string) {
    const row = this.row(owner, requestId) as Record<string, unknown> | undefined;
    return Boolean(row && Number(row.cancel_requested) === 1);
  }
  purgeExpired() {
    const cutoff = this.now() - this.options.retentionMs;
    return this.transaction(() => {
      const deleted = this.db
        .prepare(
          'DELETE FROM v2_journal_events WHERE EXISTS (SELECT 1 FROM v2_journal_requests r WHERE r.owner=v2_journal_events.owner AND r.request_id=v2_journal_events.request_id AND r.updated_at<?)',
        )
        .run(cutoff);
      this.db
        .prepare(
          "DELETE FROM v2_journal_event_ids WHERE EXISTS (SELECT 1 FROM v2_journal_requests r WHERE r.owner=v2_journal_event_ids.owner AND r.request_id=v2_journal_event_ids.request_id AND r.status IN ('completed','failed','cancelled','interrupted') AND r.updated_at<?)",
        )
        .run(cutoff);
      this.db
        .prepare('UPDATE v2_journal_requests SET floor_sequence=last_sequence+1 WHERE updated_at<?')
        .run(cutoff);
      return Number(deleted.changes);
    });
  }
}
