/**
 * Input bar — WhatsApp-style.
 *
 * Text: Enter sends, Shift+Enter newline; textarea auto-grows.
 * Files: the paperclip STAGES a file (with a preview); it's only sent when you
 * press Send/Enter (optionally with the text as a caption). A × removes the stage.
 * Buttons: the 🔘 button attaches up to 3 quick-reply chips to the typed text.
 * 24h window closed → server returns 409 WINDOW_CLOSED → show template notice.
 */
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { api, apiUpload, ApiError } from '../api/client';
import { TemplateModal } from './TemplateModal';
import type { ChatMessage } from './ConversationView';

/**
 * Emoji offered by the picker, in the order they appear.
 *
 * A hand-picked common set rather than a full Unicode browser: this is for
 * dropping a 👍 or a ❤️ into a reply, not for hunting an obscure glyph. Grouped
 * loosely — faces, hands, hearts, then everyday symbols — so the eye can land on
 * the right region quickly.
 */
const EMOJI = [
  '😀', '😂', '🤣', '🙂', '😉', '😊', '😍', '🥰',
  '😘', '😎', '🤔', '🤗', '😅', '😢', '😭', '😡',
  '🥳', '😴', '🤦', '🤷', '😱', '🤩', '😇', '🙃',
  '👍', '👎', '👌', '🙏', '👏', '💪', '🤝', '✌️',
  '👋', '☝️', '🤞', '🫶', '❤️', '🧡', '💛', '💚',
  '💙', '💜', '🖤', '💔', '💕', '✨', '🔥', '⭐',
  '🎉', '🎁', '✅', '❌', '❗', '❓', '💯', '👀',
  '☀️', '🌙', '📞', '📩', '⏰', '🚗', '🏠', '🍀',
];

/**
 * Quick-reply limits, mirroring the server (twilio/quickReply.ts).
 *
 * Three is not an arbitrary UI choice: it is WhatsApp's cap for a quick-reply
 * sent WITHOUT Meta approval, which is the only kind this app sends. Going to
 * four would drag every button message into the approval queue.
 */
