/**
 * Chat list (Phase 3 ticket 3.6).
 *
 * Fetches /api/conversations and renders the list. Re-fetches on realtime
 * 'message.added' / 'conversation.added' / 'conversation.updated' events so new
 * chats and unread counts update without a page refresh. Clicking a row selects
 * the conversation (handled by the parent via onSelect).
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

  if (error) return <div className="p-4 text-sm text-red-700">{error}</div>;

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
  );
}
