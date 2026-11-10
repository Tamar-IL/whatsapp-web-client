/* eslint-disable no-console */
// Diagnose outgoing email. Shows which transport the app will pick (Zoho SMTP or
// Resend), then attempts one real send so the provider's own answer is visible.
// Usage:  npm run mail-check          (local)
//         docker compose run --rm app npm run mail-check     (server)
import 'dotenv/config';
import nodemailer from 'nodemailer';

function describeSecret(raw: string): string[] {
  const notes: string[] = [];
  if (raw !== raw.trim()) notes.push('has leading/trailing whitespace');
  if (/["']/.test(raw)) notes.push('contains quote characters — .env values need no quotes');
  if (/\r/.test(raw)) notes.push('contains a carriage return (Windows line ending)');
  if (/\s#/.test(raw)) notes.push('looks like an inline # comment leaked in');
  if (raw.includes('…') || raw.includes('...')) notes.push('contains "…" — looks like a masked value copied from a dashboard');
  return notes;
}

async function checkSmtp(user: string, pass: string) {
  const host = process.env.SMTP_HOST ?? 'smtp.zoho.com';
  const port = Number(process.env.SMTP_PORT ?? 465);
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465;
  const from = process.env.MAIL_FROM || user;
  const to = process.env.MEDIA_EMAIL_TO ?? 'swenlly123@gmail.com';

  console.log('Transport:      SMTP (SMTP_USER + SMTP_PASS are set)');
  console.log(`  host/port:    ${host}:${port}  (secure=${secure})`);
  console.log(`  user:         ${user}`);
  console.log(`  pass:         set, length ${pass.length}`);
  for (const n of describeSecret(pass)) console.log(`                - ${n}`);
  console.log(`MAIL_FROM:      ${from}${process.env.MAIL_FROM ? '' : '   (defaults to SMTP_USER)'}`);
  console.log(`MEDIA_EMAIL_TO: ${to}`);

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  console.log('\nVerifying the connection and login...');
  try {
    await transporter.verify();
    console.log('Login OK.');
  } catch (err) {
    const e = err as { message?: string; code?: string; responseCode?: number };
    console.log(`FAIL - ${e.message ?? err}`);
    console.log('');
    if (e.code === 'ETIMEDOUT' || e.code === 'ESOCKET' || e.code === 'ECONNECTION') {
      console.log('Could not reach the SMTP server. Either the host blocks outbound SMTP,');
      console.log(`or ${host}:${port} is wrong. Try port 587 with SMTP_SECURE=false.`);
    } else if (e.responseCode === 535 || e.responseCode === 534) {
      console.log('Zoho rejected the credentials. With 2FA on the account, SMTP_PASS must be');
      console.log('an APP-SPECIFIC password (Zoho > My Account > Security > App Passwords),');
      console.log('not the normal login password. SMTP_USER must be the full email address.');
      console.log('Zoho EU accounts use smtp.zoho.eu instead of smtp.zoho.com.');
    }
    process.exitCode = 1;
    return;
  }

  console.log('Sending a test email...');
  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject: 'SMTP test from the WhatsApp app',
      text: 'If you are reading this, outgoing email works.',
    });
    console.log(`PASS - accepted: ${info.response ?? 'ok'}`);
    console.log(`Check ${to} (including spam).`);
    console.log('If the app itself still fails, its container is running with an older');
    console.log('environment than this test. Fix with:');
    console.log('  docker compose up -d --force-recreate app');
  } catch (err) {
    const e = err as { message?: string; responseCode?: number };
    console.log(`FAIL - ${e.message ?? err}`);
    if (e.responseCode === 553 || e.responseCode === 550) {
      console.log('');
      console.log('The login worked but Zoho refused the "from" address. MAIL_FROM must be an');
      console.log('address the account is allowed to send as (usually exactly SMTP_USER).');
    }
    process.exitCode = 1;
  }
}

async function checkResend(key: string) {
  const from = process.env.MAIL_FROM ?? 'WhatsApp <onboarding@resend.dev>';
  const to = process.env.MEDIA_EMAIL_TO ?? 'swenlly123@gmail.com';

  console.log('Transport:      Resend (SMTP is not configured)');
  console.log(`  key length:   ${key.length}${key.length === 36 ? '' : '   (a Resend key is normally 36)'}`);
  console.log(`  key starts:   ${key.slice(0, 8)}...`);
  for (const n of describeSecret(key)) console.log(`                - ${n}`);
  if (!key.startsWith('re_')) console.log('                - does not start with "re_"');
  console.log(`MAIL_FROM:      ${from}${process.env.MAIL_FROM ? '' : '   (default)'}`);
  console.log(`MEDIA_EMAIL_TO: ${to}`);

  console.log('\nSending a test email through Resend...');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject: 'Resend test from the WhatsApp app', text: 'If you are reading this, outgoing email works.' }),
    signal: AbortSignal.timeout(15_000),
  });

  const detail = await res.text().catch(() => '');
  console.log(`HTTP ${res.status}`);
  console.log(detail);
  console.log('');

  if (res.ok) {
    console.log(`PASS - Resend accepted it. Check ${to} (including spam).`);
    return;
  }
  if (res.status === 401) {
    console.log('FAIL - Resend does not recognise this key. Set SMTP_USER/SMTP_PASS to use');
    console.log('Zoho SMTP instead, which takes priority over Resend.');
  } else if (res.status === 403) {
    console.log('FAIL - The key is valid, but this "from" address is not allowed.');
  } else {
    console.log('FAIL - see the response above.');
  }
  process.exitCode = 1;
}

async function main() {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  const key = process.env.RESEND_API_KEY?.trim();

  console.log('');
  if (user && pass) {
    await checkSmtp(user, pass);
    return;
  }
  if (key) {
    if (user || pass) {
      console.log(`NOTE: only ${user ? 'SMTP_USER' : 'SMTP_PASS'} is set — SMTP needs both, so it is being skipped.\n`);
    }
    await checkResend(key);
    return;
  }

  console.log('No email transport is configured for this process.');
  console.log('The app would report "Email is not set up" (HTTP 503).');
  console.log('');
  console.log('Add these to the .env next to docker-compose.yml:');
  console.log('  SMTP_HOST=smtp.zoho.com');
  console.log('  SMTP_PORT=465');
  console.log('  SMTP_USER=you@yourdomain.com');
  console.log('  SMTP_PASS=<Zoho app-specific password>');
  console.log('then:  docker compose up -d --force-recreate app');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
