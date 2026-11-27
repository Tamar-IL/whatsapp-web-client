/**
 * Conversation view (Phase 3 + media display).
 *
 * Header (avatar, name, 24h window timer, search, chat menu), pinned-messages
 * bar, message bubbles with a per-message menu (reply, copy, star, pin,
 * forward, retry), AI draft bar, realtime append, mark-read on open, input bar
 * and the contact panel.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAppData } from './AppData';
import { Avatar } from './Avatar';
import { ContactPanel, type ConversationDetail } from './ContactPanel';
import { ForwardModal } from './ForwardModal';
import { LabelPicker } from './LabelPicker';
import { Dropdown, Icons, IconButton, Svg, copyText } from './ui';
import { useRealtime } from './RealtimeProvider';
import { InputBar } from './InputBar';
import { ScheduledBar } from './ScheduledBar';
import { AudioPlayer } from './AudioPlayer';
import { EmailMediaButton } from './EmailMediaButton';
import { RichText } from '../lib/richText';

export interface ChatMessage {
  id: string;
  clientId?: string | null;
  direction: 'inbound' | 'outbound';
  type: string;
  status: string;
  body: string | null;
  mediaUrl?: string | null;
  mediaMime?: string | null;
  mediaName?: string | null;
  mediaSize?: number | null;
  hasMedia?: boolean;
  sentAt: string;
  replyTo?: { id: string; body: string | null; direction: string; type: string } | null;
  /** Quick-reply button labels shown under this message, as ["Yes", "No"]. */
  buttons?: string[] | null;
  /** Set on a reaction row: the id of the message it reacts to. */
  reactsToId?: string | null;
  /** Reactions others placed ON this message, newest per side. */
  reactions?: MessageReaction[];
  isPinned?: boolean;
  isStarred?: boolean;
  /** null = you; 'ai' | 'away' | 'bulk' | 'forward' otherwise. */
  origin?: string | null;
  errorMessage?: string | null;
}

export interface MessageReaction {
  id: string;
  /** Empty string means the reaction was removed. */
  emoji: string;
  direction: string;
  sentAt: string;
}

/** Messages fetched per request. The server caps `limit` at 100. */
const PAGE_SIZE = 100;

/** Types that actually carry a file. Location/reaction/system are text-only. */
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice', 'document']);

/**
 * Local calendar day of a timestamp, as "YYYY-M-D".
 *
 * Built from the LOCAL getters, not from the ISO string: slicing the ISO text
 * would group by UTC day, so anything sent after 03:00 Israel time would be
 * filed under the wrong date — including "today" appearing as yesterday.
 */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "היום" / "אתמול" / a full date, matching how WhatsApp labels day separators. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (dayKey(iso) === dayKey(now.toISOString())) return 'היום';

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return 'אתמול';

  // Within the last week, the weekday is easier to place than a numeric date.
  const ageDays = (now.getTime() - d.getTime()) / 86_400_000;
  if (ageDays < 7) {
    return d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' });
  }
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' });
}

/** Chronological order, with id as the tiebreaker for identical timestamps. */
const bySentAt = (a: ChatMessage, b: ChatMessage): number =>
  a.sentAt === b.sentAt ? a.id.localeCompare(b.id) : a.sentAt < b.sentAt ? -1 : 1;

/**
 * Fold reaction rows onto the messages they react to.
 *
 * A reaction is stored as its own message row, so it arrives both in the history
 * fetch and as a live `message.added` event. Rendering those rows as bubbles
 * would litter the thread with lone emoji, so each is attached to its target
 * instead — except when the target is not loaded (reacted to something older
 * than the current page), where it stays a bubble so the emoji is never lost.
 *
 * Two sources are merged: `reactions` computed server-side across all pages, and
 * reaction rows sitting in the loaded list (which is how live ones show up).
 * Whichever has the newest `sentAt` wins per (target, side), so replacing an
 * emoji works and a removal — an empty emoji — clears it.
 */
function foldReactions(messages: ChatMessage[]): {
  bubbles: ChatMessage[];
  reactionsByTarget: Map<string, MessageReaction[]>;
} {
  const latest = new Map<string, MessageReaction>();
  const keep = (targetId: string, r: MessageReaction) => {
    const key = `${targetId}:${r.direction}`;
    const prev = latest.get(key);
    if (!prev || prev.sentAt <= r.sentAt) latest.set(key, r);
  };

  for (const m of messages) {
    for (const r of m.reactions ?? []) keep(m.id, r);
  }

  const loadedIds = new Set(messages.map((m) => m.id));
  const bubbles = messages.filter((m) => {
    if (m.type !== 'reaction') return true;
    if (!m.reactsToId || !loadedIds.has(m.reactsToId)) return true; // orphan — show it
    keep(m.reactsToId, {
      id: m.id,
      emoji: (m.body ?? '').trim(),
      direction: m.direction,
      sentAt: m.sentAt,
    });
    return false;
  });

  const reactionsByTarget = new Map<string, MessageReaction[]>();
  for (const [key, r] of latest) {
    if (!r.emoji) continue; // removed
    const targetId = key.slice(0, key.lastIndexOf(':'));
    const list = reactionsByTarget.get(targetId);
    if (list) list.push(r);
    else reactionsByTarget.set(targetId, [r]);
  }

  return { bubbles, reactionsByTarget };
}


