/**
 * "Email this media to me" action.
 *
 * Replaces the old direct-download link: instead of opening the file in the
 * browser (where NetFree swaps it for a block page), it asks the server to mail
 * the file as an attachment. The bytes never pass through the filtered browser.
 *
 * Clicking opens a small composer for an optional note, which is mailed with the
 * file — in the subject and at the top of the body. Without it, several voice
 * notes from the same contact arrive in the inbox looking identical.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

type State = 'idle' | 'composing' | 'sending' | 'done' | 'error';

/** Matches the server's cap so the input can't submit something it will reject. */
const NOTE_MAX = 500;

export function EmailMediaButton({
  messageId,
  label = 'Email to me',
  className,
}: {
  messageId: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<State>('idle');
  const [status, setStatus] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the field as it opens — the click that opened it was the intent to type.
  useEffect(() => {
    if (state === 'composing') inputRef.current?.focus();
  }, [state]);

  async function send() {
    if (state === 'sending') return;
    setState('sending');
    setStatus(null);
    try {
      const trimmed = note.trim();
      const r = await api<{ ok: boolean; to: string }>(`/api/media/${messageId}/email`, {
        method: 'POST',
        body: trimmed ? { note: trimmed } : {},
      });
      setState('done');
      setStatus(`Sent to ${r.to}`);
      setNote('');
    } catch (e) {
      setState('error');
      setStatus((e as Error)?.message ?? 'Could not send email.');
    }
  }

  if (state === 'composing' || state === 'sending') {
    const sending = state === 'sending';
    return (
      <span className="inline-flex items-center gap-1">
        <input
          ref={inputRef}
          value={note}
          maxLength={NOTE_MAX}
          disabled={sending}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void send();
            } else if (e.key === 'Escape') {
              setState('idle');
              setNote('');
            }
          }}
          placeholder="Add a note (optional)"
          aria-label="Note to send with the file"
          className="w-44 rounded border border-black/15 bg-white px-1.5 py-0.5 text-xs
                     outline-none focus:border-brand-primary disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending}
          className="rounded bg-brand-primary px-1.5 py-0.5 text-xs text-white disabled:opacity-60"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
        {!sending && (
          <button
            type="button"
            onClick={() => {
              setState('idle');
              setNote('');
            }}
            title="Cancel"
            className="px-1 text-xs text-ink-muted hover:text-ink"
          >
            ✕
          </button>
        )}
      </span>
    );
  }

  const text = state === 'done' ? '✓ Emailed' : state === 'error' ? 'Retry email' : label;

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => {
          setStatus(null);
          setState('composing');
        }}
        title={status ?? label}
        className={className ?? 'text-brand-link underline disabled:opacity-60'}
      >
        {text}
      </button>
      {status && <span className={state === 'error' ? 'text-red-500' : 'text-ink-muted'}>{status}</span>}
    </span>
  );
}
