import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Action, Artifact, Event, Row } from '../../../packages/contracts/index.ts';
import {
  consumeSSE,
  initialState,
  reduceEvent,
  type ClientState,
} from '../../../packages/client-runtime/index.ts';
import { layout } from '../../../packages/layout/index.ts';
import { OpenUIPanel } from '../../../packages/renderer-openui/index.tsx';
import './style.css';
import { ExpandablePanel } from './expandable-panel.tsx';
import { responseMessages } from '../../../packages/layout/messages.ts';

type Message = { id: string; role: string; text: string; evidence?: unknown; visual?: Artifact };
function InlineArtifact({
  artifact,
  current,
  updating,
  busy,
  action,
  openRecord,
  panelIds,
  showToolbar = true,
}: {
  panelIds?: string[];
  showToolbar?: boolean;
  artifact: Artifact;
  current: boolean;
  updating: boolean;
  busy: boolean;
  action: (value: Action) => void;
  openRecord: (row: Row) => void;
}) {
  const [width, setWidth] = useState(900);
  const workspace = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!workspace.current) return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    observer.observe(workspace.current);
    return () => observer.disconnect();
  }, []);
  const [options, setOptions] = useState<Record<string, string[]>>({});
  const [optionsError, setOptionsError] = useState(false);
  useEffect(() => {
    if (!current || !artifact.plan.filters.length) {
      setOptions({});
      return;
    }
    let active = true;
    setOptions({});
    setOptionsError(false);
    void api(`/api/artifacts/${artifact.artifactId}/filter-options`)
      .then((value) => {
        if (active) setOptions(value);
      })
      .catch(() => {
        if (active) setOptionsError(true);
      });
    return () => {
      active = false;
    };
  }, [current, artifact.artifactId, artifact.revision, artifact.generationId]);
  const panels = panelIds
    ? panelIds.map((id) => artifact.plan.panels.find((panel) => panel.id === id)!)
    : artifact.plan.panels;
  const placements = layout(panels, width);
  return (
    <section
      className="inline-artifact"
      data-kind={
        artifact.plan.panels.length === 1 ? artifact.plan.panels[0].component : 'collection'
      }
      data-current={current ? 'true' : 'false'}
      data-revision={artifact.revision}
      ref={workspace}
      aria-label="Response visualization"
      aria-busy={updating}
    >
      {artifact.plan.panels.length > 1 && (
        <div className="workspace-head">
          <div>
            <p className="eyebrow">IN THIS RESPONSE</p>
            <h2>{artifact.plan.title}</h2>
          </div>
        </div>
      )}
      {current && showToolbar && (
        <div className="toolbar">
          {artifact.plan.filters.map((filter) => (
            <label key={filter.id}>
              {filter.label}{' '}
              <select
                aria-label={filter.label}
                value={String(artifact.filters[filter.id as keyof typeof artifact.filters] ?? '')}
                disabled={busy || !options[filter.id]}
                onChange={(e) =>
                  action({ type: 'setFilter', filters: { [filter.id]: e.target.value || null } })
                }
              >
                <option value="">All available {filter.label.toLowerCase()} values</option>
                {options[filter.id]?.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {optionsError && <span role="alert">Filter options are unavailable.</span>}
          <button onClick={() => void action({ type: 'refresh' })} disabled={busy || updating}>
            Refresh
          </button>
          <button onClick={() => void action({ type: 'saveView' })} disabled={busy || updating}>
            Save view
          </button>
          <span className="muted">{updating ? 'Updating all panels…' : 'Source snapshot'}</span>
        </div>
      )}
      {!current && <p className="muted">Earlier response · preserved snapshot</p>}
      <p className="scope">
        Scope:{' '}
        {Object.entries({
          ...(artifact.plan.bindings[0]?.toolId === 'provided.data'
            ? {}
            : artifact.plan.bindings[0]?.args),
          ...artifact.filters,
        })
          .filter(([k, v]) => v !== null && k !== 'sourceText' && k !== 'view')
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · ') ||
          (artifact.plan.bindings.some(
            (b) => b.toolId === 'project.suppliedSchedule' || b.toolId === 'provided.data',
          )
            ? 'Content snapshot for this response'
            : 'All authorized source records')}
      </p>
      <div className={`panel-grid ${updating ? 'updating' : ''}`}>
        {panels.map((panel, i) => {
          const state = artifact.datasets[panel.bindingId];
          return (
            <article
              className="panel"
              key={panel.id}
              data-panel-id={panel.id}
              style={{
                gridColumn: `span ${placements[i].span}`,
                minHeight: placements[i].minHeight,
              }}
            >
              <ExpandablePanel title={panel.title}>
                {!state || state.status === 'loading' ? (
                  <div className="skeleton" role="status">
                    Loading source data…
                  </div>
                ) : state.status === 'error' ? (
                  <div role="alert">
                    <p>Source unavailable: {state.code}</p>
                    <button onClick={() => void action({ type: 'refresh' })}>Retry source</button>
                  </div>
                ) : (
                  <OpenUIPanel
                    readOnly={!current}
                    panel={panel}
                    data={state.data}
                    onAction={(a) => void action(a)}
                    onRecord={(r) => void openRecord(r)}
                  />
                )}
                <footer className="panel-source">
                  {state?.status === 'ready' ? (
                    <>
                      Source: {state.data.sourceId} · as of {state.data.asOf}
                      {state.data.warnings.map((warning, index) => (
                        <div key={index}>{warning}</div>
                      ))}
                    </>
                  ) : (
                    'Source details available when data loads.'
                  )}
                </footer>
              </ExpandablePanel>
            </article>
          );
        })}
      </div>
      {artifact.plan.panels.some((panel) =>
        Object.values(panel.config).flat().includes('sla_mean'),
      ) && (
        <p className="footnote">
          SLA means are unweighted source-record averages. This file does not provide ticket-level
          denominators or causal explanations.
        </p>
      )}
    </section>
  );
}

async function api(path: string, body?: unknown) {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'REQUEST_FAILED');
  return value;
}
function newId() {
  return crypto.randomUUID();
}
function App() {
  const [conversation, setConversation] = useState(
    () => localStorage.getItem('csv.conversation') ?? newId(),
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [client, setClient] = useState<ClientState>(initialState);
  const clientRef = useRef(client);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [hydrating, setHydrating] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [notice, setNotice] = useState('');
  const [session, setSession] = useState<{ mode: string; domainOptions: string[] } | null>(null);
  const [record, setRecord] = useState<Row | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const actionSequence = useRef(0);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const transcript = useRef<HTMLDivElement | null>(null);
  const followBottom = useRef(true);
  useEffect(() => {
    if (followBottom.current && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [messages, busy]);
  const artifact = client.artifact;
  function setState(next: ClientState) {
    clientRef.current = next;
    setClient(next);
  }
  function fail(error: unknown) {
    const code = error instanceof Error ? error.message : 'REQUEST_FAILED';
    setNotice(code === 'DATA_FORBIDDEN' ? 'Access is no longer available.' : code);
    if (code === 'DATA_FORBIDDEN') {
      setState({ ...initialState });
      setMessages([]);
      setRecord(null);
    }
  }
  useEffect(() => {
    void api('/api/session').then(setSession).catch(fail);
  }, []);
  useEffect(() => {
    localStorage.setItem('csv.conversation', conversation);
    setHydrating(true);
    let active = true;
    void api(`/api/conversations/${conversation}`, {})
      .then((data) => {
        if (active) {
          setMessages(data.messages);
          const a = data.artifacts.at(-1);
          setState({ ...initialState, artifact: a });
        }
      })
      .catch((error) => {
        if (active) fail(error);
      })
      .finally(() => {
        if (active) setHydrating(false);
      });
    return () => {
      active = false;
    };
  }, [conversation]);
  useEffect(() => {
    if (record && !dialog.current?.open) dialog.current?.showModal();
    if (!record && dialog.current?.open) dialog.current.close();
  }, [record]);
  // Revalidate access in an open view; server still authorizes every operation.
  useEffect(() => {
    const id = setInterval(() => {
      void api('/api/session').catch(fail);
    }, 5000);
    return () => clearInterval(id);
  }, []);
  async function recover(requestId: string) {
    for (let attempt = 0; attempt < 120; attempt++) {
      let result;
      try {
        result = await api(
          `/api/requests/${requestId}/events?after=${clientRef.current.lastSequence[requestId] ?? 0}`,
        );
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'REPLAY_EXPIRED') throw error;
        const status = await api(`/api/requests/${requestId}`);
        if (status.status === 'running') {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        const restored = await api(`/api/conversations/${status.conversationId}`);
        setMessages(restored.messages);
        setState({
          ...initialState,
          artifact: restored.artifacts.at(-1),
          status: status.status === 'completed' ? 'completed' : 'failed',
          error: status.status === 'completed' ? undefined : 'REQUEST_INTERRUPTED',
        });
        return;
      }
      for (const e of result.events) setState(reduceEvent(clientRef.current, e));
      if (result.status !== 'running') {
        if (result.status === 'interrupted') throw new Error('REQUEST_INTERRUPTED');
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('REQUEST_TIMEOUT');
  }
  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!question.trim() || busy || hydrating) return;
    const text = question.trim();
    followBottom.current = true;
    setQuestion('');
    setNotice('');
    setBusy(true);
    const assistantId = newId();
    setMessages((m) => [
      ...m,
      { id: newId(), role: 'user', text },
      { id: assistantId, role: 'assistant', text: '' },
    ]);
    setState({
      ...clientRef.current,
      status: 'running',
      text: '',
      requestId: undefined,
      error: undefined,
    });
    const current = clientRef.current.artifact;
    try {
      const response = await fetch('/api/chat/turns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversation,
          text,
          idempotencyKey: newId(),
          ...(current ? { artifactId: current.artifactId, baseRevision: current.revision } : {}),
        }),
      });
      try {
        await consumeSSE(response, (raw) => {
          const e = raw as Event;
          const next = reduceEvent(clientRef.current, e);
          setState(next);
          setMessages((list) =>
            list.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    text: next.text,
                    evidence: next.evidence,
                    ...((e.type === 'artifact.committed' || e.type === 'artifact.settled') &&
                    next.artifact
                      ? { visual: next.artifact }
                      : {}),
                  }
                : m,
            ),
          );
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'STREAM_INTERRUPTED' &&
          clientRef.current.requestId
        )
          await recover(clientRef.current.requestId);
        else throw error;
      }
      const end = clientRef.current;
      if (end.text)
        setMessages((list) =>
          list.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  text: end.text,
                  evidence: end.evidence,
                  ...(end.artifact &&
                  (end.artifact.artifactId !== current?.artifactId ||
                    end.artifact.revision !== current?.revision)
                    ? { visual: end.artifact }
                    : {}),
                }
              : m,
          ),
        );
      if (end.error) {
        setNotice(end.error);
        setMessages((list) =>
          list.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  text:
                    end.text ||
                    'I could not generate a usable response. Please retry or clarify your request.',
                }
              : m,
          ),
        );
      }
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
      composer.current?.focus();
    }
  }
  async function action(target: Artifact, value: Action) {
    const artifact = target;
    const seq = ++actionSequence.current;
    setUpdating(true);
    setNotice('');
    try {
      const updated: Artifact = await api(`/api/artifacts/${artifact.artifactId}/actions`, {
        baseRevision: artifact.revision,
        action: value,
      });
      if (seq === actionSequence.current) {
        setState({ ...clientRef.current, artifact: updated });
        setMessages((list) =>
          list.map((m) =>
            m.visual?.artifactId === updated.artifactId && m.visual.revision === updated.revision
              ? { ...m, visual: updated }
              : m,
          ),
        );
        setNotice(value.type === 'saveView' ? 'View saved.' : 'View updated.');
      }
    } catch (e) {
      fail(e);
    } finally {
      if (seq === actionSequence.current) setUpdating(false);
    }
  }
  async function openRecord(row: Row) {
    try {
      setRecord(await api(`/api/records?id=${encodeURIComponent(String(row.rowId))}`));
    } catch (e) {
      fail(e);
    }
  }
  return (
    <div className="app chat-app">
      <header className="topbar">
        <a href="/" className="brand">
          <span className="brand-mark">S</span>Source
          <span className="brand-caption"> / operations intelligence</span>
        </a>
        <div className="header-right">
          <span className="status-dot" />
          {session?.mode === 'deepseek' ? 'DeepSeek connected' : 'Deterministic demo'}
          <button
            onClick={() => {
              setHydrating(true);
              setConversation(newId());
              setState(initialState);
              setMessages([]);
              setNotice('');
            }}
            disabled={busy || hydrating}
          >
            New chat
          </button>
        </div>
      </header>
      <main className="content">
        <section className="conversation" aria-label="Conversation">
          {messages.length === 0 && (
            <div className="welcome">
              <h1>What would you like to explore?</h1>
              <p>Ask a question. I’ll bring the data into our conversation when it helps.</p>
              <p className="muted">Monthly systems data · January 2023–May 2025</p>
              <div className="suggestions">
                {[
                  'How many source records are in the file?',
                  'Show monthly unweighted mean SLA rate and source-record counts by domain.',
                  'What is the unweighted mean of all recorded SLA rates?',
                  'Show a project management demo',
                ].map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      setQuestion(t);
                      composer.current?.focus();
                    }}
                  >
                    {t}
                    <span>↗</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div
            className="transcript"
            ref={transcript}
            onScroll={() => {
              const el = transcript.current;
              if (el) followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            }}
            role="log"
            aria-label="Chat messages"
            aria-live="polite"
          >
            {messages.flatMap((m) => {
              const groups = m.visual ? responseMessages(m.visual) : [{ id: m.id, panelIds: [] }];
              return groups.map((group, groupIndex) => (
                <article
                  key={`${m.id}-${group.id}`}
                  className={`message ${m.role}`}
                  data-message-id={m.id}
                  data-message-group={group.id}
                >
                  <p className="message-role">{m.role === 'user' ? 'YOU' : 'SOURCE'}</p>
                  <div className="message-bubble">
                    {groupIndex === 0 && m.text && <p className="message-text">{m.text}</p>}
                    {m.visual && (
                      <InlineArtifact
                        artifact={m.visual}
                        panelIds={group.panelIds}
                        showToolbar={groupIndex === 0}
                        current={
                          m.visual.artifactId === artifact?.artifactId &&
                          m.visual.revision === artifact?.revision
                        }
                        updating={updating && m.visual.revision === artifact?.revision}
                        busy={busy}
                        action={(value) => void action(m.visual!, value)}
                        openRecord={(row) => void openRecord(row)}
                      />
                    )}
                    {groupIndex === 0 && !!m.evidence && (
                      <details className="evidence">
                        <summary>Source evidence</summary>
                        <p>Immutable source snapshot · provenance details</p>
                        <pre>
                          {JSON.stringify(
                            typeof m.evidence === 'string' ? JSON.parse(m.evidence) : m.evidence,
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    )}
                  </div>
                </article>
              ));
            })}
            {busy && (
              <p className="working" role="status">
                Working with the source data…
              </p>
            )}
          </div>
          <form onSubmit={send} className="composer">
            <label htmlFor="question">Ask about your data</label>
            <textarea
              id="question"
              ref={composer}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Ask a question about the source records…"
              rows={2}
              maxLength={16000}
              disabled={busy || hydrating}
            />
            <div className="composer-footer">
              <span>Grounded in your CSV</span>
              {busy ? (
                <button
                  type="button"
                  onClick={() =>
                    clientRef.current.requestId &&
                    void api(`/api/requests/${clientRef.current.requestId}/cancel`, {})
                  }
                >
                  Cancel
                </button>
              ) : (
                <button className="primary" type="submit" disabled={!question.trim() || hydrating}>
                  Send question <span>↑</span>
                </button>
              )}
            </div>
          </form>
          <p className="notice" role="status">
            {notice}
          </p>
        </section>
      </main>
      <dialog
        ref={dialog}
        aria-label="Source record"
        className="drawer"
        onClose={() => setRecord(null)}
      >
        {record && (
          <>
            <button autoFocus onClick={() => setRecord(null)}>
              Close record
            </button>
            <h2>Source record</h2>
            <dl>
              {Object.entries(record).map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt>{k}</dt>
                  <dd>{v === null ? 'Missing' : String(v)}</dd>
                </React.Fragment>
              ))}
            </dl>
          </>
        )}
      </dialog>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
