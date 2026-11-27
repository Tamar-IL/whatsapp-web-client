import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ChatList } from './ChatList';
import { ConversationView } from './ConversationView';
import { RealtimeProvider, useRealtime } from './RealtimeProvider';
import { AppDataProvider, Toasts, useAppData } from './AppData';
import { SettingsModal } from './SettingsModal';
import { TemplateManager } from './TemplateManager';
import { BulkSendModal } from './BulkSendModal';
import { StarredModal } from './StarredModal';
import { AskAiPanel } from './AskAiPanel';
import { Dropdown, IconButton, Icons, Svg } from './ui';
import { isNotificationMuted, playMessageDing, setNotificationMuted } from '../lib/sound';

export function AppShell() {
  return (
    <RealtimeProvider>
      <AppDataProvider>
        <Layout />
        <Toasts />
      </AppDataProvider>
    </RealtimeProvider>
  );
}

type Panel = 'settings' | 'templates' | 'bulk' | 'starred' | null;

function Layout() {
  const { user, logout } = useAuth();
  const { status, socket } = useRealtime();
  const { features, toast } = useAppData();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const [muted, setMuted] = useState<boolean>(isNotificationMuted());
  const [panel, setPanel] = useState<Panel>(null);
  const [askOpen, setAskOpen] = useState(false);

  // Ring on every new inbound message.
  useEffect(() => {
    if (!socket) return;
    const onAdded = (data: { payload?: { direction?: string } }) => {
      if (data?.payload?.direction === 'inbound') playMessageDing();
    };
    // The AI agent asks for a human, or fails — tell the operator wherever they are.
    const onHandoff = (data: { conversationId?: string; payload?: { reason?: string } }) => {
      const id = data.conversationId;
      toast(`🤖 A chat needs you${data.payload?.reason ? `: ${data.payload.reason}` : ''}`, 'warn', id ? { label: 'Open', onClick: () => setSelectedId(id) } : undefined);
    };
    const onAiError = (data: { conversationId?: string; payload?: { message?: string } }) => {
      const id = data.conversationId;
      toast(`AI agent: ${data.payload?.message ?? 'error'}`, 'error', id ? { label: 'Open', onClick: () => setSelectedId(id) } : undefined);
    };
    socket.on('message.added', onAdded);
    socket.on('ai.handoff', onHandoff);
    socket.on('ai.error', onAiError);
    return () => {
      socket.off('message.added', onAdded);
      socket.off('ai.handoff', onHandoff);
      socket.off('ai.error', onAiError);
    };
  }, [socket, toast]);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    setNotificationMuted(next);
  }

  const onJumped = useCallback(() => setJumpTo(null), []);

  return (
    <div className="flex h-full flex-col">
      <EnvBanner />
      <ConnectionBanner status={status} />

      <div className="flex flex-1 overflow-hidden">
        {/* Chat list column (~30% per spec §5.2) */}
        <aside className="flex w-[360px] shrink-0 flex-col border-r border-gray-200 bg-chat-list">
          <header className="flex items-center justify-between bg-brand-primary px-3 py-2 text-white">
            <span className="truncate pl-1 text-sm font-medium">{user?.email}</span>
            <div className="ml-2 flex shrink-0 items-center gap-0.5">
              {features.aiAgent && (
                <IconButton light title="Ask AI" onClick={() => setAskOpen((v) => !v)}>
                  <Svg d={Icons.sparkle} />
                </IconButton>
              )}
              {features.starMessages && (
                <IconButton light title="Starred messages" onClick={() => setPanel('starred')}>
                  <Svg d={Icons.star} />
                </IconButton>
              )}
              {features.templateManager && (
                <IconButton light title="Templates" onClick={() => setPanel('templates')}>
                  <Svg d={Icons.template} />
                </IconButton>
              )}
              {features.bulkSend && (
                <IconButton light title="Bulk send" onClick={() => setPanel('bulk')}>
                  <Svg d={Icons.megaphone} />
                </IconButton>
              )}
              <IconButton light title={muted ? 'Notifications muted' : 'Mute notifications'} onClick={toggleMute}>
                <span className="text-base leading-none">{muted ? '🔕' : '🔔'}</span>
              </IconButton>
              <Dropdown
                trigger={
                  <IconButton light title="Menu">
                    <Svg d={Icons.dots} />
                  </IconButton>
                }
                items={[
                  { label: 'Settings', icon: '⚙', onClick: () => setPanel('settings') },
                  { label: 'Sign out', icon: '⎋', onClick: () => void logout() },
                ]}
              />
            </div>
          </header>
          <ChatList selectedId={selectedId} onSelect={setSelectedId} />
        </aside>

        {/* Conversation column */}
        <main className="min-w-0 flex-1 chat-canvas">
          <ConversationView
            conversationId={selectedId}
            jumpTo={jumpTo}
            onJumped={onJumped}
            onLeave={() => setSelectedId(null)}
          />
        </main>
      </div>

      {askOpen && features.aiAgent && (
        <AskAiPanel conversationId={selectedId} chatName={selectedId ? 'this chat' : null} onClose={() => setAskOpen(false)} />
      )}
      {panel === 'settings' && <SettingsModal onClose={() => setPanel(null)} />}
      {panel === 'templates' && <TemplateManager onClose={() => setPanel(null)} />}
      {panel === 'bulk' && <BulkSendModal onClose={() => setPanel(null)} />}
      {panel === 'starred' && (
        <StarredModal
          onClose={() => setPanel(null)}
          onOpen={(conversationId, messageId) => {
            setPanel(null);
            setSelectedId(conversationId);
            setJumpTo(messageId);
          }}
        />
      )}
    </div>
  );
}

/** Orange bar on a test (staging) copy, so it is never mistaken for the real app. */
function EnvBanner() {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    api<{ config?: { envLabel?: string | null } }>('/api/auth/me')
      .then((r) => {
        const l = r.config?.envLabel ?? null;
        setLabel(l);
        if (l && !document.title.startsWith(`[${l}]`)) document.title = `[${l}] ${document.title}`;
      })
      .catch(() => undefined);
  }, []);
  if (!label) return null;
  return (
    <div className="bg-amber-500 px-4 py-0.5 text-center text-xs font-semibold tracking-wide text-white">
      {label} ENVIRONMENT — messages here go to the Twilio sandbox, not to real customers
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
