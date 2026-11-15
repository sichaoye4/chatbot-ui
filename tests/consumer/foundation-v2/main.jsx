import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatShell, ResponseRenderer } from '@source/chat-foundation-v2/react';
import { MaterializedResponse, ProtocolEvent } from '@source/chat-foundation-v2/contracts';
import '@source/chat-foundation-v2/styles.css';

// This fixture owns its data, execution, history and transport. It does not use the
// framework server, reference application, CSV connector, or provider adapter.
const sources = {
  library: { label: 'Library books', unit: 'books', rows: [{ value: 42 }] },
  energy: { label: 'Energy capacity', unit: 'MW', rows: [{ value: 17 }] },
};
const key = 'independent-foundation-conversation';
const component = { id: 'host.reading', version: 1 };
const id = (prefix) => prefix + crypto.randomUUID().replaceAll('-', '');
const response = (messageId, domain) => {
  const source = sources[domain];
  const tool = { id: `${domain}.read`, version: 1 };
  const field = { id: 'value', label: source.label, type: 'number', role: 'measure', nullable: false,
    description: 'Host-owned synthetic measure', unit: source.unit,
    measure: { aggregation: 'Current total', precision: 0, additive: false } };
  return MaterializedResponse.parse({
    protocolVersion: 2, messageId, responseId: id('response'), revision: 1, generation: 0,
    plan: { schemaVersion: 2, capabilitySnapshotId: 'hostcapabilities',
      bindings: [{ id: 'data', tool, args: {}, fixedArgs: {} }], facts: [],
      blocks: [{ id: 'visual', kind: 'visual', layoutIntent: 'auto', controls: [],
        elements: [{ id: 'reading', component, title: source.label,
          roles: { value: [{ bindingId: 'data', fieldId: 'value' }] }, props: {} }] }] },
    bindingDescriptors: [{ bindingId: 'data', source: tool, fields: [field], grain: 'one total' }],
    datasets: { data: { status: 'ready', result: { rows: source.rows, provenance: {
      sourceId: domain, sourceVersion: '1', queryId: id('query'), executedAt: '2026-01-01T00:00:00Z',
      grain: 'one total', truncated: false, nextCursor: null, warnings: [] } } } },
    facts: {}, operations: [], status: 'complete', diagnostics: [],
  });
};
const history = () => JSON.parse(localStorage.getItem(key) || '[]');
const client = {
  async negotiate() { return { protocolVersion: 2, components: [component], operations: [], history: true, replay: false, cancellation: false }; },
  async getConversation(conversationId) { return { conversationId, messages: history() }; },
  async *sendTurn(input) {
    const domain = input.text.toLowerCase().includes('energy') ? 'energy' : 'library';
    const result = response(input.messageId, domain);
    const text = `Independent ${domain} result`;
    const messages = [...history(), { id: id('user'), role: 'user', text: input.text },
      { id: input.messageId, role: 'assistant', text, response: result }];
    localStorage.setItem(key, JSON.stringify(messages));
    const base = { protocolVersion: 2, requestId: id('request'), conversationId: input.conversationId, messageId: input.messageId };
    const events = [ { type: 'request.started' }, { type: 'text.delta', text },
      { type: 'response.committed', response: result }, { type: 'request.completed' } ];
    for (const [sequence, event] of events.entries()) yield ProtocolEvent.parse({ ...base, ...event, sequence, eventId: id('event') });
  },
};
const registry = { 'host.reading@1': ({ data, fields }) => <output aria-label="Host reading">{data.rows[0].value} {fields[0].unit}</output> };
const embedded = new URLSearchParams(location.search).has('embed');
createRoot(document.getElementById('root')).render(embedded
  ? <ResponseRenderer response={response('embeddedmessage', 'library')} registry={registry} />
  : <ChatShell client={client} conversationId="hostconversation" registry={registry} />);
