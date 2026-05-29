/**
 * Conversation view (Phase 3 + media display).
 *
 * Header (contact name, phone, 24h window badge), message bubbles (text + media),
 * realtime append, mark-read on open, and the input bar.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useRealtime } from './RealtimeProvider';
import { InputBar } from './InputBar';
import { AudioPlayer } from './AudioPlayer';

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
  const [windowOpen, setWindowOpen] = useState(true);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const { socket } = useRealtime();
  const bottomRef = useRef<HTMLDivElement>(null);

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

    api<{ messages: ChatMessage[] }>(`/api/conversations/${conversationId}/messages`)
      .then((r) => setMessages(r.messages))
      .catch(() => setMessages([]))
      .finally(() => setLoading(false));

    api(`/api/conversations/${conversationId}/read`, { method: 'POST' }).catch(() => undefined);
  }, [conversationId]);

  useEffect(() => {
    if (!socket || !conversationId) return;
    const onAdded = (data: { conversationId?: string; payload?: Record<string, unknown> }) => {
      if (data.conversationId !== conversationId || !data.payload) return;
      const p = data.payload as Record<string, unknown>;
      const incoming: ChatMessage = {
        id: String(p.messageId),
        clientId: (p.clientId as string) ?? null,
        direction: p.direction as 'inbound' | 'outbound',
        type: String(p.type),
        status: String(p.status),
        body: (p.body as string) ?? null,
        sentAt: String(p.sentAt),
        hasMedia: Boolean(p.hasMedia) || p.type !== 'text',
        mediaUrl: p.type !== 'text' ? `/api/media/${String(p.messageId)}` : null,
        mediaMime: (p.mediaMime as string) ?? null,
        mediaName: (p.mediaName as string) ?? null,
      };
      setMessages((prev) => (prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]));
    };
    const onUpdated = (data: { conversationId?: string; payload?: Record<string, unknown> }) => {
      if (data.conversationId !== conversationId || !data.payload) return;
      const p = data.payload as { messageId: string; status: string };
      setMessages((prev) => prev.map((m) => (m.id === p.messageId ? { ...m, status: p.status } : m)));
    };
    socket.on('message.added', onAdded);
    socket.on('message.updated', onUpdated);
    return () => {
      socket.off('message.added', onAdded);
      socket.off('message.updated', onUpdated);
    };
  }, [socket, conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSent = useCallback((m: ChatMessage) => {
    setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
  }, []);

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
        {!loading && messages.length === 0 && (
          <div className="text-center text-sm text-ink-muted">No messages yet.</div>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
          {messages.map((m) => (
            <Bubble key={m.id} message={m} onOpenImage={setLightbox} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <InputBar
        conversationId={conversationId}
        windowOpen={windowOpen}
        onSent={handleSent}
        setWindowOpen={setWindowOpen}
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

function Bubble({ message, onOpenImage }: { message: ChatMessage; onOpenImage: (url: string) => void }) {
  const outbound = message.direction === 'outbound';
  const time = new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className={'flex ' + (outbound ? 'justify-end' : 'justify-start')}>
      <div
        className={
          'max-w-[75%] rounded-lg px-2.5 py-1.5 text-sm shadow-sm ' +
          (outbound ? 'rounded-tr-none bg-chat-out' : 'rounded-tl-none bg-chat-in') +
          ' text-ink'
        }
      >
        {message.hasMedia && message.mediaUrl && (
          <MediaContent message={message} onOpenImage={onOpenImage} />
        )}
        {message.body && <div className="whitespace-pre-wrap break-words">{message.body}</div>}
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-ink-muted">
          <span>{time}</span>
          {outbound && <StatusTick status={message.status} />}
        </div>
      </div>
    </div>
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
        <div>Media unavailable or still under review.</div>
        <a href={`${url}?download=1`} className="text-brand-link underline" target="_blank" rel="noreferrer">
          Try downloading
        </a>
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
        <a
          href={`${url}?download=1`}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-[11px] text-brand-link underline"
        >
          ⬇ Download
        </a>
      </div>
    );
  }
  if (isVideo) {
    return (
      <video controls src={url} onError={() => setFailed(true)} className="mb-1 max-h-72 rounded" />
    );
  }
  if (isAudio) {
    return (
      <div className="mb-1 w-64">
        <AudioPlayer src={url} onError={() => setFailed(true)} />
      </div>
    );
  }
  // document / other
  return (
    <a
      href={`${url}?download=1`}
      target="_blank"
      rel="noreferrer"
      className="mb-1 flex items-center gap-2 rounded bg-black/5 px-3 py-2 text-brand-link underline"
    >
      <span>📎</span>
      <span>{message.mediaName ?? 'Download file'}</span>
    </a>
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
