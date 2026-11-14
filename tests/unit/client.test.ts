import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduceEvent, consumeSSE } from '../../packages/client-runtime/index.ts';
import { layout } from '../../packages/layout/index.ts';
import { csvPlan } from '../../examples/csv-analytics/plans.ts';
import type { Event } from '../../packages/contracts/index.ts';
const event = (
  sequence: number,
  type: Event['type'],
  payload: unknown = type === 'request.started' ? { requestId: 'request' } : {},
): Event => ({
  sequence,
  type,
  payload,
  eventId: `e${sequence}`,
  requestId: 'request',
  protocolVersion: 1,
});
test('events deduplicate, reject stale sequences and retain artifacts on failure', () => {
  let s = reduceEvent(initialState, event(1, 'request.started'));
  s = reduceEvent(s, event(2, 'assistant.text.delta', { text: 'hello' }));
  assert.equal(reduceEvent(s, event(2, 'assistant.text.delta', { text: 'hello' })).text, 'hello');
  assert.equal(reduceEvent(s, event(1, 'request.started')), s);
  assert.equal(
    reduceEvent(s, event(3, 'request.failed', { code: 'PLAN_INVALID' })).status,
    'failed',
  );
});
test('SSE fragmented frames decode and closure without terminal is failure', async () => {
  const bytes = new TextEncoder().encode(
    `data: ${JSON.stringify(event(1, 'request.started'))}\n\ndata: ${JSON.stringify(event(2, 'request.completed'))}\n\n`,
  );
  const response = new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    }),
  );
  let count = 0;
  await consumeSSE(response, () => count++);
  assert.equal(count, 2);
  await assert.rejects(
    () =>
      consumeSSE(
        new Response(`data: ${JSON.stringify(event(1, 'request.started'))}\n\n`),
        () => {},
      ),
    /STREAM_INTERRUPTED/,
  );
});
for (const width of [360, 768, 1024, 1440])
  for (let count = 1; count <= 6; count++)
    test(`deterministic layout ${count} panels / ${width}px`, () => {
      const panels = csvPlan('overview').panels.slice(0, count);
      const a = layout(panels, width);
      assert.deepEqual(a, layout(panels, width));
      assert.equal(a.length, count);
      assert.deepEqual(
        a.map((x) => x.id),
        panels.map((x) => x.id),
      );
      if (width === 360) assert.ok(a.every((p) => p.span === 12));
    });
