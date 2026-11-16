import { z } from 'zod';
import {
  Arguments,
  CapabilityRef,
  DataResult,
  FieldDefinition,
  InputValue,
  LocalId,
  ResponsePlan,
} from './foundation.ts';

// Wire contracts deliberately contain no executable registration or transport implementation.
export const WireDiagnostic = z.strictObject({
  code: z.enum([
    'SCHEMA_INVALID',
    'CAPABILITY_UNAVAILABLE',
    'STALE_CAPABILITIES',
    'SEMANTIC_INVALID',
    'SCOPE_CONFLICT',
    'BUDGET_EXCEEDED',
    'DATA_FORBIDDEN',
    'RESULT_INVALID',
    'CANCELLED',
    'TRANSPORT_INTERRUPTED',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
    'REPLAY_EXPIRED',
    'UNSUPPORTED_VERSION',
    'SOURCE_FAILURE',
    'AUTHENTICATION_EXPIRED',
  ]),
  message: z.string().min(1).max(1000),
  retryable: z.boolean(),
  targetId: LocalId.optional(),
});
export const BindingCapabilities = z.strictObject({
  refreshable: z.boolean(),
  sorting: z
    .strictObject({
      fieldArg: LocalId,
      directionArg: LocalId,
      fields: z.array(LocalId).max(100),
      localSort: z.boolean(),
    })
    .optional(),
  pagination: z
    .strictObject({
      cursorArg: LocalId,
    })
    .optional(),
});
export const BindingDescriptor = z.strictObject({
  bindingId: LocalId,
  source: CapabilityRef,
  fields: z.array(FieldDefinition).max(100),
  grain: z.string().min(1).max(500),
  capabilities: BindingCapabilities.optional(),
});
export type BindingDescriptor = z.infer<typeof BindingDescriptor>;
export const DatasetState = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending') }),
  z.strictObject({ status: z.literal('ready'), result: DataResult }),
  z.strictObject({ status: z.literal('failed'), diagnostic: WireDiagnostic }),
]);
export const MaterializedFact = z.strictObject({
  value: z.string().max(16000),
  field: z.strictObject({ bindingId: LocalId, fieldId: LocalId }),
  row: z.number().int().nonnegative(),
  format: z.enum(['raw', 'integer', 'decimal', 'percent']),
});
export const MaterializedResponse = z
  .strictObject({
    protocolVersion: z.literal(2),
    messageId: LocalId,
    responseId: LocalId,
    revision: z.number().int().positive(),
    generation: z.number().int().nonnegative(),
    plan: ResponsePlan,
    bindingDescriptors: z.array(BindingDescriptor).max(100),
    datasets: z.record(LocalId, DatasetState),
    facts: z.record(LocalId, MaterializedFact),
    operations: z.array(CapabilityRef).max(100),
    status: z.enum(['pending', 'complete', 'partial', 'failed']),
    diagnostics: z.array(WireDiagnostic).max(100),
  })
  .superRefine((response, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const ids = response.plan.bindings.map((b) => b.id);
    if (
      new Set(response.bindingDescriptors.map((d) => d.bindingId)).size !== ids.length ||
      response.bindingDescriptors.some((d) => !ids.includes(d.bindingId)) ||
      Object.keys(response.datasets).length !== ids.length ||
      Object.keys(response.datasets).some((id) => !ids.includes(id))
    )
      issue('Descriptors and datasets must match plan bindings');
    for (const descriptor of response.bindingDescriptors) {
      const binding = response.plan.bindings.find((b) => b.id === descriptor.bindingId);
      if (
        !binding ||
        binding.tool.id !== descriptor.source.id ||
        binding.tool.version !== descriptor.source.version
      )
        issue('Descriptor source mismatch');
      if (new Set(descriptor.fields.map((f) => f.id)).size !== descriptor.fields.length)
        issue('Duplicate descriptor fields');
      const state = response.datasets[descriptor.bindingId];
      if (state?.status === 'ready') {
        if (state.result.provenance.grain !== descriptor.grain) issue('Result grain mismatch');
        const valid = state.result.rows.every((row) => {
          if (Object.keys(row).length !== descriptor.fields.length) return false;
          return descriptor.fields.every((field) => {
            const value = row[field.id];
            if (value === null) return field.nullable;
            if (field.type === 'date') return z.iso.date().safeParse(value).success;
            if (field.type === 'datetime')
              return z.iso.datetime({ offset: true }).safeParse(value).success;
            return typeof value === field.type;
          });
        });
        if (!valid) issue('Result does not match its field descriptors');
      }
    }
    const refs = [
      ...response.plan.facts.map((fact) => fact.field),
      ...response.plan.blocks.flatMap((block) =>
        block.kind === 'visual'
          ? block.elements.flatMap((element) => Object.values(element.roles).flat())
          : [],
      ),
    ];
    if (
      refs.some(
        (ref) =>
          !response.bindingDescriptors
            .find((d) => d.bindingId === ref.bindingId)
            ?.fields.some((field) => field.id === ref.fieldId),
      )
    )
      issue('Plan refers to an unknown descriptor field');
    for (const [id, fact] of Object.entries(response.facts)) {
      const definition = response.plan.facts.find((f) => f.id === id);
      const state = response.datasets[fact.field.bindingId];
      if (
        !definition ||
        JSON.stringify({ field: fact.field, row: fact.row, format: fact.format }) !==
          JSON.stringify({
            field: definition.field,
            row: definition.row,
            format: definition.format,
          }) ||
        state?.status !== 'ready' ||
        state.result.rows[fact.row]?.[fact.field.fieldId] === undefined
      )
        issue('Fact must reference a ready result and its plan definition');
    }
    if (
      response.status === 'complete' &&
      (Object.values(response.datasets).some((s) => s.status !== 'ready') ||
        Object.keys(response.facts).length !== response.plan.facts.length)
    )
      issue('Complete response requires all results and facts');
    if (response.status === 'partial') {
      const states = Object.values(response.datasets);
      if (
        !states.some((state) => state.status === 'ready') ||
        !states.some((state) => state.status === 'failed') ||
        states.some((state) => state.status === 'pending') ||
        response.plan.facts.some(
          (fact) =>
            response.datasets[fact.field.bindingId]?.status === 'ready' &&
            !Object.hasOwn(response.facts, fact.id),
        )
      )
        issue('Partial response requires settled successes and failures and all available facts');
    }
  });
