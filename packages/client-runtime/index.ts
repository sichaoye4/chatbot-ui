import { Event, type Artifact } from '../contracts/index.ts';
export type ClientState = {
  artifact?: Artifact;
  lastSequence: Record<string, number>;
  requestId?: string;
  text: string;
  evidence?: unknown;
  status: 'idle' | 'running' | 'completed' | 'failed';
  error?: string;
};
export const initialState: ClientState = { lastSequence: {}, text: '', status: 'idle' };
export function reduceEvent(state: ClientState, raw: unknown): ClientState {
  const event = Event.parse(raw);
  if ((state.lastSequence[event.requestId] ?? 0) >= event.sequence) return state;
  const next = {
    ...state,
    lastSequence: { ...state.lastSequence, [event.requestId]: event.sequence },
  };
  if (event.type === 'request.started')
    return {
      ...next,
      requestId: event.requestId,
      text: '',
      evidence: undefined,
      status: 'running',
      error: undefined,
    };
  if (state.requestId && state.requestId !== event.requestId) return state;
  if (
    state.artifact &&
    event.artifactId === state.artifact.artifactId &&
    ((event.revision ?? 0) < state.artifact.revision ||
      (event.revision === state.artifact.revision &&
        (event.generationId ?? 0) < state.artifact.generationId))
  )
    return next;
  const payload = event.payload as Record<string, unknown>;
  if (event.type === 'artifact.committed' || event.type === 'artifact.settled')
    return { ...next, artifact: payload.artifact as Artifact };
  // Dataset events are staged by the server; only settled replaces visible generations.
  if (event.type === 'assistant.text.delta')
    return { ...next, text: next.text + String(payload.text), evidence: payload.evidence };
  if (event.type === 'request.completed') return { ...next, status: 'completed' };
  if (event.type === 'request.failed')
    return { ...next, status: 'failed', error: String(payload.code) };
  return next;
}
export async function consumeSSE(response: Response, onEvent: (event: unknown) => void) {
  if (!response.ok) throw new Error((await response.json()).error ?? 'REQUEST_FAILED');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let index: number;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const line = block.split('\n').find((x) => x.startsWith('data: '));
      if (line) {
        const event = Event.parse(JSON.parse(line.slice(6)));
        onEvent(event);
        if (event.type === 'request.completed' || event.type === 'request.failed') terminal = true;
      }
    }
    if (done) break;
  }
  if (!terminal) throw new Error('STREAM_INTERRUPTED');
}
