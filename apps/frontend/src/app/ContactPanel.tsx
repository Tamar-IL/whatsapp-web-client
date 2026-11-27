/**
 * Right-hand contact panel (opens from the chat header, like WhatsApp's
 * "Contact info"): photo, name, email, notes, labels, opt-out and the chat's
 * AI agent configuration.
 */
import { useEffect, useRef, useState } from 'react';
import { api, apiUpload } from '../api/client';
import { useAppData } from './AppData';
import { Avatar } from './Avatar';
import { LabelPicker } from './LabelPicker';
import { CloseButton, ErrorNote, Field, InfoNote, PrimaryButton, Toggle, GhostButton, inputCls, toLocalInput } from './ui';
import type { ConversationListItem } from './ChatList';

export type ConversationDetail = ConversationListItem & {
  contact: ConversationListItem['contact'] & { email: string | null; optOut: boolean };
  aiPausedUntil: string | null;
};

export function ContactPanel({
  detail,
  onClose,
  onChanged,
}: {
  detail: ConversationDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { features, toast } = useAppData();
  const c = detail.contact;
  const [name, setName] = useState(c.displayName ?? '');
  const [email, setEmail] = useState(c.email ?? '');
  const [notes, setNotes] = useState(c.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(c.displayName ?? '');
    setEmail(c.email ?? '');
    setNotes(c.notes ?? '');
  }, [c.id, c.displayName, c.email, c.notes]);

  const dirty = name !== (c.displayName ?? '') || email !== (c.email ?? '') || notes !== (c.notes ?? '');

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/contacts/${c.id}`, { method: 'PATCH', body: { displayName: name, email, notes } });
      onChanged();
      toast('Contact saved', 'ok');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function setOptOut(v: boolean) {
    try {
      await api(`/api/contacts/${c.id}`, { method: 'PATCH', body: { optOut: v } });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function uploadPhoto(file: File) {
    setError(null);
    const form = new FormData();
    form.append('file', file);
    try {
      await apiUpload(`/api/contacts/${c.id}/avatar`, form);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removePhoto() {
    await api(`/api/contacts/${c.id}/avatar`, { method: 'DELETE' }).catch(() => undefined);
    onChanged();
  }

  const shownName = c.displayName ?? c.profileName ?? c.phoneNumber;

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-black/10 bg-[#f0f2f5]">
      <header className="flex items-center gap-3 border-b border-black/10 bg-[#f0f2f5] px-4 py-3">
        <CloseButton onClick={onClose} />
        <span className="font-medium text-ink">Contact info</span>
      </header>
      <div className="scroll-thin flex-1 overflow-y-auto">
        {/* Identity */}
        <section className="flex flex-col items-center bg-white px-6 py-5">
          <Avatar contactId={c.id} name={shownName} phone={c.phoneNumber} hasPhoto={c.hasAvatar} version={c.avatarVersion} size={120} />
          {features.avatars && (
            <div className="mt-2 flex gap-3 text-xs">
              <button type="button" className="text-brand-link hover:underline" onClick={() => fileRef.current?.click()}>
                {c.hasAvatar ? 'Change photo' : 'Add photo'}
              </button>
              {c.hasAvatar && (
                <button type="button" className="text-ink-muted hover:text-red-600" onClick={() => void removePhoto()}>
                  Remove
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void uploadPhoto(f);
                }}
              />
            </div>
          )}
          <div className="mt-3 text-lg text-ink">{shownName}</div>
          <div className="text-sm text-ink-muted" dir="ltr">
            {c.phoneNumber}
          </div>
          {c.profileName && c.displayName && c.profileName !== c.displayName && (
            <div className="text-xs text-ink-muted">WhatsApp name: ~{c.profileName}</div>
          )}
        </section>

        {/* Details */}
        <section className="mt-2 bg-white px-5 py-4">
          <Field label="Name (shown to you only)">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={c.profileName ?? 'Name'} className={inputCls} />
          </Field>
          {features.contactNotes && (
            <>
              <Field label="Email">
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" className={inputCls} dir="ltr" />
              </Field>
              <Field label="Notes" hint="Private. The AI agent can read these too.">
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} className={inputCls + ' resize-y'} placeholder="Anything worth remembering about this customer" />
              </Field>
            </>
          )}
          <div className="flex justify-end">
            <PrimaryButton small onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save'}
            </PrimaryButton>
          </div>
          <ErrorNote>{error}</ErrorNote>
        </section>

        {features.labels && (
          <section className="mt-2 bg-white px-5 py-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm text-ink-muted">Labels</span>
              <button type="button" className="text-xs text-brand-link hover:underline" onClick={() => setShowLabels(true)}>
                Edit
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {detail.labels.length === 0 && <span className="text-xs text-ink-muted">No labels</span>}
              {detail.labels.map((l) => (
                <span key={l.id} className="rounded px-2 py-0.5 text-xs font-medium text-white" style={{ backgroundColor: l.color }}>
                  {l.name}
                </span>
              ))}
            </div>
          </section>
        )}

        {features.aiAgent && <AiChatSection conversationId={detail.id} paused={detail.aiPausedUntil} onChanged={onChanged} />}

        <section className="mt-2 bg-white px-5 py-3">
          <Toggle
            checked={c.optOut}
            onChange={(v) => void setOptOut(v)}
            label={<span className="text-red-600">Opted out</span>}
            hint="Stops bulk sends, the away message and the AI agent for this customer."
          />
        </section>
        <div className="h-6" />
      </div>
      {showLabels && (
        <LabelPicker conversationId={detail.id} selected={detail.labels.map((l) => l.id)} onClose={() => setShowLabels(false)} onSaved={onChanged} />
      )}
    </aside>
  );
}

interface AiConfig {
  enabled: boolean;
  mode: 'auto' | 'suggest';
  instructions: string;
  customerInfo: string;
  rangeType: 'always' | 'temporary';
  activeFrom: string | null;
  activeUntil: string | null;
  useBusinessHours: 'any' | 'inside' | 'outside';
  maxRepliesPerDay: number | null;
}

function AiChatSection({ conversationId, paused, onChanged }: { conversationId: string; paused: string | null; onChanged: () => void }) {
  const { settings, toast } = useAppData();
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [saved, setSaved] = useState<AiConfig | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [sentToday, setSentToday] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ action: string; reply: string; reason: string } | null>(null);

  useEffect(() => {
    setCfg(null);
    setTest(null);
    api<{ config: AiConfig; blocked: string | null; sentToday: number }>(`/api/ai/chats/${conversationId}`)
      .then((r) => {
        setCfg(r.config);
        setSaved(r.config);
        setBlocked(r.blocked);
        setSentToday(r.sentToday);
      })
      .catch((e: Error) => setError(e.message));
  }, [conversationId]);

  if (!cfg) return <section className="mt-2 bg-white px-5 py-4 text-sm text-ink-muted">{error ?? 'Loading AI agent…'}</section>;

  const set = <K extends keyof AiConfig>(k: K, v: AiConfig[K]) => setCfg((p) => (p ? { ...p, [k]: v } : p));
  const dirty = JSON.stringify(cfg) !== JSON.stringify(saved);

  function quickRange(days: number) {
    const from = new Date();
    const until = new Date(Date.now() + days * 86_400_000);
    setCfg((p) => (p ? { ...p, rangeType: 'temporary', activeFrom: from.toISOString(), activeUntil: until.toISOString() } : p));
  }

  async function save(next = cfg) {
    if (!next) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ config: AiConfig; blocked: string | null }>(`/api/ai/chats/${conversationId}`, { method: 'PUT', body: next });
      setCfg(r.config);
      setSaved(r.config);
      setBlocked(r.blocked);
      onChanged();
      toast('AI agent settings saved', 'ok');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    setError(null);
    try {
      const r = await api<{ decision: { action: string; reply: string; reason: string } }>(`/api/ai/chats/${conversationId}/draft`, {
        method: 'POST',
        body: {},
      });
      setTest(r.decision);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function resume() {
    await api(`/api/conversations/${conversationId}`, { method: 'PATCH', body: { resumeAi: true } }).catch(() => undefined);
    const r = await api<{ blocked: string | null }>(`/api/ai/chats/${conversationId}`);
    setBlocked(r.blocked);
    onChanged();
  }

  const isPaused = paused && new Date(paused) > new Date();

  return (
    <section className="mt-2 bg-white px-5 py-4">
      <Toggle
        checked={cfg.enabled}
        onChange={(v) => {
          const next = { ...cfg, enabled: v };
          setCfg(next);
          void save(next);
        }}
        label={<span className="font-medium">🤖 AI agent for this chat</span>}
        hint={cfg.enabled ? (blocked ? `Not answering now: ${blocked}` : `Active · ${sentToday} AI repl${sentToday === 1 ? 'y' : 'ies'} in the last 24h`) : 'Off — you answer this chat yourself.'}
      />
      {!settings?.ai.enabled && cfg.enabled && (
        <InfoNote tone="warn">The global AI switch is off. Turn it on in Settings → AI agent.</InfoNote>
      )}
      {isPaused && cfg.enabled && (
        <InfoNote>
          Paused because you replied by hand.{' '}
          <button type="button" className="font-medium text-brand-link hover:underline" onClick={() => void resume()}>
            Resume now
          </button>
        </InfoNote>
      )}

      {cfg.enabled && (
        <div className="mt-2">
          <Field label="What should it do?">
            <div className="flex gap-1.5">
              {(['auto', 'suggest'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => set('mode', m)}
                  className={
                    'flex-1 rounded-lg border px-2 py-1.5 text-xs ' +
                    (cfg.mode === m ? 'border-brand-primary bg-brand-action/10 font-medium text-brand-primary' : 'border-gray-300 text-ink-muted')
                  }
                >
                  {m === 'auto' ? 'Reply by itself' : 'Draft — I send'}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Instructions for this chat" hint="e.g. “Book a meeting for next week, offer Sun–Tue mornings.”">
            <textarea value={cfg.instructions} onChange={(e) => set('instructions', e.target.value)} rows={4} className={inputCls + ' resize-y'} />
          </Field>
          <Field label="Good to know about this customer" hint="Facts the agent may use: history, preferences, what they ordered…">
            <textarea value={cfg.customerInfo} onChange={(e) => set('customerInfo', e.target.value)} rows={3} className={inputCls + ' resize-y'} />
          </Field>

          <Field label="When is it active?">
            <div className="flex gap-1.5">
              {(['always', 'temporary'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => set('rangeType', r)}
                  className={
                    'flex-1 rounded-lg border px-2 py-1.5 text-xs ' +
                    (cfg.rangeType === r ? 'border-brand-primary bg-brand-action/10 font-medium text-brand-primary' : 'border-gray-300 text-ink-muted')
                  }
                >
                  {r === 'always' ? 'Permanent' : 'Temporary'}
                </button>
              ))}
            </div>
          </Field>
          {cfg.rangeType === 'temporary' && (
            <div className="mb-3 rounded-lg bg-black/[0.03] p-2.5">
              <div className="mb-2 flex flex-wrap gap-1.5">
                {[
                  ['Today', 1],
                  ['3 days', 3],
                  ['1 week', 7],
                  ['1 month', 30],
                ].map(([l, d]) => (
                  <GhostButton key={l} small onClick={() => quickRange(Number(d))}>
                    {l}
                  </GhostButton>
                ))}
              </div>
              <label className="mb-1 block text-[11px] text-ink-muted">From (empty = now)</label>
              <input
                type="datetime-local"
                value={cfg.activeFrom ? toLocalInput(new Date(cfg.activeFrom)) : ''}
                onChange={(e) => set('activeFrom', e.target.value ? new Date(e.target.value).toISOString() : null)}
                className={inputCls + ' mb-2'}
              />
              <label className="mb-1 block text-[11px] text-ink-muted">Until</label>
              <input
                type="datetime-local"
                value={cfg.activeUntil ? toLocalInput(new Date(cfg.activeUntil)) : ''}
                onChange={(e) => set('activeUntil', e.target.value ? new Date(e.target.value).toISOString() : null)}
                className={inputCls}
              />
            </div>
          )}
          <Field label="Business hours">
            <select value={cfg.useBusinessHours} onChange={(e) => set('useBusinessHours', e.target.value as AiConfig['useBusinessHours'])} className={inputCls}>
              <option value="any">Any time</option>
              <option value="outside">Only outside business hours</option>
              <option value="inside">Only during business hours</option>
            </select>
          </Field>
          <Field label="Max AI replies per 24 hours" hint="Empty = no limit">
            <input
              type="number"
              min={1}
              value={cfg.maxRepliesPerDay ?? ''}
              onChange={(e) => set('maxRepliesPerDay', e.target.value ? Math.max(1, Number(e.target.value)) : null)}
              className={inputCls}
            />
          </Field>
          <div className="flex items-center justify-between gap-2">
            <GhostButton small onClick={() => void runTest()} disabled={testing} title="Ask the AI what it would answer now — nothing is sent">
              {testing ? 'Thinking…' : '✨ Test answer'}
            </GhostButton>
            <PrimaryButton small onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save'}
            </PrimaryButton>
          </div>
        </div>
      )}
      {!cfg.enabled && (
        <div className="mt-1">
          <GhostButton small onClick={() => void runTest()} disabled={testing}>
            {testing ? 'Thinking…' : '✨ What would the AI answer?'}
          </GhostButton>
        </div>
      )}
      {test && (
        <div className="mt-2 rounded-lg border border-gray-200 p-2.5 text-xs">
          <div className="mb-1 font-medium text-ink-muted">
            Test result — {test.action === 'reply' ? 'would reply' : test.action === 'handoff' ? 'would hand over to you' : 'would not answer'} (not sent)
          </div>
          {test.reply && <div className="whitespace-pre-wrap rounded-lg bg-chat-out px-2.5 py-1.5 text-sm text-ink">{test.reply}</div>}
          {test.reason && <div className="mt-1 text-ink-muted">Why: {test.reason}</div>}
        </div>
      )}
      <ErrorNote>{error}</ErrorNote>
    </section>
  );
}
