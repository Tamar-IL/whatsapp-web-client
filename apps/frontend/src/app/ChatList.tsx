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
  const [showNew, setShowNew] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newError, setNewError] = useState<string | null>(null);
  // Read from the server rather than hardcoded, so the hint can never disagree
  // with the DEFAULT_COUNTRY_CODE the backend actually applies.
  const [countryCode, setCountryCode] = useState('972');
  const { socket } = useRealtime();

  useEffect(() => {
    api<{ config?: { defaultCountryCode?: string } }>('/api/auth/me')
      .then((r) => {
        if (r.config?.defaultCountryCode) setCountryCode(r.config.defaultCountryCode);
      })
      .catch(() => undefined);
  }, []);

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

  async function createChat(e: React.FormEvent) {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    setNewError(null);
    try {
      const r = await api<{ conversation: { id: string }; existing: boolean }>('/api/conversations', {
        method: 'POST',
        body: { phoneNumber: newPhone, displayName: newName.trim() || undefined },
      });
      setShowNew(false);
      setNewPhone('');
      setNewName('');
      load();
      // Opening the chat lands the operator on the template-only bar, which is
      // the only thing they can do with a contact who has never written.
      onSelect(r.conversation.id);
    } catch (err) {
      setNewError((err as Error)?.message ?? 'Could not start the chat.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* New chat */}
      <div className="border-b border-gray-200 px-2 pt-2">
        {!showNew ? (
          <button
            type="button"
            onClick={() => {
              setShowNew(true);
              setNewError(null);
            }}
            className="flex w-full items-center justify-center gap-1.5 rounded-full bg-brand-primary
                       px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
          >
            <span className="text-base leading-none">＋</span> New chat
          </button>
        ) : (
          <form onSubmit={createChat} className="flex flex-col gap-1.5 pb-1">
            <input
              autoFocus
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              placeholder="+972501234567"
              inputMode="tel"
              dir="ltr"
              className="rounded-full border border-gray-300 bg-white px-3.5 py-1.5 text-sm
                         text-ink placeholder:text-ink-muted
                         focus:border-brand-primary focus:outline-none"
            />
            {/* The country code is optional, not absent — spell that out, or a
                number for another country looks impossible to enter. */}
            <p className="px-2 text-[11px] leading-tight text-ink-muted">
              Type the full number with its country code (+972, +1, +44…). A number starting with 0
              is treated as local (+{countryCode}).
            </p>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name (optional)"
              className="rounded-full border border-gray-300 bg-white px-3.5 py-1.5 text-sm
                         text-ink placeholder:text-ink-muted
                         focus:border-brand-primary focus:outline-none"
            />
            {newError && <div className="px-1 text-xs text-red-600">{newError}</div>}
            <div className="flex gap-1.5">
              <button
                type="submit"
                disabled={creating || !newPhone.trim()}
                className="flex-1 rounded-full bg-brand-primary px-4 py-1.5 text-sm font-medium
                           text-white transition hover:opacity-90 disabled:opacity-50"
              >
                {creating ? 'Starting…' : 'Start'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowNew(false);
                  setNewError(null);
                }}
                className="rounded-full px-4 py-1.5 text-sm text-ink-muted hover:bg-black/5"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

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
