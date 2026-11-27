/**
 * Small shared UI pieces, styled exactly like the existing modals and
 * popovers (white rounded-2xl panels, brand-primary buttons, gray borders).
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div
        className={
          'flex max-h-[88vh] w-full flex-col rounded-2xl bg-white shadow-xl ' + (wide ? 'max-w-3xl' : 'max-w-lg')
        }
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-black/10 px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-ink">{title}</h2>
            {subtitle && <p className="text-xs text-ink-muted">{subtitle}</p>}
          </div>
          <CloseButton onClick={onClose} />
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-black/10 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function CloseButton({ onClick, title = 'Close' }: { onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="rounded-full px-2 text-2xl leading-none text-ink-muted hover:text-red-600"
    >
      ×
    </button>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = 'button',
  small,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  small?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={
        'whitespace-nowrap rounded-full bg-brand-primary font-medium text-white transition hover:opacity-90 disabled:opacity-50 ' +
        (small ? 'px-3 py-1 text-xs' : 'px-5 py-2 text-sm')
      }
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  disabled,
  danger,
  small,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  small?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        'rounded-full transition disabled:opacity-50 ' +
        (small ? 'px-2.5 py-1 text-xs ' : 'px-4 py-2 text-sm ') +
        (danger ? 'text-red-600 hover:bg-red-50' : 'text-ink-muted hover:bg-black/5 hover:text-ink')
      }
    >
      {children}
    </button>
  );
}

/** WhatsApp-green on/off switch. */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  hint?: ReactNode;
}) {
  const sw = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition disabled:opacity-50 ' +
        (checked ? 'bg-brand-action' : 'bg-gray-300')
      }
    >
      <span
        className={
          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition ' +
          (checked ? 'translate-x-[18px]' : 'translate-x-0.5')
        }
      />
    </button>
  );
  if (!label) return sw;
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-sm text-ink">{label}</div>
        {hint && <div className="text-[11px] leading-snug text-ink-muted">{hint}</div>}
      </div>
      {sw}
    </div>
  );
}

export const inputCls =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-muted ' +
  'focus:border-brand-primary focus:outline-none';

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="mb-3 flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-ink-muted">{hint}</span>}
    </label>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <div className="my-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{children}</div>;
}

export function InfoNote({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'ok' }) {
  const cls =
    tone === 'warn' ? 'bg-amber-50 text-amber-900' : tone === 'ok' ? 'bg-green-50 text-green-800' : 'bg-brand-action/10 text-ink';
  return <div className={'my-2 rounded-lg px-3 py-2 text-xs leading-snug ' + cls}>{children}</div>;
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  hidden?: boolean;
}

/**
 * Small dropdown menu (like WhatsApp's ⌄ / ⋮ menus). Closes on outside click,
 * Escape, or after choosing an item.
 */
