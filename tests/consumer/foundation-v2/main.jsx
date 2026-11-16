import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ChatShell,
  ResponseRenderer,
  builtinRegistry,
} from '@source/chat-foundation-v2/react';
import { FoundationHttpClient } from '@source/chat-foundation-v2/client';
import { MaterializedResponse } from '@source/chat-foundation-v2/contracts';
import '@source/chat-foundation-v2/styles.css';

const headers = () => ({ Authorization: 'Bearer host-dev-secret' });
const client = new FoundationHttpClient('/api', headers);

const registry = {
  ...builtinRegistry,
  'host.reading@1': ({ data, fields }) => (
    <output aria-label="Host reading">
      {data.rows[0].value} {fields[0].unit}
    </output>
  ),
};

function EmbeddedHost() {
  const [response, setResponse] = useState(null);
  useEffect(() => {
    fetch('/api/embedded', { headers: headers() })
      .then((res) => res.json())
      .then((payload) => setResponse(MaterializedResponse.parse(payload)));
  }, []);
  return response ? <ResponseRenderer response={response} registry={registry} /> : <p>Loading…</p>;
}

const embedded = new URLSearchParams(location.search).has('embed');
createRoot(document.getElementById('root')).render(
  embedded ? (
    <EmbeddedHost />
  ) : (
    <ChatShell client={client} conversationId="hostconversation" registry={registry} />
  ),
);
