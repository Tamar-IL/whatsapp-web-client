/**
 * Bulk send — one approved template to many chats, with per-contact tokens
 * ({name}, {first}, {phone}) and a live delivery report.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAppData } from './AppData';
import { useRealtime } from './RealtimeProvider';
import { displayName, type ConversationListItem } from './ChatList';
import type { Template } from './TemplateManager';
import { ErrorNote, Field, GhostButton, InfoNote, Modal, PrimaryButton, formatWhen, inputCls } from './ui';

interface Campaign {
  id: string;
  name: string;
  templateName: string;
  status: string;
  createdAt: string;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
}

interface Recipient {
  id: string;
  name: string;
  phone: string;
  status: string;
  error: string | null;
}

export function BulkSendModal({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<'list' | 'new' | { id: string }>('list');
  if (view === 'new') return <NewCampaign onClose={onClose} onBack={() => setView('list')} onCreated={(id) => setView({ id })} />;
  if (typeof view === 'object') return <CampaignReport id={view.id} onClose={onClose} onBack={() => setView('list')} />;
  return <CampaignList onClose={onClose} onNew={() => setView('new')} onOpen={(id) => setView({ id })} />;
}

function CampaignList({ onClose, onNew, onOpen }: { onClose: () => void; onNew: () => void; onOpen: (id: string) => void }) {
  const { socket } = useRealtime();
  const [items, setItems] = useState<Campaign[] | null>(null);
  useEffect(() => {
    const load = () => api<{ campaigns: Campaign[] }>('/api/bulk').then((r) => setItems(r.campaigns)).catch(() => setItems([]));
    void load();
    if (!socket) return;
    socket.on('bulk.progress', load);
    return () => {
      socket.off('bulk.progress', load);
    };
  }, [socket]);
  return (
    <Modal title="Bulk send" subtitle="Send an approved template to many customers at once." onClose={onClose} footer={<PrimaryButton onClick={onNew}>+ New bulk send</PrimaryButton>}>
      {!items && <div className="py-6 text-center text-sm text-ink-muted">Loading…</div>}
      {items && items.length === 0 && <div className="py-8 text-center text-sm text-ink-muted">No bulk sends yet.</div>}
      <ul className="flex flex-col gap-2">
        {items?.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => onOpen(c.id)} className="block w-full rounded-xl border border-gray-200 px-4 py-3 text-left hover:border-brand-primary">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-ink">{c.name}</span>
                <span className="text-[11px] text-ink-muted">{formatWhen(new Date(c.createdAt))}</span>
              </div>
              <div className="mt-0.5 text-xs text-ink-muted">
                {c.templateName} · {c.status === 'running' ? `sending… ${c.sent + c.failed + c.skipped}/${c.total}` : c.status} · ✓ {c.sent} · ✗ {c.failed}
                {c.skipped ? ` · skipped ${c.skipped}` : ''}
              </div>
              <Progress c={c} />
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function Progress({ c }: { c: Campaign }) {
  const pct = (n: number) => `${c.total ? (n / c.total) * 100 : 0}%`;
  return (
    <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-gray-200">
      <div className="bg-brand-action" style={{ width: pct(c.sent) }} />
      <div className="bg-red-400" style={{ width: pct(c.failed) }} />
      <div className="bg-gray-400" style={{ width: pct(c.skipped) }} />
    </div>
  );
}

function NewCampaign({ onClose, onBack, onCreated }: { onClose: () => void; onBack: () => void; onCreated: (id: string) => void }) {
  const { labels, features } = useAppData();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [chats, setChats] = useState<ConversationListItem[] | null>(null);
  const [tplSid, setTplSid] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [labelId, setLabelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ templates: Template[] }>('/api/templates').then((r) => setTemplates(r.templates.filter((t) => t.status === 'approved'))).catch((e: Error) => setError(e.message));
    api<{ conversations: ConversationListItem[] }>('/api/conversations?limit=500').then((r) => setChats(r.conversations)).catch(() => setChats([]));
  }, []);

  const tpl = templates?.find((t) => t.sid === tplSid) ?? null;
  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (chats ?? []).filter(
      (c) =>
        (!labelId || c.labels.some((l) => l.id === labelId)) &&
        (!s || displayName(c).toLowerCase().includes(s) || c.contact.phoneNumber.includes(s)),
    );
  }, [chats, q, labelId]);

  const sample = chats?.find((c) => chosen.has(c.id)) ?? chats?.[0];
  const fill = (v: string) => {
    if (!sample) return v;
    const n = displayName(sample);
    return v.replace(/\{name\}/g, n).replace(/\{first\}/g, n.split(/\s+/)[0] ?? '').replace(/\{phone\}/g, sample.contact.phoneNumber);
  };
  const preview = tpl ? tpl.body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (vars[k] ? fill(vars[k]!) : m)) : '';
  const ready = tpl && chosen.size > 0 && tpl.variables.every((v) => vars[v.key]?.trim()) && name.trim();

  async function send() {
    if (!tpl || !ready) return;
    if (!confirm(`Send “${tpl.friendlyName}” to ${chosen.size} chat${chosen.size > 1 ? 's' : ''}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ campaign: { id: string } }>('/api/bulk', {
        method: 'POST',
        body: { name: name.trim(), contentSid: tpl.sid, variables: vars, conversationIds: [...chosen] },
      });
      onCreated(r.campaign.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function toggleAllVisible() {
    const all = visible.every((c) => chosen.has(c.id));
    setChosen((p) => {
      const n = new Set(p);
      visible.forEach((c) => (all ? n.delete(c.id) : n.add(c.id)));
      return n;
    });
  }

  return (
    <Modal
      title="New bulk send"
      onClose={onClose}
      wide
      footer={
        <>
          <GhostButton onClick={onBack}>Back</GhostButton>
          <PrimaryButton onClick={() => void send()} disabled={!ready || busy}>
            {busy ? 'Starting…' : `Send to ${chosen.size}`}
          </PrimaryButton>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div>
          <Field label="Name (for your report)">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="e.g. Holiday hours notice" />
          </Field>
          <Field label="Template (approved only)">
            <select
              value={tplSid}
              onChange={(e) => {
                setTplSid(e.target.value);
                setVars({});
              }}
              className={inputCls}
            >
              <option value="">— choose —</option>
              {templates?.map((t) => (
                <option key={t.sid} value={t.sid}>
                  {t.friendlyName} ({t.language})
                </option>
              ))}
            </select>
          </Field>
          {templates && templates.length === 0 && <InfoNote tone="warn">No approved templates yet. Create one in Templates.</InfoNote>}
          {tpl && tpl.variables.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-xs font-medium text-ink-muted">
                Fill the fields. Use <span className="font-mono">{'{name}'}</span>, <span className="font-mono">{'{first}'}</span> or{' '}
                <span className="font-mono">{'{phone}'}</span> for each customer’s own details.
              </div>
              {tpl.variables.map((v) => (
                <div key={v.key} className="mb-1.5 flex items-center gap-2">
                  <span className="w-10 text-xs text-ink-muted">{`{{${v.key}}}`}</span>
                  <input value={vars[v.key] ?? ''} placeholder={v.example} onChange={(e) => setVars({ ...vars, [v.key]: e.target.value })} className={inputCls} />
                </div>
              ))}
            </div>
          )}
          {tpl && (
            <>
              <div className="mb-1 text-xs font-medium text-ink-muted">Preview{sample ? ` for ${displayName(sample)}` : ''}</div>
              <div className="whitespace-pre-wrap rounded-xl bg-chat-out px-3 py-2 text-sm text-ink">{preview}</div>
            </>
          )}
        </div>
        <div>
          <div className="mb-2 flex gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className={inputCls} />
            {features.labels && labels.length > 0 && (
              <select value={labelId} onChange={(e) => setLabelId(e.target.value)} className={inputCls + ' w-36'}>
                <option value="">All labels</option>
                {labels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="mb-1 flex items-center justify-between text-xs text-ink-muted">
            <button type="button" onClick={toggleAllVisible} className="text-brand-link hover:underline">
              {visible.length && visible.every((c) => chosen.has(c.id)) ? 'Unselect shown' : `Select shown (${visible.length})`}
            </button>
            <span>{chosen.size} selected</span>
          </div>
          <ul className="scroll-thin max-h-80 overflow-y-auto rounded-xl border border-gray-200">
            {!chats && <li className="p-3 text-sm text-ink-muted">Loading…</li>}
            {visible.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-2.5 border-b border-gray-100 px-3 py-1.5 hover:bg-black/5">
                  <input
                    type="checkbox"
                    checked={chosen.has(c.id)}
                    onChange={() =>
                      setChosen((p) => {
                        const n = new Set(p);
                        if (n.has(c.id)) n.delete(c.id);
                        else n.add(c.id);
                        return n;
                      })
                    }
                    className="h-4 w-4 accent-[#128C7E]"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{displayName(c)}</span>
                  <span className="text-[11px] text-ink-muted" dir="ltr">
                    {c.contact.phoneNumber}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <InfoNote>Opted-out customers are skipped automatically. Messages go out about one per second.</InfoNote>
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
    </Modal>
  );
}

function CampaignReport({ id, onClose, onBack }: { id: string; onClose: () => void; onBack: () => void }) {
  const { socket } = useRealtime();
  const [c, setC] = useState<Campaign | null>(null);
  const [rows, setRows] = useState<Recipient[]>([]);
  useEffect(() => {
    const load = () =>
      api<{ campaign: Campaign; recipients: Recipient[] }>(`/api/bulk/${id}`)
        .then((r) => {
          setC(r.campaign);
          setRows(r.recipients);
        })
        .catch(() => undefined);
    void load();
    if (!socket) return;
    socket.on('bulk.progress', load);
    return () => {
      socket.off('bulk.progress', load);
    };
  }, [id, socket]);

  async function cancel() {
    if (!confirm('Stop sending to the remaining recipients?')) return;
    await api(`/api/bulk/${id}/cancel`, { method: 'POST' }).catch(() => undefined);
  }

  return (
    <Modal
      title={c?.name ?? 'Bulk send'}
      subtitle={c ? `${c.templateName} · ${c.status}` : undefined}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onBack}>Back</GhostButton>
          {c?.status === 'running' && (
            <GhostButton danger onClick={() => void cancel()}>
              Stop
            </GhostButton>
          )}
        </>
      }
    >
      {c && (
        <>
          <div className="grid grid-cols-4 gap-2 text-center">
            {[
              ['Sent', c.sent, 'text-brand-primary'],
              ['Failed', c.failed, 'text-red-600'],
              ['Skipped', c.skipped, 'text-ink-muted'],
              ['Waiting', c.pending, 'text-amber-700'],
            ].map(([l, n, cls]) => (
              <div key={String(l)} className="rounded-xl bg-black/[0.03] py-2">
                <div className={'text-lg font-semibold ' + cls}>{n}</div>
                <div className="text-[11px] text-ink-muted">{l}</div>
              </div>
            ))}
          </div>
          <Progress c={c} />
        </>
      )}
      <ul className="mt-3 flex flex-col">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between border-b border-gray-100 py-1.5 text-sm">
            <span className="min-w-0 truncate text-ink">{r.name}</span>
            <span
              className={
                'shrink-0 text-xs ' +
                (r.status === 'sent' ? 'text-brand-primary' : r.status === 'failed' ? 'text-red-600' : r.status === 'skipped' ? 'text-ink-muted' : 'text-amber-700')
              }
              title={r.error ?? undefined}
            >
              {r.status}
              {r.error ? ` — ${r.error}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
