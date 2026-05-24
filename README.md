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
│   └── 03-build-plan.md        Phase-by-phase ticket plan
├── apps/
│   ├── backend/                Express + TypeScript + Prisma + Socket.IO
│   └── frontend/               Vite + React + TypeScript + Tailwind
├── nixpacks.toml               Railway build config (ffmpeg)
├── railway.json                Railway service config
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
- **Deploy**: Railway (Nixpacks), single replica, custom domain

## Environment variables

See `apps/backend/.env.example` for the full list with comments. Critical:

- `PUBLIC_BASE_URL` — your approved domain (used for Twilio webhook signature verification)
- `DATABASE_URL` — Postgres connection
- `SESSION_SECRET` — random 32+ bytes
- `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` — bootstrap user
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_CONVERSATION_SERVICE_SID`, `TWILIO_WHATSAPP_SENDER`

## Deployment to Railway

1. Push to GitHub.
2. Create a Railway project, link the repo.
3. Add the PostgreSQL plugin.
4. Set environment variables (use the list above).
5. Connect a custom domain, point DNS, and **submit the domain to Netfree for approval**.
6. Railway builds via `nixpacks.toml` (includes ffmpeg).
7. Configure Twilio webhooks to point at `https://<your-domain>/webhooks/twilio/...`.

See `docs/03-build-plan.md` Phase 1 for the full deployment ticket.

## Status

Skeleton scaffolding. Phase 1 of the build plan. Most endpoints are stubs that
return 501; auth, webhook signature verification, and the Socket.IO + outbox
event scaffold are functional. Implement Phase 2+ per `docs/03-build-plan.md`.
