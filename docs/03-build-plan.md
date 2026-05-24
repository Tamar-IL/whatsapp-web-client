# Build Plan — Phased Ticket List

Ordered to reach a usable product fast, then layer on features. Each ticket has: **goal · acceptance criteria · estimate (S/M/L)**. Treat estimates as "an engineer who knows the stack, working full days." Tickets are designed to be handed to Claude Code one at a time.

> **Read first:** `01-spec-review.md` (decisions to lock in) and `02-deep-dives.md` (implementation patterns).

---

## Phase 0 — Decisions & spikes (1 week)

Before any code. Output: a `decisions.md` and 6 working spikes against a real Twilio account.

| # | Ticket | Acceptance | Size |
|---|---|---|---|
| 0.1 | **Lock product name + logo + domain** | Name and logo file checked in. Domain purchased, registrar access confirmed. | S |
| 0.2 | **Provision Twilio account + sandbox WhatsApp** | Account SID, Auth Token, Conversation Service SID, Messaging Service SID, WhatsApp Sender stored in a 1Password vault. Sandbox number can send/receive. | S |
| 0.3 | **Spike: signature verification** | Local server with ngrok receives a Twilio webhook and verifies the signature. Documented `PUBLIC_BASE_URL` strategy. | S |
| 0.4 | **Spike: send + receive text** | Round-trip text via Conversations API. Webhook handler logs the upsert. | S |
| 0.5 | **Spike: send + receive media (image, voice)** | Pre-upload media SID path works for image. ffmpeg WebM→OGG path tested locally with the actual blob a browser produces. | M |
| 0.6 | **Spike: Content API templates with variables** | Approved template sent with 2 variables. UI mockup of variable-fill modal. | S |
| 0.7 | **Spike: reactions** | Send and receive a reaction. Document the exact API call. If unsupported, note the fallback (display-only inbound). | M |
| 0.8 | **Spike: conversation auto-creation behaviour** | Confirm `onConversationAdded` + `onMessageAdded` ordering on first message from a new number. | S |
| 0.9 | **Decision doc** | One-pager: queue choice, single-replica yes/no, session storage, CSRF approach, template API (Content vs legacy), reactions verdict, media storage (Volume vs S3). | S |

**Exit criteria:** decisions.md committed. Twilio works end-to-end in a 50-line script.

---

## Phase 1 — Infrastructure (1 week)

| # | Ticket | Acceptance | Size |
|---|---|---|---|
| 1.1 | **Monorepo scaffold** | `apps/backend`, `apps/frontend`, root `package.json` workspaces. TypeScript everywhere. ESLint + Prettier. Husky pre-commit. | S |
| 1.2 | **Backend skeleton** | Express app, `GET /healthz`, `GET /readyz` (DB ping). Pino logger with request IDs. Graceful shutdown. | S |
| 1.3 | **Frontend skeleton** | Vite + React + TS + Tailwind. `/login` and `/app` routes. Empty shell renders. | S |
| 1.4 | **Prisma schema v1** | All entities from §4 of the spec + `OutboxEvent` + `User` + `Session`. Initial migration committed. | M |
| 1.5 | **Postgres on Railway + connection** | DATABASE_URL works locally and in Railway. Migrations run on deploy via `prisma migrate deploy`. | S |
| 1.6 | **Auth: bootstrap user + login** | `ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH` env. `POST /api/auth/login` returns session cookie. `POST /api/auth/logout`. `GET /api/me`. Rate-limited login. | M |
| 1.7 | **Auth middleware + CSRF** | All `/api/*` routes (except `/api/auth/*`) require session. `X-CSRF-Token` enforced on mutating methods. | S |
| 1.8 | **Frontend login flow** | Login form posts cookies. Redirect to `/app` on success. Auth context provides `user`. Logout button. | S |
| 1.9 | **Domain + Railway deploy** | App live at `https://<user-domain>`. HTTPS healthy. Domain approved in Netfree. | M |
| 1.10 | **Env validation** | `zod` schema validates required env at boot. Missing var = crash with a clear message. | S |

**Exit criteria:** logged-in user sees an empty `/app` page on a public, Netfree-approved domain.

---

## Phase 2 — Twilio connection (1 week)

