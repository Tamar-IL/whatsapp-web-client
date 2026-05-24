# Spec Review — WhatsApp Web Client v1.0

Surgical review of `whatsapp_web_spec_EN.docx`. Calls out what's missing, what's risky, and what to harden **before** Phase 1.

Legend: **🔴 must fix before building** · **🟡 fix during build** · **🟢 nice-to-have / future**

---

## 1. Architecture & infrastructure

### 🔴 R1. No background job system specified
**Problem.** Several flows demand async work that must NOT block a request:
- Downloading inbound media from Twilio (15s webhook ack budget — Twilio retries otherwise).
- Re-trying failed outbound sends.
- Reconciling status callbacks that arrive out of order.
- ffmpeg conversion of voice recordings (CPU-bound, seconds).

**Fix.** Pick a queue. Two viable options:
- **BullMQ + Redis** (Railway has a Redis plugin). Robust, retry/backoff, dashboards.
- **pg-boss** (uses Postgres, no new infra). Simpler, fewer moving parts. Recommended for v1.0.

Add a "Jobs" entity to §4 of the spec and a `worker` process to the Railway services.

### 🔴 R2. Single-instance assumption is hidden
The spec talks about Railway deployment but doesn't say "1 replica only." If horizontally scaled:
- WebSocket fan-out breaks without a Redis adapter for Socket.IO.
- The job queue must coordinate (pg-boss does; ad-hoc setTimeouts don't).
- Webhook ordering is now even less guaranteed.

**Fix.** Either (a) explicitly state "single replica" and document the scaling-path debt, or (b) pick `socket.io-redis-adapter` + pg-boss/BullMQ from day one. **(a) is fine for v1.0.**

### 🟡 R3. Real-time reconnection has no resync protocol
§5.6 says "reconnects automatically" — but reconnect alone isn't enough. If the socket drops for 30s and 3 messages arrive in that window, the client never sees them.

**Fix.** Define a resync handshake:
1. Client stores `lastEventId` per conversation (or one global cursor).
2. On reconnect, client sends `{ since: <lastEventId> }` in the upgrade query or first message.
3. Server replays everything since that cursor before resuming live push.
4. Server emits monotonically increasing event IDs (a `bigserial` events table or `(timestamp, message_id)` tuples).

### 🟡 R4. Storage retention policy is missing
§8.3 says "periodic backup." Nothing says when media is deleted, or whether it ever is. For a single-user system this might be "never," but it should be a documented choice — otherwise the disk fills silently in year 2.

**Fix.** Pick one of: indefinite, age-based purge, size-cap LRU. Document.

---

## 2. Twilio integration

### 🔴 T1. Conversation Service SID is missing from required config
§7.1 lists Account SID, Auth Token, and "WhatsApp number." For the **Conversations API** (which the spec recommends in §3.6) you also need:
- `TWILIO_CONVERSATION_SERVICE_SID` (groups conversations under a service)
- `TWILIO_MESSAGING_SERVICE_SID` (for outbound; can be the Conversation Service's default messaging service)
- `TWILIO_WHATSAPP_SENDER` (the `whatsapp:+E.164` address)

Add these to §7.1.

### 🔴 T2. Webhook signature verification has subtle failure modes on Railway
Twilio's signature is computed over `full_url + sorted_form_params`. Behind Railway's proxy:
- `req.protocol` is `http`, not `https`, unless you trust `X-Forwarded-Proto`.
- The reconstructed URL must match what Twilio called *exactly*, including any base path.
- Body must be `application/x-www-form-urlencoded` raw — if a middleware mutates it, verification fails.

**Fix.** Be explicit in the spec: trust proxy, use `req.originalUrl` against a configured `PUBLIC_BASE_URL`, mount Twilio webhooks BEFORE any JSON-body middleware. Add a webhook-replay endpoint behind admin auth so developers can re-verify a request from logs.

### 🔴 T3. Idempotency is not addressed
Twilio retries webhooks (up to ~7 times across 6 hours, with backoff) until you return 2xx. The spec doesn't say to dedupe.

**Fix.** Put a `UNIQUE` constraint on `Message.twilio_sid` and `UPSERT` on every inbound webhook. Webhooks that re-fire after a partial failure should never duplicate messages.

### 🟡 T4. Status update ordering and partial states
Inbound flow returns `received`; outbound progresses through `queued → sent → delivered → read`. Twilio status callbacks can arrive **out of order** (especially `delivered` and `read`). If you write blindly you could regress `read` back to `delivered`.

**Fix.** Define a monotonic status ladder and an UPDATE rule: never downgrade. Concretely:
```sql
UPDATE messages SET status = $1 WHERE id = $2 AND status_rank($1) > status_rank(status)
```

### 🟡 T5. The two webhook payload shapes
Conversations API uses `EventType=onMessageAdded` with `ConversationSid`, `MessageSid`, `Author`, `Body`, `Media`. Programmable Messaging uses a different envelope (`From`, `To`, `Body`, `NumMedia`, `MediaUrl0`...). The spec recommends Conversations but mentions Programmable Messaging as a fallback — the parser must know which.

**Fix.** Versioned webhook handlers — `/webhooks/twilio/conversations/*` and `/webhooks/twilio/programmable/*` — never one endpoint that tries to autodetect.

### 🟡 T6. Reactions support: state of play in 2025
Reactions on the **Programmable Messaging API** are supported (Twilio added `MessagingServiceSid` + `MessageType=reaction` flows). On the **Conversations API** they remain limited and version-dependent. The spec correctly flags this — but mandate a Phase-0 spike to confirm BEFORE building the UI affordance.

**Fix.** Add a "Day-1 spike" task: send and receive a reaction with the planned API; record the outcome.

### 🟢 T7. Twilio Content API for templates
For templates with placeholders, Twilio's **Content API** is the modern path (Content SID + `ContentVariables` JSON). Worth using over the legacy `body` + `parameters` approach.

---

## 3. Data model

### 🔴 D1. `last_inbound_at = NULL` semantics
§4.2 has `last_inbound_at` but §2.1 + §5.3 + §7.3 use it to determine the 24h window. For a contact the **user** initiated (no inbound yet), `last_inbound_at IS NULL` → the window must be treated as **closed** (template required). Spec doesn't say this explicitly.

**Fix.** Helper: `windowOpenUntil = last_inbound_at ? last_inbound_at + 24h : null`. UI shows "Template required" whenever the helper returns null OR is in the past.

### 🔴 D2. Reaction model can't represent removal
WhatsApp lets a user remove their reaction. The spec's Reaction table can't express that — `emoji` is required, no `removed_at`.

**Fix.** Either:
- Add `removed_at` column + treat the latest row per `(message_id, direction)` as the current reaction.
- Or store `emoji = NULL` to mean "removed."

### 🔴 D3. Status enum mixes directions
The §4.3 `status` enum lists both `received` (inbound) and `sent/delivered/read/failed` (outbound). Workable, but easy to misuse.

**Fix.** Either split into `inbound_status` + `outbound_status`, or document strictly: "for `direction=inbound`, status is always `received` or `read`; for `outbound`, the rest."

### 🟡 D4. Message ordering: use `DateSent`, not arrival time
If you sort by `created_at` (server insert time), out-of-order webhooks shuffle history.

**Fix.** Add a separate `sent_at` (from Twilio's `DateSent`) used for display ordering. Keep `created_at` for audit.

### 🟡 D5. No `Template` placeholder model
§4.5 says templates have "body with placeholders" but doesn't model the placeholders. The UI in §5.5 needs to know how many vars + their names/positions.

**Fix.** `Template.variables jsonb` — array of `{ name, example }` parsed from the Content API.

### 🟡 D6. Conversation needs a Twilio identifier
For Conversations API, you'll need `Conversation.twilio_conversation_sid` to send messages.

### 🟢 D7. Soft delete for conversations
Currently `is_archived` exists. No `deleted_at`. Probably fine — leave as is — but note for future.

---

## 4. UI / UX

### 🔴 U1. Netfree image scanning applies to your own server too
§2.4 correctly identifies the issue but the implication is understated: **media served from your approved domain is STILL scanned by Netfree** (Netfree inspects content in the browser, not by URL). Hosting media on the approved domain doesn't bypass scanning.

**Fix.** Spell this out so no one wastes a sprint thinking "if we proxy it, it's fine." Also: design the media placeholder to communicate this state (e.g., "Awaiting content review" instead of a generic loading spinner).

### 🟡 U2. 24-hour window indicator must be live
§5.3 mentions an indicator, but a chat opened 23h59m ago needs to update to "closed" in the UI without a manual refresh.

**Fix.** Either (a) tick a timer client-side, or (b) push a `window-closed` event from the server at the deadline.

### 🟡 U3. Outbound queue when WS is down
Spec assumes online send. If the WebSocket is briefly disconnected (Netfree quirks, brief outage), the user might type a message before the socket reconnects.

**Fix.** Decide: block the send button when disconnected (simple) OR queue locally with optimistic UI (complex, can desync). Recommend **block + clear "reconnecting" banner** for v1.0.

### 🟡 U4. Optimistic send + reconcile
For sent messages: render the bubble immediately with a local `tmp-` id and "sending..." indicator; reconcile with Twilio SID when the API returns.

### 🟢 U5. File size + type validation
WhatsApp limits per the platform:
- Image: 5 MB (jpeg, png)
- Video: 16 MB (mp4, 3gpp)
- Audio: 16 MB (aac, mp4, mpeg, amr, ogg/opus)
- Document: 100 MB (pdf, doc, ppt, xls)
- Voice (PTT): ogg/opus, ≤16 MB

Validate client-side (immediate feedback) AND server-side (security). Spec doesn't mention these limits.

### 🟢 U6. Search performance
"Free-text search by message content" via `LIKE %q%` works until you have ~50k messages. With Postgres, set up `tsvector` + GIN from day one — it's cheap.

---

## 5. Security

### 🔴 S1. Auth is one line of spec
§8.1 says "login (password / session)." That's not enough for a public-internet system. Specify:
- Password hashing: **bcrypt cost 12+** or **argon2id**.
- Session storage: HTTP-only, Secure, SameSite=Lax cookies; signed; rotating secret.
- Bootstrap: env-driven first-user creation (`ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH`) — never a public signup endpoint.
- Login rate limit (e.g., 5 attempts / 15min / IP).
- Optional but recommended: TOTP 2FA. Cheap to add later if the model is right now.

### 🔴 S2. WebSocket auth not specified
How does the WS connection authenticate? Without an answer it'll get bolted on insecurely.

**Fix.** Cookie-based: Socket.IO uses the same cookie as HTTP — works out of the box with the session middleware. Document this and test that `withCredentials: true` is set client-side.

### 🔴 S3. CSRF for state-changing endpoints
Cookie sessions + state-changing endpoints (`POST /api/messages`, `PATCH /api/contacts/:id`) require CSRF protection.

**Fix.** Double-submit token (custom `X-CSRF-Token` header validated server-side) OR rely on `SameSite=Lax` + a same-origin check. Document the choice.

### 🟡 S4. Authenticated media endpoint — range requests
§3.5 says serve media authenticated. For video to scrub, the endpoint must support HTTP **Range** requests. Express's `res.sendFile` does; a naive `fs.readFile + res.send` doesn't.

### 🟡 S5. Webhook endpoints are NOT session-authenticated
Obvious, but worth spelling out: `/webhooks/twilio/*` is authenticated by Twilio's signature, not by user session. Don't accidentally protect it with the session middleware.

### 🟢 S6. Audit log
For a system handling business communication, a minimal audit log (who logged in when, what messages were sent, template usage) is cheap insurance.

---

## 6. Deployment & operations

### 🔴 O1. Migration strategy
Prisma is recommended. Production migrations on Railway: use `prisma migrate deploy` in the release command. Spec doesn't say.

### 🟡 O2. Health check + readiness
Railway uses HTTP health checks. Add `GET /healthz` (process up) and `GET /readyz` (DB reachable, Twilio creds present).

### 🟡 O3. Structured logging
Pino or similar with request IDs. Critical for debugging webhook signature failures.

### 🟡 O4. Concrete backup plan
"Periodic backup recommended" → make it concrete: nightly `pg_dump` to S3/B2 + media volume snapshot (Railway has this).

### 🟢 O5. Error tracking
Sentry (free tier) for both frontend and backend. Cheaper than reading logs to find the bug a user is hitting.

---

## 7. Smaller items worth noting

| # | Item | Severity |
|---|------|---------|
| M1 | Define a Twilio-error-code → user-message map (63016 window-closed, 63018 rate limit, 21408 number invalid, ...) | 🟡 |
| M2 | Voice recording max length (16 min / 16 MB) — enforce client + server | 🟡 |
| M3 | MIME sniffing on uploaded media (don't trust browser `type`) | 🟡 |
| M4 | Time-zone storage: UTC in DB, display in local TZ; persist user's TZ preference | 🟢 |
| M5 | Conversation list pagination — `/api/conversations` returns paged result, not unbounded | 🟡 |
| M6 | Soft `unread_count` recomputation — denormalized + a "recompute" job in case of drift | 🟢 |
| M7 | Pin & archive should round-trip on the server, not just client state | 🟡 |
| M8 | Browser notifications need a service worker for "notify when tab is closed" — out-of-scope for v1 but note | 🟢 |
| M9 | Settings screen needs "test webhook" + "test Twilio credentials" buttons | 🟢 |
| M10 | Empty conversation render: if user opens a chat with a contact but no messages have crossed yet, show a clean state (no error). | 🟡 |

---

## Summary — what to fix before writing code

Top of the list, ordered by leverage:

1. **Pick and document the job queue** (pg-boss for v1). Affects every async flow.
2. **Webhook signature verification + idempotency** (R2-R3, T2-T3). Foundational.
3. **Auth + WS auth + CSRF** (S1-S3). Define before building any endpoint.
4. **`last_inbound_at = NULL` + status enum direction** (D1, D3). Cheap to fix in schema; expensive later.
5. **Resync protocol for WebSocket** (R3). Define the event-cursor mechanism now; bolting on later is painful.
6. **Day-1 Twilio spike** (T6). Confirm reactions support on the chosen API before drawing the UI for it.

Everything else can be addressed during the relevant phase. The above six change the **shape** of the system and need decisions up front.