const MAX_BUTTONS = 3;
const MAX_BUTTON_CHARS = 20;
/** Twilio's cap on a quick-reply body — lower than the 4096 a plain text allows. */
const MAX_BUTTON_BODY_CHARS = 1024;

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
  const [showEmoji, setShowEmoji] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showButtons, setShowButtons] = useState(false);
  const [buttonLabels, setButtonLabels] = useState<string[]>(['']);
  const [sendingButtons, setSendingButtons] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Close the emoji picker on Escape or a click outside it. Clicks inside any
  // emoji UI are ignored so the toggle button still works — otherwise mousedown
  // would close it and the click right after would reopen it.
  useEffect(() => {
    if (!showEmoji) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setShowEmoji(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('[data-emoji-ui]')) setShowEmoji(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [showEmoji]);

  /**
   * Insert an emoji at the caret (replacing any selection), rather than
   * appending. Someone who clicks into the middle of a sentence to add a 🙂
   * means it to land there.
   */
  function insertEmoji(emoji: string) {
    const ta = taRef.current;
    if (!ta) {
      onChangeText(text + emoji);
      return;
    }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? start;
    onChangeText(text.slice(0, start) + emoji + text.slice(end));
    // Wait a frame: React has to write the new value before the caret can be
    // placed after the emoji, otherwise it snaps back to the old position.
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + emoji.length;
      ta.setSelectionRange(pos, pos);
    });
  }

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

  /**
   * Send the typed text with quick-reply chips attached.
   *
   * Blank rows are dropped rather than rejected — an empty third slot is just an
   * unused slot, and erroring on it would punish the operator for the UI showing
   * one more input than they needed.
   */
  async function sendButtons() {
    const body = text.trim();
    const labels = buttonLabels.map((l) => l.trim()).filter(Boolean);
    if (sendingButtons) return;
    if (!body) {
      setError('Type the message first, then add its buttons.');
      return;
    }
    if (!labels.length) {
      setError('Add at least one button, or send it as a normal message.');
      return;
    }
    // A button message is capped well below a plain one, so say which limit was
    // hit — the server would otherwise reject this as a malformed payload.
    if (body.length > MAX_BUTTON_BODY_CHARS) {
      setError(
        `A message with buttons can be up to ${MAX_BUTTON_BODY_CHARS} characters (this one is ${body.length}). ` +
          'Shorten it, or send it without buttons.',
      );
      return;
    }
    // Checked here as well as on the server so the operator finds out before the
    // round trip — WhatsApp rejects the whole template over a duplicate label.
    if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) {
      setError('Each button needs different text.');
      return;
    }

    setSendingButtons(true);
    setError(null);
    try {
      const { message } = await api<{ message: ChatMessage }>('/api/messages/buttons', {
        method: 'POST',
        body: { conversationId, body, buttons: labels, clientId: newClientId() },
      });
      onSent(message);
      setText('');
      resetHeight();
      setButtonLabels(['']);
      setShowButtons(false);
      onCancelReply();
    } catch (err) {
      handleApiError(err, 'Could not send the buttons. Please try again.');
    } finally {
      setSendingButtons(false);
    }
  }

  function setLabel(i: number, value: string) {
    setButtonLabels((prev) => prev.map((l, idx) => (idx === i ? value : l)));
  }
  function removeLabel(i: number) {
    // Never drop to zero rows: an empty composer with no input looks broken.
    setButtonLabels((prev) => (prev.length === 1 ? [''] : prev.filter((_, idx) => idx !== i)));
  }

  function openButtons() {
    if (!text.trim()) {
      setError('Type a message first, then add buttons to it.');
      return;
    }
    setError(null);
    // Both popovers occupy the same slot above the input bar, so they take turns.
    setShowSchedule(false);
    setShowButtons((v) => !v);
  }

  function openScheduler() {
    if (!text.trim()) {
      setError('Type a message first, then schedule it.');
      return;
    }
    setError(null);
    setCustomWhen(toLocalInput(nextTimeAt(8, 0)));
    setShowButtons(false);
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
        <div>
          The 24-hour window is closed. You can only reply with an approved template message.
        </div>
        <button
          type="button"
          onClick={() => setShowTemplates(true)}
          className="mt-2 rounded-full bg-brand-primary px-5 py-2 text-sm font-medium text-white
                     transition hover:opacity-90"
        >
          Send template
        </button>
        {showTemplates && (
          <TemplateModal
            conversationId={conversationId}
            onClose={() => setShowTemplates(false)}
            onSent={onSent}
          />
        )}
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

      {/* Quick-reply composer. The message body is whatever is in the textarea;
          this only collects the chip labels that ride along with it. */}
      {showButtons && (
        <div className="absolute bottom-full left-4 right-4 z-20 mb-2 flex justify-center">
          <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-3 shadow-lg">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">Quick-reply buttons</span>
              <button
                type="button"
                onClick={() => setShowButtons(false)}
                className="rounded-full px-2 text-lg leading-none text-ink-muted hover:text-red-600"
                title="Close"
              >
                ×
              </button>
            </div>

            <div className="mb-2 rounded-lg bg-black/5 px-2.5 py-2">
              <div className="mb-0.5 text-[11px] font-medium text-ink-muted">Message</div>
              <div className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-ink">
                {text.trim() || '—'}
              </div>
            </div>

            <div className="mb-2 space-y-1.5">
              {buttonLabels.map((label, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={label}
                    onChange={(e) => setLabel(i, e.target.value.slice(0, MAX_BUTTON_CHARS))}
                    placeholder={`Button ${i + 1}`}
                    maxLength={MAX_BUTTON_CHARS}
                    className="flex-1 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm
                               text-ink placeholder:text-ink-muted focus:border-brand-primary focus:outline-none"
                  />
                  <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-ink-muted">
                    {label.length}/{MAX_BUTTON_CHARS}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeLabel(i)}
                    className="shrink-0 rounded-full px-1.5 text-lg leading-none text-ink-muted hover:text-red-600"
                    title="Remove this button"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {buttonLabels.length < MAX_BUTTONS && (
              <button
                type="button"
                onClick={() => setButtonLabels((prev) => [...prev, ''])}
                className="mb-2 text-xs font-medium text-brand-link hover:text-brand-primary"
              >
                + Add button
              </button>
            )}

            {/* The 3-button ceiling is the approval boundary, so it is stated
                rather than left as an unexplained disabled "Add button". */}
            <p className="mb-2 text-[11px] leading-snug text-ink-muted">
              Up to {MAX_BUTTONS} buttons. Sends right away with no Meta approval, because the
              24-hour window is open. Tapping one sends its text back to you as a normal reply.
            </p>

            <button
              type="button"
              disabled={sendingButtons || !text.trim() || !buttonLabels.some((l) => l.trim())}
              onClick={() => void sendButtons()}
              className="w-full rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white
                         transition hover:opacity-90 disabled:opacity-50"
            >
              {sendingButtons ? 'Sending…' : 'Send with buttons'}
            </button>
          </div>
        </div>
      )}

      {/* Emoji picker. Inserts into the text — the message then sends as any
          other text message, with no special handling. */}
      {showEmoji && (
        <div
          data-emoji-ui
          className="absolute bottom-full left-4 z-20 mb-2 w-[19rem] rounded-2xl border
                     border-gray-200 bg-white p-2.5 shadow-lg"
        >
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="text-xs font-semibold text-ink">אימוג'י</span>
            <button
              type="button"
              onClick={() => setShowEmoji(false)}
              className="rounded-full px-2 text-lg leading-none text-ink-muted hover:text-red-600"
              title="Close"
            >
              ×
            </button>
          </div>
          <div className="scroll-thin grid max-h-52 grid-cols-8 gap-0.5 overflow-y-auto">
            {EMOJI.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => insertEmoji(e)}
                title={e}
                className="rounded-lg p-1.5 text-xl leading-none transition hover:bg-black/5"
              >
                {e}
              </button>
            ))}
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
          {/* Quick-reply buttons — text only, like scheduling: WhatsApp has no
              way to attach buttons to a media message. */}
          {!staged && (
            <button
              type="button"
              title="Add quick-reply buttons"
              aria-label="Add quick-reply buttons"
              aria-expanded={showButtons}
              onClick={openButtons}
              disabled={sending || sendingButtons}
              className={
                'shrink-0 leading-none transition disabled:opacity-50 ' +
                (showButtons ? 'text-brand-primary' : 'text-ink-muted hover:text-brand-primary')
              }
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                <path d="M4 5h16a2 2 0 012 2v3a2 2 0 01-2 2H4a2 2 0 01-2-2V7a2 2 0 012-2zm0 2v3h16V7H4zm0 7h16a2 2 0 012 2v3a2 2 0 01-2 2H4a2 2 0 01-2-2v-3a2 2 0 012-2zm0 2v3h16v-3H4z" />
              </svg>
            </button>
          )}
          {/* Emoji — next to the clock. Stays available with a file staged, so
              a caption can carry one too. */}
          <button
            type="button"
            data-emoji-ui
            title="Emoji"
            aria-label="Insert emoji"
            aria-expanded={showEmoji}
            onClick={() => setShowEmoji((s) => !s)}
            disabled={sending}
            className={
              'shrink-0 leading-none transition disabled:opacity-50 ' +
              (showEmoji ? 'text-brand-primary' : 'text-ink-muted hover:text-brand-primary')
            }
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
              <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zM8.5 11a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm7 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM12 17.5c2.33 0 4.31-1.46 5-3.5H7c.69 2.04 2.67 3.5 5 3.5z" />
            </svg>
          </button>
          {/* Templates — also reachable while the window is open, so a stock
              greeting doesn't have to be retyped just because the chat is live. */}
          <button
            type="button"
            title="Send a template"
            aria-label="Send a template"
            onClick={() => setShowTemplates(true)}
            disabled={sending}
            className="shrink-0 leading-none text-ink-muted transition hover:text-brand-primary disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 7V3.5L18.5 9H13zM8 13h8v1.5H8V13zm0 3.5h8V18H8v-1.5z" />
            </svg>
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
      </div>

      {showTemplates && (
        <TemplateModal
          conversationId={conversationId}
          onClose={() => setShowTemplates(false)}
          onSent={onSent}
        />
      )}
    </form>
  );
}
