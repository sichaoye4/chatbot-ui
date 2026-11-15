import {
  ConversationSnapshot,
  Negotiation,
  MaterializedResponse,
  OptionPage,
  ReplayResult,
  ProtocolEvent,
  type BackendClient,
} from '../contracts/protocol.ts';

type HeadersProvider = () => HeadersInit | Promise<HeadersInit>;
type ActionInput = Parameters<NonNullable<BackendClient['dispatchAction']>>[0];
type TurnInput = Parameters<BackendClient['sendTurn']>[0];
type OptionInput = Parameters<NonNullable<BackendClient['resolveOptions']>>[0];

/** HTTP framing belongs to this replaceable adapter; identity and credentials belong to the host. */
export class FoundationHttpClient implements BackendClient {
  constructor(
    private readonly baseUrl: string,
    private readonly headers: HeadersProvider = () => ({}),
    private readonly request: typeof fetch = fetch,
  ) {}
  private url(path: string) {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }
  private async get(path: string, signal: AbortSignal) {
    const request = this.request;
    const response = await request(this.url(path), { signal, headers: await this.headers() });
    if (!response.ok) throw new Error(`BACKEND_HTTP_${response.status}`);
    return response.json();
  }
  private async post(path: string, body: unknown, signal: AbortSignal) {
    const headers = new Headers(await this.headers());
    headers.set('Content-Type', 'application/json');
    const request = this.request;
    const response = await request(this.url(path), {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`BACKEND_HTTP_${response.status}`);
    return response;
  }
  async negotiate(signal: AbortSignal) {
    return Negotiation.parse(await this.get('/capabilities', signal));
  }
  async getConversation(conversationId: string, signal: AbortSignal) {
    return ConversationSnapshot.parse(
      await this.get(`/conversations/${encodeURIComponent(conversationId)}`, signal),
    );
  }
  async getResponse(responseId: string, signal: AbortSignal) {
    return MaterializedResponse.parse(
      await this.get(`/responses/${encodeURIComponent(responseId)}`, signal),
    );
  }
  async cancelRequest(requestId: string, signal: AbortSignal) {
    await this.post(`/requests/${encodeURIComponent(requestId)}/cancel`, {}, signal);
  }
  async resumeRequest(requestId: string, afterSequence: number, signal: AbortSignal) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < -1)
      throw new Error('INVALID_REPLAY_CURSOR');
    return ReplayResult.parse(
      await this.get(
        `/requests/${encodeURIComponent(requestId)}/events?after=${afterSequence}`,
        signal,
      ),
    );
  }
  async resolveOptions(input: OptionInput, signal: AbortSignal) {
    const response = await this.post('/options', input, signal);
    return OptionPage.parse(await response.json());
  }
  async *sendTurn(input: TurnInput, signal: AbortSignal) {
    yield* this.events(await this.post('/turns', input, signal));
  }
  async *dispatchAction(input: ActionInput, signal: AbortSignal) {
    yield* this.events(await this.post('/actions', input, signal));
  }
  private async *events(response: Response) {
    if (
      !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') ||
      !response.body
    )
      throw new Error('BACKEND_INVALID_STREAM');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let terminal = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let separator: RegExpExecArray | null;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          if (frame.length > 1_000_000) throw new Error('BACKEND_FRAME_TOO_LARGE');
          const lines = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''));
          if (!lines.length) continue;
          if (terminal) throw new Error('BACKEND_EVENT_AFTER_TERMINAL');
          const event = ProtocolEvent.parse(JSON.parse(lines.join('\n')));
          terminal = ['request.completed', 'request.failed', 'request.cancelled'].includes(
            event.type,
          );
          yield event;
        }
        if (buffer.length > 1_000_000) throw new Error('BACKEND_FRAME_TOO_LARGE');
        if (done) break;
      }
      if (!terminal || buffer.trim()) throw new Error('TRANSPORT_INTERRUPTED');
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
