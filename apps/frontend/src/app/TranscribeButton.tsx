/**
 * "Transcribe" action for a voice/audio message that has no text yet.
 *
 * Automatic transcription only covers inbound voice notes that arrived while
 * the server had a GROQ_API_KEY and whose attempt succeeded. This button lets
 * the operator transcribe any other recording on demand. On success the server
 * broadcasts `message.updated`, so the transcript appears in the bubble; on
 * failure the server's reason is shown, so a bad key or blocked network is
 * visible instead of the transcript just never appearing.
 */
import { useState } from 'react';
import { api } from '../api/client';

export function TranscribeButton({
  messageId,
  onDone,
}: {
  messageId: string;
  onDone?: (body: string) => void;
}) {
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (state === 'working') return;
    setState('working');
    setError(null);
    try {
      const r = await api<{ ok: boolean; body: string }>(`/api/media/${messageId}/transcribe`, {
        method: 'POST',
        body: {},
      });
      setState('idle');
      onDone?.(r.body);
    } catch (e) {
      setState('error');
      setError((e as Error)?.message ?? 'Transcription failed.');
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => void run()}
        disabled={state === 'working'}
        className="text-brand-link underline disabled:opacity-60"
        title="Convert this recording to text"
      >
        {state === 'working' ? 'Transcribing…' : state === 'error' ? 'Retry transcribe' : 'Transcribe'}
      </button>
      {error && <span className="text-red-500">{error}</span>}
    </span>
  );
}
