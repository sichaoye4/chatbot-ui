import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ConversationSnapshot,
  MaterializedResponse,
  Negotiation,
  ProtocolEvent,
  ReplayResult,
  type BackendClient,
  type ConversationMessage,
} from '../contracts/protocol.ts';
import type { Arguments } from '../contracts/foundation.ts';
import {
  initialFoundationState,
  interruptFoundationRequest,
  reduceFoundationEvent,
  type FoundationClientState,
} from '../client-runtime/foundation.ts';
import { installedComponents } from './builtins.tsx';
import { ResponseRenderer, type ClientRegistry, type Presentation } from './foundation.tsx';

type ShellMessage = ConversationMessage & { view?: FoundationClientState };
export type ShellPresentation = Presentation & {
  title?: string;
  brand?: string;
  composerLabel?: string;
  sendLabel?: string;
  placeholder?: string;
  suggestions?: string[];
};
const id = (prefix: string) => `${prefix}${crypto.randomUUID().replaceAll('-', '')}`;

/** Host supplies identity, transport and renderer registrations. No URL or credentials are read here. */
export function ChatShell({
  client,
  conversationId,
  registry,
  presentation = {},
}: {
  client: BackendClient;
  conversationId: string;
  registry: ClientRegistry;
  presentation?: ShellPresentation;
}) {
  const [messages, setMessages] = useState<ShellMessage[]>([]);
  const [text, setText] = useState('');
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [running, setRunning] = useState(false);
  const [supported, setSupported] = useState<{ id: string; version: number }[]>([]);
  const [operations, setOperations] = useState<{ id: string; version: number }[]>([]);
  const [canCancel, setCanCancel] = useState(false);
  const [canReplay, setCanReplay] = useState(false);
  const session = useRef(0);
  const active = useRef<{ controller: AbortController; requestId?: string } | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    const node = transcript.current;
    if (node && follow.current) node.scrollTop = node.scrollHeight;
  }, [messages, running]);

  useEffect(() => {
    const controller = new AbortController();
    session.current++;
    setReady(false);
    setMessages([]);
    setFailure(undefined);
    setRunning(false);
    setCanCancel(false);
    setCanReplay(false);
    setOperations([]);
    void (async () => {
      try {
        const capabilities = Negotiation.parse(await client.negotiate(controller.signal));
        const installed = installedComponents(registry);
        const intersection = capabilities.components.filter((candidate) =>
          installed.some((item) => item.id === candidate.id && item.version === candidate.version),
        );
        if (capabilities.history) {
          if (!client.getConversation) throw new Error('History adapter missing');
          const history = ConversationSnapshot.parse(
            await client.getConversation(conversationId, controller.signal),
          );
          if (history.conversationId !== conversationId) throw new Error('Conversation mismatch');
          if (!controller.signal.aborted)
            setMessages(
              history.messages.map((message) =>
                message.interruptedRequest
                  ? {
                      ...message,
                      view: {
                        ...initialFoundationState,
                        sequences: {},
                        requestId: message.interruptedRequest.requestId,
                        conversationId,
                        messageId: message.id,
                        response: message.response,
                        status: 'interrupted',
                        error: 'The previous request was interrupted. You can try to recover it.',
                      },
                    }
                  : message,
              ),
            );
        }
        if (!controller.signal.aborted) {
          setSupported(intersection);
          setOperations(capabilities.operations);
          setCanCancel(capabilities.cancellation && !!client.cancelRequest);
          setCanReplay(capabilities.replay && !!client.resumeRequest);
          setReady(true);
        }
      } catch {
        if (!controller.signal.aborted)
          setFailure('The conversation could not be loaded. Please try again.');
      }
    })();
    return () => {
      controller.abort();
      active.current?.controller.abort();
      active.current = null;
      session.current++;
    };
  }, [client, conversationId, registry]);

  async function send(
    input: string,
    choice?: { responseId: string; blockId: string; choiceId: string },
  ) {
    const content = input.trim();
    if (!content || !ready || active.current) return;
    const controller = new AbortController();
    const pending: { controller: AbortController; requestId?: string } = { controller };
    const currentSession = session.current;
    active.current = pending;
    setRunning(true);
    setText('');
    setFailure(undefined);
    const assistantId = id('message');
    const previous = messages.flatMap((message) =>
      message.response
        ? [
            {
              responseId: message.response.responseId,
              revision: message.response.revision,
              generation: message.response.generation,
            },
          ]
        : [],
    );
    setMessages((current) => [
      ...current,
      { id: id('message'), role: 'user', text: content },
      { id: assistantId, role: 'assistant', text: '' },
    ]);
    let state: FoundationClientState = { ...initialFoundationState, sequences: {} };
    const publish = () => {
      if (session.current === currentSession)
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, text: state.text, response: state.response, view: state }
              : message,
          ),
        );
    };
    try {
      for await (const raw of client.sendTurn(
        {
          conversationId,
          messageId: assistantId,
          text: content,
          idempotencyKey: id('turn'),
          components: supported,
          previous,
          ...(choice ? { choice } : {}),
        },
        controller.signal,
      )) {
        const event = ProtocolEvent.parse(raw);
        if (
          event.conversationId !== conversationId ||
          event.messageId !== assistantId ||
          (pending.requestId && pending.requestId !== event.requestId)
        )
          throw new Error('Unexpected event target');
        if (!pending.requestId && event.type !== 'request.started')
          throw new Error('Missing request start');
        if (
          event.type === 'response.committed' &&
          event.response.plan.blocks.some(
            (block) =>
              block.kind === 'visual' &&
              block.elements.some(
                (element) =>
                  !supported.some(
                    (component) =>
                      component.id === element.component.id &&
                      component.version === element.component.version,
                  ),
              ),
          )
        )
          throw new Error('Response contains a component outside the negotiated intersection');
        pending.requestId = event.requestId;
        state = reduceFoundationEvent(state, event);
        publish();
      }
      if (state.status === 'running' || state.status === 'idle')
        state =
          state.status === 'idle'
            ? {
                ...state,
                status: 'interrupted',
                error: 'The connection ended before the request started.',
              }
            : interruptFoundationRequest(state);
    } catch {
      if (state.status === 'running') state = interruptFoundationRequest(state);
      else if (state.status === 'idle')
        state = { ...state, status: 'interrupted', error: 'The request was interrupted.' };
      else if (state.status === 'completed')
        state = { ...state, status: 'failed', error: 'The response stream was invalid.' };
    } finally {
      publish();
      if (active.current === pending) {
        active.current = null;
        setRunning(false);
      }
    }
  }
  async function recover(message: ShellMessage) {
    const resume = client.resumeRequest?.bind(client);
    const requestId = message.view?.requestId;
    if (!resume || !requestId || active.current || !canReplay) return;
    const controller = new AbortController();
    const pending = { controller, requestId };
    const currentSession = session.current;
    active.current = pending;
    setRunning(true);
    const last = message.view?.sequences[requestId] ?? -1;
    let state: FoundationClientState = {
      ...message.view!,
      sequences: { ...message.view!.sequences },
      status: last < 0 ? 'idle' : 'running',
      error: undefined,
    };
    const publish = () => {
      if (session.current === currentSession)
        setMessages((current) =>
          current.map((item) =>
            item.id === message.id
              ? { ...item, text: state.text, response: state.response, view: state }
              : item,
          ),
        );
    };
    try {
      const page = ReplayResult.parse(await resume(requestId, last, controller.signal));
      if (page.kind === 'expired') {
        if (page.responseId && client.getResponse) {
          const recovered = MaterializedResponse.parse(
            await client.getResponse(page.responseId, controller.signal),
          );
          const previous = state.response;
          if (
            recovered.messageId !== message.id ||
            (previous &&
              (recovered.responseId !== previous.responseId ||
                recovered.revision < previous.revision ||
                (recovered.revision === previous.revision &&
                  recovered.generation < previous.generation)))
          )
            throw new Error('Unexpected recovery snapshot');
          state = {
            ...state,
            response: recovered,
            status:
              page.status === 'completed'
                ? 'completed'
                : page.status === 'cancelled'
                  ? 'cancelled'
                  : page.status === 'failed'
                    ? 'failed'
                    : 'interrupted',
            error:
              page.status === 'completed' || page.status === 'cancelled'
                ? undefined
                : 'The latest snapshot was restored, but the request did not complete.',
          };
        } else
          state = {
            ...state,
            status: 'interrupted',
            error: 'Replay has expired. Reload the conversation to recover available snapshots.',
          };
      } else {
        for (const event of page.events) {
          if (
            event.requestId !== requestId ||
            event.conversationId !== conversationId ||
            event.messageId !== message.id
          )
            throw new Error('Unexpected replay target');
          state = reduceFoundationEvent(state, event);
        }
        if (state.status === 'idle' || state.status === 'running')
          state = {
            ...state,
            status: 'interrupted',
            error:
              page.status === 'running' || page.status === 'pending'
                ? 'The request is still running. Try recovery again shortly.'
                : 'The request ended without a recoverable terminal event.',
          };
      }
    } catch {
      state = { ...state, status: 'interrupted', error: 'The request could not be recovered.' };
    } finally {
      publish();
      if (active.current === pending) {
        active.current = null;
        setRunning(false);
      }
    }
  }
  async function updateControl(
    message: ShellMessage,
    action: { id: string; version: number },
    payload: Arguments,
  ) {
    const response = message.response;
    const dispatch = client.dispatchAction?.bind(client);
    if (!response || !dispatch || !ready || active.current) return;
    const scopeControl =
      action.id === 'ui.setControl' && action.version === 1 && typeof payload.controlId === 'string'
        ? response.plan.blocks
            .flatMap((block) => (block.kind === 'visual' ? block.controls : []))
            .find((item) => item.id === payload.controlId && item.scopeMode === 'change-answer')
        : undefined;
    const scopeChange = scopeControl
      ? {
          newMessageId: id('message'),
          userMessageId: id('message'),
          text: `Scope change (${scopeControl.label}): ${
            payload.value === null
              ? 'all permitted values'
              : Array.isArray(payload.value)
                ? payload.value.join(', ')
                : String(payload.value)
          }`,
        }
      : undefined;
    const targetMessageId = scopeChange ? scopeChange.newMessageId : message.id;
    const requestPayload: Arguments = scopeChange
      ? {
          ...payload,
          newMessageId: scopeChange.newMessageId,
          userMessageId: scopeChange.userMessageId,
        }
      : payload;
    const controller = new AbortController();
    const pending: { controller: AbortController; requestId?: string } = { controller };
    const currentSession = session.current;
    active.current = pending;
    setRunning(true);
    let committed = false;
    let state: FoundationClientState = {
      ...initialFoundationState,
      sequences: {},
      ...(scopeChange ? {} : { response }),
      conversationId,
      messageId: targetMessageId,
    };
    if (scopeChange)
      setMessages((current) => [
        ...current,
        { id: scopeChange.userMessageId, role: 'user', text: scopeChange.text },
        { id: scopeChange.newMessageId, role: 'assistant', text: '', view: state },
      ]);
    const publish = () => {
      if (session.current === currentSession)
        setMessages((current) =>
          current.map((item) =>
            item.id === targetMessageId
              ? { ...item, text: state.text || item.text, response: state.response, view: state }
              : item,
          ),
        );
    };
    try {
      for await (const raw of dispatch(
        {
          responseId: response.responseId,
          revision: response.revision,
          generation: response.generation,
          action,
          payload: requestPayload,
          idempotencyKey: id('action'),
        },
        controller.signal,
      )) {
        const event = ProtocolEvent.parse(raw);
        if (
          event.conversationId !== conversationId ||
          event.messageId !== targetMessageId ||
          (pending.requestId && pending.requestId !== event.requestId) ||
          (!pending.requestId && event.type !== 'request.started')
        )
          throw new Error('Unexpected action event');
        if (event.type === 'response.committed') {
          const validCommit = scopeChange
            ? event.response.responseId !== response.responseId &&
              event.response.messageId === scopeChange.newMessageId &&
              event.response.revision === response.revision + 1 &&
              event.response.generation === 0
            : event.response.responseId === response.responseId &&
              event.response.messageId === message.id &&
              event.response.revision === response.revision &&
              event.response.generation === response.generation + 1;
          if (
            !validCommit ||
            event.response.plan.blocks.some(
              (block) =>
                block.kind === 'visual' &&
                block.elements.some(
                  (element) =>
                    !supported.some(
                      (component) =>
                        component.id === element.component.id &&
                        component.version === element.component.version,
                    ),
                ),
            )
          )
            throw new Error('Unexpected action target');
          committed = true;
        }
        pending.requestId = event.requestId;
        state = reduceFoundationEvent(state, event);
        publish();
      }
      if (state.status === 'running') state = interruptFoundationRequest(state);
      else if (state.status === 'idle' || (state.status === 'completed' && !committed))
        state = { ...state, status: 'failed', error: 'The update did not complete.' };
    } catch {
      if (state.status === 'running') state = interruptFoundationRequest(state);
      else state = { ...state, status: 'failed', error: 'The update could not be completed.' };
    } finally {
      publish();
      if (active.current === pending) {
        active.current = null;
        setRunning(false);
      }
    }
  }
  function cancel() {
    const pending = active.current;
    if (!pending) return;
    if (canCancel && pending.requestId && client.cancelRequest)
      void client.cancelRequest(pending.requestId, new AbortController().signal).catch(() => {});
    pending.controller.abort();
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void send(text);
  }
  const currentResponseId = [...messages].reverse().find((message) => message.response)
    ?.response?.responseId;
  return (
    <div className="foundation-chat">
      <header className="foundation-header">
        {presentation.brand && <span className="foundation-brand">{presentation.brand}</span>}
        <h1>{presentation.title ?? 'Chat'}</h1>
      </header>
      <div
        ref={transcript}
        className="foundation-transcript"
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        onScroll={(event) => {
          const node = event.currentTarget;
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        {messages.length === 0 &&
          presentation.suggestions &&
          presentation.suggestions.length > 0 && (
            <div className="foundation-suggestions" role="group" aria-label="Suggested prompts">
              {presentation.suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  disabled={!ready || running}
                  onClick={() => void send(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
        {messages.map((message) => (
          <article
            key={message.id}
            className={`foundation-message foundation-${message.role}`}
            aria-label={message.role === 'user' ? 'You' : 'Assistant'}
          >
            {message.response ? (
              <ResponseRenderer
                response={message.response}
                registry={registry}
                presentation={presentation}
                controlsDisabled={running}
                onAction={
                  message.response.responseId === currentResponseId && client.dispatchAction
                    ? (action, payload) => void updateControl(message, action, payload as Arguments)
                    : undefined
                }
                onRetry={
                  message.response.responseId === currentResponseId &&
                  client.dispatchAction &&
                  operations.some(
                    (operation) => operation.id === 'ui.retryBinding' && operation.version === 1,
                  )
                    ? (bindingId) =>
                        void updateControl(
                          message,
                          { id: 'ui.retryBinding', version: 1 },
                          { bindingId },
                        )
                    : undefined
                }
                controls={
                  message.response.responseId !== currentResponseId ||
                  !client.dispatchAction ||
                  !operations.some(
                    (operation) => operation.id === 'ui.setControl' && operation.version === 1,
                  )
                    ? undefined
                    : {
                        onChange: (controlId, value) => {
                          void updateControl(
                            message,
                            { id: 'ui.setControl', version: 1 },
                            { controlId, value },
                          );
                        },
                        ...(client.resolveOptions
                          ? {
                              resolveOptions: (
                                controlId: string,
                                search: string | undefined,
                                cursor: string | undefined,
                                signal: AbortSignal,
                              ) =>
                                client.resolveOptions!(
                                  {
                                    responseId: message.response!.responseId,
                                    revision: message.response!.revision,
                                    generation: message.response!.generation,
                                    controlId,
                                    ...(search ? { search } : {}),
                                    ...(cursor ? { cursor } : {}),
                                  },
                                  signal,
                                ),
                            }
                          : {}),
                      }
                }
                onChoice={
                  message.response.responseId !== currentResponseId || running
                    ? undefined
                    : (blockId, choiceId) => {
                        const block = message.response!.plan.blocks.find(
                          (item) => item.kind === 'clarification' && item.id === blockId,
                        );
                        const label =
                          block?.kind === 'clarification'
                            ? block.choices.find((item) => item.id === choiceId)?.label
                            : undefined;
                        if (label)
                          void send(label, {
                            responseId: message.response!.responseId,
                            blockId,
                            choiceId,
                          });
                      }
                }
              />
            ) : (
              message.text && <p>{message.text}</p>
            )}
            {message.view?.status === 'running' && (
              <p role="status">
                {message.view.staged
                  ? (() => {
                      const entries = Object.values(message.view.staged.bindings);
                      const done = entries.filter((entry) => entry.status !== 'pending').length;
                      return entries.length
                        ? `Preparing response (${done}/${entries.length} data sources settled)…`
                        : 'Responding…';
                    })()
                  : 'Responding…'}
              </p>
            )}
            {message.view?.error && <p role="status">{message.view.error}</p>}
            {message.view?.status === 'interrupted' && message.view.requestId && canReplay && (
              <button type="button" disabled={running} onClick={() => void recover(message)}>
                Recover response
              </button>
            )}
            {message.view?.status === 'cancelled' && <p role="status">Request cancelled.</p>}
          </article>
        ))}
      </div>
      {failure && <p role="alert">{failure}</p>}
      <form onSubmit={submit}>
        <label htmlFor="foundation-composer">{presentation.composerLabel ?? 'Message'}</label>
        <textarea
          id="foundation-composer"
          value={text}
          placeholder={presentation.placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          disabled={!ready || running}
        />
        <button type="submit" disabled={!ready || running || !text.trim()}>
          {presentation.sendLabel ?? 'Send'}
        </button>
        {running && (
          <button type="button" onClick={cancel}>
            Stop
          </button>
        )}
      </form>
    </div>
  );
}
