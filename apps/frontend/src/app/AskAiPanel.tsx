/**
 * "Ask AI" — your own assistant. It can use every enabled AI action
 * (e.g. MailerLite open rates) and, when a chat is open, read that chat.
 * Nothing here is sent to customers.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { CloseButton, Icons, Svg } from './ui';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  actions?: Array<{ action: string; ok: boolean; error?: string }>;
}

export function AskAiPanel({ conversationId, chatName, onClose }: { conversationId: string | null; chatName: string | null; onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useChat, setUseChat] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, busy]);

  async function ask(e?: React.FormEvent) {
    e?.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    const next: Turn[] = [...turns, { role: 'user', content: q }];
    setTurns(next);
    setText('');
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ answer: string; actionsUsed: Turn['actions'] }>('/api/ai/ask', {
        method: 'POST',
        body: {
          messages: next.map((t) => ({ role: t.role, content: t.content })),
          conversationId: useChat ? conversationId : null,
        },
      });
      setTurns([...next, { role: 'assistant', content: r.answer || '(no answer)', actions: r.actionsUsed }]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="fixed bottom-0 right-0 top-0 z-40 flex w-[400px] flex-col border-l border-black/10 bg-[#f0f2f5] shadow-xl">
      <header className="flex items-center gap-3 border-b border-black/10 px-4 py-3">
        <CloseButton onClick={onClose} />
        <Svg d={Icons.sparkle} className="h-5 w-5 text-brand-link" />
        <span className="flex-1 font-medium text-ink">Ask AI</span>
        {turns.length > 0 && (
          <button type="button" className="text-xs text-ink-muted hover:text-ink" onClick={() => setTurns([])}>
            New
          </button>
        )}
      </header>
      {conversationId && chatName && (
        <label className="flex items-center gap-2 border-b border-black/10 bg-white px-4 py-2 text-xs text-ink-muted">
          <input type="checkbox" checked={useChat} onChange={(e) => setUseChat(e.target.checked)} className="accent-[#128C7E]" />
          Include the open chat so the AI can read it
        </label>
      )}
      <div className="chat-canvas scroll-thin flex-1 overflow-y-auto px-4 py-3">
        {turns.length === 0 && (
          <div className="mt-6 rounded-xl bg-white/90 p-4 text-sm text-ink-muted shadow-sm">
            Ask anything — the AI can use your actions (Settings → AI actions). For example:
            <ul className="mt-2 list-disc pl-5 text-ink">
              <li>What was the open rate of the last newsletter?</li>
              <li>Summarise this chat in three lines.</li>
              <li>Write a polite reply offering Sunday at 10:00.</li>
            </ul>
          </div>
        )}
        <div className="flex flex-col gap-2">
          {turns.map((t, i) => (
            <div key={i} className={'flex ' + (t.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div className={'max-w-[85%] rounded-lg px-3 py-2 text-sm shadow-sm ' + (t.role === 'user' ? 'rounded-tr-none bg-chat-out' : 'rounded-tl-none bg-chat-in')}>
                {t.actions && t.actions.length > 0 && (
                  <div className="mb-1 text-[10px] italic text-ink-muted">
                    {t.actions.map((a) => `${a.ok ? '✓' : '✗'} ${a.action}`).join(' · ')}
                  </div>
                )}
                <div dir="auto" className="whitespace-pre-wrap break-words text-ink">
                  {t.content}
                </div>
              </div>
            </div>
          ))}
          {busy && <div className="w-fit animate-pulse rounded-lg bg-white px-3 py-2 text-sm text-ink-muted shadow-sm">Thinking…</div>}
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <div ref={endRef} />
        </div>
      </div>
      <form onSubmit={(e) => void ask(e)} className="flex items-end gap-2 px-3 py-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
          rows={1}
          placeholder="Ask…"
          className="max-h-32 flex-1 resize-none rounded-3xl border border-gray-300 bg-white px-4 py-2 text-sm focus:border-brand-primary focus:outline-none"
        />
        <button type="submit" disabled={busy || !text.trim()} className="shrink-0 text-brand-link disabled:opacity-40" title="Ask">
          <svg viewBox="0 0 24 24" className="h-6 w-6 -scale-x-100 fill-current">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </form>
    </aside>
  );
}
