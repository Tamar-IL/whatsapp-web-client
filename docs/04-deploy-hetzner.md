# Deploying to a Hetzner server (Docker Compose)

This guide stands the whole app up on a single Hetzner Cloud server (or any
Linux box with Docker) using the `docker-compose.yml` in the repo root. The
stack is fully self-contained:

| Service | What it does |
| --- | --- |
| `app` | Express backend + built React frontend (single origin) |
| `db` | PostgreSQL 16 with a persistent volume |
| `caddy` | Reverse proxy that terminates HTTPS in front of the app |

The app bundles `ffmpeg` (via npm), runs its message scheduler in-process, and
serves the frontend itself — so there is nothing else to install.

---

## 0. Create the server

1. In the Hetzner Cloud console create a server (a **CX22 / 2 vCPU / 4 GB** is
   plenty for a single user; the Docker build is the heaviest moment).
2. Image: **Ubuntu 24.04**. Add your SSH key.
3. Note the public IPv4 address.

SSH in:

```bash
ssh root@<your-server-ip>
```

## 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
docker --version && docker compose version
```

(Optional but recommended firewall — allow SSH + web only:)

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

## 2. Get the code

```bash
git clone https://github.com/tamar-il/whatsapp-web-client.git
cd whatsapp-web-client
git checkout claude/deploy-hetzner-server-m1rumh
```

## 3. Configure `.env`

```bash
cp .env.production.example .env
```

Generate the secrets:

```bash
# session secret
openssl rand -base64 32
# a strong DB password
openssl rand -base64 24
```

Edit `.env` and set at minimum:

- `PUBLIC_BASE_URL` → `https://<your-server-ip>` for now (change to your domain later)
- `POSTGRES_PASSWORD` → the generated DB password
- `SESSION_SECRET` → the generated session secret
- `ADMIN_EMAIL` → your login email
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_CONVERSATION_SERVICE_SID`, `TWILIO_WHATSAPP_SENDER`

Leave `SITE_ADDRESS=:443` and `TLS_OPTS=internal` for now (self-signed HTTPS on
the IP — see step 6 to switch to a real domain).

## 4. Create the admin password hash

```bash
docker compose run --rm app npm run hash-password
```

Paste the password when prompted, copy the printed hash into `.env` as
`ADMIN_PASSWORD_HASH`.

## 5. Launch

```bash
docker compose up -d --build
```

First build takes a few minutes (installing deps + compiling both apps).
Watch it come up:

```bash
docker compose ps
docker compose logs -f app
```

Database migrations run automatically on startup (`prisma migrate deploy`).

Open **`https://<your-server-ip>`**. Because the cert is self-signed you'll get
a one-time browser warning — accept it (this is expected until you attach a
domain). Log in with your `ADMIN_EMAIL` and the password you hashed.

> Why HTTPS even without a domain? The app sets secure session cookies in
> production, which browsers only accept over HTTPS. The self-signed cert makes
> login work now; a real cert (step 6) removes the warning.

## 6. Attach a real domain (required for Twilio + Netfree)

Twilio webhooks and Netfree both need a real domain with a trusted certificate.
When you have one:

1. Create a DNS **A record** pointing your domain (e.g. `chat.example.com`) at
   the server's IP.
2. Edit `.env`:
   ```env
   PUBLIC_BASE_URL=https://chat.example.com
   SITE_ADDRESS=chat.example.com
   TLS_OPTS=you@example.com        # your email, for Let's Encrypt
   ```
3. Apply:
   ```bash
   docker compose up -d
   ```
   Caddy automatically obtains and renews a Let's Encrypt certificate. Make sure
   ports 80 and 443 are open (step 1) — port 80 is needed for the ACME challenge.
4. Submit the domain to **Netfree** for approval.

## 7. Point Twilio at the server

In the Twilio console, set the webhook URLs to your public base URL, e.g.:

```
https://chat.example.com/webhooks/twilio/...
```

(See `docs/03-build-plan.md` for the exact webhook paths.) Twilio signature
verification uses `PUBLIC_BASE_URL`, so it must match exactly.

---

## Day-2 operations

**Update to the latest code:**

```bash
git pull
docker compose up -d --build
```

**View logs / restart / stop:**

```bash
docker compose logs -f app
docker compose restart app
docker compose down            # stop (data in named volumes is kept)
```

**After editing `.env`:** `restart` re-runs the process with the environment the
container was *created* with, so a changed secret appears to be ignored. Recreate
instead:

```bash
docker compose up -d --force-recreate app
```

**Check outgoing email:**

```bash
docker compose run --rm app npm run mail-check
```

Prints which transport the app will actually use, then attempts one real send and
explains whatever the provider answers.

Email sends over **Zoho SMTP** whenever `SMTP_USER` *and* `SMTP_PASS` are both
set; that takes priority over `RESEND_API_KEY`, which is only a fallback for
hosts that block outbound SMTP ports. On this server SMTP works, so set:

```env
SMTP_HOST=smtp.zoho.com     # smtp.zoho.eu for EU accounts
SMTP_PORT=465               # try 587 with SMTP_SECURE=false if 465 times out
SMTP_USER=you@yourdomain.com
SMTP_PASS=<Zoho app-specific password>
```

`SMTP_PASS` must be an **app-specific password** if the Zoho account has 2FA
(Zoho → My Account → Security → App Passwords), not the normal login password.

Then recreate the container so it picks up the new values:

```bash
docker compose up -d --force-recreate app
```

If `mail-check` passes but the app still fails, the running container has an
older environment than the test — the `--force-recreate` above is the fix.
A `Resend error 401` in the app logs means it fell back to Resend with an
invalid key, i.e. SMTP was not configured; set the two SMTP vars above.

**Back up the database:**

```bash
docker compose exec db pg_dump -U wweb wweb > backup-$(date +%F).sql
```

**Restore:**

```bash
cat backup-YYYY-MM-DD.sql | docker compose exec -T db psql -U wweb -d wweb
```

**Where data lives** (Docker named volumes, survive `docker compose down`):

- `pgdata` – PostgreSQL data
- `media` – uploaded/received media files
- `caddy_data` – TLS certificates

To wipe everything including data: `docker compose down -v` (destructive).

---

## Troubleshooting

- **App restarts / can't reach DB** — check `docker compose logs app`. The app
  waits for the DB healthcheck, but a wrong `POSTGRES_PASSWORD` mismatch between
  runs will fail auth; if you changed it after first boot, the old password is
  baked into the `pgdata` volume (reset with `docker compose down -v`, only if
  you don't need the data).
- **Login "works" but immediately logs out** — you're on plain HTTP. Use the
  `https://` URL; secure cookies won't persist over HTTP.
- **Twilio webhook 403 / signature errors** — `PUBLIC_BASE_URL` doesn't match
  the URL Twilio calls. They must be byte-for-byte identical (scheme + host).
- **Let's Encrypt fails** — DNS not yet pointing at the server, or port 80
  blocked. Verify `dig +short chat.example.com` returns your IP and that ufw
  allows 80/443.
