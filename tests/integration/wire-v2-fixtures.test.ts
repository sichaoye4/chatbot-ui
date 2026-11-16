import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConversationSnapshot,
  MaterializedResponse,
  Negotiation,
  OptionPage,
  ProtocolEvent,
  ReplayResult,
} from '../../packages/contracts/protocol.ts';

const wireDir = join(process.cwd(), 'tests/fixtures/wire-v2');

test('v2 wire fixtures match TypeScript schemas and independent Python validator', () => {
  const tc = JSON.parse(readFileSync(join(wireDir, 'text-and-clarification.json'), 'utf8'));
  Negotiation.parse(tc.negotiation);
  for (const ev of [...tc.clarifyEvents, ...tc.textEvents]) ProtocolEvent.parse(ev);
  ConversationSnapshot.parse(tc.snapshot);

  const va = JSON.parse(readFileSync(join(wireDir, 'visual-with-actions.json'), 'utf8'));
  Negotiation.parse(va.negotiation);
  for (const name of [
    'initialEvents',
    'paginateEvents',
    'sortEvents',
    'refreshEvents',
    'scopeChangeEvents',
  ])
    for (const ev of va[name]) ProtocolEvent.parse(ev);
  ConversationSnapshot.parse(va.conversation);

  const pr = JSON.parse(readFileSync(join(wireDir, 'partial-and-retry.json'), 'utf8'));
  for (const name of ['partialTurnEvents', 'retryEvents', 'failedEvents'])
    for (const ev of pr[name]) ProtocolEvent.parse(ev);

  const ing = JSON.parse(readFileSync(join(wireDir, 'ingested-precomputed.json'), 'utf8'));
  MaterializedResponse.parse(ing.ingestedResponse);

  const rep = JSON.parse(readFileSync(join(wireDir, 'replay-and-errors.json'), 'utf8'));
  OptionPage.parse(rep.optionPage);
  ReplayResult.parse(rep.replayEvents);
  ReplayResult.parse(rep.replayExpired);

  const out = execFileSync('python', ['tests/oracles/verify_wire_v2.py'], { encoding: 'utf8' });
  assert.match(out, /wire-v2 validation passed/);
});
