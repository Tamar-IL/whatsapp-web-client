# Production image for self-hosting (e.g. Hetzner) via Docker Compose.
#
# Notes:
#  - Debian (glibc) base, NOT Alpine: the app ships ffmpeg/ffprobe through the
#    `ffmpeg-static` / `ffprobe-static` npm packages, whose prebuilt binaries are
#    glibc-linked and will not run on Alpine's musl libc.
#  - Single service: server.ts runs an in-process scheduler, so there is no
#    separate pg-boss worker to launch.
#  - The backend serves the built frontend from ../../frontend/dist, so both
#    workspaces are built and their dist/ layout is preserved.
#  - Prisma engines are generated at build time; keeping the build and runtime on
#    the same base image guarantees the engine binary target matches.

FROM node:20-bookworm-slim

# openssl: required by the Prisma query engine at runtime.
# ca-certificates: TLS to Twilio / SMTP / etc.
# wget: used by the container HEALTHCHECK.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first (better layer caching). --include=dev is required so
# the TypeScript compiler, Vite and the Prisma CLI are available for the build;
# they also stay in the image because `prisma migrate deploy` runs on startup.
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
RUN npm ci --include=dev

# Build both workspaces.
COPY . .
RUN npm --workspace apps/backend run prisma:generate \
  && npm --workspace apps/backend run build \
  && npm --workspace apps/frontend run build

# Default media location (overridable via MEDIA_STORAGE_PATH); mounted as a volume.
RUN mkdir -p /app/apps/backend/storage

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

# start:prod runs `prisma migrate deploy` then boots the server.
CMD ["npm", "--workspace", "apps/backend", "run", "start:prod"]
