import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import { FoundationControlService } from '../../packages/server-runtime/controls.ts';
import { SqliteControlSnapshotStore } from '../../packages/server-runtime/control-sqlite.ts';
import { SqliteConversationStore } from '../../packages/server-runtime/conversation-store.ts';
import { AuthorizedConversations } from '../../packages/server-runtime/authorized-conversations.ts';
import type { JournalPolicy } from '../../packages/server-runtime/authorized-journal.ts';
import { catalog, plan, principal, result } from '../fixtures/foundation-domains.ts';

const signal = () => new AbortController().signal;
test('v2 conversation restores stored response snapshots after restart and rechecks scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'foundation-conversation-'));
  const path = join(directory, 'conversation.sqlite');
  let epoch = 1;
  const policy: JournalPolicy = {
    owner: (who) => String(who.context.account ?? ''),
    scope: async () => `epoch-${epoch}`,
    response: async () => {},
    recovery: async () => {},
  };
  let snapshots: SqliteControlSnapshotStore | undefined;
  let messages: SqliteConversationStore | undefined;
  try {
    const c = catalog();
    const response = await new FoundationRuntime(c).ingest(
      plan(c),
      { data: result([{ date: '2024-01-01', net: 130 }], 'one row per day') },
      principal,
      signal(),
      { messageId: 'assistant1', responseId: 'response1', revision: 1, generation: 0 },
    );
    snapshots = new SqliteControlSnapshotStore(path);
    messages = new SqliteConversationStore(path);
    let controls = new FoundationControlService(c, policy.owner, snapshots);
    let conversations = new AuthorizedConversations(messages, controls, policy);
    const turn = {
      conversationId: 'conversation1',
      requestId: 'request1',
      userMessageId: 'user1',
      assistantMessageId: 'assistant1',
      text: 'Show revenue',
    };
    await conversations.prepare(turn, principal, signal());
    await conversations.prepare(turn, principal, signal());
    await assert.rejects(
      conversations.prepare({ ...turn, text: 'Different message' }, principal, signal()),
      /MESSAGE_CONFLICT/,
    );
    await controls.attach(response, principal, signal(), { enableControls: false });
    await conversations.attach('conversation1', 'assistant1', 'response1', principal, signal());
    assert.equal(
      (await conversations.history('conversation1', principal, signal())).messages.length,
      2,
    );
    snapshots.close();
    snapshots = undefined;
    messages.close();
    messages = undefined;
    snapshots = new SqliteControlSnapshotStore(path);
    messages = new SqliteConversationStore(path);
    controls = new FoundationControlService(catalog(), policy.owner, snapshots);
    conversations = new AuthorizedConversations(messages, controls, policy);
    const restored = await conversations.history('conversation1', principal, signal());
    assert.equal(restored.messages[0].text, 'Show revenue');
    assert.equal(restored.messages[1].response?.datasets.data.status, 'ready');
    assert.deepEqual(await conversations.locate('response1', principal, signal()), {
      conversationId: 'conversation1',
      messageId: 'assistant1',
    });
    const other = { subject: 'other', context: { account: 'other' } };
    assert.deepEqual((await conversations.history('conversation1', other, signal())).messages, []);
    await assert.rejects(conversations.locate('response1', other, signal()), /DATA_FORBIDDEN/);
    epoch = 2;
    await assert.rejects(
      conversations.history('conversation1', principal, signal()),
      /DATA_FORBIDDEN/,
    );
    await assert.rejects(conversations.locate('response1', principal, signal()), /DATA_FORBIDDEN/);
  } finally {
    messages?.close();
    snapshots?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
