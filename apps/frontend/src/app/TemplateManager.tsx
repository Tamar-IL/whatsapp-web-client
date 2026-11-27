/**
 * Template manager — every WhatsApp template with its Meta status
 * (approved / pending / rejected + reason), filters, copy, duplicate, delete,
 * submit for approval, and a form to create new ones.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAppData } from './AppData';
import { ErrorNote, Field, GhostButton, InfoNote, Modal, PrimaryButton, copyText, formatWhen, inputCls } from './ui';
import { useRealtime } from './RealtimeProvider';

export interface Template {
  sid: string;
  friendlyName: string;
  language: string;
  body: string;
  variables: Array<{ key: string; example: string }>;
  category: string | null;
  status: string;
  rejectionReason: string | null;
  approvalName: string | null;
  kind: string;
  actions: Array<{ type: string; title: string; value?: string }>;
  createdAt: string | null;
  updatedAt: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  approved: 'bg-green-100 text-green-800',
  pending: 'bg-amber-100 text-amber-800',
  received: 'bg-amber-100 text-amber-800',
  rejected: 'bg-red-100 text-red-700',
  paused: 'bg-gray-200 text-gray-700',
  disabled: 'bg-gray-200 text-gray-700',
  unsubmitted: 'bg-gray-100 text-ink-muted',
};

type StatusFilter = 'all' | 'approved' | 'pending' | 'rejected' | 'unsubmitted';

interface Draft {
  friendlyName: string;
  language: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  body: string;
  variables: Record<string, string>;
  buttonKind: 'none' | 'quick' | 'cta';
  actions: Array<{ type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER'; title: string; value?: string }>;
  submit: boolean;
}

const EMPTY: Draft = {
  friendlyName: '',
  language: 'he',
  category: 'UTILITY',
  body: '',
  variables: {},
  buttonKind: 'none',
  actions: [],
  submit: true,
};

export function TemplateManager({ onClose }: { onClose: () => void }) {
  const { toast } = useAppData();
  const { socket } = useRealtime();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [category, setCategory] = useState('all');
  const [language, setLanguage] = useState('all');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [submitFor, setSubmitFor] = useState<Template | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setRefreshing(true);
    try {
      const r = await api<{ templates: Template[] }>(`/api/templates${refresh ? '?refresh=1' : ''}`);
      setTemplates(r.templates);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const h = () => void load();
    socket.on('template.status', h);
    return () => {
      socket.off('template.status', h);
    };
  }, [socket, load]);

  const languages = useMemo(() => [...new Set((templates ?? []).map((t) => t.language))].sort(), [templates]);
  const categories = useMemo(() => [...new Set((templates ?? []).map((t) => t.category).filter(Boolean) as string[])].sort(), [templates]);

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (templates ?? [])
      .filter((t) => {
        if (status !== 'all') {
          const st = t.status === 'received' ? 'pending' : t.status;
          if (st !== status) return false;
        }
        if (category !== 'all' && t.category !== category) return false;
        if (language !== 'all' && t.language !== language) return false;
        return !s || t.friendlyName.toLowerCase().includes(s) || t.body.toLowerCase().includes(s);
      })
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, [templates, q, status, category, language]);

  function duplicate(t: Template) {
    const quick = t.actions.filter((a) => a.type === 'QUICK_REPLY' || !a.value || a.value.startsWith('btn_'));
    const cta = t.actions.filter((a) => a.type === 'URL' || a.type === 'PHONE_NUMBER');
    setDraft({
      friendlyName: `${t.friendlyName}_copy`,
      language: t.language,
      category: (t.category?.toUpperCase() as Draft['category']) || 'UTILITY',
      body: t.body,
      variables: Object.fromEntries(t.variables.map((v) => [v.key, v.example])),
      buttonKind: cta.length ? 'cta' : quick.length ? 'quick' : 'none',
      actions: cta.length
        ? cta.map((a) => ({ type: a.type as 'URL' | 'PHONE_NUMBER', title: a.title, value: a.value }))
        : quick.map((a) => ({ type: 'QUICK_REPLY' as const, title: a.title })),
      submit: true,
    });
  }

  async function remove(t: Template) {
    if (!confirm(`Delete “${t.friendlyName}” from Twilio? This cannot be undone.`)) return;
    try {
      await api(`/api/templates/${t.sid}`, { method: 'DELETE' });
      toast('Template deleted', 'ok');
      void load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  if (draft) return <TemplateEditor draft={draft} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); void load(true); }} />;

  const counts = (st: StatusFilter) =>
    (templates ?? []).filter((t) => st === 'all' || (t.status === 'received' ? 'pending' : t.status) === st).length;

  return (
    <Modal
      title="Templates"
      subtitle="Message templates approved by WhatsApp — the only way to write first or after 24 hours."
      onClose={onClose}
      wide
      footer={
        <>
          <GhostButton onClick={() => void load(true)} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : '⟳ Refresh status'}
          </GhostButton>
          <PrimaryButton onClick={() => setDraft({ ...EMPTY })}>+ New template</PrimaryButton>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or text" className={inputCls + ' max-w-xs'} />
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls + ' w-auto'}>
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={language} onChange={(e) => setLanguage(e.target.value)} className={inputCls + ' w-auto'}>
          <option value="all">All languages</option>
          {languages.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {(['all', 'approved', 'pending', 'rejected', 'unsubmitted'] as StatusFilter[]).map((st) => (
          <button
            key={st}
            type="button"
            onClick={() => setStatus(st)}
            className={
              'rounded-full px-3 py-1 text-xs font-medium capitalize ' +
              (status === st ? 'bg-brand-action/20 text-brand-primary' : 'bg-black/5 text-ink-muted hover:bg-black/10')
            }
          >
            {st === 'unsubmitted' ? 'Not submitted' : st} ({counts(st)})
          </button>
        ))}
      </div>
      <ErrorNote>{error}</ErrorNote>
      {!templates && !error && <div className="py-8 text-center text-sm text-ink-muted">Loading templates…</div>}
      {templates && visible.length === 0 && <div className="py-8 text-center text-sm text-ink-muted">No templates here.</div>}
      <ul className="flex flex-col gap-2">
        {visible.map((t) => (
          <li key={t.sid} className="rounded-xl border border-gray-200 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-ink">{t.friendlyName}</span>
              <span className={'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ' + (STATUS_STYLE[t.status] ?? 'bg-gray-100 text-ink-muted')}>
                {t.status === 'unsubmitted' ? 'not submitted' : t.status}
              </span>
              <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase text-ink-muted">{t.language}</span>
              {t.category && <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase text-ink-muted">{t.category}</span>}
              <span className="text-[10px] text-ink-muted">{t.kind}</span>
              {t.updatedAt && <span className="ml-auto text-[11px] text-ink-muted">{formatWhen(new Date(t.updatedAt))}</span>}
            </div>
            <div className="mt-1.5 whitespace-pre-wrap rounded-lg bg-chat-out/60 px-3 py-2 text-sm text-ink">{t.body}</div>
            {t.actions.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {t.actions.map((a, i) => (
                  <span key={i} className="rounded-full border border-brand-link/40 px-2 py-0.5 text-xs text-brand-link">
                    {a.type === 'URL' ? '🔗 ' : a.type === 'PHONE_NUMBER' ? '📞 ' : ''}
                    {a.title}
                  </span>
                ))}
              </div>
            )}
            {t.status === 'rejected' && t.rejectionReason && <InfoNote tone="warn">Rejected: {t.rejectionReason}</InfoNote>}
            <div className="mt-2 flex flex-wrap gap-1">
              <GhostButton small onClick={() => void copyText(t.body).then((ok) => toast(ok ? 'Text copied' : 'Could not copy', ok ? 'ok' : 'error'))}>
                ⧉ Copy text
              </GhostButton>
              <GhostButton small onClick={() => duplicate(t)}>
                ⎘ Duplicate
              </GhostButton>
              {(t.status === 'unsubmitted' || t.status === 'rejected') && (
                <GhostButton small onClick={() => setSubmitFor(t)}>
                  ➤ Submit for approval
                </GhostButton>
              )}
              <GhostButton small danger onClick={() => void remove(t)}>
                🗑 Delete
              </GhostButton>
            </div>
          </li>
        ))}
      </ul>
      {submitFor && <SubmitDialog t={submitFor} onClose={() => setSubmitFor(null)} onDone={() => { setSubmitFor(null); void load(true); }} />}
    </Modal>
  );
}

function SubmitDialog({ t, onClose, onDone }: { t: Template; onClose: () => void; onDone: () => void }) {
  const { toast } = useAppData();
  const [cat, setCat] = useState<'UTILITY' | 'MARKETING' | 'AUTHENTICATION'>('UTILITY');
  const [name, setName] = useState(t.friendlyName.toLowerCase().replace(/[^a-z0-9_]+/g, '_'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/templates/${t.sid}/submit`, { method: 'POST', body: { name, category: cat } });
      toast('Submitted to WhatsApp — usually decided within minutes to a few hours.', 'ok');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Submit for approval"
      subtitle={t.friendlyName}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={() => void go()} disabled={busy || !name}>
            {busy ? 'Submitting…' : 'Submit'}
          </PrimaryButton>
        </>
      }
    >
      <Field label="WhatsApp template name" hint="Lowercase letters, digits and _ only.">
        <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} className={inputCls} dir="ltr" />
      </Field>
      <CategoryField value={cat} onChange={setCat} />
      <ErrorNote>{error}</ErrorNote>
    </Modal>
  );
}

function CategoryField({ value, onChange }: { value: Draft['category']; onChange: (v: Draft['category']) => void }) {
  return (
    <Field label="Category" hint="Utility = updates about an existing order/appointment. Marketing = offers and promotions. Authentication = one-time codes.">
      <select value={value} onChange={(e) => onChange(e.target.value as Draft['category'])} className={inputCls}>
        <option value="UTILITY">Utility</option>
        <option value="MARKETING">Marketing</option>
        <option value="AUTHENTICATION">Authentication</option>
      </select>
    </Field>
  );
}

function TemplateEditor({ draft: initial, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: () => void }) {
  const { toast } = useAppData();
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const placeholders = useMemo(() => [...new Set([...d.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => m[1]!))].sort((a, b) => Number(a) - Number(b)), [d.body]);
  const nextVar = String((placeholders.map(Number).reduce((a, b) => Math.max(a, b), 0) || 0) + 1);
  const preview = d.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, k: string) => d.variables[k]?.trim() || m);

  function setAction(i: number, patch: Partial<Draft['actions'][number]>) {
    setD((p) => ({ ...p, actions: p.actions.map((a, idx) => (idx === i ? { ...a, ...patch } : a)) }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ sid: string; submitted: boolean; submitError: string | null }>('/api/templates', {
        method: 'POST',
        body: {
          friendlyName: d.friendlyName,
          language: d.language,
          category: d.category,
          body: d.body,
          variables: Object.fromEntries(placeholders.map((k) => [k, d.variables[k] ?? ''])),
          actions: d.buttonKind === 'none' ? [] : d.actions.filter((a) => a.title.trim()),
          submit: d.submit,
        },
      });
      if (r.submitError) toast(`Template created, but submitting failed: ${r.submitError}`, 'warn');
      else toast(r.submitted ? 'Template created and submitted for approval' : 'Template created', 'ok');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const maxButtons = d.buttonKind === 'quick' ? 10 : 2;

  return (
    <Modal
      title="New template"
      subtitle="Write it, give an example for each {{variable}}, and submit to WhatsApp."
      onClose={onClose}
      wide
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={() => void save()} disabled={busy || !d.friendlyName.trim() || !d.body.trim()}>
            {busy ? 'Saving…' : d.submit ? 'Create & submit' : 'Create'}
          </PrimaryButton>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <input value={d.friendlyName} onChange={(e) => setD({ ...d, friendlyName: e.target.value })} className={inputCls} placeholder="order_ready" />
            </Field>
            <Field label="Language">
              <select value={d.language} onChange={(e) => setD({ ...d, language: e.target.value })} className={inputCls}>
                <option value="he">Hebrew (he)</option>
                <option value="en">English (en)</option>
                <option value="en_US">English US (en_US)</option>
                <option value="ar">Arabic (ar)</option>
                <option value="ru">Russian (ru)</option>
                <option value="yi">Yiddish (yi)</option>
                <option value="fr">French (fr)</option>
              </select>
            </Field>
          </div>
          <CategoryField value={d.category} onChange={(v) => setD({ ...d, category: v })} />
          <Field label={`Text (${d.body.length}/1024)`} hint="Use {{1}}, {{2}}… where details change for each customer.">
            <textarea value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} rows={6} maxLength={1024} className={inputCls + ' resize-y'} />
          </Field>
          <GhostButton small onClick={() => setD({ ...d, body: `${d.body}{{${nextVar}}}` })}>
            + Insert {`{{${nextVar}}}`}
          </GhostButton>
          {placeholders.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-xs font-medium text-ink-muted">Example values (Meta reviews the template with these)</div>
              {placeholders.map((k) => (
                <div key={k} className="mb-1.5 flex items-center gap-2">
                  <span className="w-10 text-xs text-ink-muted">{`{{${k}}}`}</span>
                  <input value={d.variables[k] ?? ''} onChange={(e) => setD({ ...d, variables: { ...d.variables, [k]: e.target.value } })} className={inputCls} />
                </div>
              ))}
            </div>
          )}
          <div className="mt-3">
            <Field label="Buttons">
              <select
                value={d.buttonKind}
                onChange={(e) => {
                  const k = e.target.value as Draft['buttonKind'];
                  setD({ ...d, buttonKind: k, actions: k === 'none' ? [] : k === 'quick' ? [{ type: 'QUICK_REPLY', title: '' }] : [{ type: 'URL', title: '', value: '' }] });
                }}
                className={inputCls}
              >
                <option value="none">No buttons</option>
                <option value="quick">Quick replies (customer taps an answer)</option>
                <option value="cta">Link / phone call buttons</option>
              </select>
            </Field>
            {d.buttonKind !== 'none' &&
              d.actions.map((a, i) => (
                <div key={i} className="mb-1.5 flex items-center gap-1.5">
                  {d.buttonKind === 'cta' && (
                    <select value={a.type} onChange={(e) => setAction(i, { type: e.target.value as 'URL' | 'PHONE_NUMBER' })} className={inputCls + ' w-28'}>
                      <option value="URL">Link</option>
                      <option value="PHONE_NUMBER">Call</option>
                    </select>
                  )}
                  <input value={a.title} maxLength={25} placeholder="Button text" onChange={(e) => setAction(i, { title: e.target.value })} className={inputCls} />
                  {d.buttonKind === 'cta' && (
                    <input value={a.value ?? ''} placeholder={a.type === 'URL' ? 'https://…' : '+972…'} onChange={(e) => setAction(i, { value: e.target.value })} className={inputCls} dir="ltr" />
                  )}
                  <button type="button" onClick={() => setD({ ...d, actions: d.actions.filter((_, x) => x !== i) })} className="px-1 text-lg text-ink-muted hover:text-red-600">
                    ×
                  </button>
                </div>
              ))}
            {d.buttonKind !== 'none' && d.actions.length < maxButtons && (
              <GhostButton small onClick={() => setD({ ...d, actions: [...d.actions, d.buttonKind === 'quick' ? { type: 'QUICK_REPLY', title: '' } : { type: 'URL', title: '', value: '' }] })}>
                + Add button
              </GhostButton>
            )}
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={d.submit} onChange={(e) => setD({ ...d, submit: e.target.checked })} className="h-4 w-4 accent-[#128C7E]" />
            Submit to WhatsApp for approval right away
          </label>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-ink-muted">Preview</div>
          <div className="chat-canvas rounded-xl p-4">
            <div className="max-w-[90%] rounded-lg rounded-tr-none bg-chat-out px-3 py-2 text-sm text-ink shadow-sm">
              <div className="whitespace-pre-wrap break-words">{preview || 'Your message…'}</div>
              {d.buttonKind !== 'none' && d.actions.some((a) => a.title.trim()) && (
                <div className="-mx-3 -mb-2 mt-2 border-t border-black/10">
                  {d.actions
                    .filter((a) => a.title.trim())
                    .map((a, i) => (
                      <div key={i} className={'px-3 py-1.5 text-center text-sm font-medium text-brand-link ' + (i ? 'border-t border-black/10' : '')}>
                        {a.type === 'URL' ? '🔗 ' : a.type === 'PHONE_NUMBER' ? '📞 ' : ''}
                        {a.title}
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>
          <InfoNote>Approval usually takes minutes to a few hours. You’ll get a notice here when WhatsApp decides.</InfoNote>
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
    </Modal>
  );
}
