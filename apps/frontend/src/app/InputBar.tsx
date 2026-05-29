/**
 * Input bar (Phase 3 ticket 3.8) — WhatsApp-style.
 *
 * Rounded pill text field + circular send button. Enter sends, Shift+Enter newline.
 * The paperclip is a placeholder for file sending (Round 2). If the 24h window is
 * closed the server returns 409 WINDOW_CLOSED — we show the template notice.
 */
import { type ChangeEvent, type FormEvent, type KeyboardEvent, useRef, useState } from 'react';
import { api, apiUpload, ApiError } from '../api/client';
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
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea up to a max height (so Shift+Enter expands the box
  // instead of showing a 1-line scrollbar).
  function autoGrow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }
  function onChangeText(v: string) {
    setText(v);
    // Defer so scrollHeight reflects the new content.
    requestAnimationFrame(autoGrow);
  }
  function resetHeight() {
    const ta = taRef.current;
    if (ta) ta.style.height = 'auto';
  }

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file || sending) return;

    // Friendly client-side size guard (WhatsApp caps vary; 16MB is a safe ceiling).
    if (file.size > 16 * 1024 * 1024) {
      setError('File is too large (max 16 MB).');
      return;
    }

    setSending(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('conversationId', conversationId);
      form.append('clientId', newClientId());
      if (text.trim()) form.append('caption', text.trim());
      const { message } = await apiUpload<{ message: ChatMessage }>('/api/messages/media', form);
      onSent(message);
      setText('');
      resetHeight();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'WINDOW_CLOSED') {
        setWindowOpen(false);
        setError(err.message);
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Could not send the file. Please try again.');
      }
    } finally {
      setSending(false);
    }
  }

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
      resetHeight();
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
        {/* Attach a file */}
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
          onChange={onPickFile}
        />
        <button
          type="button"
          title="Attach a file"
          onClick={() => fileRef.current?.click()}
          disabled={sending}
          className="mb-1 shrink-0 text-xl text-ink-muted hover:text-brand-primary disabled:opacity-50"
        >
          📎
        </button>

        <div className="flex flex-1 items-end rounded-3xl border border-gray-300 bg-white px-4 py-2 shadow-sm focus-within:border-brand-primary focus-within:ring-1 focus-within:ring-brand-primary">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => onChangeText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Type a message"
            className="max-h-40 flex-1 resize-none bg-transparent text-sm leading-6 focus:outline-none"
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
