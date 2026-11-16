import { ProtocolEvent, type MaterializedResponse } from '../contracts/protocol.ts';

export type FoundationStagedBinding = {
  status: 'pending' | 'ready' | 'failed';
  rowCount?: number;
  truncated?: boolean;
  diagnostic?: string;
};
export type FoundationClientState = {
  requestId?: string;
  conversationId?: string;
  messageId?: string;
  sequences: Record<string, number>;
  text: string;
  staged?: {
    responseId: string;
    revision: number;
    generation: number;
    bindings: Record<string, FoundationStagedBinding>;
  };
  response?: MaterializedResponse;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  error?: string;
};
export const initialFoundationState: FoundationClientState = {
  sequences: {},
  text: '',
  status: 'idle',
};

function matchesTarget(
  current: MaterializedResponse | undefined,
  event: { responseId: string; revision: number; generation: number },
) {
  if (!current) return true;
  if (current.responseId !== event.responseId) return event.revision > current.revision;
  return (
    event.revision > current.revision ||
    (event.revision === current.revision && event.generation > current.generation)
  );
}

/** Only committed snapshots replace the visible view; aborted updates leave it intact. */
export function reduceFoundationEvent(
  state: FoundationClientState,
  raw: unknown,
): FoundationClientState {
  const event = ProtocolEvent.parse(raw);
  if ((state.sequences[event.requestId] ?? -1) >= event.sequence) return state;
  if (
    event.type === 'request.started' &&
    (state.status === 'running' ||
      (state.response &&
        (state.conversationId !== event.conversationId || state.messageId !== event.messageId)))
  )
    return state;
  if (
    event.type !== 'request.started' &&
    (state.requestId !== event.requestId ||
      state.conversationId !== event.conversationId ||
      state.messageId !== event.messageId ||
      state.status !== 'running')
  )
    return state;
  const next = { ...state, sequences: { ...state.sequences, [event.requestId]: event.sequence } };
  switch (event.type) {
    case 'request.started':
      return {
        ...next,
        requestId: event.requestId,
        conversationId: event.conversationId,
        messageId: event.messageId,
        text: '',
        staged: undefined,
        status: 'running',
        error: undefined,
      };
    case 'text.delta':
      return { ...next, text: next.text + event.text };
    case 'plan.accepted':
      if (!matchesTarget(state.response, event)) return next;
      return {
        ...next,
        staged: {
          responseId: event.responseId,
          revision: event.revision,
          generation: event.generation,
          bindings: Object.fromEntries(event.bindingIds.map((id) => [id, { status: 'pending' }])),
        },
      };
    case 'binding.pending':
    case 'binding.ready':
    case 'binding.failed': {
      if (!matchesTarget(state.response, event)) return next;
      const base =
        state.staged &&
        state.staged.responseId === event.responseId &&
        state.staged.revision === event.revision &&
        state.staged.generation === event.generation
          ? state.staged
          : {
              responseId: event.responseId,
              revision: event.revision,
              generation: event.generation,
              bindings: {},
            };
      const entry: FoundationStagedBinding =
        event.type === 'binding.pending'
          ? { status: 'pending' }
          : event.type === 'binding.ready'
            ? { status: 'ready', rowCount: event.rowCount, truncated: event.truncated }
            : { status: 'failed', diagnostic: event.diagnostic.message };
      return {
        ...next,
        staged: {
          ...base,
          bindings: { ...base.bindings, [event.bindingId]: entry },
        },
      };
    }
    case 'response.committed': {
      const response = event.response;
      if (response.messageId !== event.messageId) return next;
      const current = state.response;
      if (
        current &&
        (current.responseId !== response.responseId ||
          current.messageId !== response.messageId ||
          response.revision < current.revision ||
          (response.revision === current.revision && response.generation <= current.generation))
      )
        return next;
      return { ...next, staged: undefined, response };
    }
    case 'request.completed':
      return { ...next, staged: undefined, status: 'completed' };
    case 'request.failed':
      return { ...next, staged: undefined, status: 'failed', error: event.diagnostic.message };
    case 'request.cancelled':
      return { ...next, staged: undefined, status: 'cancelled' };
  }
}
export function interruptFoundationRequest(state: FoundationClientState): FoundationClientState {
  return state.status === 'running'
    ? {
        ...state,
        staged: undefined,
        status: 'interrupted',
        error: 'The connection ended before the request completed.',
      }
    : state;
}
