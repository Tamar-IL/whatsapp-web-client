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
│   └── 04-deploy-hetzner.md    How the app runs on the private server
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

## Signing in

- Email + password (the eye button shows/hides the password).
- **Forgot password?** Click "Forgot password? Email me a code" on the login
  page. A 6-digit code is emailed to `ADMIN_EMAIL` (no need to type the email).
  It works once, expires after 10 minutes and locks after 5 wrong tries. It uses
  the same email setup as the rest of the app (SMTP, or Resend as a fallback).
- To actually change the password, run `npm run hash-password` and update
  `ADMIN_PASSWORD_HASH` in `.env` — the app resets the password from that value
  on every start.

## Status

In use on the private server. Chats, media, voice notes, templates, quick
replies, scheduled messages, email of media and email-code sign-in all work.
`docs/01`–`03` are the original design notes and still mention Railway; the
current deployment is described in `docs/04-deploy-hetzner.md`.
