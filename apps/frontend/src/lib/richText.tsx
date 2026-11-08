/**
 * Render a message body as rich text, WhatsApp-style:
 *  - URLs (http(s)://… or www.…) become clickable links opening in a new tab
 *  - *bold*, _italic_, ~strikethrough~, ```monospace```
 *
 * Builds React nodes (no dangerouslySetInnerHTML), so message text can never inject HTML.
 */
import type { ReactNode } from 'react';

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
// Trailing punctuation that is usually sentence punctuation, not part of the link.
const TRAILING_PUNCT = /[.,!?;:)\]}'"*_~]+$/;

// Markers must hug non-space text, like WhatsApp: "*bold*" yes, "* not *" no.
const FORMAT_RE = /```([\s\S]+?)```|\*(\S(?:[^*\n]*\S)?)\*|_(\S(?:[^_\n]*\S)?)_|~(\S(?:[^~\n]*\S)?)~/g;

function format(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(FORMAT_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    // Ignore markers glued to a word (e.g. snake_case_name, 2*3*4).
    if (m[1] === undefined && (/\w/.test(text[start - 1] ?? '') || /\w/.test(text[end] ?? ''))) {
      continue;
    }
    if (start > last) out.push(text.slice(last, start));
    const k = `${keyPrefix}-${i++}`;
    if (m[1] !== undefined) {
      out.push(
        <code key={k} className="rounded bg-black/5 px-1 font-mono text-[0.9em]">
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined) {
      out.push(<strong key={k}>{format(m[2], k)}</strong>);
    } else if (m[3] !== undefined) {
      out.push(<em key={k}>{format(m[3], k)}</em>);
    } else if (m[4] !== undefined) {
      out.push(<s key={k}>{format(m[4], k)}</s>);
    }
    last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let url = m[0];
    const trail = TRAILING_PUNCT.exec(url)?.[0] ?? '';
    if (trail) url = url.slice(0, -trail.length);
    if (!url) continue;
    if (start > last) out.push(...format(text.slice(last, start), `t${i}`));
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    out.push(
      <a
        key={`l${i++}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-brand-link underline hover:opacity-80"
      >
        {url}
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) out.push(...format(text.slice(last), `t${i}`));
  return <>{out}</>;
}
