import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FoundationHttpClient } from '../../../packages/client-runtime/http.ts';
import { ChatShell } from '../../../packages/renderer-openui/chat-shell.tsx';
import { builtinRegistry } from '../../../packages/renderer-openui/builtins.tsx';
import '../../../packages/renderer-openui/foundation.css';
import './v2.css';

const client = new FoundationHttpClient('/api/v2');
const key = 'reference.v2.conversation';
function newConversation() {
  return `conversation${crypto.randomUUID().replaceAll('-', '')}`;
}
function App() {
  const [conversationId, setConversationId] = useState(() => {
    const saved = localStorage.getItem(key);
    if (saved && /^conversation[a-f0-9]{32}$/.test(saved)) return saved;
    const next = newConversation();
    localStorage.setItem(key, next);
    return next;
  });
  return (
    <div className="reference-v2">
      <button
        className="new-chat"
        type="button"
        onClick={() => {
          const next = newConversation();
          localStorage.setItem(key, next);
          setConversationId(next);
        }}
      >
        New chat
      </button>
      <ChatShell
        client={client}
        conversationId={conversationId}
        registry={builtinRegistry}
        presentation={{
          title: 'Source',
          composerLabel: 'Message',
          placeholder: 'Ask a question about your data',
        }}
      />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
