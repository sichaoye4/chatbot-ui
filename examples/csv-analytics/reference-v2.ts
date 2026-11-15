import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  FoundationError,
  type PlanningAgent,
  type Principal,
} from '../../packages/contracts/foundation.ts';
import { FoundationCatalog } from '../../packages/catalog/foundation.ts';
import { registerBuiltins } from '../../packages/catalog/builtins.ts';
import { CapabilityPlanningAgent } from '../../packages/agent-adapter/foundation.ts';
import { DeepSeekPlanningModel } from '../../packages/agent-adapter/providers/deepseek.ts';
import { FoundationControlService } from '../../packages/server-runtime/controls.ts';
import { SqliteControlSnapshotStore } from '../../packages/server-runtime/control-sqlite.ts';
import { SqliteConversationStore } from '../../packages/server-runtime/conversation-store.ts';
import { SqliteRequestJournal } from '../../packages/server-runtime/request-journal.ts';
import {
  AuthorizedRequestJournal,
  type JournalPolicy,
} from '../../packages/server-runtime/authorized-journal.ts';
import { AuthorizedConversations } from '../../packages/server-runtime/authorized-conversations.ts';
import { FoundationBackend } from '../../packages/server-runtime/backend.ts';
import { CsvRepository } from './index.ts';
import { csvFoundationPolicy, registerCsvFoundation } from './foundation.ts';

/** Local single-user example host. Real deployments must supply authenticated identity and policy. */
export function createCsvFoundationBackend(
  repository: CsvRepository,
  database: string,
  mode: 'deepseek' | 'deterministic',
  override?: PlanningAgent,
) {
  const catalog = registerCsvFoundation(
    registerBuiltins(new FoundationCatalog(csvFoundationPolicy)),
    repository,
  );
  const snapshots = new SqliteControlSnapshotStore(database);
  const requestStore = new SqliteRequestJournal(database, {
    maxEvents: 100,
    retentionMs: 24 * 60 * 60 * 1000,
  });
  const messages = new SqliteConversationStore(requestStore.connectionForConversations());
  // This reference host assumes exclusive ownership of the SQLite database during startup.
  requestStore.interruptRunning();
  const identity = z.object({ id: z.string(), tenant: z.string() }).passthrough();
  const owner = (principal: Principal) => {
    const parsed = identity.safeParse(principal.context.csvIdentity);
    return parsed.success && parsed.data.id === principal.subject
      ? JSON.stringify([parsed.data.tenant, parsed.data.id])
      : '';
  };
  const controls = new FoundationControlService(catalog, owner, snapshots);
  const policy: JournalPolicy = {
    owner,
    scope: async (_conversationId, principal) =>
      (await csvFoundationPolicy.authorize({ id: 'csv.analytics', version: 1 }, {}, principal))
        .scopeKey,
    response: async (response, principal, signal) => {
      const stored = await controls.read(
        response.responseId,
        principal,
        signal,
        response.revision,
        response.generation,
      );
      if (!isDeepStrictEqual(stored, response))
        throw new FoundationError({
          code: 'DATA_FORBIDDEN',
          path: '',
          message: 'Response is unavailable',
        });
    },
    recovery: async (responseId, principal, signal) => {
      await controls.read(responseId, principal, signal);
    },
  };
  const conversations = new AuthorizedConversations(messages, controls, policy);
  const journal = new AuthorizedRequestJournal(requestStore, policy);
  const provider = mode === 'deepseek' && !override ? new DeepSeekPlanningModel() : undefined;
  const agent: PlanningAgent =
    override ??
    (provider
      ? new CapabilityPlanningAgent(provider)
      : {
          propose: async (context) => ({
            schemaVersion: 2,
            capabilitySnapshotId: (context.capabilities as { id: string }).id,
            bindings: [],
            facts: [],
            blocks: [
              {
                id: 'message',
                kind: 'text',
                parts: [
                  { text: 'Configure the DeepSeek agent to answer questions in this example.' },
                ],
              },
            ],
          }),
        });
  const backend = new FoundationBackend(catalog, agent, controls, conversations, journal, policy);
  return {
    backend,
    provider,
    close: () => {
      backend.shutdown();
      requestStore.close();
      messages.close();
      snapshots.close();
    },
  };
}
