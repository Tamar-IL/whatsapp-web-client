/**
 * App-wide data every screen needs: settings (feature switches), labels,
 * saved replies, and a toast queue. Reloads itself on the server's
 * `library.changed` ping so two open tabs never disagree.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useRealtime } from './RealtimeProvider';

export interface Features {
  playbackSpeed: boolean;
  lastMessagePreview: boolean;
  pinChats: boolean;
  archive: boolean;
  markUnread: boolean;
  pinMessages: boolean;
  starMessages: boolean;
  forward: boolean;
  copyMessage: boolean;
  searchInChat: boolean;
  labels: boolean;
  savedReplies: boolean;
  contactNotes: boolean;
  windowTimer: boolean;
  retryFailed: boolean;
  exportChat: boolean;
  scheduleMedia: boolean;
  bulkSend: boolean;
  templateManager: boolean;
  aiAgent: boolean;
}

export interface DayHours {
  on: boolean;
  from: string;
  to: string;
}

export interface Settings {
  features: Features;
  audio: { defaultSpeed: number };
  businessHours: { timezone: string; days: Record<string, DayHours> };
  away: { enabled: boolean; text: string; when: 'outsideHours' | 'always'; cooldownHours: number };
  ai: {
    enabled: boolean;
    model: string;
    effort: 'low' | 'medium' | 'high';
    businessInfo: string;
    globalInstructions: string;
    defaultMode: 'auto' | 'suggest';
    replyDelaySeconds: number;
    pauseAfterOperatorMinutes: number;
    historyMessages: number;
    hasApiKey: boolean;
    apiKeyFromEnv: boolean;
  };
}

export interface Label {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  count?: number;
}

export interface SavedReply {
  id: string;
  shortcut: string;
  body: string;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'ok' | 'warn' | 'error';
  action?: { label: string; onClick: () => void };
}

interface AppDataState {
  settings: Settings | null;
  aiModels: string[];
  features: Features;
  labels: Label[];
  savedReplies: SavedReply[];
  reloadSettings: () => Promise<void>;
  reloadLabels: () => Promise<void>;
  reloadSavedReplies: () => Promise<void>;
  saveSettings: (patch: unknown) => Promise<Settings>;
  toasts: Toast[];
  toast: (text: string, tone?: Toast['tone'], action?: Toast['action']) => void;
  dismissToast: (id: number) => void;
}

/** Until settings load, everything shows (same as the server defaults). */
const ALL_ON: Features = {
  playbackSpeed: true,
  lastMessagePreview: true,
  pinChats: true,
  archive: true,
  markUnread: true,
  pinMessages: true,
  starMessages: true,
  forward: true,
  copyMessage: true,
  searchInChat: true,
  labels: true,
  savedReplies: true,
  contactNotes: true,
  windowTimer: true,
  retryFailed: true,
  exportChat: true,
  scheduleMedia: true,
  bulkSend: true,
  templateManager: true,
  aiAgent: true,
};

const Ctx = createContext<AppDataState | null>(null);

let toastSeq = 1;

