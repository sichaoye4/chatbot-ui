import type { CapabilityRef } from '../contracts/foundation.ts';
import type { MaterializedResponse } from '../contracts/protocol.ts';

export type StoredControlSnapshot = {
  response: MaterializedResponse;
  scopes: Record<string, string>;
  components?: CapabilityRef[];
};
export type StoredControlRequest = { fingerprint: string; snapshot: StoredControlSnapshot };
export type ControlCommit = {
  owner: string;
  responseId: string;
  baseRevision: number;
  baseGeneration: number;
  idempotencyKey: string;
  fingerprint: string;
  snapshot: StoredControlSnapshot;
};
export type ControlCommitResult =
  | { kind: 'committed'; snapshot: StoredControlSnapshot }
  | { kind: 'replayed'; snapshot: StoredControlSnapshot }
  | { kind: 'conflict' }
  | { kind: 'idempotency-conflict' };

/** Implementations must atomically compare the head, save a snapshot and record idempotency. */
export interface ControlSnapshotStore {
  create(owner: string, snapshot: StoredControlSnapshot): boolean;
  current(owner: string, responseId: string): StoredControlSnapshot | undefined;
  version(
    owner: string,
    responseId: string,
    revision: number,
    generation: number,
  ): StoredControlSnapshot | undefined;
  request(owner: string, idempotencyKey: string): StoredControlRequest | undefined;
  commit(input: ControlCommit): ControlCommitResult;
}

/** Non-durable store intended for embeddings and tests. */
export class MemoryControlSnapshotStore implements ControlSnapshotStore {
  private readonly snapshots = new Map<string, Map<string, StoredControlSnapshot>>();
  private readonly heads = new Map<string, string>();
  private readonly requests = new Map<string, StoredControlRequest>();
  private key(owner: string, responseId: string) {
    return JSON.stringify([owner, responseId]);
  }
  private versionKey(revision: number, generation: number) {
    return `${revision}:${generation}`;
  }
  create(owner: string, snapshot: StoredControlSnapshot) {
    const key = this.key(owner, snapshot.response.responseId);
    if (this.heads.has(key)) return false;
    const version = this.versionKey(snapshot.response.revision, snapshot.response.generation);
    this.heads.set(key, version);
    this.snapshots.set(key, new Map([[version, structuredClone(snapshot)]]));
    return true;
  }
  current(owner: string, responseId: string) {
    const key = this.key(owner, responseId);
    const head = this.heads.get(key);
    const snapshot = head && this.snapshots.get(key)?.get(head);
    return snapshot ? structuredClone(snapshot) : undefined;
  }
  version(owner: string, responseId: string, revision: number, generation: number) {
    const snapshot = this.snapshots
      .get(this.key(owner, responseId))
      ?.get(this.versionKey(revision, generation));
    return snapshot ? structuredClone(snapshot) : undefined;
  }
  request(owner: string, idempotencyKey: string) {
    const item = this.requests.get(JSON.stringify([owner, idempotencyKey]));
    return item ? structuredClone(item) : undefined;
  }
  commit(input: ControlCommit): ControlCommitResult {
    const requestKey = JSON.stringify([input.owner, input.idempotencyKey]);
    const prior = this.requests.get(requestKey);
    if (prior)
      return prior.fingerprint === input.fingerprint
        ? { kind: 'replayed', snapshot: structuredClone(prior.snapshot) }
        : { kind: 'idempotency-conflict' };
    const key = this.key(input.owner, input.responseId);
    if (
      this.heads.get(key) !== this.versionKey(input.baseRevision, input.baseGeneration) ||
      input.snapshot.response.responseId !== input.responseId ||
      input.snapshot.response.revision !== input.baseRevision ||
      input.snapshot.response.generation !== input.baseGeneration + 1
    )
      return { kind: 'conflict' };
    const next = structuredClone(input.snapshot);
    const version = this.versionKey(next.response.revision, next.response.generation);
    this.snapshots.get(key)!.set(version, next);
    this.heads.set(key, version);
    this.requests.set(requestKey, {
      fingerprint: input.fingerprint,
      snapshot: structuredClone(next),
    });
    return { kind: 'committed', snapshot: structuredClone(next) };
  }
}
