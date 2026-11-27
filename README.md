# WhatsApp Web Client

A standalone web client for managing a WhatsApp Business number through Twilio.
Designed to operate behind Netfree by routing all browser traffic through a single
approved domain. Built for a single user, v1.0.

> **Read the design docs first.** `docs/01-spec-review.md`, `docs/02-deep-dives.md`,
> `docs/03-build-plan.md`. They explain the *why* behind every architectural choice
> and walk through the build phase by phase.

## Quick start

```bash
# 1. Install dependencies (uses npm workspaces)
npm install

# 2. Start Postgres locally (Docker example)
docker run -d --name wweb-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=wweb \
  -p 5432:5432 postgres:16

# 3. Configure env
cp .env.example .env
cp apps/backend/.env.example apps/backend/.env
# Edit apps/backend/.env with real values

# 4. Generate Prisma client + run migrations
npm run prisma:generate
npm run prisma:migrate

# 5. Create the admin user (interactive)
npm run hash-password
# paste ADMIN_PASSWORD_HASH into apps/backend/.env

# 6. Run dev servers (backend on :3000, frontend on :5173)
npm run dev
```

Open `http://localhost:5173`, log in with `ADMIN_EMAIL` + the password you hashed.

## Layout

```
.
├── docs/                       Design documents (read these first)
│   ├── 01-spec-review.md       Surgical review of the spec
│   ├── 02-deep-dives.md        Critical subsystem deep dives
│   ├── 03-build-plan.md        Phase-by-phase ticket plan
│   ├── 04-deploy-hetzner.md    How the app runs on the private server
│   └── 05-staging.md           Test copy (staging) next to production
├── apps/
│   ├── backend/                Express + TypeScript + Prisma + Socket.IO
│   └── frontend/               Vite + React + TypeScript + Tailwind
├── deploy/Caddyfile            HTTPS reverse proxy config (server)
├── docker-compose.yml          Production stack: app + Postgres + Caddy
├── Dockerfile                  App image used by docker-compose
├── nixpacks.toml, railway.json Old Railway config (not used)
└── package.json                Workspace root
```

## Architecture summary

```
                         Netfree (approved domain)
                                  │
   ┌──────────────┐               ▼
   │  Browser     │ ─── HTTPS + WSS ───┐
   │  (Frontend)  │                    │
   └──────────────┘                    ▼
                              ┌──────────────────────┐
                              │  Backend (Express)   │ ───► Twilio (REST)
                              │  - HTTP API          │       Conversations API
                              │  - Socket.IO         │ ◄─── Webhooks (signature-verified)
                              │  - Worker (pg-boss)  │
                              └──────────────────────┘
                                        │
                                        ▼
                                  PostgreSQL
                                  + file storage volume
```

The browser only ever talks to your approved domain. The backend is the only
component that talks to Twilio. ffmpeg runs server-side for voice conversion.

## Tech stack

- **Backend**: Node 20, Express 4, TypeScript, Prisma, Socket.IO, pg-boss, Pino, Zod, bcryptjs
- **Frontend**: Vite, React 18, TypeScript, Tailwind, React Router, Socket.IO client
- **Database**: PostgreSQL 16
- **Deploy**: private server (Hetzner) with Docker Compose + Caddy, built from `main`

## Environment variables

See `apps/backend/.env.example` for the full list with comments. Critical:

- `PUBLIC_BASE_URL` — your approved domain (used for Twilio webhook signature verification)
- `DATABASE_URL` — Postgres connection
- `SESSION_SECRET` — random 32+ bytes
- `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` — bootstrap user
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_CONVERSATION_SERVICE_SID`, `TWILIO_WHATSAPP_SENDER`
- `OPENAI_API_KEY` *(optional)* — for the AI agent; can instead be pasted in Settings → AI agent

## Deployment (private server)

The app runs on a **private server** (Hetzner) with Docker Compose: the app,
PostgreSQL and Caddy (HTTPS) all run there. It is **not** deployed to Railway or
Vercel. The server builds from the **`main`** branch.

To put new changes live, merge them into `main`, then on the server:

```bash
cd whatsapp-web-client
git checkout main
git pull
docker compose up -d --build
```

Database migrations run automatically when the app starts. See
**`docs/04-deploy-hetzner.md`** for the full guide (first-time setup, `.env`,
domain + HTTPS, email, backups, troubleshooting).

## Test environment

A separate test copy (own database, Twilio WhatsApp Sandbox, orange TEST
bar) can run next to production on the same server to try a branch before it
reaches `main`. See `docs/05-staging.md`.

## Signing in

- Email + password (the eye button shows/hides the password).
- **Forgot password?** Click "Forgot password? Email me a code" on the login
  page. A 6-digit code is emailed to `ADMIN_EMAIL` (no need to type the email).
  It works once, expires after 10 minutes and locks after 5 wrong tries. It uses
  the same email setup as the rest of the app (SMTP, or Resend as a fallback).
- To actually change the password, run `npm run hash-password` and update
  `ADMIN_PASSWORD_HASH` in `.env` — the app resets the password from that value
  on every start.

## Features

Everything optional can be switched off in **Settings → Features** (⋮ menu at
the top of the chat list); a switched-off feature disappears from the UI and
nothing is deleted.

- **Chat list** — WhatsApp's default avatar (customers' real photos are not
  available through Twilio), last-message preview, pin chats, archive, mark as unread, labels with filter
  chips, filters for Unread / Needs you / AI.
- **In a chat** — pinned-messages bar, per-message menu (reply, copy, star,
  pin, forward, retry failed), search across the whole history, time left in
  the 24-hour window, export as text or print-ready PDF, contact panel with
  name, email, notes, labels and opt-out.
- **Voice messages** — 1× / 1.5× / 2× playback speed, default set in Settings.
- **Writing** — saved replies with `/shortcut`, ✨ AI draft, schedule files as
  well as text.
- **Templates manager** — list with Meta status (approved / pending /
  rejected + reason), filters, copy, duplicate, delete, create (text, quick
  replies, link / call buttons) and submit for approval; a background watcher
  announces when Meta decides.
- **Bulk send** — one approved template to many chats with `{name}` /
  `{first}` / `{phone}` tokens, label filter, live report, stop button.
- **Away message** — automatic reply outside business hours (or always), with
  a per-chat cooldown.
- **AI agent (OpenAI)** — switched on per chat, with its own instructions and
  “good to know” customer info; permanent or for a date range; any time /
  only inside / only outside business hours; replies by itself or drafts for
  you; daily cap; pauses after you reply by hand; hands the chat to you
  (“Needs you”) when it lacks information. Global business info, house rules,
  model and master switch in Settings → AI agent.
- **AI actions** — things the AI may look up before answering: a MailerLite
  account (campaign open / click rates, groups, subscribers) or any HTTP
  endpoint / webhook you define (URL with `{parameters}`, secret headers kept
  on the server, a Test button). Each action is either for your own **Ask AI**
  assistant only, or also allowed in customer chats.
- **Ask AI** — your own assistant (✨ at the top of the chat list), can read the
  open chat and use every enabled action.
- **WhatsApp profile** — name, photo, about, description, address, category,
  email and website through Twilio's Senders API.
- **Contacts** — CSV import / export.

Reactions are shown when customers send them but cannot be sent: Twilio has no
API for it.

## Status

In use on the private server. Chats, media, voice notes, templates, quick
replies, scheduled messages, email of media and email-code sign-in all work.
`docs/01`–`03` are the original design notes and still mention Railway; the
current deployment is described in `docs/04-deploy-hetzner.md`.
