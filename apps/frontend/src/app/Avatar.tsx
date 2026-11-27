/**
 * Contact avatar: the operator-uploaded photo when there is one, otherwise a
 * coloured initial (colour derived from the phone number, so it stays stable).
 *
 * WhatsApp doesn't share customers' profile pictures with businesses through
 * Twilio, which is why photos are uploaded by hand in the contact panel.
 */
import { useState } from 'react';
import { useAppData } from './AppData';

const COLORS = ['#128C7E', '#075E54', '#34B7F1', '#7E57C2', '#EF6C00', '#C2185B', '#2E7D32', '#5D4037', '#00838F', '#6D4C41'];

function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length]!;
}

export function Avatar({
  contactId,
  name,
  phone,
  hasPhoto,
  version,
  size = 40,
}: {
  contactId: string;
  name: string;
  phone: string;
  hasPhoto?: boolean;
  version?: string | null;
  size?: number;
}) {
  const { features } = useAppData();
  const [broken, setBroken] = useState<string | null>(null);
  const first = name.trim()[0] ?? '';
  // A chat known only by its number gets a person silhouette, not a "+".
  const initial = /\p{L}/u.test(first) ? first.toUpperCase() : null;
  const showPhoto = features.avatars && hasPhoto && broken !== version;
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };

  if (showPhoto) {
    return (
      <img
        src={`/api/contacts/${contactId}/avatar?v=${encodeURIComponent(version ?? '')}`}
        alt={name}
        style={style}
        onError={() => setBroken(version ?? 'x')}
        className="shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <div
      style={{ ...style, backgroundColor: features.avatars ? colorFor(phone) : undefined }}
      className={
        'flex shrink-0 items-center justify-center rounded-full font-semibold text-white ' +
        (features.avatars ? '' : 'bg-brand-primary')
      }
    >
      {initial ?? (
        <svg viewBox="0 0 24 24" style={{ width: size * 0.6, height: size * 0.6 }} className="fill-current opacity-90">
          <path d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-3.33 0-10 1.67-10 5v3h20v-3c0-3.33-6.67-5-10-5z" />
        </svg>
      )}
    </div>
  );
}
