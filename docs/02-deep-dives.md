# Deep Dives — Critical Subsystems

Drilling into the seven areas with the most architectural risk. Each section: problem · model · implementation sketch · gotchas.

1. [Twilio Conversations API integration](#1-twilio-conversations-api-integration)
2. [Webhook signature verification + idempotency](#2-webhook-signature-verification--idempotency)
3. [Voice recording pipeline](#3-voice-recording-pipeline)
4. [Real-time architecture (WS auth + event cursor)](#4-real-time-architecture-ws-auth--event-cursor)
5. [Netfree-resilient media UX](#5-netfree-resilient-media-ux)
6. [24-hour window + template messaging](#6-24-hour-window--template-messaging)
7. [Auth for single-user, internet-exposed](#7-auth-for-single-user-internet-exposed)

---

## 1. Twilio Conversations API integration

### Resource model

Twilio Conversations builds a layer on top of WhatsApp:

```
Conversation Service (one per app)
  └── Conversation (one per customer phone)
       ├── Participants (your WhatsApp sender + customer's number)
       └── Messages (text, media, system events)
```

You configure **one service** in the Twilio console and store its SID. Conversations get auto-created on first inbound message **if** you've set the service's auto-creation behaviour — otherwise the system must create them explicitly.

**Recommendation for v1:** enable auto-creation server-side. Your webhook handler will receive `onConversationAdded` once, then `onMessageAdded` for the first message. Treat both as upserts.

### Key webhook events (Conversations API)

| `EventType` | When | What you do |
|---|---|---|
| `onConversationAdded` | A new conversation is created (e.g., first inbound from a new number) | UPSERT `Conversation`, link to `Contact` by phone, init `unread_count=0` |
| `onMessageAdded` | A message is added to a conversation (inbound from customer, OR outbound echo of your own send) | UPSERT `Message` by `MessageSid`, set status, enqueue media download if any |
| `onMessageUpdated` | Status change, edit, etc. | UPDATE message status (monotonic) |
| `onDeliveryUpdated` | Delivery/read receipt | UPDATE message status (monotonic) |
| `onParticipantAdded` | Rarely relevant in 1:1 WhatsApp; ignore safely | — |

**Crucial detail:** outbound messages you send via the REST API also trigger `onMessageAdded`. To avoid double-rendering an optimistic UI bubble, the client sends with a local `clientId`, the server stores it on the message row, and the echoing webhook reconciles.

### Sending a text message

```ts
// server side, called from POST /api/messages
const msg = await twilio.conversations.v1
  .services(SERVICE_SID)
  .conversations(conversationSid)
  .messages
  .create({
    author: WHATSAPP_SENDER,   // your business number, "whatsapp:+E.164"
    body: text,
  });
// msg.sid is the Twilio Message SID — store it as twilio_sid
```

### Sending media

Two ways:

- **Pre-uploaded media SID** (recommended): you upload the file to Twilio's Media Content Service first, get back a `MediaSid`, attach it. This decouples ingestion from sending and gives you a retryable path.
- **Public URL**: you give Twilio a URL it fetches. Won't work behind Netfree without making the media URL public — which violates §3.5's "authenticated endpoint" rule. **Do not use.**

Pre-upload flow:
```ts
const mediaSid = await twilio.media.uploadMedia({
  serviceSid: SERVICE_SID,
  contentType: 'image/jpeg',
  filePath,
});
await twilio.conversations.v1
  .services(SERVICE_SID)
  .conversations(conversationSid)
  .messages
  .create({ author: WHATSAPP_SENDER, mediaSid });
```

### Sending a template (outside 24h window)

Use Twilio's **Content API**:
```ts
await twilio.conversations.v1
  .services(SERVICE_SID)
  .conversations(conversationSid)
  .messages
  .create({
    author: WHATSAPP_SENDER,
    contentSid: 'HXxxx...',                   // the approved template's Content SID
    contentVariables: JSON.stringify({ 1: 'John', 2: '12345' }),
  });
```

### Reactions

Day-1 spike: run this against your Twilio account and record the result:
```ts
// outbound reaction (if supported)
await twilio.messages.create({
  from: WHATSAPP_SENDER,
  to: `whatsapp:${customerNumber}`,
  contentSid: undefined,
  // ... per current Twilio docs; APIs around reactions changed during 2024-2025
});
```
If sending reactions isn't supported on your account/region, show inbound reactions only and disable the outbound affordance.

### Abstraction layer

Put all Twilio calls behind a `TwilioGateway` interface. The rest of the app doesn't import the SDK:
```ts
interface TwilioGateway {
  sendText(conversationSid, text, clientId): Promise<{ sid: string }>;
  sendMedia(conversationSid, mediaSid, clientId): Promise<{ sid: string }>;
  sendTemplate(conversationSid, contentSid, vars, clientId): Promise<{ sid: string }>;
  uploadMedia(file): Promise<{ mediaSid: string }>;
  reactToMessage?(messageSid, emoji): Promise<void>;  // optional, feature-flagged
  fetchMedia(mediaSid): Promise<Buffer>;
}
```
This is what makes the Programmable-Messaging fallback realistic.

---

## 2. Webhook signature verification + idempotency

### Signature verification (the gotcha)

Twilio signs `URL + sorted(form params concatenated)`. Behind Railway's proxy:

```ts
// app.ts (BEFORE any json/url-encoded body parser)
app.set('trust proxy', 1);

import twilio from 'twilio';

const verify = (req: Request): boolean => {
  const sig = req.header('X-Twilio-Signature');
  if (!sig) return false;
  const url = `${PUBLIC_BASE_URL}${req.originalUrl}`;  // MUST match what Twilio called
  return twilio.validateRequest(AUTH_TOKEN, sig, url, req.body as Record<string, string>);
};

// Mount BEFORE express.json()
app.post('/webhooks/twilio/conversations',
  express.urlencoded({ extended: false }),  // local body parser, scoped to this route
  (req, res, next) => {
    if (!verify(req)) return res.status(403).send('bad signature');
    next();
  },
  handleConversationsWebhook,
);

app.use(express.json());  // global JSON parser AFTER
```

Three traps:
1. **`PUBLIC_BASE_URL`** must be your custom domain (the one Twilio is configured with), not Railway's `xxx.up.railway.app`. Hard-code via env var.
2. **Body parsing**: if `express.json()` runs first, `req.body` is mutated; signature fails. Always scope the URL-encoded parser per route.
3. **Trailing slash mismatch**: `/webhooks/twilio/conversations` vs `/webhooks/twilio/conversations/` — both must agree with Twilio's configured URL. Pick one in `app.ts`'s router and configure the same string in Twilio.

### Idempotency

Twilio retries on non-2xx, with backoff, for up to ~6 hours. Even with 2xx you can get duplicates (timeouts at Twilio).

```prisma
model Message {
  id          String  @id @default(cuid())
  twilioSid   String  @unique     // ← the magic
  ...
}
```

Handler pattern — **upsert + early-return**:
```ts
async function handleMessageAdded(payload: ConversationsWebhookPayload) {
  const { MessageSid, ConversationSid, Author, Body, Media, DateCreated } = payload;
  const existing = await prisma.message.findUnique({ where: { twilioSid: MessageSid } });
  if (existing && existing.status !== 'queued') return;  // already processed

  await prisma.$transaction(async (tx) => {
    const conv = await ensureConversation(tx, ConversationSid, Author);
    await tx.message.upsert({
      where: { twilioSid: MessageSid },
      create: {
        twilioSid: MessageSid,
        conversationId: conv.id,
        direction: directionFor(Author),
        body: Body,
        sentAt: new Date(DateCreated),
        status: 'received',
      },
      update: { /* no-op fields */ },
    });
  });

  if (Media?.length) await jobs.enqueue('download-media', { messageSid: MessageSid });
  await realtime.broadcast('message.added', { /* ... */ });
}
```

### The "ack fast" rule

Twilio expects 2xx within ~15s. Don't run media downloads or anything slow on the request thread. Webhook handler does: verify → upsert metadata → enqueue side-effects → 200 OK. Total budget: under 1 second.

### Status update monotonicity

```ts
const RANK: Record<MessageStatus, number> = {
  queued: 0, sent: 1, delivered: 2, read: 3, failed: 99,
};
// failed is terminal but separate; never downgrade FROM failed
await prisma.$executeRaw`
  UPDATE messages
  SET status = ${newStatus}, updated_at = now()
  WHERE twilio_sid = ${sid}
    AND (status_rank(status) < ${RANK[newStatus]} OR status = 'failed' AND ${newStatus} = 'failed')
`;
```
Use a Postgres function `status_rank(text) → int` so the WHERE clause is index-friendly.

---

## 3. Voice recording pipeline

### Capture in the browser

```ts
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const recorder = new MediaRecorder(stream, {
  mimeType: 'audio/webm;codecs=opus',   // best supported across Chromium/Firefox; Safari needs fallback
  audioBitsPerSecond: 32000,
});
const chunks: Blob[] = [];
recorder.ondataavailable = (e) => chunks.push(e.data);
recorder.start();
// ... later
recorder.stop();
recorder.onstop = () => {
  const blob = new Blob(chunks, { type: 'audio/webm' });
  upload(blob);
};
```

**Safari note:** Safari produces `audio/mp4` from MediaRecorder. The server must accept both and convert both.

### Upload

```ts
const form = new FormData();
form.append('file', blob, 'voice.webm');
form.append('conversationId', convId);
form.append('clientId', clientId);  // for optimistic UI reconciliation
await fetch('/api/messages/voice', { method: 'POST', body: form, credentials: 'include' });
```

Server uses `multer` (memoryStorage for small files <16MB, diskStorage for larger).

### Conversion (server-side)

WhatsApp Voice (PTT, push-to-talk) needs **OGG/Opus**, mono, with the right "PTT" hint via Twilio. ffmpeg:

```bash
ffmpeg -i input.webm \
  -c:a libopus \
  -b:a 32k \
  -application voip \
  -ac 1 \
  -ar 16000 \
  -vn \
  output.ogg
```

Wrap in Node:
```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

async function convertToOgg(input: string, output: string) {
  await execFileP('ffmpeg', [
    '-i', input,
    '-c:a', 'libopus',
    '-b:a', '32k',
    '-application', 'voip',
    '-ac', '1', '-ar', '16000', '-vn',
    output,
  ], { timeout: 60_000 });
}
```

Critical: do this **in a worker process** (the job queue), not on the request thread. ffmpeg eats CPU.

### Railway setup for ffmpeg

Nixpacks (Railway's default builder) lets you declare native deps via a `nixpacks.toml`:
```toml
[phases.setup]
nixPkgs = ["nodejs_20", "ffmpeg"]
```
Or use a Dockerfile (`apt-get install ffmpeg`) — more explicit, recommended.

### Server flow

```
POST /api/messages/voice
  ↓
1. multer accepts file → temp path
2. validate size (≤16MB), mime
3. UPSERT Message(status=queued, type=voice, clientId, ...)
4. Enqueue job 'send-voice' { messageId, srcPath }
5. Return { messageId } immediately (200 OK)
```

Worker:
```
job 'send-voice'
  ↓
1. ffmpeg convert → out.ogg
2. twilio.uploadMedia(out.ogg, 'audio/ogg') → mediaSid
3. twilio.sendMedia(conversationSid, mediaSid, clientId) → twilioSid
4. UPDATE Message SET twilio_sid=..., status='sent'
5. Real-time push status change
6. Delete temp files
```

### Length & safety

- Client: cap at 16 minutes; show a counter.
- Server: re-validate duration via `ffprobe` before upload; reject silently-long files.

---

## 4. Real-time architecture (WS auth + event cursor)

### Authentication

Socket.IO over the same origin reuses the HTTP session cookie. With Express:

```ts
import session from 'express-session';
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  store: new (require('connect-pg-simple')(session))({ pool }),
  cookie: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 3600_000 },
  resave: false, saveUninitialized: false,
});

app.use(sessionMiddleware);

io.engine.use(sessionMiddleware);  // shares cookie with Socket.IO
io.use((socket, next) => {
  const req = socket.request as any;
  if (!req.session?.userId) return next(new Error('unauthorized'));
  next();
});
```

Client:
```ts
const socket = io('/', { withCredentials: true });
```

### Event cursor (the missing protocol)

Server-side: maintain a monotonic event stream.

```prisma
model OutboxEvent {
  id             BigInt   @id @default(autoincrement())
  kind           String   // 'message.added' | 'message.updated' | 'conversation.updated' | ...
  conversationId String?
  payload        Json
  createdAt      DateTime @default(now())
  @@index([id])
}
```

Every state change writes an OutboxEvent inside the same transaction. The realtime layer reads it for fanout.

**Client side:** stores `lastEventId` in localStorage. On socket connect:

```ts
socket.emit('subscribe', { sinceEventId: localStorage.getItem('lastEventId') ?? '0' });
```

Server replays:
```ts
socket.on('subscribe', async ({ sinceEventId }) => {
  const missed = await prisma.outboxEvent.findMany({
    where: { id: { gt: BigInt(sinceEventId) } },
    orderBy: { id: 'asc' },
    take: 1000,
  });
  for (const e of missed) socket.emit(e.kind, { id: e.id.toString(), ...e.payload });
  socket.join('live');  // now safe to fan out new events
});
```

After subscribe, all new events go to the `live` room. Each event includes its `id`; the client updates `lastEventId` on receipt.

**Edge case:** if a client is offline for so long the outbox is pruned, server should respond with `{ resync: 'full' }` and the client refetches conversations from REST.

### Outbox pruning

`OutboxEvent` grows forever otherwise. Hourly job: delete rows older than 7 days. (Or skip pruning for v1 — single user, low volume.)

### Heartbeats & reconnect UX

Socket.IO has built-in ping/pong. Surface connection state:
- `connected` → green dot
- `disconnected, will retry` → yellow banner "Reconnecting..."
- `disconnected, failing` → red banner "Offline" + disable send buttons

---

## 5. Netfree-resilient media UX

### What Netfree actually does

Netfree scans **content displayed in the user's browser**. Not your server. Not the URL. The IMG bytes themselves. Hosting on the approved domain doesn't bypass scanning — it just means the **request** isn't blocked at the DNS layer.

Implication: a customer's photo, once it arrives at your server, will still go through human review when rendered in the user's browser. Your job is to make this state legible, not invisible.

### States to design

| State | Display | When |
|---|---|---|
| Pending arrival from Twilio | "Receiving image..." skeleton | Webhook received, download not done |
| Stored on server, awaiting Netfree review | "Awaiting content review" placeholder + filename + size + type | `<img>` is requested but Netfree hasn't approved yet |
| Approved, rendering | Normal image | Netfree returned the bytes |
| Blocked by Netfree | "Content blocked" placeholder + filename + size + type + "Download" button | Image fails to load (onerror fires, OR known-blocked indicator if Netfree exposes one) |
| Server has the file but client offline / fetch failed | Generic "Could not load" + retry button | Distinct from "blocked" |

The user can **always** download the raw bytes via a button — Netfree filters images and video, but a download is usually allowed (it's then on the OS to handle the file). Confirm with the user.

### Implementation sketch

```tsx
function MediaThumb({ message }: { message: Message }) {
  const [state, setState] = useState<'loading' | 'ok' | 'blocked'>('loading');

  return (
    <div className="media-card">
      <div className="media-meta">
        <span>{message.filename}</span>
        <span>{prettyBytes(message.sizeBytes)}</span>
        <span>{message.mediaMime}</span>
      </div>
      {state === 'loading' && <Skeleton label="Awaiting content review" />}
      {state === 'blocked' && (
        <Placeholder label="Content blocked or unavailable">
          <a href={`/api/media/${message.id}?download=1`}>Download anyway</a>
        </Placeholder>
      )}
      <img
        src={`/api/media/${message.id}`}
        style={{ display: state === 'ok' ? 'block' : 'none' }}
        onLoad={() => setState('ok')}
        onError={() => setState('blocked')}
      />
    </div>
  );
}
```

### Don't show alarming errors

Default browser broken-image icon is bad UX in this environment. Always render the placeholder.

### Audio

Audio (voice messages) isn't filtered by Netfree the same way images are. Should play normally. But still design for "audio failed to load" — network glitches happen.

### Documents

PDFs etc. — Netfree may or may not scan them. Worst case: download. The doc card UI (filename + size + download icon) is the right pattern regardless.

---

## 6. 24-hour window + template messaging

### Computation

```ts
function windowState(conversation: { lastInboundAt: Date | null }): {
  open: boolean;
  closesAt: Date | null;
} {
  if (!conversation.lastInboundAt) return { open: false, closesAt: null };
  const closesAt = new Date(conversation.lastInboundAt.getTime() + 24 * 3600 * 1000);
  return { open: closesAt > new Date(), closesAt };
}
```

Three observations:
1. **Closed if never received.** Self-initiated conversations always need a template first.
2. **Closes during a session.** UI ticks a timer or refreshes the indicator each minute.
3. **Re-opens on any inbound message.** Including a one-character "ok" — that's a fresh 24h window.

### Server enforcement

The browser is not trusted. Every `POST /api/messages` checks:
```ts
if (!body.contentSid && !windowState(conv).open) {
  return res.status(409).json({
    code: 'WINDOW_CLOSED',
    message: 'Free-form messaging is not available outside the 24-hour window. Use a template message.',
  });
}
```

### Templates with variables

A template body looks like:
> `Hi {{1}}, your order {{2}} is ready for pickup at {{3}}.`

The UI flow:
1. User clicks "Send template" → modal opens.
2. List of approved templates (from cached `/api/templates`).
3. Selection reveals the variable fields, each with a placeholder example.
4. Live preview of the rendered message.
5. Submit.

Template fetch refreshes occasionally — once on app load + on demand from settings. Templates change in Twilio's UI; the system doesn't manage their approval.

### Template fallback when Content API isn't usable

Some accounts still use the legacy `body` + parameters approach. Hide this behind the `TwilioGateway` interface so the UI doesn't care.

---

## 7. Auth for single-user, internet-exposed

### Bootstrap

No public signup. First user is created at boot from env:

```ts
// db/seed-bootstrap.ts (idempotent, runs on every start)
const { ADMIN_EMAIL, ADMIN_PASSWORD_HASH } = process.env;
if (ADMIN_EMAIL && ADMIN_PASSWORD_HASH) {
  await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: { email: ADMIN_EMAIL, passwordHash: ADMIN_PASSWORD_HASH },
    update: {},
  });
}
```

`ADMIN_PASSWORD_HASH` is computed locally once via a helper script and pasted into Railway env. Plain `ADMIN_PASSWORD` is also fine if the script is convenient.

### Password storage

```ts
import bcrypt from 'bcryptjs';
const hash = await bcrypt.hash(password, 12);
const ok = await bcrypt.compare(input, hash);
```

`argon2id` is the modern choice if you don't mind native bindings. `bcrypt` (bcryptjs is pure JS) is fine, well-understood, no compile step.

### Session

```ts
import session from 'express-session';
import ConnectPgSimple from 'connect-pg-simple';

app.use(session({
  store: new (ConnectPgSimple(session))({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,                  // requires HTTPS — Railway gives you this
    sameSite: 'lax',
    maxAge: 30 * 24 * 3600 * 1000, // 30 days
  },
}));
```

### Rate-limit login

```ts
import rateLimit from 'express-rate-limit';

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip + ':' + (req.body?.email ?? ''),
});

app.post('/api/auth/login', loginLimiter, handleLogin);
```

### CSRF

With `SameSite=Lax`, cross-site POSTs from external sites don't carry the cookie. For an additional layer:

```ts
// On any GET that renders the SPA shell, set a CSRF token cookie
res.cookie('csrf', crypto.randomBytes(24).toString('base64url'), { sameSite: 'lax' });

// On state-changing endpoints, verify header echoes cookie
app.use((req, res, next) => {
  if (['POST', 'PATCH', 'DELETE'].includes(req.method) && !req.path.startsWith('/webhooks/')) {
    if (req.cookies.csrf !== req.header('X-CSRF-Token')) {
      return res.status(403).send('CSRF mismatch');
    }
  }
  next();
});
```

The frontend reads the cookie and includes the header on mutating fetches.

### Webhook routes are NOT inside the session

Mount webhook routes BEFORE session middleware, OR explicitly skip session for them. Twilio doesn't carry your cookie.

### 2FA (future, not v1)

Add a `User.totp_secret` column and a `/api/auth/verify-totp` step. Cheap to add later. Don't pay the UX cost in v1.

---

## Cross-cutting: the spike list

Before Phase 2 of the build plan, run these spikes on a real Twilio account:

1. **Webhook signature verification** end-to-end against the custom domain on Railway.
2. **Send and receive a media message** (image, then voice).
3. **Send a template via Content API** with variables.
4. **Send a reaction** — verify support, capture the exact API call/response.
5. **Conversation auto-creation** — confirm `onConversationAdded` fires on first inbound from a new number.
6. **Status callback ordering** — observe whether `delivered` and `read` arrive in order in practice.

Each spike: half a day. Total: ~3 days. Their output becomes acceptance criteria for the corresponding feature ticket.
