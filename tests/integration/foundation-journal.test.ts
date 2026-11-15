import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRequestJournal } from '../../packages/server-runtime/request-journal.ts';
import {
  AuthorizedRequestJournal,
  type JournalPolicy,
} from '../../packages/server-runtime/authorized-journal.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import { SqliteConversationStore } from '../../packages/server-runtime/conversation-store.ts';
import { catalog, plan, principal, result } from '../fixtures/foundation-domains.ts';

const signal = () => new AbortController().signal;
const request = {
  requestId: 'request1',
  conversationId: 'conversation1',
  messageId: 'message1',
  idempotencyKey: 'turn1',
  operation: 'turn',
  fingerprint: 'hash1',
};
const event = (type: string, sequence: number, payload: object = {}) => ({
  protocolVersion: 2,
  requestId: 'request1',
  conversationId: 'conversation1',
  messageId: 'message1',
  eventId: `event${sequence}`,
  sequence,
  type,
  ...payload,
});
async function fixtureResponse() {
  const c = catalog();
  return new FoundationRuntime(c).ingest(
    plan(c),
    { data: result([{ date: '2024-01-01', net: 130 }], 'one row per day') },
    principal,
    signal(),
    { messageId: 'message1', responseId: 'response1', revision: 1, generation: 0 },
  );
}

