import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  type Artifact,
  type Event,
  type Filters,
  type Plan,
} from '../contracts/index.ts';
import type { Principal } from '../catalog/index.ts';

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, owner TEXT NOT NULL, tenant TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_scopes(conversation TEXT PRIMARY KEY REFERENCES conversations(id), domains TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, conversation TEXT NOT NULL REFERENCES conversations(id), idem TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(conversation,idem));
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL, text TEXT NOT NULL, artifact TEXT, revision INTEGER);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, conversation TEXT NOT NULL REFERENCES conversations(id), revision INTEGER NOT NULL, view TEXT NOT NULL, saved TEXT);
      CREATE TABLE IF NOT EXISTS revisions(artifact TEXT NOT NULL REFERENCES artifacts(id), revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(artifact,revision));
      CREATE TABLE IF NOT EXISTS events(request TEXT NOT NULL REFERENCES requests(id), sequence INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(request,sequence));`);
    if (
      !this.db
        .prepare('PRAGMA table_info(messages)')
        .all()
        .some((r) => r.name === 'evidence')
    )
      this.db.exec('ALTER TABLE messages ADD COLUMN evidence TEXT');
    // A process restart cannot leave a request pretending to still run.
    this.db.prepare("UPDATE requests SET status='interrupted' WHERE status='running'").run();
  }
  close() {
    this.db.close();
  }
  authorize(conversation: string, p: Principal) {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(conversation);
    const scope = this.db
      .prepare('SELECT domains FROM conversation_scopes WHERE conversation=?')
      .get(conversation);
    if (
      !row ||
      !scope ||
      p.revoked ||
      row.owner !== p.id ||
      row.tenant !== p.tenant ||
      !(JSON.parse(String(scope.domains)) as string[]).every((d) => p.domains.includes(d))
    )
      throw new AppError('DATA_FORBIDDEN', 403);
  }
  conversation(id: string, p: Principal, create = false) {
    if (create) {
      const inserted = this.db
        .prepare('INSERT OR IGNORE INTO conversations VALUES(?,?,?)')
        .run(id, p.id, p.tenant);
      if (inserted.changes)
        this.db
          .prepare('INSERT INTO conversation_scopes VALUES(?,?)')
          .run(id, JSON.stringify(p.domains));
    }
    this.authorize(id, p);
    const messages = this.db
      .prepare('SELECT * FROM messages WHERE conversation=? ORDER BY rowid')
      .all(id);
    const artifacts = this.db
      .prepare('SELECT view,saved FROM artifacts WHERE conversation=? ORDER BY rowid')
      .all(id)
      .map((r) => JSON.parse(String(r.saved ?? r.view)) as Artifact);
    const attachedMessages = messages.map((message) => {
      if (!message.artifact || !message.revision) return message;
      const current = artifacts.find(
        (a) => a.artifactId === message.artifact && a.revision === message.revision,
      );
      return {
        ...message,
        visual: current ?? this.artifact(String(message.artifact), p, Number(message.revision)),
      };
    });
    return { id, messages: attachedMessages, artifacts };
  }
  message(
    conversation: string,
    role: string,
    text: string,
    artifact?: Artifact,
    evidence?: unknown,
  ) {
    this.db
      .prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        conversation,
        role,
        text,
        artifact?.artifactId ?? null,
        artifact?.revision ?? null,
        evidence ? JSON.stringify(evidence) : null,
      );
  }
  start(conversation: string, idem: string, fingerprint: string, p: Principal) {
    this.conversation(conversation, p, true);
    const old = this.db
      .prepare('SELECT * FROM requests WHERE conversation=? AND idem=?')
      .get(conversation, idem);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new AppError('IDEMPOTENCY_CONFLICT', 409);
      return { id: String(old.id), existing: true, status: String(old.status) };
    }
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO requests VALUES(?,?,?,?,?)')
      .run(id, conversation, idem, fingerprint, 'running');
    return { id, existing: false, status: 'running' };
  }
  request(id: string, p: Principal) {
    const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    if (!row) throw new AppError('NOT_FOUND', 404);
    this.authorize(String(row.conversation), p);
    return row;
  }
  finish(id: string, status: string) {
    this.db.prepare('UPDATE requests SET status=? WHERE id=?').run(status, id);
  }
  append(requestId: string, type: Event['type'], payload: unknown, artifact?: Artifact) {
    const row = this.db
      .prepare('SELECT MAX(sequence) AS seq FROM events WHERE request=?')
      .get(requestId);
    const event: Event = {
      protocolVersion: 1,
      eventId: randomUUID(),
      requestId,
      sequence: Number(row?.seq ?? 0) + 1,
      type,
      payload,
      ...(artifact
        ? {
            artifactId: artifact.artifactId,
            revision: artifact.revision,
            generationId: artifact.generationId,
          }
        : {}),
    };
    this.db
      .prepare('INSERT INTO events VALUES(?,?,?)')
      .run(requestId, event.sequence, JSON.stringify(event));
    this.db
      .prepare('DELETE FROM events WHERE request=? AND sequence<=?')
      .run(requestId, event.sequence - 200);
    return event;
  }
  events(id: string, p: Principal, after = 0) {
    this.request(id, p);
    const first = this.db
      .prepare('SELECT MIN(sequence) AS seq FROM events WHERE request=?')
      .get(id);
    if (first?.seq && after < Number(first.seq) - 1) throw new AppError('REPLAY_EXPIRED', 410);
    return this.db
      .prepare('SELECT body FROM events WHERE request=? AND sequence>? ORDER BY sequence')
      .all(id, after)
      .map((r) => JSON.parse(String(r.body)) as Event);
  }
  artifact(id: string, p: Principal, revision?: number): Artifact {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id);
    if (!row) throw new AppError('NOT_FOUND', 404);
    this.authorize(String(row.conversation), p);
    const body = revision
      ? this.db
          .prepare('SELECT body FROM revisions WHERE artifact=? AND revision=?')
          .get(id, revision)?.body
      : row.view;
    if (!body) throw new AppError('NOT_FOUND', 404);
    return JSON.parse(String(body));
  }
  commit(conversation: string, plan: Plan, sourceHash: string, p: Principal, previous?: Artifact) {
    this.authorize(conversation, p);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (previous) {
        const row = this.db
          .prepare('SELECT conversation,revision FROM artifacts WHERE id=?')
          .get(previous.artifactId);
        if (!row || row.conversation !== conversation) throw new AppError('DATA_FORBIDDEN', 403);
        if (row.revision !== previous.revision) throw new AppError('REVISION_CONFLICT', 409);
      }
      const filters: Filters = Object.fromEntries(
        plan.filters.map((f) => [
          f.id,
          previous?.plan.filters.some(
            (old) =>
              old.id === f.id &&
              old.optionsSource === f.optionsSource &&
              old.defaultValue === f.defaultValue,
          )
            ? (previous.filters[f.id as keyof Filters] ?? f.defaultValue)
            : f.defaultValue,
        ]),
      );
      const a: Artifact = {
        artifactId: previous?.artifactId ?? randomUUID(),
        revision: (previous?.revision ?? 0) + 1,
        plan,
        sourceHash,
        filters,
        generationId: (previous?.generationId ?? 0) + 1,
        datasets: {},
        catalogVersion: '1',
        adapterVersion: 'openui-1.1.1',
      };
      const body = JSON.stringify(a);
      if (previous)
        this.db
          .prepare('UPDATE artifacts SET revision=?,view=?,saved=NULL WHERE id=?')
          .run(a.revision, body, a.artifactId);
      else
        this.db
          .prepare('INSERT INTO artifacts VALUES(?,?,?,?,NULL)')
          .run(a.artifactId, conversation, a.revision, body);
      this.db.prepare('INSERT INTO revisions VALUES(?,?,?)').run(a.artifactId, a.revision, body);
      this.db.exec('COMMIT');
      return a;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  update(a: Artifact) {
    const row = this.db
      .prepare('SELECT view FROM artifacts WHERE id=? AND revision=?')
      .get(a.artifactId, a.revision);
    if (!row) return false;
    const old = JSON.parse(String(row.view)) as Artifact;
    if (old.generationId > a.generationId) return false;
    this.db.prepare('UPDATE artifacts SET view=? WHERE id=?').run(JSON.stringify(a), a.artifactId);
    return true;
  }
  retainSnapshot(a: Artifact) {
    // A revision's first settled result is immutable; later filters only change its view.
    const row = this.db
      .prepare('SELECT body FROM revisions WHERE artifact=? AND revision=?')
      .get(a.artifactId, a.revision);
    if (row && Object.keys((JSON.parse(String(row.body)) as Artifact).datasets).length === 0)
      this.db
        .prepare('UPDATE revisions SET body=? WHERE artifact=? AND revision=?')
        .run(JSON.stringify(a), a.artifactId, a.revision);
  }
  save(a: Artifact) {
    this.db.prepare('UPDATE artifacts SET saved=? WHERE id=?').run(JSON.stringify(a), a.artifactId);
  }
}
