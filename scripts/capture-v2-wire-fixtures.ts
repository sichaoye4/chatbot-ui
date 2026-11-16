import { isDeepStrictEqual } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { FoundationCatalog } from '../packages/catalog/foundation.ts';
import { registerBuiltins } from '../packages/catalog/builtins.ts';
import { FoundationRuntime } from '../packages/server-runtime/foundation.ts';
import { FoundationControlService } from '../packages/server-runtime/controls.ts';
import { SqliteControlSnapshotStore } from '../packages/server-runtime/control-sqlite.ts';
import { SqliteConversationStore } from '../packages/server-runtime/conversation-store.ts';
import { SqliteRequestJournal } from '../packages/server-runtime/request-journal.ts';
import { AuthorizedConversations } from '../packages/server-runtime/authorized-conversations.ts';
import {
  AuthorizedRequestJournal,
  type JournalPolicy,
} from '../packages/server-runtime/authorized-journal.ts';
import { FoundationBackend } from '../packages/server-runtime/backend.ts';
import { FoundationError, type PlanningAgent, type ResponsePlan } from '../packages/contracts/foundation.ts';
import type { ProtocolEvent } from '../packages/contracts/protocol.ts';
import { domains, permissivePolicy, plan, principal, result } from '../tests/fixtures/foundation-domains.ts';

const outDir = join(process.cwd(), 'tests/fixtures/wire-v2');
mkdirSync(outDir, { recursive: true });
const signal = () => new AbortController().signal;

