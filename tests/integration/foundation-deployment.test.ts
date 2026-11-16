import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApplication, signAuthToken } from '../../apps/reference-server/server.ts';
import { createCsvFoundationBackend } from '../../examples/csv-analytics/reference-v2.ts';
import { CsvRepository, SOURCE_HASH } from '../../examples/csv-analytics/index.ts';
import { SqliteControlSnapshotStore } from '../../packages/server-runtime/control-sqlite.ts';
import { SqliteConversationStore } from '../../packages/server-runtime/conversation-store.ts';
import { SqliteRequestJournal } from '../../packages/server-runtime/request-journal.ts';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import { FoundationControlService } from '../../packages/server-runtime/controls.ts';
import {
  domains,
  permissivePolicy,
  plan,
  principal,
  result,
} from '../fixtures/foundation-domains.ts';

const signal = () => new AbortController().signal;

test('reference HTTP server enforces host bearer authentication, rejects spoofing and expired tokens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundation-auth-'));
  const secret = 'test-signing-secret-must-be-at-least-32-bytes';
  const app = createApplication({
    database: join(dir, 'auth.sqlite'),
    mode: 'deterministic',
    authSecret: secret,
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (app.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    // Ready check stays reachable without user token
    const readyRes = await fetch(`${base}/api/ready`);
    assert.equal(readyRes.status, 200);

    // Unauthenticated requests fail 401 AUTHENTICATION_EXPIRED even if x-test-principal is spoofed
    const unauth = await fetch(`${base}/api/v2/capabilities`, {
      headers: { 'x-test-principal': 'limited' },
    });
    assert.equal(unauth.status, 401);
    assert.deepEqual(await unauth.json(), { error: 'AUTHENTICATION_EXPIRED' });

    // Expired token fails 401
    const expiredToken = signAuthToken(
      { id: 'alice', tenant: 't1', domains: ['payment'], policyEpoch: 1 },
      secret,
      1000,
      Date.now() - 5000,
    );
    const expiredRes = await fetch(`${base}/api/session`, {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    assert.equal(expiredRes.status, 401);
    assert.deepEqual(await expiredRes.json(), { error: 'AUTHENTICATION_EXPIRED' });

    // Valid token authenticates and scopes conversations per tenant/subject
    const aliceToken = signAuthToken(
      { id: 'alice', tenant: 't1', domains: ['payment'], policyEpoch: 1 },
      secret,
    );
    const bobToken = signAuthToken(
      { id: 'bob', tenant: 't2', domains: ['kyc'], policyEpoch: 1 },
      secret,
    );
    const sessionRes = await fetch(`${base}/api/session`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    assert.equal(sessionRes.status, 200);
    const session = (await sessionRes.json()) as { identityMode: string; domainOptions: string[] };
    assert.equal(session.identityMode, 'host-authenticated');
    assert.deepEqual(session.domainOptions, ['payment']);

    const capsRes = await fetch(`${base}/api/v2/capabilities`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    assert.equal(capsRes.status, 200);
    const caps = (await capsRes.json()) as { components: { id: string; version: number }[] };

    const turnRes = await fetch(`${base}/api/v2/turns`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        conversationId: 'alice_conv',
        messageId: 'm1',
        text: 'Hello',
        idempotencyKey: 'auth_turn_1',
        components: caps.components,
        previous: [],
      }),
    });
    assert.equal(turnRes.status, 200);
    await turnRes.text();

    // Alice sees her conversation; Bob sees an empty list (separate owner isolation)
    const aliceHistory = (await (
      await fetch(`${base}/api/v2/conversations/alice_conv`, {
        headers: { Authorization: `Bearer ${aliceToken}` },
      })
    ).json()) as { messages: unknown[] };
    assert.equal(aliceHistory.messages.length, 2);

    const bobHistory = (await (
      await fetch(`${base}/api/v2/conversations/alice_conv`, {
        headers: { Authorization: `Bearer ${bobToken}` },
      })
    ).json()) as { messages: unknown[] };
    assert.equal(bobHistory.messages.length, 0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite stores enforce retention purge for expired requests, conversations and superseded snapshots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundation-retention-'));
  let clock = 1_000_000;
  const dbPath = join(dir, 'retention.sqlite');
  const journal = new SqliteRequestJournal(dbPath, {
    maxEvents: 50,
    retentionMs: 1000,
    now: () => clock,
  });
  const conversations = new SqliteConversationStore(journal.connectionForConversations());
  const snapshots = new SqliteControlSnapshotStore(dbPath, () => clock);
  try {
    journal.beginTurn(
      'owner1',
      {
        requestId: 'req_old',
        conversationId: 'conv_old',
        messageId: 'm_old',
        idempotencyKey: 'idem_old',
        operation: 'turn',
        fingerprint: 'fp1',
        scopeKey: 's1',
      },
      'Old turn',
    );
    journal.append('owner1', {
      protocolVersion: 2,
      eventId: 'ev1',
      requestId: 'req_old',
      sequence: 0,
      conversationId: 'conv_old',
      messageId: 'm_old',
      type: 'request.started',
    });
    const c = registerBuiltins(new FoundationCatalog(permissivePolicy));
    c.registerDomain(domains[1]);
    const r = await new FoundationRuntime(c).ingest(
      plan(c),
      { data: result([{ date: '2024-01-01', net: 170 }], 'one row per day') },
      principal,
      signal(),
      { messageId: 'm_old', responseId: 'resp_old', revision: 1, generation: 0 },
    );
    const service = new FoundationControlService(c, () => 'owner1', snapshots);
    await service.attach(r, principal, signal(), { enableControls: false });
    // Force an older superseded snapshot + control request timestamp for purge verification
    const second = { ...r, generation: 1 };
    snapshots.commit({
      owner: 'owner1',
      responseId: 'resp_old',
      baseRevision: 1,
      baseGeneration: 0,
      idempotencyKey: 'ckey1',
      fingerprint: 'cfp1',
      snapshot: { response: second, scopes: { data: 'fixture-scope-v1' } },
    });

    clock += 5000;
    const purgedEvents = journal.purgeExpired();
    const purgedConvs = conversations.purgeExpired(1000, clock);
    const purgedSnaps = snapshots.purgeExpired(1000);
    assert.ok(purgedEvents >= 1);
    assert.equal(purgedConvs, 1);
    assert.ok(purgedSnaps >= 1);
    assert.equal(journal.replay('owner1', 'req_old', -1).kind, 'expired');
    assert.equal(conversations.history('owner1', 'conv_old', 's1').length, 0);
    // Active head generation remains readable
    assert.equal((await service.read('resp_old', principal, signal())).generation, 1);
  } finally {
    snapshots.close();
    conversations.close();
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-worker workers preserve live leases on restart, cancel across processes and interrupt stale leases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundation-workers-'));
  const dbPath = join(dir, 'shared.sqlite');
  const repo = new CsvRepository('sample_data/training_data_masked_final_1.csv', SOURCE_HASH);
  let now = 1_000_000;
  let releaseSlowPlanner!: () => void;
  let plannerEntered = false;
  let notifyPlannerEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    notifyPlannerEntered = resolve;
  });
  const workerA = createCsvFoundationBackend(
    repo,
    dbPath,
    'deterministic',
    {
      propose: async (ctx) => {
        plannerEntered = true;
        notifyPlannerEntered();
        await new Promise<void>((resolve, reject) => {
          releaseSlowPlanner = resolve;
          ctx.signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
        });
        return {
          schemaVersion: 2,
          capabilitySnapshotId: (ctx.capabilities as { id: string }).id,
          bindings: [],
          facts: [],
          blocks: [{ id: 't', kind: 'text', parts: [{ text: 'done' }] }],
        };
      },
    },
    { workerId: 'worker-a', leaseMs: 1000, multiWorker: true, now: () => now },
  );
  let workerB: ReturnType<typeof createCsvFoundationBackend> | undefined;
  try {
    const csvPrincipal = {
      subject: 'demo',
      context: {
        csvIdentity: { id: 'demo', tenant: 'demo', domains: ['payment'], policyEpoch: 1 },
      },
    };
    const components = workerA.backend.negotiate(csvPrincipal).components;
    const events: { type: string; requestId: string }[] = [];
    const streamTask = (async () => {
      for await (const ev of workerA.backend.turn(
        {
          conversationId: 'mw_conv',
          messageId: 'mw_msg',
          text: 'Slow report',
          idempotencyKey: 'mw_turn_1',
          components,
          previous: [],
        },
        csvPrincipal,
        signal(),
      ))
        events.push({ type: ev.type, requestId: ev.requestId });
    })();
    await entered;
    assert.equal(plannerEntered, true);

    // Worker B boots against the SAME SQLite file in multiWorker mode without killing Worker A's live lease!
    workerB = createCsvFoundationBackend(repo, dbPath, 'deterministic', undefined, {
      workerId: 'worker-b',
      leaseMs: 1000,
      multiWorker: true,
      now: () => now,
    });
    const activeRequestId = events[0].requestId;
    assert.equal(
      workerB.requestStore.metadata(JSON.stringify(['demo', 'demo']), activeRequestId)?.status,
      'running',
    );

    // Worker B handles HTTP cancel for Worker A's active request via shared SQLite cancel_requested flag
    const cancelRes = await workerB.backend.cancel(activeRequestId, csvPrincipal, signal());
    assert.equal(cancelRes.accepted, true);
    await streamTask;
    assert.equal(events.at(-1)?.type, 'request.cancelled');
    assert.equal(
      (await workerB.backend.history('mw_conv', csvPrincipal, signal())).messages[1].response,
      undefined,
    );

    // Now test stale expired lease cleanup when a crashed worker left a request running past lease_expires_at
    workerB.requestStore.beginTurn(
      JSON.stringify(['demo', 'demo']),
      {
        requestId: 'req_crashed',
        conversationId: 'mw_conv2',
        messageId: 'mw_msg2',
        idempotencyKey: 'mw_turn_2',
        operation: 'turn',
        fingerprint: 'fp2',
        scopeKey: JSON.stringify({
          id: 'demo',
          tenant: 'demo',
          domains: ['payment'],
          policyEpoch: 1,
        }),
        workerId: 'crashed-worker',
        leaseMs: 500,
      },
      'Crashed query',
    );
    now += 2000;
    assert.equal(workerB.requestStore.interruptStaleLeases(), 1);
    assert.equal(
      workerB.requestStore.metadata(JSON.stringify(['demo', 'demo']), 'req_crashed')?.status,
      'interrupted',
    );
    releaseSlowPlanner?.();
  } finally {
    workerA.close();
    workerB?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
