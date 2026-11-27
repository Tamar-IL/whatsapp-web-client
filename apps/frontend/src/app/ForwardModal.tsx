/** Forward a message to one or more chats. */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAppData } from './AppData';
import { Avatar } from './Avatar';
import { displayName, type ConversationListItem } from './ChatList';
import { ErrorNote, GhostButton, Modal, PrimaryButton, inputCls } from './ui';
import type { ChatMessage } from './ConversationView';

export function ForwardModal({ message, onClose }: { message: ChatMessage; onClose: () => void }) {
  const { toast } = useAppData();
  const [chats, setChats] = useState<ConversationListItem[] | null>(null);
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Array<{ conversationId: string; ok: boolean; error?: string }> | null>(null);

  useEffect(() => {
    api<{ conversations: ConversationListItem[] }>('/api/conversations')
      .then((r) => setChats(r.conversations))
      .catch((e: Error) => setError(e.message));
  }, []);

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (chats ?? []).filter((c) => !s || displayName(c).toLowerCase().includes(s) || c.contact.phoneNumber.includes(s));
  }, [chats, q]);

  async function send() {
    setSending(true);
    setError(null);
    try {
      const r = await api<{ results: Array<{ conversationId: string; ok: boolean; error?: string }> }>(
        `/api/messages/${message.id}/forward`,
        { method: 'POST', body: { conversationIds: [...chosen] } },
      );
      const okCount = r.results.filter((x) => x.ok).length;
      if (okCount === r.results.length) {
        toast(`Forwarded to ${okCount} chat${okCount > 1 ? 's' : ''}`, 'ok');
        onClose();
      } else setResults(r.results);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const nameOf = (id: string) => {
    const c = chats?.find((x) => x.id === id);
    return c ? displayName(c) : id;
  };

  return (
    <Modal
      title="Forward message"
      subtitle={message.body?.slice(0, 80) || message.mediaName || `[${message.type}]`}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>{results ? 'Close' : 'Cancel'}</GhostButton>
          {!results && (
            <PrimaryButton onClick={() => void send()} disabled={!chosen.size || sending}>
              {sending ? 'Sending…' : `Forward${chosen.size ? ` (${chosen.size})` : ''}`}
            </PrimaryButton>
          )}
        </>
      }
    >
      {results ? (
        <ul className="flex flex-col gap-1.5 text-sm">
          {results.map((r) => (
            <li key={r.conversationId} className={'rounded-lg px-3 py-2 ' + (r.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700')}>
              <span className="font-medium">{nameOf(r.conversationId)}</span> — {r.ok ? 'sent' : r.error}
            </li>
          ))}
        </ul>
      ) : (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" className={inputCls + ' mb-3'} />
          {!chats && <div className="py-6 text-center text-sm text-ink-muted">Loading…</div>}
          <ul className="flex flex-col">
            {visible.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-black/5">
                  <input
                    type="checkbox"
                    checked={chosen.has(c.id)}
                    onChange={() =>
                      setChosen((p) => {
                        const n = new Set(p);
                        if (n.has(c.id)) n.delete(c.id);
                        else n.add(c.id);
                        return n;
                      })
                    }
                    className="h-4 w-4 accent-[#128C7E]"
                  />
                  <Avatar contactId={c.contact.id} name={displayName(c)} phone={c.contact.phoneNumber} hasPhoto={c.contact.hasAvatar} version={c.contact.avatarVersion} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{displayName(c)}</span>
                    {!c.window.open && <span className="text-[11px] text-amber-700">24h window closed — will be skipped</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      <ErrorNote>{error}</ErrorNote>
    </Modal>
  );
}
