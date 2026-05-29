/**
 * Input bar — WhatsApp-style.
 *
 * Text: Enter sends, Shift+Enter newline; textarea auto-grows.
 * Files: the paperclip STAGES a file (with a preview); it's only sent when you
 * press Send/Enter (optionally with the text as a caption). A × removes the stage.
 * 24h window closed → server returns 409 WINDOW_CLOSED → show template notice.
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
  replyingTo,
  onCancelReply,
}: {
  conversationId: string;
  windowOpen: boolean;
  onSent: (m: ChatMessage) => void;
  setWindowOpen: (open: boolean) => void;
  replyingTo: ChatMessage | null;
  onCancelReply: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<File | null>(null);
  const [stagedPreview, setStagedPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  function autoGrow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }
  function onChangeText(v: string) {
    setText(v);
    requestAnimationFrame(autoGrow);
  }
  function resetHeight() {
    const ta = taRef.current;
    if (ta) ta.style.height = 'auto';
  }

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const mime = file.type || '';
    // WhatsApp doesn't support SVG images.
    if (mime === 'image/svg+xml') {
      setError("WhatsApp doesn't support SVG images. Please use a JPG or PNG.");
      return;
    }

    // Enforce WhatsApp's per-type size limits up front (clear message before send).
    const isImage = mime.startsWith('image/');
    const isVideo = mime.startsWith('video/');
    const isAudio = mime.startsWith('audio/');
    const limitMB = isImage ? 5 : isVideo || isAudio ? 16 : 100;
    if (file.size > limitMB * 1024 * 1024) {
      const kind = isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio file' : 'file';
      setError(
        `This ${kind} is ${(file.size / 1024 / 1024).toFixed(1)} MB — WhatsApp's limit is ${limitMB} MB. ` +
          (isImage ? 'Try compressing or resizing it.' : ''),
      );
      return;
    }

    setError(null);
    setStaged(file);
    setStagedPreview(isImage ? URL.createObjectURL(file) : null);
  }

  function clearStaged() {
    if (stagedPreview) URL.revokeObjectURL(stagedPreview);
    setStaged(null);
    setStagedPreview(null);
  }

  function handleApiError(err: unknown, fallback: string) {
    if (err instanceof ApiError && err.code === 'WINDOW_CLOSED') {
      setWindowOpen(false);
      setError(err.message);
    } else if (err instanceof ApiError) {
      setError(err.message);
    } else {
      setError(fallback);
    }
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (sending) return;

    // A staged file takes priority; the text becomes its caption.
    if (staged) {
      setSending(true);
      setError(null);
      try {
        const form = new FormData();
        form.append('file', staged);
        form.append('conversationId', conversationId);
        form.append('clientId', newClientId());
        if (text.trim()) form.append('caption', text.trim());
        const { message } = await apiUpload<{ message: ChatMessage }>('/api/messages/media', form);
        onSent(message);
        setText('');
        resetHeight();
        clearStaged();
      } catch (err) {
        handleApiError(err, 'Could not send the file. Please try again.');
      } finally {
        setSending(false);
      }
      return;
    }

    const body = text.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      const { message } = await api<{ message: ChatMessage }>('/api/messages', {
        method: 'POST',
        body: {
          conversationId,
          body,
          clientId: newClientId(),
          ...(replyingTo ? { replyToId: replyingTo.id } : {}),
        },
      });
      onSent(message);
      setText('');
      resetHeight();
      onCancelReply();
    } catch (err) {
      handleApiError(err, 'Could not send. Please try again.');
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

  const canSend = !sending && (Boolean(staged) || text.trim().length > 0);

  return (
    <form onSubmit={send} className="bg-[#f0f2f5] px-4 py-3">
      {error && <div className="mb-2 text-center text-sm text-red-600">{error}</div>}

      {/* Replying-to bar */}
      {replyingTo && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border-l-4 border-brand-action bg-white px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-brand-link">
              Replying to {replyingTo.direction === 'outbound' ? 'yourself' : 'them'}
            </div>
            <div className="truncate text-sm text-ink-muted">
              {replyingTo.body ?? `[${replyingTo.type}]`}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancelReply}
            className="shrink-0 rounded-full px-2 text-lg text-ink-muted hover:text-red-600"
            title="Cancel reply"
          >
            ×
          </button>
        </div>
      )}

      {/* Staged file preview */}
      {staged && (
        <div className="mb-2 flex items-center gap-3 rounded-lg border border-gray-300 bg-white px-3 py-2">
          {stagedPreview ? (
            <img src={stagedPreview} alt="preview" className="h-12 w-12 rounded object-cover" />
          ) : (
            <span className="text-2xl">📎</span>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-ink">{staged.name}</div>
            <div className="text-xs text-ink-muted">{(staged.size / 1024).toFixed(0)} KB · ready to send</div>
          </div>
          <button
            type="button"
            onClick={clearStaged}
            className="shrink-0 rounded-full px-2 text-lg text-ink-muted hover:text-red-600"
            title="Remove"
          >
            ×
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
          onChange={onPickFile}
        />

        {/* Pill containing the attach button + textarea (attach now lives inside) */}
        <div className="flex flex-1 items-end gap-2 rounded-3xl border border-gray-300 bg-white px-3 py-2 shadow-sm focus-within:border-brand-primary focus-within:ring-1 focus-within:ring-brand-primary">
          <button
            type="button"
            title="Attach a file"
            onClick={() => fileRef.current?.click()}
            disabled={sending}
            className="shrink-0 text-xl leading-none text-ink-muted hover:text-brand-primary disabled:opacity-50"
          >
            📎
          </button>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => onChangeText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={staged ? 'Add a caption (optional)' : 'Type a message'}
            className="max-h-40 flex-1 resize-none bg-transparent text-sm leading-6 focus:outline-none"
          />
        </div>

        <button
          type="submit"
          disabled={!canSend}
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
