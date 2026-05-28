/**
 * Conversation view (Phase 3 tickets 3.7-3.9).
 *
 * Loads messages for the selected conversation, renders bubbles (inbound left/white,
 * outbound right/green per spec §5.2), appends new messages from realtime events,
 * and includes the input bar to send replies. Marks the conversation read on open.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useRealtime } from './RealtimeProvider';
import { InputBar } from './InputBar';

export interface ChatMessage {
  id: string;
  clientId?: string | null;
  direction: 'inbound' | 'outbound';
  type: string;
  status: string;
  body: string | null;
  mediaMime?: string | null;
  sentAt: string;
}

export function ConversationView({ conversationId }: { conversationId: string | null }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [windowOpen, setWindowOpen] = useState(true);
  const { socket } = useRealtime();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load messages + mark read when a conversation is opened.
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    setLoading(true);
    api<{ messages: ChatMessage[] }>(`/api/conversations/${conversationId}/messages`)
      .then((r) => setMessages(r.messages))
      .catch(() => setMessages([]))
      .finally(() => setLoading(false));

    api(`/api/conversations/${conversationId}/read`, { method: 'POST' }).catch(() => undefined);
  }, [conversationId]);

  // Append realtime messages for this conversation (dedup by id).
  useEffect(() => {
    if (!socket || !conversationId) return;
    const onAdded = (data: { conversationId?: string; payload?: Record<string, unknown> }) => {
      if (data.conversationId !== conversationId || !data.payload) return;
      const p = data.payload as unknown as ChatMessage & { messageId: string };
      const incoming: ChatMessage = {
        id: p.messageId,
        clientId: p.clientId ?? null,
        direction: p.direction,
        type: p.type,
        status: p.status,
        body: p.body ?? null,
        sentAt: p.sentAt,
      };
      setMessages((prev) => {
        if (prev.some((m) => m.id === incoming.id)) return prev;
        return [...prev, incoming];
      });
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

  // Keep scrolled to the newest message.
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading && <div className="text-center text-sm text-ink-muted">Loading…</div>}
        {!loading && messages.length === 0 && (
          <div className="text-center text-sm text-ink-muted">No messages yet.</div>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-1">
          {messages.map((m) => (
            <Bubble key={m.id} message={m} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <InputBar conversationId={conversationId} windowOpen={windowOpen} onSent={handleSent} setWindowOpen={setWindowOpen} />
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const outbound = message.direction === 'outbound';
  const time = new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className={'flex ' + (outbound ? 'justify-end' : 'justify-start')}>
      <div
        className={
          'max-w-[75%] rounded-lg px-3 py-2 text-sm shadow-sm ' +
          (outbound ? 'bg-chat-out text-ink' : 'bg-chat-in text-ink')
        }
      >
        {message.body && <div className="whitespace-pre-wrap break-words">{message.body}</div>}
        {!message.body && message.type !== 'text' && (
          <div className="italic text-ink-muted">[{message.type}]</div>
        )}
        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-ink-muted">
          <span>{time}</span>
          {outbound && <StatusTick status={message.status} />}
        </div>
      </div>
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

// Re-export so InputBar consumers get the type.
export type { ChatMessage as ConversationMessage };
