/** Choose which labels a chat carries; new labels can be created inline. */
import { useState } from 'react';
import { api } from '../api/client';
import { useAppData } from './AppData';
import { ErrorNote, GhostButton, Modal, PrimaryButton, inputCls } from './ui';

export const LABEL_COLORS = ['#128C7E', '#25D366', '#34B7F1', '#7E57C2', '#EF6C00', '#E53935', '#C2185B', '#FBC02D', '#5D4037', '#546E7A'];

export function LabelPicker({
  conversationId,
  selected,
  onClose,
  onSaved,
}: {
  conversationId: string;
  selected: string[];
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { labels, reloadLabels } = useAppData();
  const [chosen, setChosen] = useState<Set<string>>(new Set(selected));
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(LABEL_COLORS[0]!);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function toggle(id: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function create() {
    if (!newName.trim()) return;
    setError(null);
    try {
      const r = await api<{ label: { id: string } }>('/api/labels', { method: 'POST', body: { name: newName.trim(), color: newColor } });
      await reloadLabels();
      setChosen((p) => new Set(p).add(r.label.id));
      setNewName('');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/conversations/${conversationId}/labels`, { method: 'PUT', body: { labelIds: [...chosen] } });
      onSaved?.();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Labels"
      subtitle="Group chats, then filter the list by label."
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </>
      }
    >
      {labels.length === 0 && <p className="mb-3 text-sm text-ink-muted">No labels yet — create the first one below.</p>}
      <div className="mb-4 flex flex-col gap-1">
        {labels.map((l) => (
          <label key={l.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-black/5">
            <input type="checkbox" checked={chosen.has(l.id)} onChange={() => toggle(l.id)} className="h-4 w-4 accent-[#128C7E]" />
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: l.color }} />
            <span className="text-sm text-ink">{l.name}</span>
          </label>
        ))}
      </div>
      <div className="rounded-xl border border-gray-200 p-3">
        <div className="mb-2 text-xs font-medium text-ink-muted">New label</div>
        <div className="flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void create())}
            placeholder="e.g. VIP, New customer, Waiting for payment"
            maxLength={40}
            className={inputCls}
          />
          <PrimaryButton small onClick={() => void create()} disabled={!newName.trim()}>
            Add
          </PrimaryButton>
        </div>
        <ColorRow value={newColor} onChange={setNewColor} />
      </div>
      <ErrorNote>{error}</ErrorNote>
    </Modal>
  );
}

export function ColorRow({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {LABEL_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={'h-6 w-6 rounded-full ring-offset-2 ' + (value === c ? 'ring-2 ring-brand-primary' : '')}
          style={{ backgroundColor: c }}
          title={c}
        />
      ))}
    </div>
  );
}