export function Dropdown({
  trigger,
  items,
  align = 'right',
  className,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'left' | 'right';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const visible = items.filter((i) => !i.hidden);
  if (!visible.length) return null;
  return (
    <div ref={ref} data-open={open} className={(className?.includes('absolute') ? '' : 'relative ') + (className ?? '')}>
      <div
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {trigger}
      </div>
      {open && (
        <div
          className={
            'absolute z-40 mt-1 min-w-[11rem] rounded-xl border border-gray-200 bg-white py-1 shadow-lg ' +
            (align === 'right' ? 'right-0' : 'left-0')
          }
          onClick={(e) => e.stopPropagation()}
        >
          {visible.map((it) => (
            <button
              key={it.label}
              type="button"
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              className={
                'flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm hover:bg-black/5 ' +
                (it.danger ? 'text-red-600' : 'text-ink')
              }
            >
              {it.icon && <span className="w-4 text-center text-ink-muted">{it.icon}</span>}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Small round icon button used in headers. */
export function IconButton({
  title,
  onClick,
  children,
  active,
  light,
}: {
  title: string;
  onClick?: () => void;
  children: ReactNode;
  active?: boolean;
  light?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={
        'flex h-8 w-8 items-center justify-center rounded-full transition ' +
        (light
          ? 'text-white/90 hover:bg-white/15 hover:text-white'
          : active
            ? 'bg-black/10 text-brand-primary'
            : 'text-ink-muted hover:bg-black/5 hover:text-ink')
      }
    >
      {children}
    </button>
  );
}

/** Inline SVG icons (Material-style paths, matching the ones already used). */
export const Icons = {
  gear: 'M19.14 12.94a7.4 7.4 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.6-.22l-2.39.96a7.03 7.03 0 00-1.63-.94l-.36-2.54A.5.5 0 0013.9 2h-3.84a.5.5 0 00-.49.42l-.36 2.54c-.58.24-1.13.55-1.63.94l-2.39-.96a.5.5 0 00-.6.22L2.67 8.48a.5.5 0 00.12.64l2.03 1.58a7.4 7.4 0 000 1.88l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.39 1.05.7 1.63.94l.36 2.54c.04.24.25.42.49.42h3.84c.24 0 .45-.18.49-.42l.36-2.54c.58-.24 1.13-.55 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z',
  star: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
  starOutline:
    'M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z',
  pin: 'M16 9V4h1a1 1 0 000-2H7a1 1 0 000 2h1v5a3 3 0 01-3 3v2h5.97v7l1 1 1-1v-7H19v-2a3 3 0 01-3-3z',
  archive:
    'M20.54 5.23l-1.39-1.68A1.45 1.45 0 0018 3H6c-.47 0-.88.21-1.16.55L3.46 5.23A1.99 1.99 0 003 6.5V19a2 2 0 002 2h14a2 2 0 002-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z',
  search:
    'M15.5 14h-.79l-.28-.27a6.5 6.5 0 10-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 119.5 5a4.5 4.5 0 010 9z',
  dots: 'M12 8a2 2 0 100-4 2 2 0 000 4zm0 2a2 2 0 100 4 2 2 0 000-4zm0 6a2 2 0 100 4 2 2 0 000-4z',
  chevron: 'M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z',
  forward: 'M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z',
  copy: 'M16 1H4a2 2 0 00-2 2v14h2V3h12V1zm3 4H8a2 2 0 00-2 2v14a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2zm0 16H8V7h11v14z',
  reply: 'M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z',
  retry: 'M17.65 6.35A7.96 7.96 0 0012 4a8 8 0 108 8h-2a6 6 0 11-1.76-4.24L13 11h7V4l-2.35 2.35z',
  megaphone:
    'M18 11v2h4v-2h-4zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61zM20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.65 3.2-2.4zM4 9a2 2 0 00-2 2v2a2 2 0 002 2h1v4h2v-4h1l5 3V6L8 9H4zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69c.92-.81 1.5-2.01 1.5-3.34z',
  template:
    'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 7V3.5L18.5 9H13zM8 13h8v1.5H8V13zm0 3.5h8V18H8v-1.5z',
  sparkle:
    'M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z',
  label:
    'M17.63 5.84A2 2 0 0016 5L5 5.01A2 2 0 003 7v10a2 2 0 002 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z',
  unread: 'M12 7a5 5 0 100 10 5 5 0 000-10zm0-5a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16z',
  download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  robot:
    'M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zM7.5 11.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5S9.83 13 9 13s-1.5-.67-1.5-1.5zM16 17H8v-2h8v2zm-1-4c-.83 0-1.5-.67-1.5-1.5S14.17 10 15 10s1.5.67 1.5 1.5S15.83 13 15 13z',
};

export function Svg({ d, className = 'h-5 w-5' }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className + ' fill-current'}>
      <path d={d} />
    </svg>
  );
}

/** "Today 14:30" / "Tomorrow 08:00" / "Mon, Dec 2 09:00". */
export function formatWhen(d: Date): string {
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return `Today ${time}`;
  if (same(d, tomorrow)) return `Tomorrow ${time}`;
  if (same(d, yesterday)) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

/** Format a Date for a datetime-local input. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Copy text; returns whether it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
