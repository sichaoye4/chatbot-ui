// Test-only, single-user bridge. It advertises only in-memory control actions, without history or replay.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CapabilityRef, LocalId } from '../../packages/contracts/foundation.ts';
import { OptionQuery } from '../../packages/contracts/protocol.ts';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import { FoundationRuntime } from '../../packages/server-runtime/foundation.ts';
import { FoundationControlService } from '../../packages/server-runtime/controls.ts';
import { CapabilityPlanningAgent } from '../../packages/agent-adapter/foundation.ts';
import { DeepSeekPlanningModel } from '../../packages/agent-adapter/providers/deepseek.ts';
import { CsvRepository } from '../../examples/csv-analytics/index.ts';
import {
  csvFoundationPolicy,
  registerCsvFoundation,
} from '../../examples/csv-analytics/foundation.ts';

const turnSchema = z.strictObject({
  conversationId: LocalId,
  messageId: LocalId,
  idempotencyKey: LocalId,
  text: z.string().min(1).max(16000),
  components: z.array(CapabilityRef).max(100),
  previous: z
    .array(
      z.strictObject({
        responseId: LocalId,
        revision: z.number().int().positive(),
        generation: z.number().int().nonnegative(),
      }),
    )
    .max(100),
  choice: z.unknown().optional(),
});
const principal = {
  subject: 'browser-test',
  context: {
    csvIdentity: {
      id: 'browser-test',
      tenant: 'demo',
      domains: ['payment', 'party', 'kyc'],
      policyEpoch: 1,
    },
  },
};
export function liveFoundationFixture() {
  const catalog = registerBuiltins(new FoundationCatalog(csvFoundationPolicy));
  registerCsvFoundation(catalog, new CsvRepository('sample_data/training_data_masked_final_1.csv'));
  const runtime = new FoundationRuntime(catalog);
  const provider = new DeepSeekPlanningModel();
  const agent = new CapabilityPlanningAgent(provider);
  const service = new FoundationControlService(catalog, (who) => who.subject);
  const conversations = new Map<string, { conversationId: string; messageId: string }>();
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/capabilities' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          protocolVersion: 2,
          components: catalog.snapshot(principal).components.map((item) => item.ref),
          operations: [{ id: 'ui.setControl', version: 1 }],
          history: false,
          replay: false,
          cancellation: false,
        }),
      );
      return;
    }
    if (req.url === '/metrics' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ modelCalls: provider.calls.length }));
      return;
    }
    if (!['/turns', '/options', '/actions'].includes(req.url ?? '') || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += String(chunk);
        if (raw.length > 65536) throw new Error('Too large');
      }
      const body = JSON.parse(raw);
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      if (req.url === '/options') {
        const page = await service.resolveOptions(
          OptionQuery.parse(body),
          principal,
          controller.signal,
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(page));
        return;
      }
      if (req.url === '/actions') {
        const input = z
          .strictObject({
            responseId: LocalId,
            revision: z.number().int().positive(),
            generation: z.number().int().nonnegative(),
            action: z.strictObject({ id: z.literal('ui.setControl'), version: z.literal(1) }),
            payload: z.strictObject({ controlId: LocalId, value: z.unknown() }),
            idempotencyKey: LocalId,
          })
          .parse(body);
        const conversation = conversations.get(input.responseId);
        if (!conversation) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        const base = {
          protocolVersion: 2,
          requestId: `request${randomUUID().replaceAll('-', '')}`,
          ...conversation,
        };
        const emit = (event: object) => {
          if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        emit({ ...base, type: 'request.started', eventId: 'event1', sequence: 0 });
        try {
          const response = await service.change(
            {
              responseId: input.responseId,
              revision: input.revision,
              generation: input.generation,
              controlId: input.payload.controlId,
              value: input.payload.value,
              idempotencyKey: input.idempotencyKey,
            },
            principal,
            controller.signal,
          );
          emit({ ...base, type: 'response.committed', eventId: 'event2', sequence: 1, response });
          emit({ ...base, type: 'request.completed', eventId: 'event3', sequence: 2 });
        } catch {
          emit({
            ...base,
            type: 'request.failed',
            eventId: 'event2',
            sequence: 1,
            diagnostic: {
              code: 'SOURCE_FAILURE',
              message: 'The selected filter could not be applied.',
              retryable: true,
            },
          });
        }
        res.end();
        return;
      }
      const input = turnSchema.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      const requestId = `request${randomUUID().replaceAll('-', '')}`;
      const base = {
        protocolVersion: 2,
        requestId,
        conversationId: input.conversationId,
        messageId: input.messageId,
      };
      const emit = (event: object) => {
        if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      emit({ ...base, type: 'request.started', eventId: 'event1', sequence: 0 });
      try {
        const plan = await runtime.plan(
          agent,
          input.text,
          principal,
          controller.signal,
          undefined,
          1,
          input.components,
        );
        const output = await runtime.execute(plan, principal, controller.signal, input.components);
        const materialized = await runtime.ingest(
          plan,
          output.datasets,
          principal,
          controller.signal,
          {
            messageId: input.messageId,
            responseId: `response${randomUUID().replaceAll('-', '')}`,
            revision: 1,
            generation: 0,
          },
          input.components,
        );
        const response = await service.attach(materialized, principal, controller.signal, {
          enableControls: true,
          components: input.components,
        });
        conversations.set(response.responseId, {
          conversationId: input.conversationId,
          messageId: input.messageId,
        });
        emit({ ...base, type: 'response.committed', eventId: 'event2', sequence: 1, response });
        emit({ ...base, type: 'request.completed', eventId: 'event3', sequence: 2 });
      } catch {
        emit({
          ...base,
          type: 'request.failed',
          eventId: 'event2',
          sequence: 1,
          diagnostic: {
            code: 'SOURCE_FAILURE',
            message: 'The test agent could not complete this request.',
            retryable: true,
          },
        });
      }
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
      else res.end();
    }
  };
}
