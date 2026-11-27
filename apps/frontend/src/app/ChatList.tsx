/**
 * Chat list with search, filters (unread / needs you / label), archive view,
 * avatars, last-message preview and a per-chat menu (pin, archive, unread,
 * labels). Everything optional is behind a Settings → Features switch.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useRealtime } from './RealtimeProvider';
import { useAppData } from './AppData';
import { Avatar } from './Avatar';
import { Dropdown, Icons, Svg } from './ui';
import { LabelPicker } from './LabelPicker';

export interface ConversationListItem {
  id: string;
  contact: {
    id: string;
    displayName: string | null;
    profileName: string | null;
    phoneNumber: string;
    notes: string | null;
  };
  lastMessageAt: string | null;
  lastMessage: {
    body: string | null;
    type: string;
    direction: string;
    status: string;
    origin: string | null;
  } | null;
  unreadCount: number;
  markedUnread: boolean;
  isPinned: boolean;
  isArchived: boolean;
  needsHuman: boolean;
  aiSuggestion: string | null;
  ai: { enabled: boolean; activeNow: boolean; mode: string } | null;
  labels: Array<{ id: string; name: string; color: string }>;
  window: { open: boolean; closesAt: string | null };
}

export function displayName(c: { contact: ConversationListItem['contact'] }): string {
  return c.contact.displayName ?? c.contact.profileName ?? c.contact.phoneNumber;
}

const MEDIA_PREVIEW: Record<string, string> = {
  image: '📷 Photo',
  video: '🎥 Video',
  audio: '🎤 Voice message',
  voice: '🎤 Voice message',
  document: '📄 Document',
  location: '📍 Location',
};

function listTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if (now.getTime() - d.getTime() < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'numeric', year: '2-digit' });
}

type Filter = 'all' | 'unread' | 'needs' | 'ai';

export function ChatList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [items, setItems] = useState<ConversationListItem[] | null>(null);
  const [archivedCount, setArchivedCount] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newError, setNewError] = useState<string | null>(null);
  const [labelsFor, setLabelsFor] = useState<ConversationListItem | null>(null);
  const [countryCode, setCountryCode] = useState('972');
  const { socket } = useRealtime();
  const { features, labels, toast } = useAppData();

  useEffect(() => {
    api<{ config?: { defaultCountryCode?: string } }>('/api/auth/me')
      .then((r) => {
        if (r.config?.defaultCountryCode) setCountryCode(r.config.defaultCountryCode);
      })
      .catch(() => undefined);
  }, []);

  const load = useCallback(() => {
    api<{ conversations: ConversationListItem[]; archivedCount: number }>(
      `/api/conversations${showArchived ? '?archived=1' : ''}`,
    )
      .then((r) => {
        setItems(r.conversations);
        if (!showArchived) setArchivedCount(r.archivedCount);
        setError(null);
      })
      .catch((e) => setError(e.message ?? 'Could not load conversations.'));
  }, [showArchived]);

  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  // Coalesce bursts of realtime events into one reload.
  useEffect(() => {
    if (!socket) return;
    let t: number | undefined;
    const handler = () => {
      window.clearTimeout(t);
      t = window.setTimeout(load, 150);
    };
    socket.on('message.added', handler);
    socket.on('conversation.added', handler);
    socket.on('conversation.updated', handler);
    return () => {
      window.clearTimeout(t);
      socket.off('message.added', handler);
      socket.off('conversation.added', handler);
      socket.off('conversation.updated', handler);
    };
  }, [socket, load]);

  // If the filtered-by label is deleted or labels are switched off, drop the filter.
  useEffect(() => {
    if (labelFilter && (!features.labels || !labels.some((l) => l.id === labelFilter))) setLabelFilter(null);
  }, [labelFilter, labels, features.labels]);

  const filtered = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    return items.filter((c) => {
      if (filter === 'unread' && !(c.unreadCount > 0 || c.markedUnread)) return false;
      if (filter === 'needs' && !c.needsHuman && !c.aiSuggestion) return false;
      if (filter === 'ai' && !c.ai?.enabled) return false;
      if (labelFilter && !c.labels.some((l) => l.id === labelFilter)) return false;
      if (!q) return true;
      return (
        displayName(c).toLowerCase().includes(q) ||
        c.contact.phoneNumber.toLowerCase().includes(q) ||
        (c.contact.notes ?? '').toLowerCase().includes(q) ||
        c.labels.some((l) => l.name.toLowerCase().includes(q))
      );
    });
  }, [items, query, filter, labelFilter]);

  async function patch(c: ConversationListItem, body: Record<string, boolean>, msg?: string) {
    try {
      await api(`/api/conversations/${c.id}`, { method: 'PATCH', body });
      load();
      if (msg) toast(msg, 'ok', body.isArchived ? { label: 'Undo', onClick: () => void patch(c, { isArchived: false }) } : undefined);
    } catch (e) {
      toast((e as Error).message || 'Could not update the chat.', 'error');
    }
  }

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
      setShowArchived(false);
      load();
      onSelect(r.conversation.id);
    } catch (err) {
      setNewError((err as Error)?.message ?? 'Could not start the chat.');
    } finally {
      setCreating(false);
    }
  }

  const filters: Array<{ key: Filter; label: string; show: boolean }> = [
    { key: 'all', label: 'All', show: true },
    { key: 'unread', label: 'Unread', show: true },
    { key: 'needs', label: 'Needs you', show: features.aiAgent },
    { key: 'ai', label: 'AI', show: features.aiAgent },
  ];

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
          <Svg d={Icons.search} className="h-4 w-4 text-ink-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, number, notes, label"
            className="flex-1 bg-transparent text-sm focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-ink-muted hover:text-ink" title="Clear">
              ×
            </button>
          )}
        </div>

        {/* Filter chips */}
        {!showArchived && (
          <div className="scroll-thin mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
            {filters
              .filter((f) => f.show)
              .map((f) => (
                <Chip key={f.key} active={filter === f.key && !labelFilter} onClick={() => { setFilter(f.key); setLabelFilter(null); }}>
                  {f.label}
                </Chip>
              ))}
            {features.labels &&
              labels.map((l) => (
                <Chip
                  key={l.id}
                  active={labelFilter === l.id}
                  onClick={() => {
                    setFilter('all');
                    setLabelFilter((cur) => (cur === l.id ? null : l.id));
                  }}
                >
                  <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
                  {l.name}
                </Chip>
              ))}
          </div>
        )}
      </div>

      {/* Archive row / back */}
      {features.archive && (showArchived || archivedCount > 0) && (
        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          className="flex items-center gap-4 border-b border-gray-100 px-5 py-2.5 text-sm text-ink hover:bg-gray-50"
        >
          <Svg d={showArchived ? Icons.back : Icons.archive} className="h-5 w-5 text-brand-link" />
          <span className="flex-1 text-left font-medium">{showArchived ? 'Back to chats' : 'Archived'}</span>
          {!showArchived && <span className="text-xs font-medium text-brand-link">{archivedCount}</span>}
        </button>
      )}

      {/* List */}
      <div className="scroll-thin flex-1 overflow-y-auto overflow-x-hidden">
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
            {showArchived
              ? 'No archived chats.'
              : 'No conversations yet. When customers message your WhatsApp Business number, they will appear here.'}
          </div>
        )}

        {!error && filtered && items && items.length > 0 && filtered.length === 0 && (
          <div className="p-6 text-center text-sm text-ink-muted">
            {query ? `No chats match “${query}”.` : 'No chats in this filter.'}
          </div>
        )}

        {!error && filtered && filtered.length > 0 && (
          <ul>
            {filtered.map((c) => (
              <ChatRow
                key={c.id}
                c={c}
                selected={selectedId === c.id}
                onSelect={() => onSelect(c.id)}
                onPatch={patch}
                onLabels={() => setLabelsFor(c)}
              />
            ))}
          </ul>
        )}
      </div>

      {labelsFor && (
        <LabelPicker
          conversationId={labelsFor.id}
          selected={labelsFor.labels.map((l) => l.id)}
          onClose={() => setLabelsFor(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex shrink-0 items-center whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition ' +
        (active ? 'bg-brand-action/20 text-brand-primary' : 'bg-white text-ink-muted hover:bg-black/5')
      }
    >
      {children}
    </button>
  );
}

function ChatRow({
  c,
  selected,
  onSelect,
  onPatch,
  onLabels,
}: {
  c: ConversationListItem;
  selected: boolean;
  onSelect: () => void;
  onPatch: (c: ConversationListItem, body: Record<string, boolean>, msg?: string) => void;
  onLabels: () => void;
}) {
  const { features } = useAppData();
  const name = displayName(c);
  // The chat that is open on screen is being read right now: never badge it,
  // even in the moment before the server confirms the read.
  const unreadCount = selected ? 0 : c.unreadCount;
  const unread = unreadCount > 0 || (!selected && c.markedUnread);
  const last = c.lastMessage;
  const preview = (() => {
    if (!features.lastMessagePreview || !last) return c.window.open ? '24h window open' : 'Template required';
    const text = last.body?.replace(/\s+/g, ' ').trim() || MEDIA_PREVIEW[last.type] || `[${last.type}]`;
    return text;
  })();
  const originTag =
    last?.direction === 'outbound' && last.origin === 'ai' ? '🤖 ' : last?.origin === 'away' ? '🌙 ' : last?.origin === 'bulk' ? '📣 ' : '';

  return (
    <li
      onClick={onSelect}
      className={
        'group flex cursor-pointer items-center gap-3 border-b border-gray-100 px-3 py-2.5 hover:bg-gray-50 ' +
        (selected ? 'bg-gray-100' : '')
      }
    >
      <Avatar
        contactId={c.contact.id}
        name={name}
        phone={c.contact.phoneNumber}
        size={46}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={'truncate text-ink ' + (unread ? 'font-semibold' : 'font-medium')}>{name}</span>
          {c.lastMessageAt && (
            <span className={'shrink-0 text-xs ' + (unread ? 'font-medium text-brand-action' : 'text-ink-muted')}>
              {listTime(c.lastMessageAt)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 text-sm text-ink-muted">
          <span className="flex min-w-0 items-center gap-1 truncate">
            {features.lastMessagePreview && last?.direction === 'outbound' && (
              <span className={'shrink-0 text-xs ' + (last.status === 'read' ? 'text-check-read' : last.status === 'failed' ? 'text-red-500' : '')}>
                {last.status === 'failed' ? '⚠' : last.status === 'read' || last.status === 'delivered' ? '✓✓' : '✓'}
              </span>
            )}
            <span className="truncate">
              {originTag}
              {preview}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {features.aiAgent && c.needsHuman && (
              <span className="rounded-full bg-red-100 px-1.5 text-[10px] font-semibold text-red-700" title="The AI agent handed this chat to you">
                Needs you
              </span>
            )}
            {features.aiAgent && !c.needsHuman && c.aiSuggestion && (
              <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-800" title="An AI draft is waiting for you">
                Draft
              </span>
            )}
            {features.aiAgent && c.ai?.enabled && (
              <span title={c.ai.activeNow ? `AI agent on (${c.ai.mode === 'auto' ? 'auto-reply' : 'drafts'})` : 'AI agent set up, outside its active dates'} className={c.ai.activeNow ? '' : 'opacity-40'}>
                <Svg d={Icons.robot} className="h-4 w-4 text-brand-link" />
              </span>
            )}
            {features.pinChats && c.isPinned && <Svg d={Icons.pin} className="h-4 w-4 rotate-45 text-ink-muted" />}
            {unreadCount > 0 ? (
              <span className="rounded-full bg-brand-action px-1.5 text-xs font-semibold text-white">{unreadCount}</span>
            ) : unread ? (
              <span className="h-3 w-3 rounded-full bg-brand-action" title="Marked as unread" />
            ) : null}
            <Dropdown
              className="w-5 opacity-0 transition group-hover:opacity-100 data-[open=true]:opacity-100"
              trigger={
                <span className="block text-ink-muted hover:text-ink" title="Chat options">
                  <Svg d={Icons.chevron} className="h-5 w-5" />
                </span>
              }
              items={[
                {
                  label: c.isPinned ? 'Unpin chat' : 'Pin chat',
                  icon: '📌',
                  hidden: !features.pinChats || c.isArchived,
                  onClick: () => onPatch(c, { isPinned: !c.isPinned }),
                },
                {
                  label: c.isArchived ? 'Unarchive chat' : 'Archive chat',
                  icon: '🗄',
                  hidden: !features.archive,
                  onClick: () => onPatch(c, { isArchived: !c.isArchived }, c.isArchived ? 'Chat unarchived' : 'Chat archived'),
                },
                {
                  label: unread ? 'Mark as read' : 'Mark as unread',
                  icon: '●',
                  hidden: !features.markUnread,
                  onClick: () =>
                    unread
                      ? void api(`/api/conversations/${c.id}/read`, { method: 'POST' }).then(() => onPatch(c, { markedUnread: false }))
                      : onPatch(c, { markedUnread: true }),
                },
                { label: 'Labels…', icon: '🏷', hidden: !features.labels, onClick: onLabels },
                {
                  label: 'Clear “needs you”',
                  icon: '✓',
                  hidden: !features.aiAgent || !c.needsHuman,
                  onClick: () => onPatch(c, { needsHuman: false }),
                },
              ]}
            />
          </span>
        </div>
        {features.labels && c.labels.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {c.labels.map((l) => (
              <span
                key={l.id}
                className="rounded px-1.5 py-px text-[10px] font-medium text-white"
                style={{ backgroundColor: l.color }}
              >
                {l.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
