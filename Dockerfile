# Build and run the whole app (backend API + built frontend) in one image.
# Mirrors the steps in nixpacks.toml.
FROM node:20-bookworm-slim

# ffmpeg: voice message conversion. openssl: required by Prisma.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies for all workspaces (the workspace package.json files must be
# copied before installing, otherwise backend/frontend deps such as tsc are missing).
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN npm ci --include=dev

COPY . .
RUN npm --workspace apps/backend run prisma:generate \
  && npm --workspace apps/backend run build \
  && npm --workspace apps/frontend run build

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
# Applies pending DB migrations, then starts the server (serves the frontend too).
CMD ["npm", "--workspace", "apps/backend", "run", "start:prod"]
