# Test environment (staging)

A second, separate copy of the app on the **same server**, for trying changes
before they reach the real app.

| | Production | Staging (test) |
| --- | --- | --- |
| Folder on the server | `~/whatsapp-web-client` | `~/whatsapp-staging` |
| Code | `main` branch | any branch you want to try |
| Address | `chat.example.com` | `staging.example.com` |
| Database, files, settings | its own | its own (empty at start) |
| WhatsApp number | your business number | **Twilio WhatsApp Sandbox** |
| Who it can message | your customers | only phones that joined the sandbox |

Staging can never message a real customer: the sandbox only talks to phones
that sent it the join code. The app shows an orange **TEST** bar and the tab
title starts with `[TEST]`.

## The flow

1. A change is pushed to a branch (e.g. `claude/…`).
2. Deploy that branch to **staging**: `./deploy/staging.sh deploy <branch>`.
3. Try it on `https://staging.example.com` with your test phone.
4. Happy → merge the branch into `main` (pull request on GitHub).
5. Deploy **production** as usual: `git pull && docker compose up -d --build`.

## One-time setup

### 1. DNS + Netfree
Add an **A record** `staging.<your-domain>` → the server's IP (same IP as
production), and submit `staging.<your-domain>` to Netfree for approval.

### 2. Update production once
Production needs the version of `docker-compose.yml` / `deploy/Caddyfile` that
can serve extra sites. In the production folder:

```bash
cd ~/whatsapp-web-client
git pull
docker compose up -d
```

(This creates the shared `wweb-edge` network. Nothing else changes.)

### 3. Second checkout for staging

```bash
cd ~
git clone https://github.com/tamar-il/whatsapp-web-client.git whatsapp-staging
cd whatsapp-staging
cp .env.staging.example .env.staging
```

Edit `.env.staging` — every `CHANGE_ME`:
- `PUBLIC_BASE_URL=https://staging.<your-domain>`
- a **different** `POSTGRES_PASSWORD` and `SESSION_SECRET` (`openssl rand -base64 32`)
- Twilio: same account SID / token, sender = the sandbox number (below)

Admin password hash:

```bash
./deploy/staging.sh hash
```

Paste it into `.env.staging` as `ADMIN_PASSWORD_HASH`.

### 4. Twilio WhatsApp Sandbox
Twilio Console → **Messaging → Try it out → Send a WhatsApp message**:
1. Note the sandbox number (usually `+1 415 523 8886`) and the join code.
2. From your phone send `join <code>` to that number on WhatsApp.
3. **Sandbox settings**:
   - When a message comes in: `https://staging.<your-domain>/webhooks/twilio/inbound`
   - Status callback: `https://staging.<your-domain>/webhooks/twilio/status`

Sandbox limits: it only reaches joined phones, the join expires after 3 days
of no messages (send `join <code>` again), and templates must be sandbox
templates or ones approved on your account.

### 5. Start staging

```bash
./deploy/staging.sh deploy <branch-to-test>
```

### 6. Point the production Caddy at it
In the **production** folder:

```bash
cd ~/whatsapp-web-client
cp deploy/sites/staging.caddy.example deploy/sites/staging.caddy
nano deploy/sites/staging.caddy        # set your staging domain + email
docker compose restart caddy
```

Open `https://staging.<your-domain>` and log in.

## Everyday commands (in `~/whatsapp-staging`)

```bash
./deploy/staging.sh deploy <branch>   # try another branch
./deploy/staging.sh logs              # watch the log
./deploy/staging.sh down              # stop staging (data kept)
```

## Notes
- Staging uses about as much memory as production; a 4 GB server runs both.
- Database changes (migrations) run on staging first, which is exactly the
  point: if one fails, production is untouched.
- AI agent: use a separate OpenAI key with a low monthly limit for staging.