export type MaterializedResponse = z.infer<typeof MaterializedResponse>;

const eventBase = {
  protocolVersion: z.literal(2),
  eventId: LocalId,
  requestId: LocalId,
  sequence: z.number().int().nonnegative(),
  conversationId: LocalId,
  messageId: LocalId,
};
const artifactEventBase = {
  ...eventBase,
  responseId: LocalId,
  revision: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
};
export const ProtocolEvent = z.discriminatedUnion('type', [
  z.strictObject({ ...eventBase, type: z.literal('request.started') }),
  z.strictObject({ ...eventBase, type: z.literal('text.delta'), text: z.string().max(16000) }),
  z.strictObject({
    ...artifactEventBase,
    type: z.literal('plan.accepted'),
    bindingIds: z.array(LocalId).max(20),
  }),
  z.strictObject({
    ...artifactEventBase,
    type: z.literal('binding.pending'),
    bindingId: LocalId,
  }),
  z.strictObject({
    ...artifactEventBase,
    type: z.literal('binding.ready'),
    bindingId: LocalId,
    rowCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  z.strictObject({
    ...artifactEventBase,
    type: z.literal('binding.failed'),
    bindingId: LocalId,
    diagnostic: WireDiagnostic,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('response.committed'),
    response: MaterializedResponse,
  }),
  z.strictObject({ ...eventBase, type: z.literal('request.completed') }),
  z.strictObject({ ...eventBase, type: z.literal('request.failed'), diagnostic: WireDiagnostic }),
  z.strictObject({ ...eventBase, type: z.literal('request.cancelled') }),
]);
export type ProtocolEvent = z.infer<typeof ProtocolEvent>;
export const RequestStatus = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export const ReplayResult = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('events'),
    status: RequestStatus,
    events: z.array(ProtocolEvent).max(1000),
  }),
  z.strictObject({
    kind: z.literal('expired'),
    status: RequestStatus,
    responseId: LocalId.optional(),
  }),
]);
export type ReplayResult = z.infer<typeof ReplayResult>;
export const Negotiation = z.strictObject({
  protocolVersion: z.literal(2),
  components: z.array(CapabilityRef),
  operations: z.array(CapabilityRef),
  history: z.boolean(),
  replay: z.boolean(),
  cancellation: z.boolean(),
});
export type Negotiation = z.infer<typeof Negotiation>;
export const ConversationMessage = z
  .strictObject({
    id: LocalId,
    role: z.enum(['user', 'assistant']),
    text: z.string().max(16000),
    response: MaterializedResponse.optional(),
    interruptedRequest: z
      .strictObject({ requestId: LocalId, status: z.enum(['pending', 'running', 'interrupted']) })
      .optional(),
  })
  .superRefine((message, ctx) => {
    if (
      message.response &&
      (message.role !== 'assistant' || message.response.messageId !== message.id)
    )
      ctx.addIssue({ code: 'custom', message: 'Response must belong to its assistant message' });
    if (message.interruptedRequest && message.role !== 'assistant')
      ctx.addIssue({ code: 'custom', message: 'Only assistant messages can reference a request' });
  });
