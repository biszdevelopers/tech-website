#!/usr/bin/env bash
# Deploys Tech-Website on a plain VPS (no Docker).
# Prereqs: Node 24, pnpm (corepack enable), build-essential + python3 for
# better-sqlite3, curl, sqlite3 CLI for manual backups, nginx/certbot if a
# proxy terminates TLS.
#
# Environment:
#   DEPLOY_BRANCH   branch to deploy (default: main)
# ADMIN_USERNAME/ADMIN_PASSWORD are the directory login and are required on every
# boot. They are also used to create the first IPstress web admin on fresh databases.
set -euo pipefail

APP_DIR="/opt/tech-website"
SERVICE="tech-website"
SERVICE_USER="techweb"
BRANCH="${DEPLOY_BRANCH:-main}"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$APP_DIR"

echo "==> Checking branch"
CURRENT="$(git branch --show-current)"
if [ "$CURRENT" != "$BRANCH" ]; then
    echo "!! Refusing to deploy branch '$CURRENT' (expected '$BRANCH')."
    echo "   Set DEPLOY_BRANCH=$CURRENT only if this is intentional."
    exit 1
fi

echo "==> Pulling latest code"
git pull --ff-only

echo "==> Installing dependencies from the audited lockfile"
corepack pnpm install --frozen-lockfile

if [ ! -f .env ]; then
    echo "!! Missing .env. Copy .env.example, fill in SITE_ORIGIN and fresh secrets."
    exit 1
fi
chmod 600 .env
set -a
# shellcheck disable=SC1091
. ./.env
set +a

echo "==> Stopping service (builds must not replace files under a running process)"
sudo systemctl stop "$SERVICE"

# Backups first: a failed schema push must never be the moment we discover
# there is no copy. better-sqlite3's .backup() is WAL-safe.
echo "==> Backing up databases to backups/$STAMP"
mkdir -p "backups/$STAMP" data var/uploads
BACKUP_DIR="$APP_DIR/backups/$STAMP" node - <<'NODE'
const fs = require("fs");
const Database = require("better-sqlite3");
const dir = process.env.BACKUP_DIR;
const paths = {
    main: (process.env.DATABASE_URL_MAIN || "file:./data/main.db").replace(/^file:/, ""),
    web: (process.env.DATABASE_URL_WEB || "file:./data/web.db").replace(/^file:/, ""),
};
(async () => {
    for (const name of ["main", "web"]) {
        const src = paths[name];
        if (!fs.existsSync(src)) continue;
        const db = new Database(src, { readonly: true });
        await db.backup(`${dir}/${name}.db`);
        db.close();
        console.log(`   backed up ${src}`);
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
NODE

FRESH=0
MAIN_DB="${DATABASE_URL_MAIN:-file:./data/main.db}"
WEB_DB="${DATABASE_URL_WEB:-file:./data/web.db}"
MAIN_DB="${MAIN_DB#file:}"
WEB_DB="${WEB_DB#file:}"
if [ ! -f "$MAIN_DB" ] || [ ! -f "$WEB_DB" ]; then
    FRESH=1
fi

echo "==> Syncing database schema"
# push --force is still required for SQLite; the backup above is the safety net.
pnpm run db:init

if [ "$FRESH" = "1" ]; then
    echo "==> Fresh database: ADMIN_USERNAME and ADMIN_PASSWORD are required"
    if [ -z "${ADMIN_USERNAME:-}" ] || [ -z "${ADMIN_PASSWORD:-}" ]; then
        echo "!! Set ADMIN_USERNAME and ADMIN_PASSWORD in .env or the environment, then rerun."
        exit 1
    fi
    pnpm run setup
fi

echo "==> Building (previous dist kept for rollback)"
rm -rf dist.prev
if [ -d dist ]; then mv dist dist.prev; fi
if ! pnpm run build; then
    echo "!! Build failed; restoring previous dist."
    rm -rf dist
    [ -d dist.prev ] && mv dist.prev dist
    sudo systemctl start "$SERVICE"
    exit 1
fi

echo "==> Fixing ownership"
sudo chown -R "$SERVICE_USER:$SERVICE_USER" data var

echo "==> Restarting service"
sudo systemctl daemon-reload
sudo systemctl restart "$SERVICE"

PORT_VALUE="$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"' || true)"
PORT_VALUE="${PORT_VALUE:-3000}"
HEALTH="http://127.0.0.1:${PORT_VALUE}/api/health"

echo "==> Health check"
for _ in $(seq 1 15); do
    if curl -fsS --max-time 3 "$HEALTH" >/dev/null 2>&1; then
        echo "==> Deploy complete: $HEALTH is healthy"
        exit 0
    fi
    sleep 1
done

echo "!! Health check failed. Restoring previous build and restarting."
if [ -d dist.prev ]; then
    rm -rf dist
    mv dist.prev dist
fi
sudo systemctl restart "$SERVICE"
echo "   Logs: journalctl -u $SERVICE -n 80"
echo "   Database backups: $APP_DIR/backups/$STAMP"
exit 1
