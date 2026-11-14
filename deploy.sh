#!/usr/bin/env bash
# Deploys Tech-Website on a plain VPS (no Docker).
# Prereqs: Node 24, pnpm (corepack enable), build-essential + python3 for
# better-sqlite3, nginx/certbot if a proxy terminates TLS.
set -euo pipefail

APP_DIR="/opt/tech-website"
SERVICE="tech-website"

cd "$APP_DIR"

echo "==> Pulling latest code"
git pull --ff-only

echo "==> Installing dependencies from the audited lockfile"
pnpm install --frozen-lockfile

if [ -f prisma/main.db ] && [ -f prisma/web.db ]; then
    echo "==> Databases exist; syncing schema only"
    pnpm exec drizzle-kit push --config=drizzle.main.config.ts --force || true
    pnpm exec drizzle-kit push --config=drizzle.web.config.ts --force || true
else
    echo "==> Creating fresh databases"
    pnpm run db:init
    pnpm run db:seed
fi

echo "==> Building"
pnpm run build

echo "==> Restarting service"
sudo systemctl restart "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" && echo "==> Deploy complete: service is active" || {
    echo "!! Service failed to start. Check: journalctl -u $SERVICE -n 50"
    exit 1
}
