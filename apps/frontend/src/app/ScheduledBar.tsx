/**
 * Scheduled-messages bar.
 *
 * Sits just above the input bar and shows outbound texts that are queued to send
 * later. Loads the current list on open, then stays live via socket pings:
 *   - scheduled.added   → a new pending item
 *   - scheduled.removed → it fired (sent) or was canceled — drop it
 *   - scheduled.updated → status changed (e.g. failed) — show the reason
 * A pending item can be canceled; a failed one can be dismissed locally.
 */
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useRealtime } from './RealtimeProvider';

interface Scheduled {
  id: string;
  conversationId: string;
  body: string;
  scheduledFor: string;
  status: string;
  errorMessage?: string | null;
}

/** Format a Date for a datetime-local input (local time, no timezone suffix). */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return `Today ${time}`;
  if (sameDay(d, tomorrow)) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

export function ScheduledBar({ conversationId }: { conversationId: string }) {
  const { socket } = useRealtime();
  const [items, setItems] = useState<Scheduled[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editWhen, setEditWhen] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ scheduled: Scheduled[] }>(`/api/scheduled?conversationId=${encodeURIComponent(conversationId)}`)
      .then((r) => alive && setItems(r.scheduled))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [conversationId]);

  useEffect(() => {
    if (!socket) return;
    const matches = (data: { conversationId?: string }) => data.conversationId === conversationId;

    const onAdded = (data: { conversationId?: string; payload?: Scheduled }) => {
      if (!matches(data) || !data.payload) return;
      const it = data.payload;
      setItems((prev) => (prev.some((x) => x.id === it.id) ? prev : [...prev, it].sort(byWhen)));
    };
    const onRemoved = (data: { conversationId?: string; payload?: { id: string } }) => {
      if (!matches(data) || !data.payload) return;
      setItems((prev) => prev.filter((x) => x.id !== data.payload!.id));
    };
    const onUpdated = (data: { conversationId?: string; payload?: Scheduled }) => {
      if (!matches(data) || !data.payload) return;
      const p = data.payload;
      setItems((prev) => prev.map((x) => (x.id === p.id ? { ...x, ...p } : x)));
    };

    socket.on('scheduled.added', onAdded);
    socket.on('scheduled.removed', onRemoved);
    socket.on('scheduled.updated', onUpdated);
    return () => {
      socket.off('scheduled.added', onAdded);
      socket.off('scheduled.removed', onRemoved);
      socket.off('scheduled.updated', onUpdated);
    };
  }, [socket, conversationId]);

  async function cancel(id: string) {
    setItems((prev) => prev.filter((x) => x.id !== id));
    await api(`/api/scheduled/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }

  function dismiss(id: string) {
    setItems((prev) => prev.filter((x) => x.id !== id));
  }

  function startEdit(it: Scheduled) {
    setEditError(null);
    setEditWhen(toLocalInput(new Date(it.scheduledFor)));
    setEditingId(it.id);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditWhen('');
    setEditError(null);
  }

  async function saveEdit(id: string) {
    if (!editWhen) return;
    const when = new Date(editWhen);
    if (when.getTime() <= Date.now() + 30 * 1000) {
      setEditError('Pick a time at least a minute from now.');
      return;
    }
    try {
      const { scheduled } = await api<{ scheduled: Scheduled }>(`/api/scheduled/${id}`, {
        method: 'PATCH',
        body: { scheduledFor: when.toISOString() },
      });
      setItems((prev) => prev.map((x) => (x.id === id ? { ...x, ...scheduled } : x)).sort(byWhen));
      cancelEdit();
    } catch {
      setEditError('Could not reschedule. Try again.');
    }
  }

  if (items.length === 0) return null;

  return (
    <div className="border-t border-black/10 bg-[#f0f2f5] px-4 pt-2">
      <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
        {items.map((it) => {
          const failed = it.status === 'failed';
          const editing = editingId === it.id;
          return (
            <div
              key={it.id}
              className={
                'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ' +
                (failed
                  ? 'border-red-200 bg-red-50'
                  : 'border-brand-link/30 bg-brand-action/10')
              }
            >
              <ClockIcon className={failed ? 'text-red-500' : 'text-brand-link'} />
              {editing ? (
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <input
                      type="datetime-local"
                      value={editWhen}
                      min={toLocalInput(new Date(Date.now() + 60 * 1000))}
                      onChange={(e) => setEditWhen(e.target.value)}
                      className="flex-1 rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-brand-primary focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void saveEdit(it.id)}
                      className="shrink-0 rounded-lg bg-brand-primary px-3 py-1 text-xs font-medium text-white hover:opacity-90"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-ink-muted hover:text-red-600"
                    >
                      Cancel
                    </button>
                  </div>
                  {editError && <div className="mt-1 text-xs text-red-600">{editError}</div>}
                </div>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <div className={'text-xs font-medium ' + (failed ? 'text-red-600' : 'text-brand-primary')}>
                      {failed ? 'Failed to send' : `Scheduled · ${formatWhen(it.scheduledFor)}`}
                    </div>
                    <div className="truncate text-ink-muted">
                      {failed && it.errorMessage ? it.errorMessage : it.body}
                    </div>
                  </div>
                  {!failed && (
                    <button
                      type="button"
                      onClick={() => startEdit(it)}
                      className="shrink-0 rounded-full px-2 text-xs font-medium text-ink-muted hover:text-brand-primary"
                      title="Edit time"
                    >
                      Edit
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => (failed ? dismiss(it.id) : void cancel(it.id))}
                    className="shrink-0 rounded-full px-2 text-xs font-medium text-ink-muted hover:text-red-600"
                    title={failed ? 'Dismiss' : 'Cancel'}
                  >
                    {failed ? 'Dismiss' : 'Cancel'}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function byWhen(a: Scheduled, b: Scheduled): number {
  return new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime();
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={'h-4 w-4 shrink-0 fill-current ' + (className ?? '')}>
      <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm.5-13H11v6l5 3 .75-1.23-4.25-2.52V7z" />
    </svg>
  );
}
