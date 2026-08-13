/**
 * Template picker — pick an approved WhatsApp template, fill its {{n}}
 * placeholders, preview the result, send.
 *
 * This is the only way to message someone outside the 24-hour window, so the
 * empty and not-approved states matter as much as the happy path: an operator
 * who sees a blank list needs to be told it means "go create one in Twilio",
 * not "this is broken".
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { ChatMessage } from './ConversationView';

interface TemplateVariable {
  key: string;
  example: string;
}

interface Template {
  sid: string;
  friendlyName: string;
  language: string;
  body: string;
  variables: TemplateVariable[];
  category: string | null;
  status: string;
}

/** Substitute {{n}} for the live preview — mirrors the server's renderer. */
function render(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => values[k]?.trim() || m);
}

export function TemplateModal({
  conversationId,
  onClose,
  onSent,
}: {
  conversationId: string;
  onClose: () => void;
  onSent: (m: ChatMessage) => void;
}) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Template | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    api<{ templates: Template[] }>('/api/templates')
      .then((r) => setTemplates(r.templates))
      .catch((e: Error) => setLoadError(e.message || 'Could not load templates.'));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const approved = useMemo(
    () => (templates ?? []).filter((t) => t.status === 'approved'),
    [templates],
  );
  const waiting = useMemo(
    () => (templates ?? []).filter((t) => t.status !== 'approved'),
    [templates],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return approved;
    return approved.filter(
      (t) => t.friendlyName.toLowerCase().includes(q) || t.body.toLowerCase().includes(q),
    );
  }, [approved, query]);

  function choose(t: Template) {
    setSelected(t);
    setSendError(null);
    // Start blank rather than pre-filled with Twilio's samples — a pre-filled
    // example is far too easy to send by accident as a real message.
    setValues(Object.fromEntries(t.variables.map((v) => [v.key, ''])));
  }

  const ready = selected != null && selected.variables.every((v) => values[v.key]?.trim());

  async function send() {
    if (!selected || !ready || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const r = await api<{ message: ChatMessage }>('/api/templates/send', {
        method: 'POST',
        body: { conversationId, contentSid: selected.sid, variables: values },
      });
      onSent(r.message);
      onClose();
    } catch (e) {
      setSendError((e as Error)?.message ?? 'Could not send the template.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-black/10 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-ink">Send a template</h2>
            <p className="text-xs text-ink-muted">
              The 24-hour window is closed — only approved templates can be delivered.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="rounded-full px-2 text-2xl leading-none text-ink-muted hover:text-red-600"
          >
            ×
          </button>
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">
          {!templates && !loadError && (
            <div className="py-8 text-center text-sm text-ink-muted">Loading templates…</div>
          )}

          {loadError && (
            <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</div>
          )}

          {templates && approved.length === 0 && (
            <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-medium">You have no approved templates yet.</p>
              <p className="mt-1">
                Create one in the Twilio Console under{' '}
                <span className="font-mono text-xs">Messaging → Content Template Builder</span>,
                then submit it for WhatsApp approval. Approval usually takes a few hours. Once it is
                approved it appears here automatically.
              </p>
              {waiting.length > 0 && (
                <p className="mt-2">
                  {waiting.length} template{waiting.length > 1 ? 's are' : ' is'} still waiting:{' '}
                  {waiting.map((t) => `${t.friendlyName} (${t.status})`).join(', ')}
                </p>
              )}
            </div>
          )}

          {/* Step 1 — pick */}
          {approved.length > 0 && !selected && (
            <>
              {approved.length > 4 && (
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search templates…"
                  className="mb-3 w-full rounded-full border border-gray-300 px-4 py-2 text-sm
                             focus:border-brand-primary focus:outline-none"
                />
              )}
              <div className="flex flex-col gap-2">
                {visible.map((t) => (
                  <button
                    key={t.sid}
                    type="button"
                    onClick={() => choose(t)}
                    className="rounded-xl border border-gray-200 px-4 py-3 text-left transition
                               hover:border-brand-primary hover:bg-brand-action/5"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ink">{t.friendlyName}</span>
                      <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase text-ink-muted">
                        {t.language}
                      </span>
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-xs text-ink-muted">{t.body}</div>
                  </button>
                ))}
                {visible.length === 0 && (
                  <div className="py-6 text-center text-sm text-ink-muted">
                    No template matches “{query}”.
                  </div>
                )}
              </div>
            </>
          )}

          {/* Step 2 — fill + preview */}
          {selected && (
            <>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="mb-3 text-xs text-brand-link hover:underline"
              >
                ← Choose a different template
              </button>

              <div className="mb-1 text-sm font-medium text-ink">{selected.friendlyName}</div>

              {selected.variables.length > 0 ? (
                <div className="mb-3 flex flex-col gap-2">
                  {selected.variables.map((v) => (
                    <label key={v.key} className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-ink-muted">
                        {`{{${v.key}}}`}
                        {v.example && (
                          <span className="ml-1 font-normal">— for example: {v.example}</span>
                        )}
                      </span>
                      <input
                        value={values[v.key] ?? ''}
                        onChange={(e) => setValues((p) => ({ ...p, [v.key]: e.target.value }))}
                        placeholder={v.example || `Value for {{${v.key}}}`}
                        className="rounded-lg border border-gray-300 px-3 py-2 text-sm
                                   focus:border-brand-primary focus:outline-none"
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <p className="mb-3 text-xs text-ink-muted">
                  This template has no fields to fill in.
                </p>
              )}

              <div className="text-xs font-medium text-ink-muted">Preview</div>
              <div className="mt-1 whitespace-pre-wrap rounded-xl bg-chat-out px-3 py-2 text-sm text-ink">
                {render(selected.body, values)}
              </div>

              {sendError && (
                <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                  {sendError}
                </div>
              )}
            </>
          )}
        </div>

        {selected && (
          <div className="flex items-center justify-end gap-2 border-t border-black/10 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-4 py-2 text-sm text-ink-muted hover:bg-black/5"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void send()}
              disabled={!ready || sending}
              title={ready ? undefined : 'Fill in every field first'}
              className="rounded-full bg-brand-primary px-5 py-2 text-sm font-medium text-white
                         transition hover:opacity-90 disabled:opacity-50"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
