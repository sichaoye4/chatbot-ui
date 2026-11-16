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
    const nextResponse = input.snapshot.response;
    const isNewRevision =
      nextResponse.responseId !== input.responseId &&
      nextResponse.revision === input.baseRevision + 1 &&
      nextResponse.generation === 0;
    const isNextGeneration =
      nextResponse.responseId === input.responseId &&
      nextResponse.revision === input.baseRevision &&
      nextResponse.generation === input.baseGeneration + 1;
    if (
      this.heads.get(key) !== this.versionKey(input.baseRevision, input.baseGeneration) ||
      (!isNewRevision && !isNextGeneration)
    )
      return { kind: 'conflict' };
    const next = structuredClone(input.snapshot);
    const targetKey = this.key(input.owner, nextResponse.responseId);
    const version = this.versionKey(nextResponse.revision, nextResponse.generation);
    if (isNewRevision) {
      if (this.heads.has(targetKey)) return { kind: 'conflict' };
      this.heads.set(targetKey, version);
      this.snapshots.set(targetKey, new Map([[version, next]]));
    } else {
      this.snapshots.get(key)!.set(version, next);
      this.heads.set(key, version);
    }
    this.requests.set(requestKey, {
      fingerprint: input.fingerprint,
      snapshot: structuredClone(next),
    });
    return { kind: 'committed', snapshot: structuredClone(next) };
  }
}
