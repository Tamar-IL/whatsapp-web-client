/**
 * Phase 3 ticket 3.6 — chat list.
 *
 * Skeleton implementation: fetches /api/conversations and renders a placeholder
 * empty state. Re-fetches on realtime 'message.added' / 'conversation.added'
 * events so new conversations appear without a page refresh.
 *
 * Real list rendering (preview, time, unread count, sort, pin, client-side search)
 * is implemented incrementally in Phase 3.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useRealtime } from './RealtimeProvider';

interface ConversationListItem {
  id: string;
  contact: { displayName: string | null; profileName: string | null; phoneNumber: string };
  lastMessageAt: string | null;
  unreadCount: number;
  window: { open: boolean; closesAt: string | null };
}

export function ChatList() {
  const [items, setItems] = useState<ConversationListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { socket } = useRealtime();

  const load = useCallback(() => {
    api<{ conversations: ConversationListItem[] }>('/api/conversations')
      .then((r) => setItems(r.conversations))
      .catch((e) => setError(e.message ?? 'Could not load conversations.'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Re-fetch when realtime tells us something changed. Phase 3 ticket 3.9 replaces
  // this with a reducer that mutates local state in place — much smoother — but
  // refetch-on-event is enough to prove the end-to-end flow works.
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

  if (error) {
    return <div className="p-4 text-sm text-red-700">{error}</div>;
  }

  if (!items) {
    return (
      <div className="space-y-2 p-4">
        <div className="h-12 animate-pulse rounded bg-gray-200" />
        <div className="h-12 animate-pulse rounded bg-gray-200" />
        <div className="h-12 animate-pulse rounded bg-gray-200" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-ink-muted">
        No conversations yet. When customers message your WhatsApp Business number, they will
        appear here.
      </div>
    );
  }

  return (
    <ul className="flex-1 overflow-y-auto">
      {items.map((c) => (
        <li
          key={c.id}
          className="cursor-pointer border-b border-gray-100 px-4 py-3 hover:bg-gray-50"
        >
          <div className="flex items-baseline justify-between">
            <span className="font-medium text-ink">
              {c.contact.displayName ?? c.contact.profileName ?? c.contact.phoneNumber}
            </span>
            {c.lastMessageAt && (
              <span className="text-xs text-ink-muted">
                {new Date(c.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between text-sm text-ink-muted">
            <span className="truncate">
              {c.window.open ? '24h window open' : 'Template required'}
            </span>
            {c.unreadCount > 0 && (
              <span className="ml-2 rounded-full bg-brand-action px-2 text-xs font-semibold text-white">
                {c.unreadCount}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
