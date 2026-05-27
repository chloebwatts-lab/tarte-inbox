#!/usr/bin/env bash
# Deploy tarte-inbox to the production droplet.
#
# Run on the droplet from /root/tarte-inbox:
#     ./scripts/deploy.sh
#
# Modelled on tarte-kitchen's deploy.sh — git reset, rebuild, restart.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "▶ Pulling latest main..."
git fetch origin main
git reset --hard origin/main

echo "▶ Rebuilding inbox image..."
docker compose build inbox

echo "▶ Restarting service..."
docker compose up -d inbox

echo "▶ Waiting for health..."
sleep 3
docker compose ps inbox

echo "✓ Deployed."
