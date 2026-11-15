import { ProtocolEvent, type MaterializedResponse } from '../contracts/protocol.ts';

export type FoundationClientState = {
  requestId?: string;
  conversationId?: string;
  messageId?: string;
  sequences: Record<string, number>;
  text: string;
  response?: MaterializedResponse;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  error?: string;
};
export const initialFoundationState: FoundationClientState = {
  sequences: {},
  text: '',
  status: 'idle',
};

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
        status: 'running',
        error: undefined,
      };
    case 'text.delta':
      return { ...next, text: next.text + event.text };
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
      return { ...next, response };
    }
    case 'request.completed':
      return { ...next, status: 'completed' };
    case 'request.failed':
      return { ...next, status: 'failed', error: event.diagnostic.message };
    case 'request.cancelled':
      return { ...next, status: 'cancelled' };
  }
}
export function interruptFoundationRequest(state: FoundationClientState): FoundationClientState {
  return state.status === 'running'
    ? {
        ...state,
        status: 'interrupted',
        error: 'The connection ended before the request completed.',
      }
    : state;
}