| # | Ticket | Acceptance | Size |
|---|---|---|---|
| 2.1 | **TwilioGateway abstraction** | Interface from deep-dive §1. Real impl for Conversations API. Fake impl for tests. Wired via DI container. | M |
| 2.2 | **Webhook routes (signature + idempotency)** | `POST /webhooks/twilio/conversations` verifies signature, parses payload, returns 200 within 1s. Replay-safe. | M |
| 2.3 | **Inbound text message flow** | Webhook → upsert `Contact` + `Conversation` + `Message`. `OutboxEvent` row written. Console log shows the flow. | M |
| 2.4 | **Outbound text endpoint** | `POST /api/messages { conversationId, body, clientId }` → enforces 24h window → calls `TwilioGateway.sendText` → returns optimistic message row. | M |
| 2.5 | **Status callback handler** | `POST /webhooks/twilio/status` updates `Message.status` monotonically. | M |
| 2.6 | **Job queue (pg-boss)** | pg-boss configured. Worker process. Two demo jobs: `noop` and `download-media`. | S |
| 2.7 | **Webhook → job: media download** | Inbound media: webhook enqueues `download-media`; worker downloads from Twilio, stores on disk/S3, updates `Message.media_url`. | M |
| 2.8 | **Twilio error map** | 63016, 63018, 21408, 21610, ... → human-readable strings. Returned in `POST /api/messages` 4xx body. | S |

**Exit criteria:** with the system running, sending a WhatsApp message from a phone shows up in Postgres. `curl POST /api/messages` (with cookie + CSRF) sends a real WhatsApp back.

---

## Phase 3 — Basic interface (1.5 weeks)

| # | Ticket | Acceptance | Size |
|---|---|---|---|
| 3.1 | **Conversation list API** | `GET /api/conversations?limit&cursor` paginated, sorted by `last_message_at` desc, pinned first. | M |
| 3.2 | **Messages API** | `GET /api/conversations/:id/messages?before&limit` reverse chrono for scrollback. | M |
| 3.3 | **Mark read API** | `POST /api/conversations/:id/read` zeroes `unread_count`, emits outbox event. | S |
| 3.4 | **WebSocket gateway** | Socket.IO on `/realtime`. Cookie auth. Subscribe with `sinceEventId`, replay outbox, join `live` room. | L |
| 3.5 | **Realtime broadcast on outbox writes** | Transactional outbox publisher: after commit, broadcast new events to the `live` room. | M |
| 3.6 | **Frontend: chat list** | Two-column layout. Chat list with name, last preview, time, unread badge. Sorted/pinned per server. Search field (client-side filter for v1). | L |
| 3.7 | **Frontend: conversation view** | Bubbles per spec §5.2 colors. Outbound right + green, inbound left + white. Status ticks. Date separators. | L |
| 3.8 | **Frontend: input bar (text only)** | Multiline textarea. Enter to send (Shift+Enter newline). Optimistic bubble. Disabled when WS disconnected. | M |
| 3.9 | **Frontend: realtime wiring** | `useSocket` hook. Reducer applies `message.added` / `message.updated` / `conversation.updated` to local state. `lastEventId` in localStorage. | L |
| 3.10 | **Frontend: reconnect banner** | Disconnected → yellow "Reconnecting..." banner + disabled send. Reconnected → resync via outbox + green dot. | M |
| 3.11 | **Empty + loading states** | No conversation selected → friendly empty illustration. Loading skeletons in list and view. | S |
| 3.12 | **Browser notifications + sound** | `Notification.requestPermission` on first user action. Notify on `message.added` when tab not focused. Toggle in settings. | M |

**Exit criteria:** send and receive text messages live, two browsers open at once stay in sync, refreshing the page restores state cleanly.

---

## Phase 4 — Media (1 week)

| # | Ticket | Acceptance | Size |
|---|---|---|---|
| 4.1 | **Authenticated media endpoint with Range** | `GET /api/media/:id` validates session, supports `Range`, sets `Content-Disposition` and `Content-Type`. | M |
| 4.2 | **Outbound media upload** | `POST /api/messages/media` accepts multipart, validates size+MIME, enqueues `send-media`. | M |
| 4.3 | **Worker: send-media job** | ffprobe metadata, upload to Twilio media SID, send via gateway, update Message. | M |
| 4.4 | **Frontend: attach file UX** | Paperclip menu (Image / Video / Document). Preview before send. Progress bar via XHR. | M |
| 4.5 | **Frontend: media bubble (image/video)** | Inline image/video with placeholder for Netfree review per deep-dive §5. Always shows name + size + mime. Download button. | L |
| 4.6 | **Frontend: document card** | Icon + filename + size + download. Distinct from image. | S |
| 4.7 | **Frontend: shared media side panel** | Slide-out panel listing all media in a conversation (chronological grid). | M |

**Exit criteria:** send and receive images, video, docs. Render correctly when Netfree allows and when it blocks. Download always works.

---

## Phase 5 — Voice + emoji + reactions (1 week)

