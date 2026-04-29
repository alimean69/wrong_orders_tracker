#!/usr/bin/env bash
set -euo pipefail

# ── 1. Pull latest ───────────────────────────────────────────────────────────
echo "[1/5] Pulling latest changes..."
git pull --ff-only

# ── 2. Install dependencies ──────────────────────────────────────────────────
echo "[2/5] Installing dependencies..."
npm ci --omit=dev

# ── 3. Environment file ──────────────────────────────────────────────────────
echo "[3/5] Checking environment..."
if [ ! -f ".env" ]; then
  cp .example.env .env
  echo ""
  echo "  ┌─────────────────────────────────────────────────────────┐"
  echo "  │  .env created from .example.env                         │"
  echo "  │  Fill in the values below before the server can start:  │"
  echo "  │    PORT=3001                                             │"
  echo "  │    mongodb_uri=mongodb://...                             │"
  echo "  │    openai_api_key=sk-...                                 │"
  echo "  └─────────────────────────────────────────────────────────┘"
  echo ""
  read -rp "  Press ENTER after editing .env to continue..." _
else
  echo "  .env already exists — skipping."
fi

source .env
if [ -z "${mongodb_uri:-}" ] || [ -z "${openai_api_key:-}" ]; then
  echo "  ERROR: mongodb_uri and openai_api_key must be set in .env"
  exit 1
fi

# ── 4. PM2 ───────────────────────────────────────────────────────────────────
echo "[4/5] Starting / reloading PM2..."
mkdir -p logs

if ! command -v pm2 &>/dev/null; then
  echo "  PM2 not found — installing globally..."
  npm install -g pm2
fi

if pm2 id wrong-orders &>/dev/null; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi

pm2 save

# ── 5. Done ──────────────────────────────────────────────────────────────────
echo "[5/5] Deploy complete."
echo ""
pm2 status
