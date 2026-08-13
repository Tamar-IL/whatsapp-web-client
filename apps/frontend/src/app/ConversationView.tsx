/**
 * Conversation view (Phase 3 + media display).
 *
 * Header (contact name, phone, 24h window badge), message bubbles (text + media),
 * realtime append, mark-read on open, and the input bar.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useRealtime } from './RealtimeProvider';
import { InputBar } from './InputBar';
import { ScheduledBar } from './ScheduledBar';
import { AudioPlayer } from './AudioPlayer';
import { EmailMediaButton } from './EmailMediaButton';

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
  /** Set on a reaction row: the id of the message it reacts to. */
  reactsToId?: string | null;
  /** Reactions others placed ON this message, newest per side. */
  reactions?: MessageReaction[];
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

interface ContactInfo {
  id: string;
  phoneNumber: string;
  displayName: string | null;
  profileName: string | null;
}

interface ConversationDetail {
  id: string;
  contact: ContactInfo;
  window: { open: boolean; closesAt: string | null };
}

export function ConversationView({ conversationId }: { conversationId: string | null }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [windowOpen, setWindowOpen] = useState(true);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const { socket } = useRealtime();
  const bottomRef = useRef<HTMLDivElement>(null);
  const skipAutoScroll = useRef(false);

  // Scroll to + briefly highlight a message (used when clicking a quote box).
  const scrollToMessage = useCallback((id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedId(id);
    window.setTimeout(() => setHighlightedId((cur) => (cur === id ? null : cur)), 1600);
  }, []);

  // Reset reply state when switching conversations.
  useEffect(() => {
    setReplyingTo(null);
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setDetail(null);
      return;
    }
    setLoading(true);

    api<{ conversation: ConversationDetail }>(`/api/conversations/${conversationId}`)
      .then((r) => {
        setDetail(r.conversation);
        setWindowOpen(r.conversation.window.open);
      })
      .catch(() => setDetail(null));

    api<{ messages: ChatMessage[] }>(
      `/api/conversations/${conversationId}/messages?limit=${PAGE_SIZE}`,
    )
      .then((r) => {
        setMessages(r.messages);
        setHasMore(r.messages.length === PAGE_SIZE);
      })
      .catch(() => setMessages([]))
      .finally(() => setLoading(false));

    api(`/api/conversations/${conversationId}/read`, { method: 'POST' }).catch(() => undefined);
  }, [conversationId]);

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
        // Carried through so a live reaction lands on its target bubble; without
        // it the row would sit in the thread as an unattached emoji.
        reactsToId: (p.reactsToId as string) ?? null,
      };
      setMessages((prev) => (prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]));
    };
    const onUpdated = (data: { conversationId?: string; payload?: Record<string, unknown> }) => {
      if (data.conversationId !== conversationId || !data.payload) return;
      const p = data.payload as { messageId: string; status?: string; body?: string };
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== p.messageId) return m;
          return {
            ...m,
            ...(p.status !== undefined && { status: p.status }),
            ...(p.body !== undefined && { body: p.body }),
          };
        }),
      );
    };
    socket.on('message.added', onAdded);
    socket.on('message.updated', onUpdated);
    return () => {
      socket.off('message.added', onAdded);
      socket.off('message.updated', onUpdated);
    };
  }, [socket, conversationId]);

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

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-black/10 bg-[#f0f2f5] px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-primary text-sm font-semibold text-white">
            {title.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <div className="font-medium text-ink">{title}</div>
            {detail && <div className="text-xs text-ink-muted">{detail.contact.phoneNumber}</div>}
          </div>
        </div>
        {detail && (
          <span
            className={
              'rounded-full px-2.5 py-1 text-xs font-medium ' +
              (detail.window.open
                ? 'bg-green-100 text-green-800'
                : 'bg-gray-200 text-gray-600')
            }
          >
            {detail.window.open ? '24h window open' : 'Template required'}
          </span>
        )}
      </header>

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
          {bubbles.map((m) => (
            <Bubble
              key={m.id}
              message={m}
              reactions={reactionsByTarget.get(m.id)}
              onOpenImage={setLightbox}
              onReply={setReplyingTo}
              onQuoteClick={scrollToMessage}
              highlighted={highlightedId === m.id}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <ScheduledBar conversationId={conversationId} />

      <InputBar
        conversationId={conversationId}
        windowOpen={windowOpen}
        onSent={handleSent}
        setWindowOpen={setWindowOpen}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
      />

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

function Bubble({
  message,
  reactions,
  onOpenImage,
  onReply,
  onQuoteClick,
  highlighted,
}: {
  message: ChatMessage;
  reactions?: MessageReaction[];
  onOpenImage: (url: string) => void;
  onReply: (m: ChatMessage) => void;
  onQuoteClick: (id: string) => void;
  highlighted: boolean;
}) {
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
        {message.body && <div className="whitespace-pre-wrap break-words">{message.body}</div>}
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-ink-muted">
          <span>{time}</span>
          {outbound && <StatusTick status={message.status} />}
        </div>
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
      <div className="mb-1 w-64">
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
