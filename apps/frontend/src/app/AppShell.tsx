import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ChatList } from './ChatList';
import { ConversationView } from './ConversationView';
import { RealtimeProvider, useRealtime } from './RealtimeProvider';
import { isNotificationMuted, playMessageDing, setNotificationMuted } from '../lib/sound';

export function AppShell() {
  return (
    <RealtimeProvider>
      <Layout />
    </RealtimeProvider>
  );
}

function Layout() {
  const { user, logout } = useAuth();
  const { status, socket } = useRealtime();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [muted, setMuted] = useState<boolean>(isNotificationMuted());

  // Ring on every new inbound message.
  useEffect(() => {
    if (!socket) return;
    const onAdded = (data: { payload?: { direction?: string } }) => {
      if (data?.payload?.direction === 'inbound') playMessageDing();
    };
    socket.on('message.added', onAdded);
    return () => {
      socket.off('message.added', onAdded);
    };
  }, [socket]);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    setNotificationMuted(next);
  }

  return (
    <div className="flex h-full flex-col">
      <ConnectionBanner status={status} />

      <div className="flex flex-1 overflow-hidden">
        {/* Chat list column (~30% per spec §5.2) */}
        <aside className="flex w-[340px] flex-col border-r border-gray-200 bg-chat-list">
          <header className="flex items-center justify-between bg-brand-primary px-4 py-3 text-white">
            <span className="truncate text-sm font-medium">{user?.email}</span>
            <div className="ml-2 flex shrink-0 items-center gap-3">
              <button
                onClick={toggleMute}
                title={muted ? 'Notifications muted' : 'Mute notifications'}
                className="text-base leading-none opacity-90 hover:opacity-100"
              >
                {muted ? '🔕' : '🔔'}
              </button>
              <button
                onClick={() => void logout()}
                className="text-xs underline opacity-90 hover:opacity-100"
              >
                Sign out
              </button>
            </div>
          </header>
          <ChatList selectedId={selectedId} onSelect={setSelectedId} />
        </aside>

        {/* Conversation column */}
        <main className="flex-1 chat-canvas">
          <ConversationView conversationId={selectedId} />
        </main>
      </div>
    </div>
  );
}

function ConnectionBanner({ status }: { status: 'connecting' | 'connected' | 'disconnected' }) {
  if (status === 'connected') return null;
  return (
    <div
      className={
        'px-4 py-1 text-center text-xs font-medium ' +
        (status === 'connecting' ? 'bg-yellow-100 text-yellow-900' : 'bg-red-100 text-red-900')
      }
    >
      {status === 'connecting' ? 'Reconnecting…' : 'Offline — messages cannot be sent right now.'}
    </div>
  );
}
