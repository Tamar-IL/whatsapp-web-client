#!/usr/bin/env bash
# Shortcut for the staging (test) stack. Run from the STAGING checkout folder.
#   ./deploy/staging.sh up        build and (re)start
#   ./deploy/staging.sh deploy B  switch to branch B, pull, rebuild
#   ./deploy/staging.sh logs      follow the app log
#   ./deploy/staging.sh hash      create the admin password hash
#   ./deploy/staging.sh down      stop (data is kept)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.staging ] || { echo "Missing .env.staging — cp .env.staging.example .env.staging and fill it in."; exit 1; }
dc() { docker compose --env-file .env.staging -f docker-compose.staging.yml "$@"; }
case "${1:-}" in
  up) dc up -d --build ;;
  deploy)
    branch="${2:?usage: deploy <branch>}"
    git fetch origin "$branch"
    git checkout "$branch"
    git pull --ff-only origin "$branch"
    dc up -d --build
    ;;
  logs) dc logs -f app ;;
  hash) dc run --rm app npm run hash-password ;;
  down) dc down ;;
  *) echo "usage: $0 up | deploy <branch> | logs | hash | down"; exit 1 ;;
esac
