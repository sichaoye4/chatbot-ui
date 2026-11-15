import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FoundationHttpClient } from '../../packages/client-runtime/http.ts';

const base = {
  protocolVersion: 2,
  requestId: 'request1',
  conversationId: 'conversation1',
  messageId: 'message1',
};
const turn = {
  conversationId: 'conversation1',
  messageId: 'message1',
  idempotencyKey: 'turn1',
  text: 'Hello',
  components: [],
  previous: [],
};
function stream(frames: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
  );
}
test('HTTP adapter injects host authentication and parses fragmented CRLF SSE', async () => {
  const calls: string[] = [];
  const started = JSON.stringify({
    ...base,
    type: 'request.started',
    eventId: 'event1',
    sequence: 0,
  });
  const completed = JSON.stringify({
    ...base,
    type: 'request.completed',
    eventId: 'event2',
    sequence: 1,
  });
  const client = new FoundationHttpClient(
    'https://backend.test/api/v2',
    () => ({ Authorization: 'Bearer fixture' }),
    async (url, init) => {
      calls.push(String(url));
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture');
      if (String(url).endsWith('/capabilities'))
        return Response.json({
          protocolVersion: 2,
          components: [],
          operations: [],
          history: false,
          replay: false,
          cancellation: false,
        });
      assert.equal(JSON.parse(String(init?.body)).text, 'Hello');
      return stream([`data: ${started}\r`, `\n\r\ndata: ${completed}\r\n`, '\r\n']);
    },
  );
  assert.equal((await client.negotiate(new AbortController().signal)).protocolVersion, 2);
  const types = [];
  for await (const event of client.sendTurn(turn, new AbortController().signal))
    types.push(event.type);
  assert.deepEqual(types, ['request.started', 'request.completed']);
  assert.deepEqual(calls, [
    'https://backend.test/api/v2/capabilities',
    'https://backend.test/api/v2/turns',
  ]);
});
test('HTTP adapter reports incomplete and malformed streams without inventing completion', async () => {
  const started = JSON.stringify({
    ...base,
    type: 'request.started',
    eventId: 'event1',
    sequence: 0,
  });
  const client = new FoundationHttpClient(
    'https://backend.test',
    () => ({}),
    async () => stream([`data: ${started}\n\n`]),
  );
  await assert.rejects(async () => {
    for await (const _event of client.sendTurn(turn, new AbortController().signal)) {
      /* consume */
    }
  }, /TRANSPORT_INTERRUPTED/);
  const invalid = new FoundationHttpClient(
    'https://backend.test',
    () => ({}),
    async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
  );
  await assert.rejects(async () => {
    for await (const _event of invalid.sendTurn(turn, new AbortController().signal)) {
      /* consume */
    }
  }, /BACKEND_INVALID_STREAM/);
});

test('HTTP adapter returns typed replay expiry and validates cursors', async () => {
  let endpoint = '';
  const client = new FoundationHttpClient(
    'https://backend.test/api/v2',
    () => ({}),
    async (url) => {
      endpoint = String(url);
      return Response.json({ kind: 'expired', status: 'interrupted', responseId: 'response1' });
    },
  );
  assert.deepEqual(await client.resumeRequest('request1', -1, new AbortController().signal), {
    kind: 'expired',
    status: 'interrupted',
    responseId: 'response1',
  });
  assert.equal(endpoint, 'https://backend.test/api/v2/requests/request1/events?after=-1');
  await assert.rejects(
    client.resumeRequest('request1', -2, new AbortController().signal),
    /INVALID_REPLAY_CURSOR/,
  );
});
