/** All starred messages across chats; click one to jump to it. */
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Modal, formatWhen } from './ui';

interface StarredItem {
  id: string;
  conversationId: string;
  contactName: string;
  body: string | null;
  type: string;
  direction: string;
  mediaName: string | null;
  sentAt: string;
}

export function StarredModal({ onClose, onOpen }: { onClose: () => void; onOpen: (conversationId: string, messageId: string) => void }) {
  const [items, setItems] = useState<StarredItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ starred: StarredItem[] }>('/api/messages/starred')
      .then((r) => setItems(r.starred))
      .catch((e: Error) => setError(e.message));
  }, []);

  async function unstar(id: string) {
    setItems((p) => p?.filter((x) => x.id !== id) ?? null);
    await api(`/api/messages/${id}`, { method: 'PATCH', body: { isStarred: false } }).catch(() => undefined);
  }

  return (
    <Modal title="Starred messages" onClose={onClose}>
      {error && <div className="text-sm text-red-700">{error}</div>}
      {!items && !error && <div className="py-6 text-center text-sm text-ink-muted">Loading…</div>}
      {items && items.length === 0 && (
        <div className="py-8 text-center text-sm text-ink-muted">
          No starred messages. Hover a message and choose ★ Star to keep it here.
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {items?.map((m) => (
          <li key={m.id} className="group rounded-xl border border-gray-200 px-3 py-2 hover:border-brand-primary">
            <button type="button" className="block w-full text-left" onClick={() => onOpen(m.conversationId, m.id)}>
              <div className="flex items-center justify-between text-xs text-ink-muted">
                <span className="font-medium text-brand-primary">
                  {m.direction === 'outbound' ? `You → ${m.contactName}` : m.contactName}
                </span>
                <span>{formatWhen(new Date(m.sentAt))}</span>
              </div>
              <div className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-ink">
                {m.body || (m.mediaName ? `📎 ${m.mediaName}` : `[${m.type}]`)}
              </div>
            </button>
            <button type="button" onClick={() => void unstar(m.id)} className="mt-1 text-[11px] text-ink-muted hover:text-red-600">
              ☆ Unstar
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