test('journal persists ordered events, idempotency and authorized replay across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'foundation-journal-'));
  const path = join(directory, 'journal.sqlite');
  let now = 1000;
  let epoch = 1;
  let responses = 0;
  let recoveries = 0;
  const response = await fixtureResponse();
  const policy: JournalPolicy = {
    owner: (who) => String(who.context.account ?? ''),
    scope: async (_conversation, who) =>
      who.subject === principal.subject ? `epoch-${epoch}` : '',
    response: async (stored) => {
      responses++;
      assert.deepEqual(stored, response);
    },
    recovery: async (id) => {
      recoveries++;
      assert.equal(id, 'response1');
    },
  };
  let store: SqliteRequestJournal | undefined;
  try {
    store = new SqliteRequestJournal(path, { maxEvents: 3, retentionMs: 5000, now: () => now });
    let journal = new AuthorizedRequestJournal(store, policy);
    assert.equal((await journal.begin(request, principal, signal())).kind, 'created');
    assert.equal(
      (await journal.begin({ ...request, requestId: 'different' }, principal, signal())).request
        .requestId,
      'request1',
    );
    await assert.rejects(
      journal.begin({ ...request, fingerprint: 'other' }, principal, signal()),
      /IDEMPOTENCY_CONFLICT/,
    );
    await journal.append(event('request.started', 0), principal, signal());
    await journal.append(event('text.delta', 1, { text: 'Working' }), principal, signal());
    await journal.append(event('response.committed', 2, { response }), principal, signal());
    await journal.append(event('request.completed', 3), principal, signal());
    await assert.rejects(
      journal.append(event('text.delta', 4, { text: 'Late' }), principal, signal()),
      /EVENT_LIFECYCLE_INVALID/,
    );
    store.close();
    store = undefined;
    store = new SqliteRequestJournal(path, { maxEvents: 3, retentionMs: 5000, now: () => now });
    journal = new AuthorizedRequestJournal(store, policy);
    const replay = await journal.replay('request1', 0, principal, signal());
    assert.equal(replay.kind, 'events');
    if (replay.kind === 'events')
      assert.deepEqual(
        replay.events.map((item) => item.sequence),
        [1, 2, 3],
      );
    assert.ok(responses >= 2);
    const expired = await journal.replay('request1', -1, principal, signal());
    assert.deepEqual(expired, { kind: 'expired', status: 'completed', responseId: 'response1' });
    assert.equal(recoveries, 1);
    await assert.rejects(
      journal.replay('request1', 0, { subject: 'other', context: { account: 'other' } }, signal()),
      /DATA_FORBIDDEN/,
    );
    epoch = 2;
    await assert.rejects(journal.replay('request1', 0, principal, signal()), /DATA_FORBIDDEN/);
    epoch = 1;
    now += 5001;
    assert.equal((await journal.replay('request1', 3, principal, signal())).kind, 'expired');
    assert.equal(store.purgeExpired(), 3);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('journal rejects gaps, duplicate event IDs, and marks stopped requests interrupted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'foundation-journal-'));
  const path = join(directory, 'journal.sqlite');
  let now = 100;
  let store: SqliteRequestJournal | undefined;
  try {
    store = new SqliteRequestJournal(path, { maxEvents: 1, retentionMs: 1000, now: () => now });
    const owner = 'owner1';
    store.begin(owner, { ...request, scopeKey: 'scope1' });
    assert.throws(
      () => store!.append(owner, event('text.delta', 0, { text: 'bad' })),
      /EVENT_LIFECYCLE_INVALID/,
    );
    store.append(owner, event('request.started', 0));
    assert.throws(
      () => store!.append(owner, event('text.delta', 2, { text: 'gap' })),
      /EVENT_SEQUENCE_INVALID/,
    );
    assert.throws(
      () =>
        store!.append(owner, {
          ...event('text.delta', 1, { text: 'duplicate' }),
          eventId: 'event0',
        }),
      /EVENT_DUPLICATE/,
    );
    store.append(owner, event('text.delta', 1, { text: 'partial' }));
    now += 1001;
    store.purgeExpired();
    assert.throws(
      () =>
        store!.append(owner, {
          ...event('text.delta', 2, { text: 'duplicate after purge' }),
          eventId: 'event0',
        }),
      /EVENT_DUPLICATE/,
    );
    store.close();
    store = undefined;
    store = new SqliteRequestJournal(path, { maxEvents: 1, retentionMs: 1000, now: () => now });
    assert.equal(store.interruptRunning(), 1);
    assert.equal(store.metadata(owner, 'request1')?.status, 'interrupted');
    assert.equal(store.replay(owner, 'request1', 0).kind, 'expired');
    assert.throws(
      () => store!.append(owner, event('request.completed', 2)),
      /EVENT_LIFECYCLE_INVALID/,
    );
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('journal rechecks authorization after inspecting a replayed response', async () => {
  const response = await fixtureResponse();
  let epoch = 1;
  const store = new SqliteRequestJournal(':memory:', { maxEvents: 10, retentionMs: 10000 });
  const policy: JournalPolicy = {
    owner: () => 'owner1',
    scope: async () => `epoch-${epoch}`,
    response: async () => {
      epoch = 2;
    },
    recovery: async () => {},
  };
  const journal = new AuthorizedRequestJournal(store, policy);
  try {
    await journal.begin(request, principal, signal());
    await journal.append(event('request.started', 0), principal, signal());
    // Insert with unchanged authorization, then revoke only during the replay check.
    policy.response = async () => {};
    await journal.append(event('response.committed', 1, { response }), principal, signal());
    policy.response = async () => {
      epoch = 2;
    };
    await assert.rejects(journal.replay('request1', -1, principal, signal()), /DATA_FORBIDDEN/);
  } finally {
    store.close();
  }
});

test('turn request and conversation messages commit or roll back together', () => {
  const store = new SqliteRequestJournal(':memory:', { maxEvents: 10, retentionMs: 10000 });
  const messages = new SqliteConversationStore(store.connectionForConversations());
  try {
    const input = { ...request, scopeKey: 'scope1' };
    assert.equal(store.beginTurn('owner1', input, 'First question').kind, 'created');
    assert.equal(
      store.beginTurn('owner1', { ...input, requestId: 'different' }, 'First question').kind,
      'existing',
    );
    assert.throws(
      () =>
        store.beginTurn(
          'owner1',
          { ...input, requestId: 'request2', idempotencyKey: 'turn2', fingerprint: 'hash2' },
          'Second question',
        ),
      /MESSAGE_CONFLICT/,
    );
    assert.equal(store.metadata('owner1', 'request2'), undefined);
    assert.equal(messages.history('owner1', 'conversation1', 'scope1').length, 2);
  } finally {
    messages.close();
    store.close();
  }
});
