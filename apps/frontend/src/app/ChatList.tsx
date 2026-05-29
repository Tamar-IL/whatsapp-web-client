/**
 * Chat list (Phase 3 ticket 3.6) with search.
 *
 * Fetches /api/conversations, re-fetches on realtime events, and filters the
 * list client-side by contact name / phone via the search box at the top.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useRealtime } from './RealtimeProvider';

interface ConversationListItem {
  id: string;
  contact: { displayName: string | null; profileName: string | null; phoneNumber: string };
  lastMessageAt: string | null;
  unreadCount: number;
  window: { open: boolean; closesAt: string | null };
}

function displayName(c: ConversationListItem): string {
  return c.contact.displayName ?? c.contact.profileName ?? c.contact.phoneNumber;
}

export function ChatList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [items, setItems] = useState<ConversationListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const { socket } = useRealtime();

  const load = useCallback(() => {
    api<{ conversations: ConversationListItem[] }>('/api/conversations')
      .then((r) => setItems(r.conversations))
      .catch((e) => setError(e.message ?? 'Could not load conversations.'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const handler = () => load();
    socket.on('message.added', handler);
    socket.on('conversation.added', handler);
    socket.on('conversation.updated', handler);
    return () => {
      socket.off('message.added', handler);
      socket.off('conversation.added', handler);
      socket.off('conversation.updated', handler);
    };
  }, [socket, load]);

  const filtered = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) => {
      const name = displayName(c).toLowerCase();
      return name.includes(q) || c.contact.phoneNumber.toLowerCase().includes(q);
    });
  }, [items, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Search */}
      <div className="border-b border-gray-200 p-2">
        <div className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5">
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-ink-muted">
            <path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 10-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 119.5 5a4.5 4.5 0 010 9z" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or number"
            className="flex-1 bg-transparent text-sm focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-ink-muted hover:text-ink" title="Clear">
              ×
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="scroll-thin flex-1 overflow-y-auto">
        {error && <div className="p-4 text-sm text-red-700">{error}</div>}

        {!error && !items && (
          <div className="space-y-2 p-4">
            <div className="h-12 animate-pulse rounded bg-gray-200" />
            <div className="h-12 animate-pulse rounded bg-gray-200" />
            <div className="h-12 animate-pulse rounded bg-gray-200" />
          </div>
        )}

        {!error && items && items.length === 0 && (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-ink-muted">
            No conversations yet. When customers message your WhatsApp Business number, they will
            appear here.
          </div>
        )}

        {!error && filtered && items && items.length > 0 && filtered.length === 0 && (
          <div className="p-6 text-center text-sm text-ink-muted">No chats match “{query}”.</div>
        )}

        {!error && filtered && filtered.length > 0 && (
          <ul>
            {filtered.map((c) => (
              <li
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={
                  'cursor-pointer border-b border-gray-100 px-4 py-3 hover:bg-gray-50 ' +
                  (selectedId === c.id ? 'bg-gray-100' : '')
                }
              >
                <div className="flex items-baseline justify-between">
                  <span className="truncate font-medium text-ink">{displayName(c)}</span>
                  {c.lastMessageAt && (
                    <span className="ml-2 shrink-0 text-xs text-ink-muted">
                      {new Date(c.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between text-sm text-ink-muted">
                  <span className="truncate">{c.window.open ? '24h window open' : 'Template required'}</span>
                  {c.unreadCount > 0 && (
                    <span className="ml-2 shrink-0 rounded-full bg-brand-action px-2 text-xs font-semibold text-white">
                      {c.unreadCount}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
