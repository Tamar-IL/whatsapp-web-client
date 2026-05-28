/**
 * Input bar (Phase 3 ticket 3.8) — WhatsApp-style.
 *
 * Rounded pill text field + circular send button. Enter sends, Shift+Enter newline.
 * The paperclip is a placeholder for file sending (Round 2). If the 24h window is
 * closed the server returns 409 WINDOW_CLOSED — we show the template notice.
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
      <div className="border-t border-black/10 bg-[#f0f2f5] px-4 py-3 text-center text-sm text-ink-muted">
        The 24-hour window is closed. You can only reply with an approved template message.
        <span className="ml-1 italic">(Template sending — Phase 6.)</span>
      </div>
    );
  }

  return (
    <form onSubmit={send} className="bg-[#f0f2f5] px-4 py-3">
      {error && <div className="mb-2 text-center text-sm text-red-600">{error}</div>}
      <div className="flex items-end gap-2">
        {/* Attach (file sending — Round 2) */}
        <button
          type="button"
          title="Attach a file (coming soon)"
          className="mb-1 shrink-0 cursor-not-allowed text-xl text-ink-muted opacity-60"
          disabled
        >
          📎
        </button>

        <div className="flex flex-1 items-end rounded-3xl bg-white px-4 py-2 shadow-sm">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Type a message"
            className="max-h-32 flex-1 resize-none bg-transparent text-sm leading-6 focus:outline-none"
          />
        </div>

        <button
          type="submit"
          disabled={sending || !text.trim()}
          title="Send"
          className="mb-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-primary text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {sending ? '…' : (
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          )}
        </button>
      </div>
    </form>
  );
}