| # | Ticket | Acceptance | Size |
|---|---|---|---|
| 5.1 | **Worker: send-voice job** | ffmpeg conversion per deep-dive §3. Upload + send via gateway. | M |
| 5.2 | **Voice upload endpoint** | `POST /api/messages/voice` accepts multipart audio (webm or mp4), enqueues `send-voice`. | M |
| 5.3 | **Frontend: voice recording UI** | Press-and-hold or click-to-toggle. Timer. Cancel + send buttons. Capped at 16 min. | L |
| 5.4 | **Frontend: voice bubble** | Inline player with play/pause, scrubber, duration. Waveform optional. | M |
| 5.5 | **Frontend: emoji picker** | Open source picker (e.g., `emoji-mart`). Keyboard shortcut `:` to open. Insertion at caret. | M |
| 5.6 | **Reactions API + outbox event** | `POST /api/messages/:id/reaction { emoji }`. If gateway supports send, call it. Webhook handler for inbound reactions. | M |
| 5.7 | **Frontend: reactions UX** | Hover to reveal "react" button. Reactions chip beneath bubble. Tap own reaction to remove (if supported). | M |

**Exit criteria:** voice recording works end-to-end on Chrome, Edge, Firefox. Voice plays back. Reactions visible per spike outcome.

---

## Phase 6 — 24h window + templates (3-4 days)

| # | Ticket | Acceptance | Size |
|---|---|---|---|
| 6.1 | **24h window helper + server enforcement** | Pure function `windowState(conv)`. Outbound text endpoint enforces. Returns `WINDOW_CLOSED` 409 with helpful message. | S |
| 6.2 | **Frontend: window indicator (live)** | Green "24h window open · closes in 3h 12m" badge in conversation header. Ticks every minute. Re-renders on inbound. | M |
| 6.3 | **Templates list endpoint + cache** | `GET /api/templates` proxies Content API, caches for 5 min. | M |
| 6.4 | **Frontend: template modal** | Search/select template. Variable fields with examples. Live preview. Submit. | L |
| 6.5 | **Send template endpoint** | `POST /api/templates/send { conversationId, contentSid, variables }`. Validates against template schema. | M |
| 6.6 | **Input bar fallback when window closed** | Free-form input disabled, replaced by "Send template" button that opens 6.4. | S |

**Exit criteria:** opening a conversation that has never sent inbound → only template option available. Sending a template successfully opens the 24h window for next message.

---

## Phase 7 — Polish (1 week)

| # | Ticket | Acceptance | Size |
|---|---|---|---|
| 7.1 | **Contact panel + name editing** | Side panel shows phone, profile name, custom name (editable), opt-out flag, creation date. | M |
| 7.2 | **Conversation actions** | Pin, archive, mark unread, delete (soft) — round-trip via API. Right-click / hover-menu in list. | M |
| 7.3 | **Server-side search** | Postgres `tsvector` GIN index on messages.body. `GET /api/search?q=` returns conversations + snippet. | M |
| 7.4 | **Settings screen** | Twilio status (read-only), theme toggle, sound on/off, notifications enable, opt-out display preference. | M |
| 7.5 | **Audit log (minimal)** | `AuditEvent` table. Login, message sent, template sent. `/api/audit` for the user to see their own actions. | S |
| 7.6 | **Backup job** | Nightly `pg_dump` to S3/B2. Documented restore procedure. | M |
| 7.7 | **Error tracking (Sentry)** | Both apps wired to Sentry. Source maps uploaded. | S |
| 7.8 | **Friendly Twilio error messages in UI** | Map from 7.8 of Phase 2 surfaced as toasts/banners. | S |
| 7.9 | **Browser sound + favicon badge** | Notification sound (toggleable). Unread count in favicon. | S |
| 7.10 | **End-to-end smoke test** | Playwright: login → receive a message → send a reply → record voice → send template. Runs in CI. | L |

**Exit criteria:** ready to hand to the end user. All P1 items from `01-spec-review.md` addressed.

---

## Future (not in v1)

- Mobile / PWA optimization
- Multi-user + role-based permissions
- Multi-number support
- Quick replies / canned responses
- Auto-responder rules
- Conversation tags
- Call support (Twilio voice WhatsApp, GA in 2025)
- 2FA / TOTP

---

## Total estimate

| Phase | Span |
|---|---|
| 0. Spikes | 1 week |
| 1. Infra | 1 week |
| 2. Twilio | 1 week |
| 3. UI v1 | 1.5 weeks |
| 4. Media | 1 week |
| 5. Voice + emoji + reactions | 1 week |
| 6. Window + templates | 3-4 days |
| 7. Polish | 1 week |
| **Total** | **~7-8 weeks** for a single engineer |

Compressible to ~5 weeks if Phase 4 + 5 are parallelizable across two devs (they barely overlap).

---

## What ships at each phase

| End of phase | What the user can do |
|---|---|
| 1 | Log in to an empty app on the approved domain |
| 2 | Nothing visible; backend can send/receive |
| 3 | Use the app for text-only conversations, live |
| 4 | Send and receive any media |
| 5 | Voice messages, emoji, reactions |
| 6 | Template messages for outside the 24h window |
| 7 | Daily use as a primary tool |
