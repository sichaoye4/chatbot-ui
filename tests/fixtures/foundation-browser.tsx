import { createRoot } from 'react-dom/client';
import { MaterializedResponse } from '../../packages/contracts/protocol.ts';
import { ResponseRenderer } from '../../packages/renderer-openui/foundation.tsx';
import { builtinRegistry } from '../../packages/renderer-openui/builtins.tsx';
import { ChatShell } from '../../packages/renderer-openui/chat-shell.tsx';
import { FoundationHttpClient } from '../../packages/client-runtime/http.ts';
import { ProtocolEvent, type BackendClient } from '../../packages/contracts/protocol.ts';
import '../../packages/renderer-openui/foundation.css';

const response = MaterializedResponse.parse({
  protocolVersion: 2,
  messageId: 'message1',
  responseId: 'response1',
  revision: 1,
  generation: 0,
  plan: {
    schemaVersion: 2,
    capabilitySnapshotId: 'fixture',
    bindings: [
      { id: 'series', tool: { id: 'example.series', version: 1 }, args: {}, fixedArgs: {} },
      { id: 'parts', tool: { id: 'example.parts', version: 1 }, args: {}, fixedArgs: {} },
    ],
    facts: [],
    blocks: [
      { id: 'text', kind: 'text', parts: [{ text: 'Independent host response' }] },
      {
        id: 'visuals',
        kind: 'visual',
        layoutIntent: 'auto',
        controls: [],
        elements: [
          {
            id: 'trend',
            component: { id: 'ui.trend', version: 1 },
            title: 'Daily readings',
            roles: {
              time: [{ bindingId: 'series', fieldId: 'recorded' }],
              values: [{ bindingId: 'series', fieldId: 'reading' }],
            },
            props: {},
          },
          {
            id: 'pie',
            component: { id: 'ui.pie', version: 1 },
            title: 'Category shares',
            roles: {
              category: [{ bindingId: 'parts', fieldId: 'category' }],
              value: [{ bindingId: 'parts', fieldId: 'amount' }],
            },
            props: {},
          },
        ],
      },
    ],
  },
  bindingDescriptors: [
    {
      bindingId: 'series',
      source: { id: 'example.series', version: 1 },
      grain: 'day',
      fields: [
        {
          id: 'recorded',
          label: 'Recorded date',
          type: 'date',
          role: 'time',
          nullable: false,
          description: 'Observation date',
          temporal: { timezone: 'UTC', calendar: 'gregorian', grain: 'day' },
        },
        {
          id: 'reading',
          label: 'Reading',
          type: 'number',
          role: 'measure',
          nullable: true,
          nullMeaning: 'No reading',
          description: 'Measured value',
          unit: 'items',
          measure: { aggregation: 'recorded', precision: 0, additive: false },
        },
      ],
    },
    {
      bindingId: 'parts',
      source: { id: 'example.parts', version: 1 },
      grain: 'category',
      fields: [
        {
          id: 'category',
          label: 'Category',
          type: 'string',
          role: 'dimension',
          nullable: false,
          description: 'Category name',
        },
        {
          id: 'amount',
          label: 'Amount',
          type: 'number',
          role: 'measure',
          nullable: false,
          description: 'Item count',
          unit: 'items',
          measure: { aggregation: 'count', precision: 0, additive: true },
        },
      ],
    },
  ],
  datasets: {
    series: {
      status: 'ready',
      result: {
        rows: [
          { recorded: '2024-01-03', reading: 15 },
          { recorded: '2024-01-02', reading: null },
          { recorded: '2024-01-01', reading: 10 },
        ],
        provenance: {
          sourceId: 'fixture',
          sourceVersion: '1',
          queryId: 'series1',
          executedAt: '2026-01-01T00:00:00Z',
          grain: 'day',
          truncated: false,
          nextCursor: null,
          warnings: [],
        },
      },
    },
    parts: {
      status: 'ready',
      result: {
        rows: [
          { category: 'Alpha', amount: 1 },
          { category: 'Beta', amount: 3 },
        ],
        provenance: {
          sourceId: 'fixture',
          sourceVersion: '1',
          queryId: 'parts1',
          executedAt: '2026-01-01T00:00:00Z',
          grain: 'category',
          truncated: false,
          nextCursor: null,
          warnings: [],
        },
      },
    },
  },
  facts: {},
  operations: [],
  status: 'complete',
  diagnostics: [],
});
let interrupted: { conversationId: string; messageId: string; expired: boolean } | undefined;
const client: BackendClient = {
  negotiate: async () => ({
    protocolVersion: 2,
    components: [
      { id: 'ui.trend', version: 1 },
      { id: 'ui.pie', version: 1 },
      { id: 'ui.unknown', version: 1 },
    ],
    operations: [],
    history: true,
    replay: true,
    cancellation: true,
  }),
  getConversation: async (conversationId) => ({
    conversationId,
    messages: [{ id: 'historic', role: 'assistant', text: 'Restored conversation' }],
  }),
  cancelRequest: async () => {
    document.body.dataset.cancelled = 'yes';
  },
  resumeRequest: async (requestId, afterSequence) => {
    document.body.dataset.replayAfter = String(afterSequence);
    if (!interrupted) throw new Error('No interrupted request');
    if (interrupted.expired)
      return { kind: 'expired', status: 'completed', responseId: 'recoveredResponse' };
    const base = {
      protocolVersion: 2,
      requestId,
      conversationId: interrupted.conversationId,
      messageId: interrupted.messageId,
    };
    return {
      kind: 'events',
      status: 'completed',
      events: [
        ProtocolEvent.parse({
          ...base,
          type: 'text.delta',
          eventId: 'event3',
          sequence: 2,
          text: ' completed',
        }),
        ProtocolEvent.parse({ ...base, type: 'request.completed', eventId: 'event4', sequence: 3 }),
      ],
    };
  },
  getResponse: async () => {
    if (!interrupted) throw new Error('No interrupted request');
    return { ...response, responseId: 'recoveredResponse', messageId: interrupted.messageId };
  },
  async *sendTurn(input, signal) {
    document.body.dataset.components = input.components.map((item) => item.id).join(',');
    document.body.dataset.previous = String(input.previous.length);
    const base = {
      protocolVersion: 2,
      requestId: 'request1',
      conversationId: input.conversationId,
      messageId: input.messageId,
    };
    yield ProtocolEvent.parse({ ...base, type: 'request.started', eventId: 'event1', sequence: 0 });
    if (input.text === 'Wait') {
      await new Promise<void>((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
      return;
    }
    if (input.text === 'Interrupt') {
      interrupted = {
        conversationId: input.conversationId,
        messageId: input.messageId,
        expired: false,
      };
      yield ProtocolEvent.parse({
        ...base,
        type: 'text.delta',
        eventId: 'event2',
        sequence: 1,
        text: 'Partial reply',
      });
      return;
    }
    if (input.text === 'Expired') {
      interrupted = {
        conversationId: input.conversationId,
        messageId: input.messageId,
        expired: true,
      };
      return;
    }
    yield ProtocolEvent.parse({
      ...base,
      type: 'response.committed',
      eventId: 'event2',
      sequence: 1,
      response: { ...response, messageId: input.messageId },
    });
    yield ProtocolEvent.parse({
      ...base,
      type: 'request.completed',
      eventId: 'event3',
      sequence: 2,
    });
  },
};
const liveClient = new FoundationHttpClient('/api/v2');
const params = new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(
  params.has('live') || params.has('controls') ? (
    <ChatShell
      client={liveClient}
      conversationId={
        params.get('controls') === 'warehouse'
          ? 'conversation2'
          : params.get('controls') === 'partial'
            ? 'conversation3'
            : params.get('controls') === 'actions'
              ? 'conversation4'
              : 'conversation1'
      }
      registry={builtinRegistry}
      presentation={{ title: 'Live DeepSeek test' }}
    />
  ) : params.has('shell') ? (
    <ChatShell
      client={client}
      conversationId="conversation1"
      registry={builtinRegistry}
      presentation={{ title: 'Example host' }}
    />
  ) : (
    <ResponseRenderer response={response} registry={builtinRegistry} />
  ),
);
