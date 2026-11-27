/**
 * Settings — every optional feature can be switched on/off here, plus the
 * engines (away message, AI agent), labels, saved replies, contacts
 * import/export and the WhatsApp Business profile.
 */
import { useEffect, useRef, useState } from 'react';
import { api, apiUpload } from '../api/client';
import { useAppData, type Features, type Settings, type DayHours } from './AppData';
import { ColorRow, LABEL_COLORS } from './LabelPicker';
import { ErrorNote, Field, GhostButton, InfoNote, Modal, PrimaryButton, Toggle, inputCls } from './ui';

type Tab = 'features' | 'hours' | 'away' | 'ai' | 'labels' | 'replies' | 'contacts' | 'profile';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'features', label: 'Features' },
  { key: 'hours', label: 'Business hours' },
  { key: 'away', label: 'Away message' },
  { key: 'ai', label: 'AI agent' },
  { key: 'labels', label: 'Labels' },
  { key: 'replies', label: 'Saved replies' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'profile', label: 'WhatsApp profile' },
];

export function SettingsModal({ onClose, initialTab = 'features' }: { onClose: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const { settings } = useAppData();
  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="flex min-h-[60vh] gap-5">
        <nav className="flex w-40 shrink-0 flex-col gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={
                'rounded-lg px-3 py-2 text-left text-sm transition ' +
                (tab === t.key ? 'bg-brand-action/15 font-medium text-brand-primary' : 'text-ink hover:bg-black/5')
              }
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {!settings ? (
            <div className="py-10 text-center text-sm text-ink-muted">Loading…</div>
          ) : (
            <>
              {tab === 'features' && <FeaturesTab />}
              {tab === 'hours' && <HoursTab />}
              {tab === 'away' && <AwayTab />}
              {tab === 'ai' && <AiTab />}
              {tab === 'labels' && <LabelsTab />}
              {tab === 'replies' && <RepliesTab />}
              {tab === 'contacts' && <ContactsTab />}
              {tab === 'profile' && <ProfileTab />}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-brand-link first:mt-0">{children}</h3>;
}

/** Save-on-change helper for a settings section. */
function useSave() {
  const { saveSettings, toast } = useAppData();
  return async (patch: unknown) => {
    try {
      await saveSettings(patch);
    } catch (e) {
      toast((e as Error).message || 'Could not save.', 'error');
    }
  };
}

// ===== Features =====

const FEATURE_GROUPS: Array<{ title: string; items: Array<[keyof Features, string, string?]> }> = [
  {
    title: 'Chat list',
    items: [
      ['avatars', 'Contact photos & coloured avatars'],
      ['lastMessagePreview', 'Last-message preview'],
      ['pinChats', 'Pin chats to the top'],
      ['archive', 'Archive chats'],
      ['markUnread', 'Mark as unread'],
      ['labels', 'Labels & label filters'],
    ],
  },
  {
    title: 'Messages',
    items: [
      ['pinMessages', 'Pin messages in a chat'],
      ['starMessages', 'Star messages'],
      ['forward', 'Forward messages'],
      ['copyMessage', 'Copy message text'],
      ['searchInChat', 'Search inside a chat'],
      ['retryFailed', 'Retry failed messages'],
      ['playbackSpeed', 'Voice message speed (1× / 1.5× / 2×)'],
    ],
  },
  {
    title: 'Writing',
    items: [
      ['savedReplies', 'Saved replies with “/”'],
      ['scheduleMedia', 'Schedule files, not only text'],
      ['windowTimer', 'Show time left in the 24-hour window'],
    ],
  },
  {
    title: 'Tools',
    items: [
      ['contactNotes', 'Contact notes & email'],
      ['exportChat', 'Export chat (text / PDF)'],
      ['templateManager', 'Template manager'],
      ['bulkSend', 'Bulk send'],
      ['aiAgent', 'AI agent', 'Hides every AI button and stops the agent everywhere.'],
    ],
  },
];

function FeaturesTab() {
  const { settings } = useAppData();
  const save = useSave();
  const f = settings!.features;
  return (
    <div>
      <p className="mb-3 text-xs text-ink-muted">Switch off anything you don’t use — it disappears from the app. Nothing is deleted.</p>
      {FEATURE_GROUPS.map((g) => (
        <div key={g.title}>
          <SectionTitle>{g.title}</SectionTitle>
          {g.items.map(([key, label, hint]) => (
            <Toggle key={key} checked={f[key]} onChange={(v) => void save({ features: { [key]: v } })} label={label} hint={hint} />
          ))}
        </div>
      ))}
      <SectionTitle>Voice messages</SectionTitle>
      <Field label="Default playback speed">
        <div className="flex gap-1.5">
          {[1, 1.5, 2].map((sp) => (
            <button
              key={sp}
              type="button"
              onClick={() => void save({ audio: { defaultSpeed: sp } })}
              className={
                'rounded-lg border px-4 py-1.5 text-sm ' +
                (settings!.audio.defaultSpeed === sp ? 'border-brand-primary bg-brand-action/10 font-medium text-brand-primary' : 'border-gray-300 text-ink-muted')
              }
            >
              {sp}×
            </button>
          ))}
        </div>
      </Field>
    </div>
  );
}

// ===== Business hours =====

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function HoursTab() {
  const { settings } = useAppData();
  const save = useSave();
  const [bh, setBh] = useState(settings!.businessHours);
  const dirty = JSON.stringify(bh) !== JSON.stringify(settings!.businessHours);
  const setDay = (k: string, patch: Partial<DayHours>) => setBh((p) => ({ ...p, days: { ...p.days, [k]: { ...p.days[k]!, ...patch } } }));
  return (
    <div>
      <p className="mb-3 text-xs text-ink-muted">Used by the away message and by AI agents set to “only outside / inside business hours”.</p>
      <Field label="Time zone">
        <input value={bh.timezone} onChange={(e) => setBh({ ...bh, timezone: e.target.value })} className={inputCls} dir="ltr" placeholder="Asia/Jerusalem" />
      </Field>
      <div className="flex flex-col gap-1.5">
        {DAY_NAMES.map((name, i) => {
          const d = bh.days[String(i)]!;
          return (
            <div key={name} className="flex items-center gap-3">
              <span className="w-24 text-sm text-ink">{name}</span>
              <input type="checkbox" checked={d.on} onChange={(e) => setDay(String(i), { on: e.target.checked })} className="h-4 w-4 accent-[#128C7E]" />
              {d.on ? (
                <>
                  <input type="time" value={d.from} onChange={(e) => setDay(String(i), { from: e.target.value })} className={inputCls + ' w-28'} />
                  <span className="text-ink-muted">–</span>
                  <input type="time" value={d.to} onChange={(e) => setDay(String(i), { to: e.target.value })} className={inputCls + ' w-28'} />
                </>
              ) : (
                <span className="text-sm text-ink-muted">Closed</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex justify-end">
        <PrimaryButton onClick={() => void save({ businessHours: bh })} disabled={!dirty}>
          Save hours
        </PrimaryButton>
      </div>
    </div>
  );
}

// ===== Away message =====

function AwayTab() {
  const { settings } = useAppData();
  const save = useSave();
  const [a, setA] = useState(settings!.away);
  const dirty = JSON.stringify(a) !== JSON.stringify(settings!.away);
  return (
    <div>
      <Toggle
        checked={settings!.away.enabled}
        onChange={(v) => void save({ away: { enabled: v } })}
        label={<span className="font-medium">Send an automatic away message</span>}
        hint="Answers new customer messages automatically. Skipped in chats where the AI agent replies by itself."
      />
      <Field label="Message">
        <textarea value={a.text} onChange={(e) => setA({ ...a, text: e.target.value })} rows={4} className={inputCls + ' resize-y'} />
      </Field>
      <Field label="When">
        <select value={a.when} onChange={(e) => setA({ ...a, when: e.target.value as Settings['away']['when'] })} className={inputCls}>
          <option value="outsideHours">Only outside business hours</option>
          <option value="always">Always (every chat, once per cooldown)</option>
        </select>
      </Field>
      <Field label="Don’t repeat in the same chat for (hours)" hint="So a customer who writes several messages gets it only once.">
        <input type="number" min={0} value={a.cooldownHours} onChange={(e) => setA({ ...a, cooldownHours: Number(e.target.value) })} className={inputCls + ' w-32'} />
      </Field>
      <div className="flex justify-end">
        <PrimaryButton onClick={() => void save({ away: { text: a.text, when: a.when, cooldownHours: a.cooldownHours } })} disabled={!dirty}>
          Save
        </PrimaryButton>
      </div>
    </div>
  );
}

// ===== AI agent =====

interface AiChatRow {
  conversationId: string;
  name: string;
  enabled: boolean;
  mode: string;
  rangeType: string;
  activeUntil: string | null;
  blocked: string | null;
}

const MODEL_LABELS: Record<string, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5 — smartest (default)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 — fast & capable',
  'claude-haiku-5-5': 'Claude Haiku 5.5 — fastest, cheapest',
};

function AiTab() {
  const { settings, aiModels, toast } = useAppData();
  const save = useSave();
  const ai = settings!.ai;
  const [form, setForm] = useState({
    businessInfo: ai.businessInfo,
    globalInstructions: ai.globalInstructions,
    replyDelaySeconds: ai.replyDelaySeconds,
    pauseAfterOperatorMinutes: ai.pauseAfterOperatorMinutes,
    historyMessages: ai.historyMessages,
  });
  const [key, setKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [chats, setChats] = useState<AiChatRow[] | null>(null);
  const dirty =
    form.businessInfo !== ai.businessInfo ||
    form.globalInstructions !== ai.globalInstructions ||
    form.replyDelaySeconds !== ai.replyDelaySeconds ||
    form.pauseAfterOperatorMinutes !== ai.pauseAfterOperatorMinutes ||
    form.historyMessages !== ai.historyMessages;

  useEffect(() => {
    api<{ chats: AiChatRow[] }>('/api/ai/chats')
      .then((r) => setChats(r.chats))
      .catch(() => setChats([]));
  }, [settings]);

  async function test() {
    setTesting(true);
    try {
      const r = await api<{ ok: boolean; model: string }>('/api/ai/test', { method: 'POST' });
      toast(`Connected ✓ (${r.model})`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div>
      <Toggle
        checked={ai.enabled}
        onChange={(v) => void save({ ai: { enabled: v } })}
        label={<span className="font-medium">AI agent master switch</span>}
        hint="Off = no chat gets AI replies, whatever its own setting. You switch the agent on per chat in Contact info → AI agent."
      />
      {!settings!.features.aiAgent && <InfoNote tone="warn">The AI agent feature is hidden (Features tab).</InfoNote>}

      <SectionTitle>Connection</SectionTitle>
      {ai.hasApiKey ? (
        <InfoNote tone="ok">
          An Anthropic API key is set{ai.apiKeyFromEnv ? ' (from the server environment)' : ''}.
        </InfoNote>
      ) : (
        <InfoNote tone="warn">No API key yet. Create one at console.anthropic.com → API keys, and paste it here.</InfoNote>
      )}
      <div className="mb-3 flex gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={ai.hasApiKey ? 'Replace key (sk-ant-…)' : 'sk-ant-…'}
          className={inputCls}
          autoComplete="off"
          dir="ltr"
        />
        <PrimaryButton
          small
          disabled={!key.trim()}
          onClick={() => {
            void save({ ai: { apiKey: key.trim() } });
            setKey('');
          }}
        >
          Save key
        </PrimaryButton>
      </div>
      <div className="mb-2 flex gap-2">
        <GhostButton small onClick={() => void test()} disabled={testing || !ai.hasApiKey}>
          {testing ? 'Testing…' : 'Test connection'}
        </GhostButton>
        {ai.hasApiKey && !ai.apiKeyFromEnv && (
          <GhostButton small danger onClick={() => void save({ ai: { apiKey: '' } })}>
            Remove key
          </GhostButton>
        )}
      </div>

      <SectionTitle>Model</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Model">
          <select value={ai.model} onChange={(e) => void save({ ai: { model: e.target.value } })} className={inputCls}>
            {aiModels.map((m) => (
              <option key={m} value={m}>
                {MODEL_LABELS[m] ?? m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Thinking effort" hint="Higher = more careful, slower and costlier.">
          <select value={ai.effort} onChange={(e) => void save({ ai: { effort: e.target.value } })} className={inputCls}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </Field>
      </div>
      <Field label="Default for newly enabled chats">
        <select value={ai.defaultMode} onChange={(e) => void save({ ai: { defaultMode: e.target.value } })} className={inputCls}>
          <option value="auto">Reply by itself</option>
          <option value="suggest">Draft — I review and send</option>
        </select>
      </Field>

      <SectionTitle>What every agent knows</SectionTitle>
      <Field label="About the business" hint="Hours, address, services, prices, policies — the agent only states facts written here or in the chat.">
        <textarea value={form.businessInfo} onChange={(e) => setForm({ ...form, businessInfo: e.target.value })} rows={6} className={inputCls + ' resize-y'} />
      </Field>
      <Field label="House rules for all chats" hint="Tone, language, what never to promise, when to hand over to you.">
        <textarea value={form.globalInstructions} onChange={(e) => setForm({ ...form, globalInstructions: e.target.value })} rows={4} className={inputCls + ' resize-y'} />
      </Field>

      <SectionTitle>Behaviour</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Wait before replying (sec)" hint="Lets the customer finish typing; a burst gets one answer.">
          <input type="number" min={0} max={600} value={form.replyDelaySeconds} onChange={(e) => setForm({ ...form, replyDelaySeconds: Number(e.target.value) })} className={inputCls} />
        </Field>
        <Field label="Pause after you reply (min)" hint="The agent steps back when you write by hand. 0 = never pause.">
          <input type="number" min={0} value={form.pauseAfterOperatorMinutes} onChange={(e) => setForm({ ...form, pauseAfterOperatorMinutes: Number(e.target.value) })} className={inputCls} />
        </Field>
        <Field label="Messages of history it reads">
          <input type="number" min={5} max={100} value={form.historyMessages} onChange={(e) => setForm({ ...form, historyMessages: Number(e.target.value) })} className={inputCls} />
        </Field>
      </div>
      <div className="flex justify-end">
        <PrimaryButton onClick={() => void save({ ai: form })} disabled={!dirty}>
          Save
        </PrimaryButton>
      </div>

      <SectionTitle>Chats with an agent</SectionTitle>
      {!chats && <div className="text-sm text-ink-muted">Loading…</div>}
      {chats && chats.length === 0 && <div className="text-sm text-ink-muted">None yet. Open a chat → Contact info → AI agent.</div>}
      <ul className="flex flex-col gap-1.5">
        {chats?.map((c) => (
          <li key={c.conversationId} className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm">
            <span className="min-w-0">
              <span className="font-medium text-ink">{c.name}</span>
              <span className="ml-2 text-xs text-ink-muted">
                {c.enabled ? (c.mode === 'auto' ? 'replies by itself' : 'drafts') : 'off'}
                {c.rangeType === 'temporary' && c.activeUntil ? ` · until ${new Date(c.activeUntil).toLocaleDateString()}` : c.enabled ? ' · permanent' : ''}
              </span>
              {c.enabled && c.blocked && <span className="block text-[11px] text-amber-700">{c.blocked}</span>}
            </span>
            <span className={'h-2.5 w-2.5 shrink-0 rounded-full ' + (c.enabled && !c.blocked ? 'bg-brand-action' : 'bg-gray-300')} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ===== Labels =====

function LabelsTab() {
  const { labels, reloadLabels } = useAppData();
  const [name, setName] = useState('');
  const [color, setColor] = useState(LABEL_COLORS[0]!);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await reloadLabels();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <div className="mb-4 rounded-xl border border-gray-200 p-3">
        <div className="flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New label name" maxLength={40} className={inputCls} />
          <PrimaryButton
            small
            disabled={!name.trim()}
            onClick={() => void run(async () => {
              await api('/api/labels', { method: 'POST', body: { name: name.trim(), color } });
              setName('');
            })}
          >
            Add
          </PrimaryButton>
        </div>
        <ColorRow value={color} onChange={setColor} />
      </div>
      <ErrorNote>{error}</ErrorNote>
      <ul className="flex flex-col gap-1.5">
        {labels.map((l) => (
          <LabelRow key={l.id} id={l.id} name={l.name} color={l.color} count={l.count ?? 0} run={run} />
        ))}
      </ul>
      {!labels.length && <div className="text-sm text-ink-muted">No labels yet.</div>}
    </div>
  );
}

function LabelRow({ id, name, color, count, run }: { id: string; name: string; color: string; count: number; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [n, setN] = useState(name);
  const [c, setC] = useState(color);
  if (editing) {
    return (
      <li className="rounded-lg border border-brand-primary p-2.5">
        <div className="flex gap-2">
          <input value={n} onChange={(e) => setN(e.target.value)} className={inputCls} maxLength={40} />
          <PrimaryButton small onClick={() => void run(() => api(`/api/labels/${id}`, { method: 'PATCH', body: { name: n.trim(), color: c } })).then(() => setEditing(false))}>
            Save
          </PrimaryButton>
          <GhostButton small onClick={() => setEditing(false)}>
            Cancel
          </GhostButton>
        </div>
        <ColorRow value={c} onChange={setC} />
      </li>
    );
  }
  return (
    <li className="flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2">
      <span className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
      <span className="flex-1 text-sm text-ink">{name}</span>
      <span className="text-xs text-ink-muted">{count} chat{count === 1 ? '' : 's'}</span>
      <GhostButton small onClick={() => setEditing(true)}>
        Edit
      </GhostButton>
      <GhostButton small danger onClick={() => confirm(`Delete the label “${name}”? Chats keep everything else.`) && void run(() => api(`/api/labels/${id}`, { method: 'DELETE' }))}>
        Delete
      </GhostButton>
    </li>
  );
}

// ===== Saved replies =====

function RepliesTab() {
  const { savedReplies, reloadSavedReplies } = useAppData();
  const [editing, setEditing] = useState<{ id?: string; shortcut: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveReply() {
    if (!editing) return;
    setError(null);
    try {
      if (editing.id) await api(`/api/saved-replies/${editing.id}`, { method: 'PATCH', body: { shortcut: editing.shortcut, body: editing.body } });
      else await api('/api/saved-replies', { method: 'POST', body: { shortcut: editing.shortcut, body: editing.body } });
      await reloadSavedReplies();
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <p className="mb-3 text-xs text-ink-muted">
        Type <span className="font-mono">/</span> in the message box to insert one. Shortcuts can be Hebrew or English, e.g. <span className="font-mono">/מחיר</span>.
      </p>
      {editing ? (
        <div className="mb-4 rounded-xl border border-brand-primary p-3">
          <Field label="Shortcut">
            <div className="flex items-center gap-1">
              <span className="text-ink-muted">/</span>
              <input value={editing.shortcut} onChange={(e) => setEditing({ ...editing, shortcut: e.target.value.replace(/\s/g, '') })} className={inputCls} maxLength={32} />
            </div>
          </Field>
          <Field label="Text">
            <textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} rows={4} className={inputCls + ' resize-y'} />
          </Field>
          <ErrorNote>{error}</ErrorNote>
          <div className="flex justify-end gap-2">
            <GhostButton onClick={() => setEditing(null)}>Cancel</GhostButton>
            <PrimaryButton onClick={() => void saveReply()} disabled={!editing.shortcut || !editing.body.trim()}>
              Save
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <div className="mb-3">
          <PrimaryButton small onClick={() => setEditing({ shortcut: '', body: '' })}>
            + New saved reply
          </PrimaryButton>
        </div>
      )}
      <ul className="flex flex-col gap-1.5">
        {savedReplies.map((r) => (
          <li key={r.id} className="flex items-start gap-3 rounded-lg border border-gray-200 px-3 py-2">
            <span className="shrink-0 font-medium text-brand-primary">/{r.shortcut}</span>
            <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap text-sm text-ink-muted">{r.body}</span>
            <GhostButton small onClick={() => setEditing({ id: r.id, shortcut: r.shortcut, body: r.body })}>
              Edit
            </GhostButton>
            <GhostButton small danger onClick={() => confirm(`Delete /${r.shortcut}?`) && void api(`/api/saved-replies/${r.id}`, { method: 'DELETE' }).then(reloadSavedReplies)}>
              Delete
            </GhostButton>
          </li>
        ))}
      </ul>
      {!savedReplies.length && !editing && <div className="text-sm text-ink-muted">No saved replies yet.</div>}
    </div>
  );
}

// ===== Contacts =====

function ContactsTab() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ created: number; updated: number; errors: string[]; errorCount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    const form = new FormData();
    form.append('file', file);
    try {
      setResult(await apiUpload('/api/contacts/import', form));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <SectionTitle>Export</SectionTitle>
      <p className="mb-2 text-xs text-ink-muted">All contacts with names, notes and labels, as a CSV file that opens in Excel.</p>
      <a href="/api/contacts/export" className="inline-block rounded-full bg-brand-primary px-5 py-2 text-sm font-medium text-white hover:opacity-90">
        Download contacts.csv
      </a>

      <SectionTitle>Import</SectionTitle>
      <p className="mb-2 text-xs text-ink-muted">
        A CSV whose first row has a <b>phone</b> column, and optionally <b>name</b>, <b>email</b>, <b>notes</b>, <b>labels</b> (several labels separated by “;”).
        Existing contacts are updated, never duplicated. Imported contacts can be reached with templates and bulk send.
      </p>
      <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
      <PrimaryButton onClick={() => fileRef.current?.click()} disabled={busy}>
        {busy ? 'Importing…' : 'Choose CSV file'}
      </PrimaryButton>
      <ErrorNote>{error}</ErrorNote>
      {result && (
        <InfoNote tone={result.errorCount ? 'warn' : 'ok'}>
          {result.created} added, {result.updated} updated
          {result.errorCount > 0 && (
            <>
              , {result.errorCount} skipped:
              <ul className="mt-1 list-disc pl-4">
                {result.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </>
          )}
        </InfoNote>
      )}
    </div>
  );
}

// ===== WhatsApp Business profile =====

interface Profile {
  senderId: string;
  status: string | null;
  name: string;
  about: string;
  description: string;
  address: string;
  vertical: string;
  logoUrl: string;
  emails: string[];
  websites: string[];
}

const VERTICALS = ['', 'Automotive', 'Beauty, Spa and Salon', 'Clothing and Apparel', 'Education', 'Entertainment', 'Event Planning and Service', 'Finance and Banking', 'Food and Grocery', 'Public Service', 'Hotel and Lodging', 'Medical and Health', 'Non-profit', 'Professional Services', 'Shopping and Retail', 'Travel and Transportation', 'Restaurant', 'Other'];

function ProfileTab() {
  const { toast } = useAppData();
  const [p, setP] = useState<Profile | null>(null);
  const [orig, setOrig] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ profile: Profile }>('/api/profile')
      .then((r) => {
        setP(r.profile);
        setOrig(r.profile);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  async function save() {
    if (!p || !orig) return;
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = {};
    (['name', 'about', 'description', 'address', 'vertical'] as const).forEach((k) => {
      if (p[k] !== orig[k]) body[k] = p[k];
    });
    if (JSON.stringify(p.emails) !== JSON.stringify(orig.emails)) body.emails = p.emails.filter(Boolean);
    if (JSON.stringify(p.websites) !== JSON.stringify(orig.websites)) body.websites = p.websites.filter(Boolean);
    try {
      const r = await api<{ profile: Profile }>('/api/profile', { method: 'PATCH', body });
      setP(r.profile);
      setOrig(r.profile);
      toast('Profile sent to WhatsApp. Changes can take a few minutes to show.', 'ok');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function uploadLogo(file: File) {
    const form = new FormData();
    form.append('file', file);
    setError(null);
    try {
      const r = await apiUpload<{ profile: Profile }>('/api/profile/logo', form);
      setP(r.profile);
      setOrig(r.profile);
      toast('Profile photo sent to WhatsApp.', 'ok');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error && !p) {
    return (
      <div>
        <ErrorNote>{error}</ErrorNote>
        <p className="text-xs text-ink-muted">Your profile can always be edited in the Twilio Console → Messaging → Senders → WhatsApp senders.</p>
      </div>
    );
  }
  if (!p || !orig) return <div className="py-10 text-center text-sm text-ink-muted">Loading profile from Twilio…</div>;
  const dirty = JSON.stringify(p) !== JSON.stringify(orig);

  return (
    <div>
      <p className="mb-3 text-xs text-ink-muted">
        What customers see on your WhatsApp profile ({p.senderId.replace('whatsapp:', '')}
        {p.status ? ` · ${p.status.toLowerCase()}` : ''}).
      </p>
      <div className="mb-4 flex items-center gap-4">
        {p.logoUrl ? <img src={p.logoUrl} alt="" className="h-16 w-16 rounded-full object-cover" /> : <div className="h-16 w-16 rounded-full bg-gray-200" />}
        <GhostButton small onClick={() => fileRef.current?.click()}>
          Change profile photo
        </GhostButton>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadLogo(f); }} />
      </div>
      <Field label="Display name" hint="Meta reviews name changes; it can take a few days and must match your business.">
        <input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} className={inputCls} />
      </Field>
      <Field label={`About (${p.about.length}/139)`}>
        <input value={p.about} maxLength={139} onChange={(e) => setP({ ...p, about: e.target.value })} className={inputCls} />
      </Field>
      <Field label={`Description (${p.description.length}/512)`}>
        <textarea value={p.description} maxLength={512} rows={3} onChange={(e) => setP({ ...p, description: e.target.value })} className={inputCls + ' resize-y'} />
      </Field>
      <Field label="Address">
        <input value={p.address} onChange={(e) => setP({ ...p, address: e.target.value })} className={inputCls} />
      </Field>
      <Field label="Category">
        <select value={p.vertical} onChange={(e) => setP({ ...p, vertical: e.target.value })} className={inputCls}>
          {VERTICALS.map((v) => (
            <option key={v} value={v}>
              {v || '—'}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Email">
          <input value={p.emails[0] ?? ''} onChange={(e) => setP({ ...p, emails: [e.target.value, ...p.emails.slice(1)] })} className={inputCls} dir="ltr" />
        </Field>
        <Field label="Website">
          <input value={p.websites[0] ?? ''} onChange={(e) => setP({ ...p, websites: [e.target.value, ...p.websites.slice(1)] })} className={inputCls} dir="ltr" placeholder="https://" />
        </Field>
      </div>
      <ErrorNote>{error}</ErrorNote>
      <div className="flex justify-end">
        <PrimaryButton onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </PrimaryButton>
      </div>
    </div>
  );
}
