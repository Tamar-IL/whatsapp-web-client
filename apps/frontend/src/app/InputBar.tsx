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

/** Next future occurrence of a given wall-clock time (e.g. the next 08:00). */
function nextTimeAt(hour: number, minute = 0): Date {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

/** Format a Date for a datetime-local input (local time, no timezone suffix). */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Human label for a scheduled time, e.g. "Today 20:00" / "Tomorrow 08:00". */
function formatWhen(d: Date): string {
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return `Today ${time}`;
  if (sameDay(d, tomorrow)) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
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
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [customWhen, setCustomWhen] = useState('');
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

    // Enforce per-type size limits up front (clear message before send).
    // Video is the exception: oversized clips are auto-compressed server-side to
    // fit WhatsApp's 16MB cap, so we allow large source files (up to the upload
    // cap) and only reject what's too big to even upload.
    const isImage = mime.startsWith('image/');
    const isVideo = mime.startsWith('video/');
    const isAudio = mime.startsWith('audio/');
    const limitMB = isImage ? 5 : isVideo ? 200 : isAudio ? 16 : 100;
    if (file.size > limitMB * 1024 * 1024) {
      const kind = isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio file' : 'file';
      setError(
        isVideo
          ? `This video is ${(file.size / 1024 / 1024).toFixed(0)} MB — too large to upload (max ${limitMB} MB). Trim it shorter and try again.`
          : `This ${kind} is ${(file.size / 1024 / 1024).toFixed(1)} MB — WhatsApp's limit is ${limitMB} MB. ` +
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

  async function schedule(when: Date) {
    const body = text.trim();
    if (!body || scheduling) return;
    if (when.getTime() <= Date.now() + 30 * 1000) {
      setError('Pick a time at least a minute from now.');
      return;
    }
    setScheduling(true);
    setError(null);
    try {
      // The server emits a `scheduled.added` event that the scheduled-message
      // bar picks up, so we don't need to thread the result back up here.
      await api('/api/scheduled', {
        method: 'POST',
        body: {
          conversationId,
          body,
          scheduledFor: when.toISOString(),
          clientId: newClientId(),
          ...(replyingTo ? { replyToId: replyingTo.id } : {}),
        },
      });
      setText('');
      resetHeight();
      onCancelReply();
      setShowSchedule(false);
      setCustomWhen('');
    } catch (err) {
      handleApiError(err, 'Could not schedule the message. Please try again.');
    } finally {
      setScheduling(false);
    }
  }

  function openScheduler() {
    if (!text.trim()) {
      setError('Type a message first, then schedule it.');
      return;
    }
    setError(null);
    setCustomWhen(toLocalInput(nextTimeAt(8, 0)));
    setShowSchedule((s) => !s);
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
    <form onSubmit={send} className="relative bg-[#f0f2f5] px-4 py-3">
      {error && <div className="mb-2 text-center text-sm text-red-600">{error}</div>}

      {/* Schedule-send popover */}
      {showSchedule && (
        <div className="absolute bottom-full left-4 right-4 z-20 mb-2 flex justify-center">
          <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-3 shadow-lg">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">Schedule message</span>
              <button
                type="button"
                onClick={() => setShowSchedule(false)}
                className="rounded-full px-2 text-lg leading-none text-ink-muted hover:text-red-600"
                title="Close"
              >
                ×
              </button>
            </div>
            <div className="mb-2 grid grid-cols-1 gap-1.5">
              {[
                { label: 'In 1 hour', date: new Date(Date.now() + 60 * 60 * 1000) },
                { label: 'In 3 hours', date: new Date(Date.now() + 3 * 60 * 60 * 1000) },
                { label: 'Morning', date: nextTimeAt(8, 0) },
              ].map((p) => (
                <button
                  key={p.label}
                  type="button"
                  disabled={scheduling}
                  onClick={() => void schedule(p.date)}
                  className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-left text-sm hover:border-brand-primary hover:bg-brand-action/5 disabled:opacity-50"
                >
                  <span className="font-medium text-ink">{p.label}</span>
                  <span className="text-xs text-ink-muted">{formatWhen(p.date)}</span>
                </button>
              ))}
            </div>
            <label className="mb-1 block text-xs font-medium text-ink-muted">Or pick a time</label>
            <div className="flex items-center gap-2">
              <input
                type="datetime-local"
                value={customWhen}
                min={toLocalInput(new Date(Date.now() + 60 * 1000))}
                onChange={(e) => setCustomWhen(e.target.value)}
                className="flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-brand-primary focus:outline-none"
              />
              <button
                type="button"
                disabled={scheduling || !customWhen}
                onClick={() => customWhen && void schedule(new Date(customWhen))}
                className="shrink-0 rounded-lg bg-brand-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {scheduling ? '…' : 'Schedule'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Replying-to bar */}
      {replyingTo && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border-l-4 border-brand-link bg-brand-action/10 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-brand-primary">
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
            <div className="text-xs text-ink-muted">
              {staged.size >= 1024 * 1024
                ? `${(staged.size / 1024 / 1024).toFixed(1)} MB`
                : `${(staged.size / 1024).toFixed(0)} KB`}
              {' · '}
              {staged.type.startsWith('video/') && staged.size > 15.3 * 1024 * 1024
                ? (sending ? 'optimizing & sending…' : 'will be optimized on send')
                : sending
                  ? 'sending…'
                  : 'ready to send'}
            </div>
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

        {/* Pill containing send (far left) + attach + textarea */}
        <div className="flex flex-1 items-end gap-2 rounded-3xl border border-gray-300 bg-white px-3 py-2 shadow-sm focus-within:border-brand-primary focus-within:ring-1 focus-within:ring-brand-primary">
          {/* Send — teal-green icon only (no circle), far left, mirrored */}
          <button
            type="submit"
            disabled={!canSend}
            title="Send"
            className="shrink-0 leading-none text-brand-link transition hover:text-brand-primary disabled:opacity-40"
          >
            {sending ? (
              <span className="text-sm">…</span>
            ) : (
              <svg viewBox="0 0 24 24" className="h-6 w-6 -scale-x-100 fill-current">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            )}
          </button>
          <button
            type="button"
            title="Attach a file"
            onClick={() => fileRef.current?.click()}
            disabled={sending}
            className="shrink-0 text-xl leading-none text-ink-muted hover:text-brand-primary disabled:opacity-50"
          >
            📎
          </button>
          {/* Schedule send — text only (a staged file is sent immediately) */}
          {!staged && (
            <button
              type="button"
              title="Schedule message"
              onClick={openScheduler}
              disabled={sending || scheduling}
              className={
                'shrink-0 leading-none transition disabled:opacity-50 ' +
                (showSchedule ? 'text-brand-primary' : 'text-ink-muted hover:text-brand-primary')
              }
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm.5-13H11v6l5 3 .75-1.23-4.25-2.52V7z" />
              </svg>
            </button>
          )}
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
      </div>
    </form>
  );
}