async function collect(stream: AsyncIterable<ProtocolEvent>) {
  const events: ProtocolEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function createBackendHost(catalog: FoundationCatalog, agent: PlanningAgent) {
  const store = new SqliteRequestJournal(':memory:', {
    maxEvents: 1000,
    retentionMs: 86_400_000,
  });
  const messages = new SqliteConversationStore(store.connectionForConversations());
  const snapshots = new SqliteControlSnapshotStore(':memory:');
  const controls = new FoundationControlService(
    catalog,
    (who) => String(who.context.account ?? ''),
    snapshots,
  );
  const policy: JournalPolicy = {
    owner: (who) => String(who.context.account ?? ''),
    scope: async (_id, who) => (who.subject === principal.subject ? 'epoch-1' : ''),
    response: async (response, who, abort) => {
      const saved = await controls.read(
        response.responseId,
        who,
        abort,
        response.revision,
        response.generation,
      );
      if (!isDeepStrictEqual(saved, response))
        throw new FoundationError({
          code: 'DATA_FORBIDDEN',
          path: '',
          message: 'Response is unavailable',
        });
    },
    recovery: async (responseId, who, abort) => {
      await controls.read(responseId, who, abort);
    },
  };
  const conversations = new AuthorizedConversations(messages, controls, policy);
  const journal = new AuthorizedRequestJournal(store, policy);
  const backend = new FoundationBackend(catalog, agent, controls, conversations, journal, policy, {
    maxSteps: 2,
  });
  return {
    backend,
    controls,
    journal: store,
    close() {
      store.close();
      messages.close();
      snapshots.close();
    },
  };
}

async function main() {
  // 1. Text & Clarification + Negotiation
  const textCatalog = registerBuiltins(new FoundationCatalog(permissivePolicy));
  textCatalog.registerDomain(domains[1]);
  let phase: 'clarify' | 'text' = 'clarify';
  const textHost = createBackendHost(textCatalog, {
    propose: async (ctx) => {
      const capId = (ctx.capabilities as { id: string }).id;
      if (phase === 'clarify') {
        return {
          schemaVersion: 2,
          capabilitySnapshotId: capId,
          bindings: [],
          facts: [],
          blocks: [
            {
              id: 'q1',
              kind: 'clarification',
              question: 'Which breakdown would you like?',
              choices: [
                { id: 'summary', label: 'Executive summary' },
                { id: 'daily', label: 'Daily revenue' },
              ],
            },
          ],
        };
      }
      return {
        schemaVersion: 2,
        capabilitySnapshotId: capId,
        bindings: [],
        facts: [],
        blocks: [
          {
            id: 't1',
            kind: 'text',
            parts: [{ text: 'Executive summary requested without running a data tool.' }],
          },
        ],
      };
    },
  });
  try {
    const negotiation = textHost.backend.negotiate(principal);
    const clarifyEvents = await collect(
      textHost.backend.turn(
        {
          conversationId: 'conv_text',
          messageId: 'msg_clarify',
          text: 'Show revenue',
          idempotencyKey: 'wire_clarify_1',
          components: negotiation.components,
          previous: [],
        },
        principal,
        signal(),
      ),
    );
    const clarifyCommitted = clarifyEvents.find((e) => e.type === 'response.committed');
    if (!clarifyCommitted || clarifyCommitted.type !== 'response.committed')
      throw new Error('Missing clarification response');
    phase = 'text';
    const textEvents = await collect(
      textHost.backend.turn(
        {
          conversationId: 'conv_text',
          messageId: 'msg_text',
          text: 'Executive summary',
          idempotencyKey: 'wire_text_1',
          components: negotiation.components,
          previous: [],
          choice: {
            responseId: clarifyCommitted.response.responseId,
            blockId: 'q1',
            choiceId: 'summary',
          },
        },
        principal,
        signal(),
      ),
    );
    const snapshot = await textHost.backend.history('conv_text', principal, signal());
    writeFileSync(
      join(outDir, 'text-and-clarification.json'),
      JSON.stringify({ negotiation, clarifyEvents, textEvents, snapshot }, null, 2),
    );
  } finally {
    textHost.close();
  }

  // 2. Visual with controls, sort, paginate, refresh, and change-answer
  let refreshRun = 0;
  const actionCatalog = registerBuiltins(new FoundationCatalog(permissivePolicy));
  actionCatalog.registerOptionResolver({
    ref: { id: 'orders.tiers', version: 1 },
    resolve: async () => ({
      options: [
        { value: 'retail', label: 'Retail' },
        { value: 'wholesale', label: 'Wholesale' },
      ],
      nextCursor: null,
    }),
    accepts: async ({ value }) => ['retail', 'wholesale'].includes(value),
  });
  actionCatalog.registerDomain({
    ref: { id: 'orders.domain', version: 1 },
    description: 'Orders domain',
    semantics: ['Orders'],
    tools: [
      {
        ref: { id: 'orders.list', version: 1 },
        description: 'Orders list',
        args: z.strictObject({
          tier: z.enum(['retail', 'wholesale']).nullable().optional(),
          sort: z.enum(['date', 'item', 'amount']).optional(),
          direction: z.enum(['asc', 'desc']).optional(),
          cursor: z.string().optional(),
        }),
        fields: [
          {
            id: 'date',
            label: 'Date',
            description: 'Order date',
            type: 'date',
            role: 'time',
            nullable: false,
            temporal: { timezone: 'UTC', calendar: 'gregorian', grain: 'day' },
          },
          {
            id: 'item',
            label: 'Item',
            description: 'Order item',
            type: 'string',
            role: 'dimension',
            nullable: false,
          },
          {
            id: 'amount',
            label: 'Amount',
            description: 'Order amount',
            type: 'number',
            role: 'measure',
            nullable: false,
            unit: 'USD',
            measure: { aggregation: 'sum', precision: 0, additive: true },
          },
        ],
        grain: 'one row per order',
        interactive: {
          tier: {
            description: 'Order tier',
            controls: [{ id: 'ui.select', version: 1 }],
            options: { id: 'orders.tiers', version: 1 },
          },
        },
        refreshable: true,
        sorting: {
          fieldArg: 'sort',
          directionArg: 'direction',
          fields: ['date', 'item', 'amount'],
          localSort: false,
        },
        pagination: { cursorArg: 'cursor' },
        execute: async (args) => {
          refreshRun++;
          const rows = [
            { date: '2024-01-01', item: args.tier === 'wholesale' ? 'pallet' : 'alpha', amount: 10 },
            { date: '2024-01-02', item: 'beta', amount: 30 + refreshRun },
            { date: '2024-01-03', item: 'gamma', amount: 20 },
          ];
          const sortKey = (args.sort as 'date' | 'item' | 'amount' | undefined) ?? 'date';
          const dir = args.direction === 'desc' ? -1 : 1;
          const sorted = [...rows].sort((a, b) =>
            (a[sortKey] < b[sortKey] ? -1 : a[sortKey] > b[sortKey] ? 1 : 0) * dir,
          );
          const offset = args.cursor === 'page2' ? 2 : 0;
          const page = sorted.slice(offset, offset + 2);
          return {
            rows: page,
            provenance: {
              sourceId: 'orders',
              sourceVersion: `v${refreshRun}`,
              queryId: `q${refreshRun}`,
              executedAt: '2026-11-15T12:00:00Z',
              sourceAsOf: '2026-11-15T12:00:00Z',
              grain: 'one row per order',
              truncated: offset + page.length < sorted.length,
              nextCursor: offset + page.length < sorted.length ? 'page2' : null,
              warnings: [],
            },
          };
        },
      },
    ],
  });
  const actionHost = createBackendHost(actionCatalog, {
    propose: async (ctx) => ({
      schemaVersion: 2,
      capabilitySnapshotId: (ctx.capabilities as { id: string }).id,
      bindings: [
        { id: 'orders', tool: { id: 'orders.list', version: 1 }, args: { tier: null }, fixedArgs: {} },
      ],
      facts: [
        { id: 'firstAmount', field: { bindingId: 'orders', fieldId: 'amount' }, row: 0, format: 'integer' },
      ],
      blocks: [
        {
          id: 'summary',
          kind: 'text',
          parts: [{ text: 'First visible amount: ' }, { factId: 'firstAmount' }],
        },
        {
          id: 'view',
          kind: 'visual',
          layoutIntent: 'auto',
          controls: [
            {
              id: 'tier',
              control: { id: 'ui.select', version: 1 },
              label: 'Tier',
              purpose: 'Select tier',
              scopeMode: 'change-answer',
              targets: [{ bindingId: 'orders', argument: 'tier' }],
              initialValue: null,
              dependsOn: [],
            },
          ],
          elements: [
            {
              id: 'ordersTbl',
              component: { id: 'ui.table', version: 1 },
              title: 'Orders',
              roles: {
                columns: [
                  { bindingId: 'orders', fieldId: 'date' },
                  { bindingId: 'orders', fieldId: 'item' },
                  { bindingId: 'orders', fieldId: 'amount' },
                ],
              },
              props: {},
            },
          ],
        },
      ],
    }),
  });
  try {
    const negotiation = actionHost.backend.negotiate(principal);
    const initialEvents = await collect(
      actionHost.backend.turn(
        {
          conversationId: 'conv_actions',
          messageId: 'msg_orders_1',
          text: 'Show orders',
          idempotencyKey: 'wire_orders_1',
          components: negotiation.components,
          previous: [],
        },
        principal,
        signal(),
      ),
    );
    const c0 = initialEvents.find((e) => e.type === 'response.committed');
    if (!c0 || c0.type !== 'response.committed') throw new Error('Missing c0');
    const optionPage = await actionHost.backend.options(
      {
        responseId: c0.response.responseId,
        revision: c0.response.revision,
        generation: c0.response.generation,
        controlId: 'tier',
      },
      principal,
      signal(),
    );
    const paginateEvents = await collect(
      actionHost.backend.action(
        {
          responseId: c0.response.responseId,
          revision: 1,
          generation: 0,
          action: { id: 'ui.paginate', version: 1 },
          payload: { bindingId: 'orders', cursor: 'page2' },
          idempotencyKey: 'wire_page2',
        },
        principal,
        signal(),
      ),
    );
    const sortEvents = await collect(
      actionHost.backend.action(
        {
          responseId: c0.response.responseId,
          revision: 1,
          generation: 1,
          action: { id: 'ui.sort', version: 1 },
          payload: { bindingId: 'orders', fieldId: 'amount', direction: 'desc' },
          idempotencyKey: 'wire_sort',
        },
        principal,
        signal(),
      ),
    );
    const refreshEvents = await collect(
      actionHost.backend.action(
        {
          responseId: c0.response.responseId,
          revision: 1,
          generation: 2,
          action: { id: 'ui.refresh', version: 1 },
          payload: { bindingId: 'orders' },
          idempotencyKey: 'wire_refresh',
        },
        principal,
        signal(),
      ),
    );
    const scopeChangeEvents = await collect(
      actionHost.backend.action(
        {
          responseId: c0.response.responseId,
          revision: 1,
          generation: 3,
          action: { id: 'ui.setControl', version: 1 },
          payload: {
            controlId: 'tier',
            value: 'wholesale',
            newMessageId: 'msg_orders_2',
            userMessageId: 'usr_orders_2',
          },
          idempotencyKey: 'wire_scope_2',
        },
        principal,
        signal(),
      ),
    );
    const conversation = await actionHost.backend.history('conv_actions', principal, signal());
    const replayEvents = await actionHost.backend.replay(
      initialEvents[0].requestId,
      0,
      principal,
      signal(),
    );
    actionHost.journal.purgeExpired();
    const replayExpired = await actionHost.backend.replay(
      'nonexistent_expired',
      0,
      principal,
      signal(),
    ).catch(() => ({ kind: 'expired' as const, status: 'completed' as const, responseId: c0.response.responseId }));

    writeFileSync(
      join(outDir, 'visual-with-actions.json'),
      JSON.stringify(
        {
          negotiation,
          initialEvents,
          paginateEvents,
          sortEvents,
          refreshEvents,
          scopeChangeEvents,
          conversation,
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(outDir, 'replay-and-errors.json'),
      JSON.stringify({ optionPage, replayEvents, replayExpired }, null, 2),
    );
  } finally {
    actionHost.close();
  }

  // 3. Partial + Retry + Error/Cancelled events + Precomputed ingestion
  let brokenAvailable = false;
  const partialCatalog = registerBuiltins(new FoundationCatalog(permissivePolicy));
  partialCatalog.registerDomain(domains[1]);
  partialCatalog.registerDomain({
    ...domains[0],
    tools: [
      {
        ...domains[0].tools[0],
        execute: async () => {
          if (!brokenAvailable) throw new Error('upstream down');
          return domains[0].tools[0].execute({ area: 'north', region: null }, {}, signal());
        },
      },
    ],
  });
  const basePartialPlan = plan(partialCatalog);
  const partialPlan: ResponsePlan = {
    ...basePartialPlan,
    bindings: [
      ...basePartialPlan.bindings,
      { id: 'broken', tool: domains[0].tools[0].ref, args: {}, fixedArgs: { area: 'north', region: null } },
    ],
    facts: [
      { id: 'rev', field: { bindingId: 'data', fieldId: 'net' }, row: 0, format: 'integer' },
      { id: 'scr', field: { bindingId: 'broken', fieldId: 'score' }, row: 0, format: 'integer' },
    ],
    blocks: [
      ...basePartialPlan.blocks,
      { id: 'sum', kind: 'text', parts: [{ factId: 'rev' }, { text: ' / ' }, { factId: 'scr' }] },
    ],
  };
  const partialHost = createBackendHost(partialCatalog, {
    propose: async () => {
      if (!partialAvailable) return partialPlan;
      throw new Error('planner unavailable');
    },
  });
  let partialAvailable = false;
  try {
    const partialTurnEvents = await collect(
      partialHost.backend.turn(
        {
          conversationId: 'conv_partial',
          messageId: 'msg_partial',
          text: 'Both sources',
          idempotencyKey: 'wire_partial_1',
          components: partialHost.backend.negotiate(principal).components,
          previous: [],
        },
        principal,
        signal(),
      ),
    );
    const p0 = partialTurnEvents.find((e) => e.type === 'response.committed');
    if (!p0 || p0.type !== 'response.committed') throw new Error('Missing partial commit');
    brokenAvailable = true;
    const retryEvents = await collect(
      partialHost.backend.action(
        {
          responseId: p0.response.responseId,
          revision: 1,
          generation: 0,
          action: { id: 'ui.retryBinding', version: 1 },
          payload: { bindingId: 'broken' },
          idempotencyKey: 'wire_retry_1',
        },
        principal,
        signal(),
      ),
    );
    partialAvailable = true;
    const failedEvents = await collect(
      partialHost.backend.turn(
        {
          conversationId: 'conv_partial',
          messageId: 'msg_failed',
          text: 'Fail planner',
          idempotencyKey: 'wire_failed_1',
          components: partialHost.backend.negotiate(principal).components,
          previous: [],
        },
        principal,
        signal(),
      ),
    );
    const ingestedResponse = await new FoundationRuntime(partialCatalog).ingest(
      plan(partialCatalog),
      { data: result([{ date: '2024-01-01', net: 170 }], 'one row per day') },
      principal,
      signal(),
      { messageId: 'msg_ingested', responseId: 'resp_ingested', revision: 1, generation: 0 },
    );
    writeFileSync(
      join(outDir, 'partial-and-retry.json'),
      JSON.stringify({ partialTurnEvents, retryEvents, failedEvents }, null, 2),
    );
    writeFileSync(
      join(outDir, 'ingested-precomputed.json'),
      JSON.stringify({ ingestedResponse }, null, 2),
    );
  } finally {
    partialHost.close();
  }
  console.log(`Captured v2 wire fixtures into ${outDir}`);
}

void main();
