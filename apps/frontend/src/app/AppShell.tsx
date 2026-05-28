import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ChatList } from './ChatList';
import { ConversationView } from './ConversationView';
import { RealtimeProvider, useRealtime } from './RealtimeProvider';

export function AppShell() {
  return (
    <RealtimeProvider>
      <Layout />
    </RealtimeProvider>
  );
}

function Layout() {
  const { user, logout } = useAuth();
  const { status } = useRealtime();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="flex h-full flex-col">
      <ConnectionBanner status={status} />

      <div className="flex flex-1 overflow-hidden">
        {/* Chat list column (~30% per spec §5.2) */}
        <aside className="flex w-[340px] flex-col border-r border-gray-200 bg-chat-list">
          <header className="flex items-center justify-between bg-brand-primary px-4 py-3 text-white">
            <span className="truncate text-sm font-medium">{user?.email}</span>
            <button
              onClick={() => void logout()}
              className="ml-2 shrink-0 text-xs underline opacity-90 hover:opacity-100"
            >
              Sign out
            </button>
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
