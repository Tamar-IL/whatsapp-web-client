/**
 * Settings → AI actions: what the AI may look up or do on its own —
 * a MailerLite account, or any HTTP endpoint (your order system, a calendar,
 * a Make.com / Zapier webhook…). Each action has a Test button.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAppData } from './AppData';
import { useRealtime } from './RealtimeProvider';
import { ErrorNote, Field, GhostButton, InfoNote, PrimaryButton, Toggle, inputCls } from './ui';

const MASK = '••••••••';

interface HttpParam {
  name: string;
  description: string;
  required: boolean;
}

interface Action {
  id: string;
  name: string;
  title: string;
  description: string;
  kind: 'http' | 'mailerlite';
  enabled: boolean;
  allowInCustomerChats: boolean;
  config: {
    apiKey?: string;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url?: string;
    headers?: Record<string, string>;
    body?: string;
    params?: HttpParam[];
  };
  functions: string[];
}

type Draft = Omit<Action, 'id' | 'functions'> & { id?: string; headerRows: Array<{ k: string; v: string }> };

const NEW_MAILERLITE: Draft = {
  name: 'mailerlite',
  title: 'MailerLite',
  description: '',
  kind: 'mailerlite',
  enabled: true,
  allowInCustomerChats: false,
  config: { apiKey: '' },
  headerRows: [],
};

const NEW_HTTP: Draft = {
  name: 'order_status',
  title: 'Order status',
  description: 'Look up the status of a customer order by its number.',
  kind: 'http',
  enabled: true,
  allowInCustomerChats: false,
  config: {
    method: 'GET',
    url: 'https://example.com/api/orders/{order_number}',
    body: '',
    params: [{ name: 'order_number', description: 'The order number the customer gave', required: true }],
  },
  headerRows: [{ k: 'Authorization', v: 'Bearer …' }],
};

function toDraft(a: Action): Draft {
  return { ...a, headerRows: Object.entries(a.config.headers ?? {}).map(([k, v]) => ({ k, v })) };
}

export function ActionsTab() {
  const { socket } = useRealtime();
  const [actions, setActions] = useState<Action[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ actions: Action[] }>('/api/ai/actions')
      .then((r) => setActions(r.actions))
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!socket) return;
    const h = (d: { payload?: { kind?: string } }) => d.payload?.kind === 'aiActions' && load();
    socket.on('library.changed', h);
    return () => {
      socket.off('library.changed', h);
    };
  }, [socket, load]);

  if (draft) return <ActionEditor draft={draft} onDone={() => { setDraft(null); load(); }} />;

  return (
    <div>
      <p className="mb-2 text-xs text-ink-muted">
        Actions let the AI look things up before it answers — e.g. ask <b>Ask AI</b> “what was the open rate of the last
        newsletter?” and it checks MailerLite. Each action can also be allowed in customer chats (e.g. order status).
      </p>
      <InfoNote tone="warn">
        Customers can write anything. Allow in customer chats only actions that are safe for a customer to trigger —
        look-ups, not actions that change or delete data.
      </InfoNote>
      <div className="mb-4 mt-3 flex flex-wrap gap-2">
        <PrimaryButton small onClick={() => setDraft({ ...NEW_MAILERLITE })}>
          + MailerLite
        </PrimaryButton>
        <PrimaryButton small onClick={() => setDraft({ ...NEW_HTTP, config: { ...NEW_HTTP.config, params: [...(NEW_HTTP.config.params ?? [])] } })}>
          + Custom (HTTP / webhook)
        </PrimaryButton>
      </div>
      <ErrorNote>{error}</ErrorNote>
      {!actions && !error && <div className="text-sm text-ink-muted">Loading…</div>}
      {actions && actions.length === 0 && <div className="text-sm text-ink-muted">No actions yet.</div>}
      <ul className="flex flex-col gap-2">
        {actions?.map((a) => (
          <li key={a.id} className="rounded-xl border border-gray-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className={'h-2.5 w-2.5 rounded-full ' + (a.enabled ? 'bg-brand-action' : 'bg-gray-300')} />
              <span className="text-sm font-medium text-ink">{a.title}</span>
              <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase text-ink-muted">{a.kind === 'mailerlite' ? 'MailerLite' : a.config.method}</span>
              <span className="ml-auto text-[11px] text-ink-muted">{a.allowInCustomerChats ? 'Ask AI + customer chats' : 'Ask AI only'}</span>
            </div>
            {a.description && <div className="mt-1 text-xs text-ink-muted">{a.description}</div>}
            <div className="mt-1 font-mono text-[10px] text-ink-muted" dir="ltr">
              {a.functions.join(', ')}
            </div>
            <div className="mt-2 flex gap-1">
              <GhostButton small onClick={() => setDraft(toDraft(a))}>
                Edit / test
              </GhostButton>
              <GhostButton
                small
                danger
                onClick={() => confirm(`Delete the action “${a.title}”?`) && void api(`/api/ai/actions/${a.id}`, { method: 'DELETE' }).then(load)}
              >
                Delete
              </GhostButton>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActionEditor({ draft: initial, onDone }: { draft: Draft; onDone: () => void }) {
  const { toast } = useAppData();
  const [d, setD] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testArgs, setTestArgs] = useState<Record<string, string>>({});
  const [testFn, setTestFn] = useState<string>('');
  const [testOut, setTestOut] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const isMl = d.kind === 'mailerlite';
  const params = d.config.params ?? [];
  const setCfg = (patch: Partial<Draft['config']>) => setD((p) => ({ ...p, config: { ...p.config, ...patch } }));

  function payload() {
    const config = isMl
      ? { apiKey: d.config.apiKey ?? '' }
      : {
          method: d.config.method ?? 'GET',
          url: d.config.url ?? '',
          headers: Object.fromEntries(d.headerRows.filter((h) => h.k.trim()).map((h) => [h.k.trim(), h.v])),
          body: d.config.body ?? '',
          params: params.filter((p) => p.name.trim()),
        };
    return { name: d.name, title: d.title, description: d.description, kind: d.kind, enabled: d.enabled, allowInCustomerChats: d.allowInCustomerChats, config };
  }

  async function save(): Promise<string | null> {
    setSaving(true);
    setError(null);
    try {
      const r = d.id
        ? await api<{ action: Action }>(`/api/ai/actions/${d.id}`, { method: 'PUT', body: payload() })
        : await api<{ action: Action }>('/api/ai/actions', { method: 'POST', body: payload() });
      setD(toDraft(r.action));
      toast('Action saved', 'ok');
      return r.action.id;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    const id = await save();
    if (!id) return;
    setTesting(true);
    setTestOut(null);
    try {
      const fn = isMl ? testFn || `${d.name}__campaigns` : undefined;
      const r = await api<{ ok: boolean; result?: string; error?: string }>(`/api/ai/actions/${id}/test`, {
        method: 'POST',
        body: { fn, args: testArgs },
      });
      setTestOut({ ok: r.ok, text: r.ok ? r.result ?? '' : r.error ?? 'Failed' });
    } catch (e) {
      setTestOut({ ok: false, text: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={onDone} className="mb-3 text-xs text-brand-link hover:underline">
        ← All actions
      </button>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Title">
          <input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Name the AI sees" hint="lowercase_with_underscores">
          <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} className={inputCls} dir="ltr" />
        </Field>
      </div>
      <Field label="When should the AI use it?" hint="The AI decides from this description — be specific.">
        <textarea value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} rows={2} className={inputCls + ' resize-y'} />
      </Field>

      {isMl ? (
        <Field label="MailerLite API key" hint="MailerLite → Integrations → API → Generate new token. Read access is enough.">
          <input
            type="password"
            value={d.config.apiKey ?? ''}
            onFocus={() => d.config.apiKey === MASK && setCfg({ apiKey: '' })}
            onChange={(e) => setCfg({ apiKey: e.target.value })}
            placeholder={initial.config.apiKey === MASK ? 'Saved — type to replace' : ''}
            className={inputCls}
            dir="ltr"
            autoComplete="off"
          />
        </Field>
      ) : (
        <>
          <div className="grid grid-cols-[110px_1fr] gap-2">
            <Field label="Method">
              <select value={d.config.method} onChange={(e) => setCfg({ method: e.target.value as Draft['config']['method'] })} className={inputCls}>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label="URL" hint="Use {name} for parameters, e.g. …/orders/{order_number}">
              <input value={d.config.url ?? ''} onChange={(e) => setCfg({ url: e.target.value })} className={inputCls} dir="ltr" />
            </Field>
          </div>
          <div className="mb-1 text-xs font-medium text-ink-muted">Parameters the AI fills in</div>
          {params.map((p, i) => (
            <div key={i} className="mb-1.5 flex items-center gap-1.5">
              <input
                value={p.name}
                placeholder="name"
                onChange={(e) => setCfg({ params: params.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_') } : x)) })}
                className={inputCls + ' w-36'}
                dir="ltr"
              />
              <input
                value={p.description}
                placeholder="What it is"
                onChange={(e) => setCfg({ params: params.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })}
                className={inputCls}
              />
              <label className="flex shrink-0 items-center gap-1 text-[11px] text-ink-muted">
                <input
                  type="checkbox"
                  checked={p.required}
                  onChange={(e) => setCfg({ params: params.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })}
                  className="accent-[#128C7E]"
                />
                required
              </label>
              <button type="button" className="px-1 text-lg text-ink-muted hover:text-red-600" onClick={() => setCfg({ params: params.filter((_, j) => j !== i) })}>
                ×
              </button>
            </div>
          ))}
          <GhostButton small onClick={() => setCfg({ params: [...params, { name: '', description: '', required: true }] })}>
            + Parameter
          </GhostButton>
          <div className="mb-1 mt-3 text-xs font-medium text-ink-muted">Headers (e.g. API key) — stored on the server, never shown to the AI</div>
          {d.headerRows.map((h, i) => (
            <div key={i} className="mb-1.5 flex items-center gap-1.5">
              <input value={h.k} placeholder="Header" onChange={(e) => setD({ ...d, headerRows: d.headerRows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)) })} className={inputCls + ' w-44'} dir="ltr" />
              <input
                value={h.v}
                placeholder="Value"
                onFocus={() => h.v === MASK && setD({ ...d, headerRows: d.headerRows.map((x, j) => (j === i ? { ...x, v: '' } : x)) })}
                onChange={(e) => setD({ ...d, headerRows: d.headerRows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)) })}
                className={inputCls}
                dir="ltr"
              />
              <button type="button" className="px-1 text-lg text-ink-muted hover:text-red-600" onClick={() => setD({ ...d, headerRows: d.headerRows.filter((_, j) => j !== i) })}>
                ×
              </button>
            </div>
          ))}
          <GhostButton small onClick={() => setD({ ...d, headerRows: [...d.headerRows, { k: '', v: '' }] })}>
            + Header
          </GhostButton>
          {d.config.method !== 'GET' && d.config.method !== 'DELETE' && (
            <div className="mt-3">
              <Field label="JSON body" hint='Use {name} inside quotes, e.g. {"phone": "{phone}"}'>
                <textarea value={d.config.body ?? ''} onChange={(e) => setCfg({ body: e.target.value })} rows={3} className={inputCls + ' font-mono text-xs'} dir="ltr" />
              </Field>
            </div>
          )}
        </>
      )}

      <div className="mt-3">
        <Toggle checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label="Enabled" />
        <Toggle
          checked={d.allowInCustomerChats}
          onChange={(v) => setD({ ...d, allowInCustomerChats: v })}
          label="Allow in customer chats"
          hint="Off = only you can use it, through Ask AI."
        />
      </div>

      <div className="mt-4 rounded-xl border border-gray-200 p-3">
        <div className="mb-2 text-xs font-medium text-ink-muted">Test it now (saves first)</div>
        {isMl ? (
          <select value={testFn || `${d.name}__campaigns`} onChange={(e) => setTestFn(e.target.value)} className={inputCls + ' mb-2'}>
            <option value={`${d.name}__campaigns`}>Recent campaigns + open rates</option>
            <option value={`${d.name}__groups`}>Groups</option>
            <option value={`${d.name}__subscriber`}>Find subscriber (email)</option>
          </select>
        ) : null}
        {(isMl ? (testFn === `${d.name}__subscriber` ? [{ name: 'email', description: 'email' }] : []) : params.filter((p) => p.name)).map((p) => (
          <input
            key={p.name}
            value={testArgs[p.name] ?? ''}
            placeholder={p.name}
            onChange={(e) => setTestArgs({ ...testArgs, [p.name]: e.target.value })}
            className={inputCls + ' mb-1.5'}
            dir="ltr"
          />
        ))}
        <GhostButton small onClick={() => void test()} disabled={testing || saving}>
          {testing ? 'Running…' : '▶ Run test'}
        </GhostButton>
        {testOut && (
          <pre
            className={'scroll-thin mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg p-2 text-[11px] ' + (testOut.ok ? 'bg-black/[0.04] text-ink' : 'bg-red-50 text-red-700')}
            dir="ltr"
          >
            {testOut.text || '(empty response)'}
          </pre>
        )}
      </div>

      <ErrorNote>{error}</ErrorNote>
      <div className="mt-3 flex justify-end gap-2">
        <GhostButton onClick={onDone}>Close</GhostButton>
        <PrimaryButton onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </PrimaryButton>
      </div>
    </div>
  );
}
