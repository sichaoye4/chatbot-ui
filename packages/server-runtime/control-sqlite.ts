import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { CapabilityRef, LocalId } from '../contracts/foundation.ts';
import { MaterializedResponse } from '../contracts/protocol.ts';
import type {
  ControlCommit,
  ControlCommitResult,
  ControlSnapshotStore,
  StoredControlRequest,
  StoredControlSnapshot,
} from './control-store.ts';

const Snapshot = z.strictObject({
  response: MaterializedResponse,
  scopes: z.record(LocalId, z.string()),
  components: z.array(CapabilityRef).optional(),
});

/** Reference SQLite adapter. Atomic commit includes the new head, immutable snapshot and request key. */
export class SqliteControlSnapshotStore implements ControlSnapshotStore {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS v2_control_heads(owner TEXT NOT NULL, response_id TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(owner,response_id));
      CREATE TABLE IF NOT EXISTS v2_control_snapshots(owner TEXT NOT NULL, response_id TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,response_id,revision,generation), FOREIGN KEY(owner,response_id) REFERENCES v2_control_heads(owner,response_id));
      CREATE TABLE IF NOT EXISTS v2_control_requests(owner TEXT NOT NULL, idem TEXT NOT NULL, fingerprint TEXT NOT NULL, response_id TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,idem), FOREIGN KEY(owner,response_id,revision,generation) REFERENCES v2_control_snapshots(owner,response_id,revision,generation));`);
    for (const tbl of ['v2_control_snapshots', 'v2_control_requests']) {
      const cols = new Set(
        this.db
          .prepare(`PRAGMA table_info(${tbl})`)
          .all()
          .map((c) => String((c as { name: unknown }).name)),
      );
      if (!cols.has('updated_at'))
        this.db.exec(`ALTER TABLE ${tbl} ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`);
    }
  }
  close() {
    this.db.close();
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
  private parse(raw: unknown): StoredControlSnapshot | undefined {
    if (!raw) return undefined;
    try {
      return Snapshot.parse(JSON.parse(String((raw as { body: unknown }).body)));
    } catch {
      throw new Error('CONTROL_STORE_CORRUPT');
    }
  }
  create(owner: string, raw: StoredControlSnapshot) {
    const snapshot = Snapshot.parse(raw);
    return this.transaction(() => {
      const head = this.db
        .prepare('INSERT OR IGNORE INTO v2_control_heads VALUES(?,?,?,?)')
        .run(
          owner,
          snapshot.response.responseId,
          snapshot.response.revision,
          snapshot.response.generation,
        );
      if (!head.changes) return false;
      this.db
        .prepare(
          'INSERT INTO v2_control_snapshots(owner,response_id,revision,generation,body,updated_at) VALUES(?,?,?,?,?,?)',
        )
        .run(
          owner,
          snapshot.response.responseId,
          snapshot.response.revision,
          snapshot.response.generation,
          JSON.stringify(snapshot),
          this.now(),
        );
      return true;
    });
  }
  current(owner: string, responseId: string) {
    return this.parse(
      this.db
        .prepare(
          `SELECT s.body FROM v2_control_heads h JOIN v2_control_snapshots s ON s.owner=h.owner AND s.response_id=h.response_id AND s.revision=h.revision AND s.generation=h.generation WHERE h.owner=? AND h.response_id=?`,
        )
        .get(owner, responseId),
    );
  }
  version(owner: string, responseId: string, revision: number, generation: number) {
    return this.parse(
      this.db
        .prepare(
          'SELECT body FROM v2_control_snapshots WHERE owner=? AND response_id=? AND revision=? AND generation=?',
        )
        .get(owner, responseId, revision, generation),
    );
  }
  request(owner: string, idempotencyKey: string): StoredControlRequest | undefined {
    const row = this.db
      .prepare(
        `SELECT r.fingerprint, s.body FROM v2_control_requests r JOIN v2_control_snapshots s ON s.owner=r.owner AND s.response_id=r.response_id AND s.revision=r.revision AND s.generation=r.generation WHERE r.owner=? AND r.idem=?`,
      )
      .get(owner, idempotencyKey);
    if (!row) return undefined;
    return { fingerprint: String(row.fingerprint), snapshot: this.parse(row)! };
  }
  commit(input: ControlCommit): ControlCommitResult {
    const snapshot = Snapshot.parse(input.snapshot);
    const nextResponse = snapshot.response;
    const isNewRevision =
      nextResponse.responseId !== input.responseId &&
      nextResponse.revision === input.baseRevision + 1 &&
      nextResponse.generation === 0;
    const isNextGeneration =
      nextResponse.responseId === input.responseId &&
      nextResponse.revision === input.baseRevision &&
      nextResponse.generation === input.baseGeneration + 1;
    if (!isNewRevision && !isNextGeneration) return { kind: 'conflict' };
    return this.transaction(() => {
      const prior = this.request(input.owner, input.idempotencyKey);
      if (prior)
        return prior.fingerprint === input.fingerprint
          ? { kind: 'replayed', snapshot: prior.snapshot }
          : { kind: 'idempotency-conflict' };
      const head = this.db
        .prepare(
          'SELECT revision, generation FROM v2_control_heads WHERE owner=? AND response_id=?',
        )
        .get(input.owner, input.responseId);
      if (
        !head ||
        Number(head.revision) !== input.baseRevision ||
        Number(head.generation) !== input.baseGeneration
      )
        return { kind: 'conflict' };
      if (isNewRevision) {
        const insertedHead = this.db
          .prepare('INSERT OR IGNORE INTO v2_control_heads VALUES(?,?,?,?)')
          .run(
            input.owner,
            nextResponse.responseId,
            nextResponse.revision,
            nextResponse.generation,
          );
        if (!insertedHead.changes) return { kind: 'conflict' };
      } else {
        const updated = this.db
          .prepare(
            'UPDATE v2_control_heads SET revision=?, generation=? WHERE owner=? AND response_id=? AND revision=? AND generation=?',
          )
          .run(
            nextResponse.revision,
            nextResponse.generation,
            input.owner,
            input.responseId,
            input.baseRevision,
            input.baseGeneration,
          );
        if (!updated.changes) return { kind: 'conflict' };
      }
      this.db
        .prepare(
          'INSERT INTO v2_control_snapshots(owner,response_id,revision,generation,body,updated_at) VALUES(?,?,?,?,?,?)',
        )
        .run(
          input.owner,
          nextResponse.responseId,
          nextResponse.revision,
          nextResponse.generation,
          JSON.stringify(snapshot),
          this.now(),
        );
      this.db
        .prepare(
          'INSERT INTO v2_control_requests(owner,idem,fingerprint,response_id,revision,generation,updated_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          input.owner,
          input.idempotencyKey,
          input.fingerprint,
          nextResponse.responseId,
          nextResponse.revision,
          nextResponse.generation,
          this.now(),
        );
      return { kind: 'committed', snapshot };
    });
  }
  /** Prune superseded snapshot generations and old control idempotency keys past retention. */
  purgeExpired(retentionMs: number) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 1)
      throw new Error('Invalid control snapshot retention');
    const cutoff = this.now() - retentionMs;
    return this.transaction(() => {
      const reqs = this.db
        .prepare('DELETE FROM v2_control_requests WHERE updated_at > 0 AND updated_at < ?')
        .run(cutoff);
      const snaps = this.db
        .prepare(
          `DELETE FROM v2_control_snapshots
           WHERE updated_at > 0 AND updated_at < ?
             AND NOT EXISTS (SELECT 1 FROM v2_control_heads h WHERE h.owner=v2_control_snapshots.owner AND h.response_id=v2_control_snapshots.response_id AND h.revision=v2_control_snapshots.revision AND h.generation=v2_control_snapshots.generation)
             AND NOT EXISTS (SELECT 1 FROM v2_control_requests r WHERE r.owner=v2_control_snapshots.owner AND r.response_id=v2_control_snapshots.response_id AND r.revision=v2_control_snapshots.revision AND r.generation=v2_control_snapshots.generation)`,
        )
        .run(cutoff);
      return Number(reqs.changes) + Number(snaps.changes);
    });
  }
}
