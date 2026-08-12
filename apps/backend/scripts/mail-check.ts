/* eslint-disable no-console */
// Diagnose outgoing email (Resend). Inspects the key this process was handed,
// then attempts one real send so Resend's own answer is visible.
// Usage:  npm run mail-check          (local)
//         docker compose run --rm app npm run mail-check     (server)
import 'dotenv/config';

const KEY_SHAPE = /^re_[A-Za-z0-9_-]+$/;

function describeKey(raw: string): string[] {
  const notes: string[] = [];
  if (raw !== raw.trim()) notes.push('has leading/trailing whitespace');
  if (/["']/.test(raw)) notes.push('contains quote characters');
  if (/\r/.test(raw)) notes.push('contains a carriage return (Windows line ending)');
  if (/\s#/.test(raw)) notes.push('looks like an inline # comment leaked in');
  if (/^Bearer /i.test(raw)) notes.push('starts with "Bearer " — that prefix is added by the code, not the key');
  if (raw.includes('…') || raw.includes('...')) notes.push('contains "…" — this is the masked key from the dashboard list, not the real secret');
  if (!raw.startsWith('re_')) notes.push('does not start with "re_"');
  else if (!KEY_SHAPE.test(raw)) notes.push('has characters not normally found in a Resend key');
  return notes;
}

async function main() {
  const raw = process.env.RESEND_API_KEY;

  console.log('');
  if (!raw) {
    console.log('RESEND_API_KEY: NOT SET for this process.');
    console.log('');
    console.log('The app would report "Email is not set up" (HTTP 503) rather than a 401.');
    console.log('Add RESEND_API_KEY to the .env next to docker-compose.yml, then:');
    console.log('  docker compose up -d --force-recreate app');
    process.exit(1);
  }

  const notes = describeKey(raw);
  console.log('RESEND_API_KEY: set');
  console.log(`  length:  ${raw.length}${raw.length === 36 ? '' : '   (a Resend key is normally 36)'}`);
  console.log(`  starts:  ${raw.slice(0, 8)}...`);
  console.log(`  format:  ${notes.length === 0 ? 'looks well-formed' : 'SUSPICIOUS'}`);
  for (const n of notes) console.log(`           - ${n}`);

  const from = process.env.MAIL_FROM ?? 'WhatsApp <onboarding@resend.dev>';
  const to = process.env.MEDIA_EMAIL_TO ?? 'swenlly123@gmail.com';
  console.log(`MAIL_FROM:      ${from}${process.env.MAIL_FROM ? '' : '   (default)'}`);
  console.log(`MEDIA_EMAIL_TO: ${to}`);

  console.log('\nSending a test email through Resend...');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${raw}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject: 'Resend test from the WhatsApp app', text: 'If you are reading this, outgoing email works.' }),
    signal: AbortSignal.timeout(15_000),
  });

  const detail = await res.text().catch(() => '');
  console.log(`HTTP ${res.status}`);
  console.log(detail);
  console.log('');

  if (res.ok) {
    console.log(`PASS - Resend accepted it. Check ${to} (including spam).`);
    console.log('If the app itself still fails, its container is running with an older');
    console.log('environment than this test. Fix with:');
    console.log('  docker compose up -d --force-recreate app');
    return;
  }

  if (res.status === 401) {
    console.log('FAIL - Resend does not recognise this key. The key is the problem, not the');
    console.log('message. Either it was deleted/rotated on resend.com/api-keys, or it belongs');
    console.log('to a different account. Create a new key, copy it from the creation dialog');
    console.log('(the list only shows a masked version), put it in .env, then:');
    console.log('  docker compose up -d --force-recreate app');
  } else if (res.status === 403) {
    console.log('FAIL - The key is valid, but this "from" address is not allowed.');
    console.log(`"onboarding@resend.dev" can only deliver to the Resend account owner's address.`);
    console.log('Verify a domain at resend.com/domains and set MAIL_FROM to an address on it.');
  } else if (res.status === 422) {
    console.log('FAIL - Resend rejected the message contents (see the detail above).');
  } else {
    console.log('FAIL - see the response above.');
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
