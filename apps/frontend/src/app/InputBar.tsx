/**
 * Input bar (Phase 3 ticket 3.8).
 *
 * Multiline text field + send. Enter sends, Shift+Enter newline. On send, POSTs
 * to /api/messages and hands the resulting message back to the parent. If the
 * 24h window is closed the server returns 409 WINDOW_CLOSED — we disable input
 * and show the "template required" notice (template UI is Phase 6).
 */
import { type FormEvent, type KeyboardEvent, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { ChatMessage } from './ConversationView';

function newClientId(): string {
  return 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function InputBar({
  conversationId,
  windowOpen,
  onSent,
  setWindowOpen,
}: {
  conversationId: string;
  windowOpen: boolean;
  onSent: (m: ChatMessage) => void;
  setWindowOpen: (open: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const { message } = await api<{ message: ChatMessage }>('/api/messages', {
        method: 'POST',
        body: { conversationId, body, clientId: newClientId() },
      });
      onSent(message);
      setText('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'WINDOW_CLOSED') {
        setWindowOpen(false);
        setError(err.message);
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Could not send. Please try again.');
      }
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  if (!windowOpen) {
    return (
      <div className="border-t border-gray-200 bg-chat-list px-4 py-3 text-center text-sm text-ink-muted">
        The 24-hour window is closed. You can only reply with an approved template message.
        <span className="ml-1 italic">(Template sending — Phase 6.)</span>
      </div>
    );
  }

  return (
    <form onSubmit={send} className="border-t border-gray-200 bg-chat-list px-4 py-3">
      {error && <div className="mb-2 text-sm text-red-600">{error}</div>}
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Type a message"
          className="max-h-32 flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
        />
        <button
          type="submit"
          disabled={sending || !text.trim()}
          className="shrink-0 rounded-lg bg-brand-action px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  );
}