export const ConversationSnapshot = z
  .strictObject({ conversationId: LocalId, messages: z.array(ConversationMessage).max(10000) })
  .superRefine((snapshot, ctx) => {
    if (new Set(snapshot.messages.map((message) => message.id)).size !== snapshot.messages.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate conversation message IDs' });
  });
export type ConversationMessage = z.infer<typeof ConversationMessage>;
export type ConversationSnapshot = z.infer<typeof ConversationSnapshot>;
export const ControlChange = z.strictObject({
  responseId: LocalId,
  revision: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
  controlId: LocalId,
  value: InputValue,
  idempotencyKey: LocalId,
  newMessageId: LocalId.optional(),
  userMessageId: LocalId.optional(),
});
export type ControlChange = z.infer<typeof ControlChange>;
export const OptionQuery = z.strictObject({
  responseId: LocalId,
  revision: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
  controlId: LocalId,
  search: z.string().max(160).optional(),
  cursor: z.string().max(2048).optional(),
});
export type OptionQuery = z.infer<typeof OptionQuery>;
export const OptionPage = z
  .strictObject({
    options: z
      .array(z.strictObject({ value: z.string().max(160), label: z.string().min(1).max(160) }))
      .max(100),
    nextCursor: z.string().max(2048).nullable(),
  })
  .superRefine((page, ctx) => {
    if (new Set(page.options.map((option) => option.value)).size !== page.options.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate option values' });
  });
export type OptionPage = z.infer<typeof OptionPage>;
export const TurnRequest = z.strictObject({
  conversationId: LocalId,
  messageId: LocalId,
  text: z.string().trim().min(1).max(16000),
  idempotencyKey: LocalId,
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
  choice: z.strictObject({ responseId: LocalId, blockId: LocalId, choiceId: LocalId }).optional(),
});
export type TurnRequest = z.infer<typeof TurnRequest>;
export const BackendAction = z.strictObject({
  responseId: LocalId,
  revision: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
  action: CapabilityRef,
  payload: Arguments,
  idempotencyKey: LocalId,
});
export type BackendAction = z.infer<typeof BackendAction>;
export type BackendClient = {
  negotiate(signal: AbortSignal): Promise<Negotiation>;
  sendTurn(input: TurnRequest, signal: AbortSignal): AsyncIterable<ProtocolEvent>;
  getConversation?(conversationId: string, signal: AbortSignal): Promise<ConversationSnapshot>;
  getResponse?(responseId: string, signal: AbortSignal): Promise<MaterializedResponse>;
  cancelRequest?(requestId: string, signal: AbortSignal): Promise<void>;
  resumeRequest?(
    requestId: string,
    afterSequence: number,
    signal: AbortSignal,
  ): Promise<ReplayResult>;
  resolveOptions?(input: OptionQuery, signal: AbortSignal): Promise<OptionPage>;
  dispatchAction?(input: BackendAction, signal: AbortSignal): AsyncIterable<ProtocolEvent>;
};
