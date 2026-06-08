/**
 * "Email this media to me" action.
 *
 * Replaces the old direct-download link: instead of opening the file in the
 * browser (where NetFree swaps it for a block page), it asks the server to mail
 * the file as an attachment. The bytes never pass through the filtered browser.
 */
import { useState } from 'react';
import { api } from '../api/client';

type State = 'idle' | 'sending' | 'done' | 'error';

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
  const [note, setNote] = useState<string | null>(null);

  async function send() {
    if (state === 'sending') return;
    setState('sending');
    setNote(null);
    try {
      const r = await api<{ ok: boolean; to: string }>(`/api/media/${messageId}/email`, { method: 'POST' });
      setState('done');
      setNote(`Sent to ${r.to}`);
    } catch (e) {
      setState('error');
      setNote((e as Error)?.message ?? 'Could not send email.');
    }
  }

  const text =
    state === 'sending' ? 'Sending…' : state === 'done' ? '✓ Emailed' : state === 'error' ? 'Retry email' : label;

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={send}
        disabled={state === 'sending'}
        title={note ?? label}
        className={className ?? 'text-brand-link underline disabled:opacity-60'}
      >
        {text}
      </button>
      {note && (
        <span className={state === 'error' ? 'text-red-500' : 'text-ink-muted'}>{note}</span>
      )}
    </span>
  );
}