export function AppDataProvider({ children }: { children: ReactNode }) {
  const { socket } = useRealtime();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [aiModels, setAiModels] = useState<string[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [savedReplies, setSavedReplies] = useState<SavedReply[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const reloadSettings = useCallback(async () => {
    const r = await api<{ settings: Settings; aiModels: string[] }>('/api/settings');
    setSettings(r.settings);
    setAiModels(r.aiModels);
  }, []);
  const reloadLabels = useCallback(async () => {
    const r = await api<{ labels: Label[] }>('/api/labels');
    setLabels(r.labels);
  }, []);
  const reloadSavedReplies = useCallback(async () => {
    const r = await api<{ replies: SavedReply[] }>('/api/saved-replies');
    setSavedReplies(r.replies);
  }, []);

  const saveSettings = useCallback(async (patch: unknown) => {
    const r = await api<{ settings: Settings; aiModels: string[] }>('/api/settings', { method: 'PATCH', body: patch });
    setSettings(r.settings);
    return r.settings;
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (text: string, tone: Toast['tone'] = 'info', action?: Toast['action']) => {
      const id = toastSeq++;
      setToasts((t) => [...t.slice(-3), { id, text, tone, action }]);
      window.setTimeout(() => dismissToast(id), tone === 'error' || action ? 9000 : 4500);
    },
    [dismissToast],
  );

  useEffect(() => {
    void reloadSettings().catch(() => undefined);
    void reloadLabels().catch(() => undefined);
    void reloadSavedReplies().catch(() => undefined);
  }, [reloadSettings, reloadLabels, reloadSavedReplies]);

  useEffect(() => {
    if (!socket) return;
    const onChanged = (data: { payload?: { kind?: string } }) => {
      const kind = data?.payload?.kind;
      if (kind === 'settings') void reloadSettings().catch(() => undefined);
      if (kind === 'labels') void reloadLabels().catch(() => undefined);
      if (kind === 'savedReplies') void reloadSavedReplies().catch(() => undefined);
    };
    const onTemplate = (data: { payload?: { friendlyName?: string; to?: string; rejectionReason?: string | null } }) => {
      const p = data.payload;
      if (!p) return;
      if (p.to === 'approved') toast(`Template “${p.friendlyName}” was approved ✓`, 'ok');
      else if (p.to === 'rejected')
        toast(`Template “${p.friendlyName}” was rejected${p.rejectionReason ? `: ${p.rejectionReason}` : ''}`, 'error');
      else toast(`Template “${p.friendlyName}” is now ${p.to}`, 'info');
    };
    const onBulk = (data: { payload?: { name?: string; status?: string; sent?: number; failed?: number } | null }) => {
      const p = data.payload;
      if (p?.status === 'done') toast(`Bulk send “${p.name}” finished: ${p.sent} sent, ${p.failed} failed`, 'ok');
    };
    socket.on('library.changed', onChanged);
    socket.on('template.status', onTemplate);
    socket.on('bulk.progress', onBulk);
    // Labels' chat counts move when chats change.
    const onConv = () => void reloadLabels().catch(() => undefined);
    socket.on('conversation.updated', onConv);
    return () => {
      socket.off('library.changed', onChanged);
      socket.off('template.status', onTemplate);
      socket.off('bulk.progress', onBulk);
      socket.off('conversation.updated', onConv);
    };
  }, [socket, reloadSettings, reloadLabels, reloadSavedReplies, toast]);

  const value = useMemo<AppDataState>(
    () => ({
      settings,
      aiModels,
      features: settings?.features ?? ALL_ON,
      labels,
      savedReplies,
      reloadSettings,
      reloadLabels,
      reloadSavedReplies,
      saveSettings,
      toasts,
      toast,
      dismissToast,
    }),
    [settings, aiModels, labels, savedReplies, reloadSettings, reloadLabels, reloadSavedReplies, saveSettings, toasts, toast, dismissToast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppData(): AppDataState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppData outside AppDataProvider');
  return v;
}

export function Toasts() {
  const { toasts, dismissToast } = useAppData();
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-24 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={
            'pointer-events-auto flex max-w-md items-center gap-3 rounded-lg px-4 py-2.5 text-sm text-white shadow-lg ' +
            (t.tone === 'error' ? 'bg-red-600' : t.tone === 'warn' ? 'bg-amber-600' : t.tone === 'ok' ? 'bg-brand-primary' : 'bg-[#3b4a54]')
          }
        >
          <span className="min-w-0 flex-1">{t.text}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action!.onClick();
                dismissToast(t.id);
              }}
              className="shrink-0 font-semibold text-brand-action hover:underline"
            >
              {t.action.label}
            </button>
          )}
          <button type="button" onClick={() => dismissToast(t.id)} className="shrink-0 text-white/70 hover:text-white">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