/** "5h 12m" until the 24h window closes. */
function remaining(closesAt: string | null): string | null {
  if (!closesAt) return null;
  const ms = new Date(closesAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const ORIGIN_BADGE: Record<string, string> = {
  ai: '🤖 AI',
  away: '🌙 Away message',
  bulk: '📣 Bulk send',
  forward: '↪ Forwarded',
};

interface SearchHit {
  id: string;
  body: string | null;
  mediaName: string | null;
  sentAt: string;
}

interface PinnedItem {
  id: string;
  body: string | null;
  type: string;
  mediaName: string | null;
}

export function ConversationView({
  conversationId,
  jumpTo,
  onJumped,
  onLeave,
}: {
  conversationId: string | null;
  /** A message to scroll to once loaded (from Starred). */
  jumpTo?: string | null;
  onJumped?: () => void;
  /** The open chat was archived — close it. */
  onLeave?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  /** Which chat the loaded messages belong to (guards jumps against a stale list). */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [windowOpen, setWindowOpen] = useState(true);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [forwarding, setForwarding] = useState<ChatMessage | null>(null);
  const [pinned, setPinned] = useState<PinnedItem[]>([]);
  const [pinIdx, setPinIdx] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [hitIdx, setHitIdx] = useState(0);
  const [inject, setInject] = useState<{ text: string; nonce: number } | null>(null);
  const [, setTick] = useState(0);
  const { socket } = useRealtime();
  const { features, toast } = useAppData();
  const bottomRef = useRef<HTMLDivElement>(null);
  const skipAutoScroll = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  // Re-render every minute so the window countdown stays current.
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);

  // Scroll to + briefly highlight a message (used when clicking a quote box).
  const scrollToMessage = useCallback((id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedId(id);
    window.setTimeout(() => setHighlightedId((cur) => (cur === id ? null : cur)), 1600);
  }, []);

  /**
   * Jump to any message, even one older than the loaded pages: if it is not
   * on screen yet, load everything from it to the newest message first.
   */
  const jumpToMessage = useCallback(
    async (id: string) => {
      if (!conversationId) return;
      if (!messagesRef.current.some((m) => m.id === id)) {
        try {
          const r = await api<{ messages: ChatMessage[] }>(
            `/api/conversations/${conversationId}/messages?fromId=${encodeURIComponent(id)}`,
          );
          skipAutoScroll.current = true;
          setMessages(r.messages);
          setHasMore(true);
        } catch {
          return;
        }
      }
      window.setTimeout(() => scrollToMessage(id), 80);
    },
    [conversationId, scrollToMessage],
  );

  const loadDetail = useCallback(() => {
    if (!conversationId) return;
    api<{ conversation: ConversationDetail }>(`/api/conversations/${conversationId}`)
      .then((r) => {
        setDetail(r.conversation);
        setWindowOpen(r.conversation.window.open);
      })
      .catch(() => setDetail(null));
  }, [conversationId]);

  const loadPinned = useCallback(() => {
    if (!conversationId) return;
    api<{ pinned: PinnedItem[] }>(`/api/conversations/${conversationId}/pinned`)
      .then((r) => {
        setPinned(r.pinned);
        setPinIdx(0);
      })
      .catch(() => setPinned([]));
  }, [conversationId]);

  // Reset per-chat UI state when switching conversations.
  useEffect(() => {
    setReplyingTo(null);
    setSearchOpen(false);
    setSearchQ('');
    setHits(null);
    setInject(null);
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setDetail(null);
      return;
    }
    setLoading(true);
    loadDetail();
    loadPinned();

    api<{ messages: ChatMessage[] }>(
      `/api/conversations/${conversationId}/messages?limit=${PAGE_SIZE}`,
    )
      .then((r) => {
        setMessages(r.messages);
        setHasMore(r.messages.length === PAGE_SIZE);
      })
      .catch(() => setMessages([]))
      .finally(() => {
        setLoading(false);
        setLoadedFor(conversationId);
      });

    api(`/api/conversations/${conversationId}/read`, { method: 'POST' }).catch(() => undefined);
  }, [conversationId, loadDetail, loadPinned]);

  // Jump requested from outside (Starred list) once the chat has loaded.
  useEffect(() => {
    if (!jumpTo || loading || !conversationId || loadedFor !== conversationId) return;
    void jumpToMessage(jumpTo).finally(() => onJumped?.());
  }, [jumpTo, loading, loadedFor, conversationId, jumpToMessage, onJumped]);

  useEffect(() => {
    if (!socket || !conversationId) return;
    const onAdded = (data: { conversationId?: string; payload?: Record<string, unknown> }) => {
      if (data.conversationId !== conversationId || !data.payload) return;
      const p = data.payload as Record<string, unknown>;
      // Keyed off the real media types — `type !== 'text'` also caught
      // location/reaction/system, which have no file and rendered as a broken
      // "📎 File" attachment.
      const hasMedia = Boolean(p.hasMedia) || MEDIA_TYPES.has(String(p.type));
      const incoming: ChatMessage = {
        id: String(p.messageId),
        clientId: (p.clientId as string) ?? null,
        direction: p.direction as 'inbound' | 'outbound',
        type: String(p.type),
        status: String(p.status),
        body: (p.body as string) ?? null,
        sentAt: String(p.sentAt),
        hasMedia,
        mediaUrl: hasMedia ? `/api/media/${String(p.messageId)}` : null,
        mediaMime: (p.mediaMime as string) ?? null,
        mediaName: (p.mediaName as string) ?? null,
        replyTo: (p.replyTo as ChatMessage['replyTo']) ?? null,
        buttons: Array.isArray(p.buttons) ? (p.buttons as string[]) : null,
        // Carried through so a live reaction lands on its target bubble; without
        // it the row would sit in the thread as an unattached emoji.
        reactsToId: (p.reactsToId as string) ?? null,
        origin: (p.origin as string) ?? null,
      };
      setMessages((prev) => (prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]));
      // The chat is open, so an inbound message is read as it arrives.
      if (incoming.direction === 'inbound' && document.visibilityState === 'visible') {
        api(`/api/conversations/${conversationId}/read`, { method: 'POST' }).catch(() => undefined);
      }
    };
    const onUpdated = (data: { conversationId?: string; payload?: Record<string, unknown> }) => {
      if (data.conversationId !== conversationId || !data.payload) return;
      const p = data.payload as { messageId: string; status?: string; body?: string; isPinned?: boolean; isStarred?: boolean };
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== p.messageId) return m;
          return {
            ...m,
            ...(p.status !== undefined && { status: p.status }),
            ...(p.body !== undefined && { body: p.body }),
            ...(p.isPinned !== undefined && { isPinned: p.isPinned }),
            ...(p.isStarred !== undefined && { isStarred: p.isStarred }),
          };
        }),
      );
      if (p.isPinned !== undefined) loadPinned();
    };
    const onRetried = (data: { conversationId?: string; payload?: { messageId: string } }) => {
      if (data.conversationId !== conversationId || !data.payload) return;
      setMessages((prev) => prev.map((m) => (m.id === data.payload!.messageId ? { ...m, errorMessage: 'retried' } : m)));
    };
    const onConv = (data: { conversationId?: string | null }) => {
      if (!data.conversationId || data.conversationId === conversationId) loadDetail();
    };
    socket.on('message.added', onAdded);
    socket.on('message.updated', onUpdated);
    socket.on('message.retried', onRetried);
    socket.on('conversation.updated', onConv);
    return () => {
      socket.off('message.added', onAdded);
      socket.off('message.updated', onUpdated);
      socket.off('message.retried', onRetried);
      socket.off('conversation.updated', onConv);
    };
  }, [socket, conversationId, loadDetail, loadPinned]);

  // Safety net: re-sync the open thread from the API on every (re)connect.
  // Outbox replay should already cover anything missed while the socket was
  // down, but a dropped replay used to leave a message invisible until the page
  // was reloaded. Merging a fresh page makes that unrecoverable state
  // impossible — an inbound message can no longer go missing from the view.
  useEffect(() => {
    if (!socket || !conversationId) return;
    const resync = () => {
      api<{ messages: ChatMessage[] }>(
        `/api/conversations/${conversationId}/messages?limit=${PAGE_SIZE}`,
      )
        .then((r) => {
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.id));
            const missing = r.messages.filter((m) => !seen.has(m.id));
            return missing.length ? [...prev, ...missing].sort(bySentAt) : prev;
          });
        })
        .catch(() => undefined);
    };
    socket.on('connect', resync);
    return () => {
      socket.off('connect', resync);
    };
  }, [socket, conversationId]);

  useEffect(() => {
    // Prepending older messages must not yank the view back to the bottom.
    if (skipAutoScroll.current) {
      skipAutoScroll.current = false;
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // In-chat search (debounced, server-side so it covers the whole history).
  useEffect(() => {
    if (!searchOpen || !conversationId) return;
    const q = searchQ.trim();
    if (!q) {
      setHits(null);
      return;
    }
    const t = window.setTimeout(() => {
      api<{ results: SearchHit[] }>(`/api/conversations/${conversationId}/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          setHits(r.results);
          setHitIdx(0);
          if (r.results[0]) void jumpToMessage(r.results[0].id);
        })
        .catch(() => setHits([]));
    }, 300);
    return () => window.clearTimeout(t);
  }, [searchQ, searchOpen, conversationId, jumpToMessage]);

  function stepHit(delta: number) {
    if (!hits?.length) return;
    const next = (hitIdx + delta + hits.length) % hits.length;
    setHitIdx(next);
    void jumpToMessage(hits[next]!.id);
  }

  const loadMore = useCallback(() => {
    if (!conversationId || loadingMore || !hasMore) return;
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingMore(true);
    // Composite cursor: `before` is the oldest loaded message's sentAt, and
    // `beforeId` breaks ties between messages sharing that timestamp — without
    // it the server skips the whole tied group.
    api<{ messages: ChatMessage[] }>(
      `/api/conversations/${conversationId}/messages?limit=${PAGE_SIZE}` +
        `&before=${encodeURIComponent(oldest.sentAt)}` +
        `&beforeId=${encodeURIComponent(oldest.id)}`,
    )
      .then((r) => {
        setHasMore(r.messages.length === PAGE_SIZE);
        if (r.messages.length === 0) return;
        skipAutoScroll.current = true;
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          return [...r.messages.filter((m) => !seen.has(m.id)), ...prev];
        });
      })
      .catch(() => undefined)
      .finally(() => setLoadingMore(false));
  }, [conversationId, loadingMore, hasMore, messages]);

  const handleSent = useCallback((m: ChatMessage) => {
    setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
  }, []);

  async function flagMessage(m: ChatMessage, body: { isPinned?: boolean; isStarred?: boolean }) {
    setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...body } : x)));
    try {
      await api(`/api/messages/${m.id}`, { method: 'PATCH', body });
      if (body.isPinned !== undefined) loadPinned();
    } catch (e) {
      toast((e as Error).message || 'Could not update the message.', 'error');
    }
  }

  async function retry(m: ChatMessage) {
    try {
      const r = await api<{ message: ChatMessage }>(`/api/messages/${m.id}/retry`, { method: 'POST' });
      setMessages((prev) => [...prev.map((x) => (x.id === m.id ? { ...x, errorMessage: 'retried' } : x)), r.message]);
      toast('Sent again', 'ok');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'WINDOW_CLOSED') setWindowOpen(false);
      toast((e as Error).message || 'Retry failed.', 'error');
    }
  }

  async function patchConv(body: Record<string, boolean>, msg?: string) {
    if (!conversationId) return;
    try {
      await api(`/api/conversations/${conversationId}`, { method: 'PATCH', body });
      loadDetail();
      if (msg) toast(msg, 'ok');
      if (body.isArchived) onLeave?.();
    } catch (e) {
      toast((e as Error).message || 'Could not update the chat.', 'error');
    }
  }

  async function sendSuggestion(text: string) {
    if (!conversationId) return;
    try {
      const { message } = await api<{ message: ChatMessage }>('/api/messages', {
        method: 'POST',
        body: { conversationId, body: text, clientId: 'c_' + Math.random().toString(36).slice(2) },
      });
      handleSent(message);
    } catch (e) {
      toast((e as Error).message || 'Could not send.', 'error');
    }
  }

  // Reaction rows are hidden from the thread and attached to their target bubble.
  const { bubbles, reactionsByTarget } = useMemo(() => foldReactions(messages), [messages]);

  if (!conversationId) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center text-ink-muted">
        <div className="max-w-md p-8">
          <h2 className="mb-2 text-lg font-medium text-ink">Select a conversation</h2>
          <p className="text-sm">
            Pick a chat from the list on the left to see messages. New incoming messages appear
            here in real time.
          </p>
        </div>
      </div>
    );
  }

  const title = detail
    ? detail.contact.displayName ?? detail.contact.profileName ?? detail.contact.phoneNumber
    : '…';
  const left = detail ? remaining(detail.window.closesAt) : null;
  const pin = pinned[pinIdx % Math.max(1, pinned.length)];

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex items-center justify-between gap-3 border-b border-black/10 bg-[#f0f2f5] px-4 py-2">
          <button type="button" className="flex min-w-0 items-center gap-3 text-left" onClick={() => setShowInfo(true)} title="Contact info">
            {detail ? (
              <Avatar
                contactId={detail.contact.id}
                name={title}
                phone={detail.contact.phoneNumber}
                hasPhoto={detail.contact.hasAvatar}
                version={detail.contact.avatarVersion}
                size={40}
              />
            ) : (
              <div className="h-10 w-10 rounded-full bg-gray-300" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 truncate font-medium text-ink">
                {title}
                {features.aiAgent && detail?.ai?.enabled && (
                  <span title={detail.ai.activeNow ? 'AI agent on' : 'AI agent outside its dates'} className={detail.ai.activeNow ? '' : 'opacity-40'}>
                    <Svg d={Icons.robot} className="h-4 w-4 text-brand-link" />
                  </span>
                )}
              </div>
              {detail && (
                <div className="truncate text-xs text-ink-muted" dir="ltr">
                  {detail.contact.phoneNumber}
                  {features.labels && detail.labels.length > 0 && <span dir="auto"> · {detail.labels.map((l) => l.name).join(', ')}</span>}
                </div>
              )}
            </div>
          </button>
          <div className="flex shrink-0 items-center gap-1">
            {detail && (
              <span
                className={
                  'mr-1 rounded-full px-2.5 py-1 text-xs font-medium ' +
                  (detail.window.open ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600')
                }
                title={detail.window.closesAt ? `Closes ${new Date(detail.window.closesAt).toLocaleString('he-IL')}` : undefined}
              >
                {detail.window.open
                  ? features.windowTimer && left
                    ? `Window open · ${left} left`
                    : '24h window open'
                  : 'Template required'}
              </span>
            )}
            {features.searchInChat && (
              <IconButton title="Search in chat" active={searchOpen} onClick={() => setSearchOpen((v) => !v)}>
                <Svg d={Icons.search} />
              </IconButton>
            )}
            <Dropdown
              trigger={
                <IconButton title="Menu">
                  <Svg d={Icons.dots} />
                </IconButton>
              }
              items={[
                { label: 'Contact info', icon: 'ℹ', onClick: () => setShowInfo(true) },
                {
                  label: detail?.isPinned ? 'Unpin chat' : 'Pin chat',
                  icon: '📌',
                  hidden: !features.pinChats || !detail || detail.isArchived,
                  onClick: () => void patchConv({ isPinned: !detail?.isPinned }),
                },
                {
                  label: detail?.isArchived ? 'Unarchive chat' : 'Archive chat',
                  icon: '🗄',
                  hidden: !features.archive || !detail,
                  onClick: () => void patchConv({ isArchived: !detail?.isArchived }, detail?.isArchived ? 'Chat unarchived' : 'Chat archived'),
                },
                {
                  label: 'Mark as unread',
                  icon: '●',
                  hidden: !features.markUnread,
                  onClick: () => void patchConv({ markedUnread: true }, 'Marked as unread').then(() => onLeave?.()),
                },
                { label: 'Labels…', icon: '🏷', hidden: !features.labels, onClick: () => setShowLabels(true) },
                { label: 'AI agent…', icon: '🤖', hidden: !features.aiAgent, onClick: () => setShowInfo(true) },
                {
                  label: 'Export chat (.txt)',
                  icon: '⬇',
                  hidden: !features.exportChat,
                  onClick: () => window.open(`/api/conversations/${conversationId}/export`, '_blank'),
                },
                {
                  label: 'Export chat (PDF / print)',
                  icon: '🖨',
                  hidden: !features.exportChat,
                  onClick: () => window.open(`/api/conversations/${conversationId}/export?format=html`, '_blank'),
                },
              ]}
            />
          </div>
        </header>

        {/* In-chat search */}
        {searchOpen && features.searchInChat && (
          <div className="flex items-center gap-2 border-b border-black/10 bg-white px-4 py-1.5">
            <Svg d={Icons.search} className="h-4 w-4 text-ink-muted" />
            <input
              autoFocus
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') stepHit(e.shiftKey ? -1 : 1);
                if (e.key === 'Escape') setSearchOpen(false);
              }}
              placeholder="Search this chat…"
              className="flex-1 bg-transparent text-sm focus:outline-none"
            />
            {hits && (
              <span className="text-xs tabular-nums text-ink-muted">
                {hits.length ? `${hitIdx + 1} / ${hits.length}${hits.length === 100 ? '+' : ''}` : 'No results'}
              </span>
            )}
            <button type="button" title="Newer" onClick={() => stepHit(-1)} className="px-1 text-ink-muted hover:text-ink" disabled={!hits?.length}>
              ▲
            </button>
            <button type="button" title="Older" onClick={() => stepHit(1)} className="px-1 text-ink-muted hover:text-ink" disabled={!hits?.length}>
              ▼
            </button>
            <button type="button" onClick={() => setSearchOpen(false)} className="px-1 text-lg leading-none text-ink-muted hover:text-red-600" title="Close search">
              ×
            </button>
          </div>
        )}

        {/* Pinned messages bar */}
        {features.pinMessages && pin && (
          <div className="flex items-center gap-2 border-b border-black/10 bg-white px-4 py-1.5 text-sm">
            <div className="flex flex-col gap-0.5" title={`${pinned.length} pinned`}>
              {pinned.slice(0, 4).map((p, i) => (
                <span key={p.id} className={'h-1.5 w-0.5 rounded ' + (i === pinIdx % pinned.length ? 'bg-brand-link' : 'bg-gray-300')} />
              ))}
            </div>
            <Svg d={Icons.pin} className="h-4 w-4 shrink-0 rotate-45 text-ink-muted" />
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-ink hover:text-brand-primary"
              onClick={() => {
                void jumpToMessage(pin.id);
                setPinIdx((i) => (i + 1) % pinned.length);
              }}
              title={pinned.length > 1 ? 'Go to message (click again for the next pinned one)' : 'Go to message'}
            >
              {pin.body?.replace(/\s+/g, ' ') || (pin.mediaName ? `📎 ${pin.mediaName}` : `[${pin.type}]`)}
            </button>
            <button
              type="button"
              className="shrink-0 text-xs text-ink-muted hover:text-red-600"
              onClick={() => void flagMessage({ id: pin.id } as ChatMessage, { isPinned: false })}
              title="Unpin"
            >
              Unpin
            </button>
          </div>
        )}

        {/* Messages */}
        <div className="chat-canvas scroll-thin flex-1 overflow-y-auto px-6 py-4">
          {loading && <div className="text-center text-sm text-ink-muted">Loading…</div>}
          {!loading && bubbles.length === 0 && (
            <div className="text-center text-sm text-ink-muted">No messages yet.</div>
          )}
          <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
            {hasMore && (
              <div className="py-2 text-center">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="rounded px-4 py-1.5 text-xs text-ink-muted hover:bg-surface-hover disabled:opacity-50"
                >
                  {loadingMore ? 'טוען…' : 'טען הודעות קודמות'}
                </button>
              </div>
            )}
            {bubbles.map((m, i) => {
              // A separator opens every new calendar day, so a bubble showing only
              // "14:30" always sits under a heading saying which day that was.
              const prev = bubbles[i - 1];
              const newDay = !prev || dayKey(prev.sentAt) !== dayKey(m.sentAt);
              return (
                <Fragment key={m.id}>
                  {newDay && <DateDivider iso={m.sentAt} />}
                  <Bubble
                    message={m}
                    reactions={reactionsByTarget.get(m.id)}
                    onOpenImage={setLightbox}
                    onReply={setReplyingTo}
                    onQuoteClick={(id) => void jumpToMessage(id)}
                    highlighted={highlightedId === m.id}
                    searchTerm={searchOpen ? searchQ.trim() : ''}
                    onFlag={(b) => void flagMessage(m, b)}
                    onForward={() => setForwarding(m)}
                    onRetry={() => void retry(m)}
                    onCopy={() => void copyText(m.body ?? '').then((ok) => toast(ok ? 'Copied' : 'Could not copy', ok ? 'ok' : 'error'))}
                  />
                </Fragment>
              );
            })}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* AI draft waiting for the operator */}
        {features.aiAgent && detail?.aiSuggestion && (
          <div className="border-t border-black/10 bg-amber-50 px-4 py-2">
            <div className="mx-auto flex max-w-3xl items-start gap-3">
              <Svg d={Icons.sparkle} className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-amber-800">AI draft</div>
                <div className="line-clamp-3 whitespace-pre-wrap text-sm text-ink">{detail.aiSuggestion}</div>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                {windowOpen && (
                  <button
                    type="button"
                    className="rounded-full bg-brand-primary px-3 py-1 text-xs font-medium text-white hover:opacity-90"
                    onClick={() => void sendSuggestion(detail.aiSuggestion!)}
                  >
                    Send
                  </button>
                )}
                <button
                  type="button"
                  className="rounded-full px-3 py-1 text-xs text-brand-link hover:bg-black/5"
                  onClick={() => {
                    setInject({ text: detail.aiSuggestion!, nonce: Date.now() });
                    void patchConv({ clearAiSuggestion: true });
                  }}
                >
                  Edit
                </button>
                <button type="button" className="rounded-full px-3 py-1 text-xs text-ink-muted hover:text-red-600" onClick={() => void patchConv({ clearAiSuggestion: true })}>
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}

        <ScheduledBar conversationId={conversationId} />

        <InputBar
          conversationId={conversationId}
          windowOpen={windowOpen}
          onSent={handleSent}
          setWindowOpen={setWindowOpen}
          replyingTo={replyingTo}
          onCancelReply={() => setReplyingTo(null)}
          inject={inject}
        />
      </div>

      {showInfo && detail && <ContactPanel detail={detail} onClose={() => setShowInfo(false)} onChanged={loadDetail} />}
      {showLabels && detail && (
        <LabelPicker conversationId={detail.id} selected={detail.labels.map((l) => l.id)} onClose={() => setShowLabels(false)} onSaved={loadDetail} />
      )}
      {forwarding && <ForwardModal message={forwarding} onClose={() => setForwarding(null)} />}

      {/* Image lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox}
            alt="full size"
            className="max-h-[90vh] max-w-[90vw] rounded object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setLightbox(null)}
            className="absolute right-5 top-4 text-3xl leading-none text-white/90 hover:text-white"
            title="Close"
          >
            ×
          </button>
          <a
            href={`${lightbox}?download=1`}
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-5 rounded-full bg-white/90 px-4 py-2 text-sm font-medium text-ink hover:bg-white"
            target="_blank"
            rel="noreferrer"
          >
            Download
          </a>
        </div>
      )}
    </div>
  );
}

/** Wrap matches of `term` in <mark> (plain-text fallback used while searching). */
function Highlight({ text, term }: { text: string; term: string }) {
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return <RichText text={text} />;
  const parts: Array<{ t: string; hit: boolean }> = [];
  let rest = text;
  const lower = term.toLowerCase();
  while (rest) {
    const j = rest.toLowerCase().indexOf(lower);
    if (j < 0) {
      parts.push({ t: rest, hit: false });
      break;
    }
    if (j > 0) parts.push({ t: rest.slice(0, j), hit: false });
    parts.push({ t: rest.slice(j, j + term.length), hit: true });
    rest = rest.slice(j + term.length);
  }
  return (
    <>
      {parts.map((p, k) =>
        p.hit ? (
          <mark key={k} className="rounded bg-yellow-200 px-0.5 text-ink">
            {p.t}
          </mark>
        ) : (
          <span key={k}>{p.t}</span>
        ),
      )}
    </>
  );
}

function Bubble({
  message,
  reactions,
  onOpenImage,
  onReply,
  onQuoteClick,
  highlighted,
  searchTerm,
  onFlag,
  onForward,
  onRetry,
  onCopy,
}: {
  message: ChatMessage;
  reactions?: MessageReaction[];
  onOpenImage: (url: string) => void;
  onReply: (m: ChatMessage) => void;
  onQuoteClick: (id: string) => void;
  highlighted: boolean;
  searchTerm: string;
  onFlag: (b: { isPinned?: boolean; isStarred?: boolean }) => void;
  onForward: () => void;
  onRetry: () => void;
  onCopy: () => void;
}) {
  const { features } = useAppData();
  const outbound = message.direction === 'outbound';
  const time = new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // A reaction whose target never loaded. Shown plainly so it is never lost.
  if (message.type === 'reaction') {
    return (
      <div className={'flex ' + (outbound ? 'justify-end' : 'justify-start')}>
        <div className="my-1 flex items-center gap-1.5 rounded-full bg-black/5 px-2.5 py-1 text-xs text-ink-muted">
          <span className="text-base leading-none">{message.body || '🚫'}</span>
          <span>{message.body ? 'הגיב/ה להודעה קודמת' : 'הסיר/ה תגובה'}</span>
        </div>
      </div>
    );
  }

  const canRetry = features.retryFailed && outbound && message.status === 'failed' && message.errorMessage !== 'retried';
  const canForward = features.forward && (Boolean(message.body?.trim()) || message.hasMedia);

  const menu = (
    <Dropdown
      align={outbound ? 'right' : 'left'}
      className="absolute right-1 top-1 z-10 opacity-0 transition group-hover:opacity-100 data-[open=true]:opacity-100"
      trigger={
        <span
          className={
            'flex h-5 w-5 items-center justify-center rounded-full text-ink-muted shadow-sm hover:text-ink ' +
            (outbound ? 'bg-chat-out' : 'bg-chat-in')
          }
          title="Message options"
        >
          <Svg d={Icons.chevron} className="h-4 w-4" />
        </span>
      }
      items={[
        { label: 'Reply', icon: '↩', onClick: () => onReply(message) },
        { label: 'Copy', icon: '⧉', hidden: !features.copyMessage || !message.body, onClick: onCopy },
        {
          label: message.isStarred ? 'Unstar' : 'Star',
          icon: message.isStarred ? '☆' : '★',
          hidden: !features.starMessages,
          onClick: () => onFlag({ isStarred: !message.isStarred }),
        },
        {
          label: message.isPinned ? 'Unpin' : 'Pin',
          icon: '📌',
          hidden: !features.pinMessages,
          onClick: () => onFlag({ isPinned: !message.isPinned }),
        },
        { label: 'Forward', icon: '↪', hidden: !canForward, onClick: onForward },
        { label: 'Retry sending', icon: '⟳', hidden: !canRetry, onClick: onRetry },
      ]}
    />
  );

  return (
    <div
      id={`msg-${message.id}`}
      className={
        'group flex ' +
        (outbound ? 'justify-end' : 'justify-start') +
        // Room for the reaction chip, which overlaps the bubble's bottom edge.
        (reactions?.length ? ' mb-3' : '')
      }
    >
      {/* Reply action (left of outbound bubbles) */}
      {outbound && <ReplyButton onClick={() => onReply(message)} />}
      <div
        className={
          'relative max-w-[75%] rounded-lg px-2.5 py-1.5 text-sm shadow-sm transition ' +
          (outbound ? 'rounded-tr-none bg-chat-out' : 'rounded-tl-none bg-chat-in') +
          ' text-ink' +
          (highlighted ? ' ring-2 ring-brand-action' : '')
        }
      >
        {menu}
        {message.origin && ORIGIN_BADGE[message.origin] && (
          <div className="mb-0.5 pr-5 text-[10px] font-medium italic text-ink-muted">{ORIGIN_BADGE[message.origin]}</div>
        )}
        {message.replyTo && (
          <button
            type="button"
            onClick={() => message.replyTo && onQuoteClick(message.replyTo.id)}
            className="mb-1 block w-full rounded border-l-4 border-brand-link bg-brand-action/10 px-2 py-1 text-left text-xs hover:bg-brand-action/20"
            title="Go to the quoted message"
          >
            <div className="font-medium text-brand-primary">
              {message.replyTo.direction === 'outbound' ? 'You' : 'Them'}
            </div>
            <div className="truncate text-ink-muted">
              {message.replyTo.body ?? `[${message.replyTo.type}]`}
            </div>
          </button>
        )}
        {message.hasMedia && message.mediaUrl && (
          <MediaContent message={message} onOpenImage={onOpenImage} />
        )}
        {message.body && <div dir="auto" className="whitespace-pre-wrap break-words pr-4">
            {searchTerm ? <Highlight text={message.body} term={searchTerm} /> : <RichText text={message.body} />}
          </div>}
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-ink-muted">
          {message.isPinned && features.pinMessages && <Svg d={Icons.pin} className="h-3 w-3 rotate-45" />}
          {message.isStarred && features.starMessages && <Svg d={Icons.star} className="h-3 w-3" />}
          {/* Hover shows the full date — the bubble itself only has room for the
              time, and the day separator above may have scrolled out of view. */}
          <span title={new Date(message.sentAt).toLocaleString('he-IL')}>{time}</span>
          {outbound && <StatusTick status={message.status} />}
        </div>
        {canRetry && (
          <button type="button" onClick={onRetry} className="mt-1 text-[11px] font-medium text-red-600 hover:underline">
            ⟳ Retry
          </button>
        )}
        {message.buttons && message.buttons.length > 0 && <QuickReplyChips labels={message.buttons} />}
        {/* Reaction chip, WhatsApp-style: overlapping the bubble's bottom corner. */}
        {reactions && reactions.length > 0 && (
          <div
            className={
              'absolute -bottom-2.5 flex items-center gap-0.5 rounded-full border border-black/5 ' +
              'bg-white px-1.5 py-0.5 text-xs shadow-sm ' +
              (outbound ? 'left-1.5' : 'right-1.5')
            }
            title={reactions.map((r) => (r.direction === 'outbound' ? `You: ${r.emoji}` : r.emoji)).join('  ')}
          >
            {reactions.map((r) => (
              <span key={r.id} className="leading-none">
                {r.emoji}
              </span>
            ))}
          </div>
        )}
      </div>
      {/* Reply action (right of inbound bubbles) */}
      {!outbound && <ReplyButton onClick={() => onReply(message)} />}
    </div>
  );
}


/**
 * Quick-reply chips under a bubble.
 *
 * A read-only echo of what the customer's WhatsApp renders — they tap on their
 * phone, not here, and the tap comes back as an ordinary inbound message whose
 * body is the button's label. Rendered as disabled buttons rather than plain
 * text so it stays obvious this is the message's shape, not a control for us.
 */
function QuickReplyChips({ labels }: { labels: string[] }) {
  return (
    <div className="-mx-2.5 -mb-1.5 mt-1.5 border-t border-black/10">
      {labels.map((label, i) => (
        <div
          key={`${label}-${i}`}
          className={
            'px-2.5 py-1.5 text-center text-sm font-medium text-brand-link ' +
            (i > 0 ? 'border-t border-black/10' : '')
          }
          title="Your customer taps this in WhatsApp; the reply arrives as a normal message"
        >
          {label}
        </div>
      ))}
    </div>
  );
}

/** Centred day heading between message groups, WhatsApp-style. */
function DateDivider({ iso }: { iso: string }) {
  return (
    <div className="my-2 flex justify-center">
      <span
        className="rounded-full bg-white/90 px-3 py-1 text-[11px] font-medium text-ink-muted shadow-sm"
        // Hovering gives the exact date even when the label reads "היום".
        title={new Date(iso).toLocaleDateString('he-IL', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })}
      >
        {dayLabel(iso)}
      </span>
    </div>
  );
}

function ReplyButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Reply"
      className="mx-1 self-center text-ink-muted opacity-0 transition group-hover:opacity-100 hover:text-brand-primary"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
        <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" />
      </svg>
    </button>
  );
}

function MediaContent({
  message,
  onOpenImage,
}: {
  message: ChatMessage;
  onOpenImage: (url: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const url = message.mediaUrl!;
  const mime = message.mediaMime ?? '';
  const t = message.type;

  // Branch on the message TYPE first (always present, even for realtime arrivals),
  // falling back to the MIME string. This is why a newly-arrived image used to
  // render as a download link — its MIME hadn't arrived yet over the socket.
  const isImage = t === 'image' || mime.startsWith('image/');
  const isVideo = t === 'video' || mime.startsWith('video/');
  const isAudio = t === 'audio' || t === 'voice' || mime.startsWith('audio/');

  if (failed) {
    return (
      <div className="mb-1 rounded bg-black/5 p-3 text-xs text-ink-muted">
        <div>This media couldn’t be shown here.</div>
        <EmailMediaButton messageId={message.id} label="Email it to me" />
      </div>
    );
  }

  if (isImage) {
    // Click the image to VIEW it full-size in an in-app lightbox (not a new tab).
    return (
      <div className="mb-1">
        <img
          src={url}
          alt="image"
          onError={() => setFailed(true)}
          onClick={() => onOpenImage(url)}
          className="max-h-72 cursor-pointer rounded object-cover"
          title="Click to view full size"
        />
        <div className="mt-1 text-[11px]">
          <EmailMediaButton messageId={message.id} label="✉ Email to me" />
        </div>
      </div>
    );
  }
  if (isVideo) {
    return (
      <div className="mb-1">
        <video controls src={url} onError={() => setFailed(true)} className="max-h-72 rounded" />
        <div className="mt-1 text-[11px]">
          <EmailMediaButton messageId={message.id} label="✉ Email to me" />
        </div>
      </div>
    );
  }
  if (isAudio) {
    return (
      <div className="mb-1 w-72">
        <AudioPlayer src={url} messageId={message.id} onError={() => setFailed(true)} />
      </div>
    );
  }
  // document / other
  return (
    <div className="mb-1 flex items-center gap-2 rounded bg-black/5 px-3 py-2">
      <span>📎</span>
      <span className="text-ink-muted">{message.mediaName ?? 'File'}</span>
      <EmailMediaButton messageId={message.id} label="✉ Email to me" />
    </div>
  );
}

function StatusTick({ status }: { status: string }) {
  if (status === 'failed') return <span className="text-red-500">failed</span>;
  if (status === 'read') return <span className="text-check-read">✓✓</span>;
  if (status === 'delivered') return <span>✓✓</span>;
  if (status === 'sent') return <span>✓</span>;
  return <span>·</span>;
}

export type { ChatMessage as ConversationMessage };
