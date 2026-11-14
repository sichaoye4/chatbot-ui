import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../packages/server-runtime/store.ts';
import { ArtifactSchema, type Artifact } from '../../packages/contracts/index.ts';
import type { Principal } from '../../packages/catalog/index.ts';

test('frozen v1 conversation restores original message revisions after process reopen', () => {
  const fixture = JSON.parse(readFileSync('tests/fixtures/v1-conversation.json', 'utf8')) as {
    principal: Principal;
    conversationId: string;
    revisions: Artifact[];
  };
  const dir = mkdtempSync(join(tmpdir(), 'foundation-legacy-'));
  const path = join(dir, 'baseline.sqlite');
  let store = new Store(path);
  try {
    const p = fixture.principal;
    const id = fixture.conversationId;
    // Seed frozen serialized bodies directly: no current plan builder or commit path can mask drift.
    store.db.prepare('INSERT INTO conversations VALUES(?,?,?)').run(id, p.id, p.tenant);
    store.db
      .prepare('INSERT INTO conversation_scopes VALUES(?,?)')
      .run(id, JSON.stringify(p.domains));
    const latest = fixture.revisions.at(-1)!;
    store.db
      .prepare('INSERT INTO artifacts VALUES(?,?,?,?,?)')
      .run(latest.artifactId, id, latest.revision, JSON.stringify(latest), JSON.stringify(latest));
    for (const artifact of fixture.revisions) {
      ArtifactSchema.parse(artifact);
      store.db
        .prepare('INSERT INTO revisions VALUES(?,?,?)')
        .run(artifact.artifactId, artifact.revision, JSON.stringify(artifact));
      store.db
        .prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)')
        .run(
          `message_${artifact.revision}`,
          id,
          'assistant',
          'Synthetic baseline',
          artifact.artifactId,
          artifact.revision,
          null,
        );
    }
    store.close();
    store = new Store(path);
    const restored = store.conversation(id, p);
    const messages = restored.messages as unknown as { visual: Artifact }[];
    assert.deepEqual(
      messages.map((m) => m.visual),
      fixture.revisions,
    );
    assert.equal(messages[0].visual.plan.panels.length, 1);
    assert.equal(messages[1].visual.plan.panels.length, 2);
    assert.throws(() => store.conversation(id, { ...p, domains: [] }), /DATA_FORBIDDEN/);
    assert.throws(() => store.conversation(id, { ...p, tenant: 'other' }), /DATA_FORBIDDEN/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
