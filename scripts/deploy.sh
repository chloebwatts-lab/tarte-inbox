#!/usr/bin/env bash
# Deploy tarte-inbox to the production droplet.
#
# Run on the droplet from /root/tarte-inbox:
#     ./scripts/deploy.sh
#
# Safety: the previous image is kept as tarte-inbox-inbox:prev, and the deploy
# FAILS LOUDLY unless the new container actually answers /health. Roll back:
#     docker tag tarte-inbox-inbox:prev tarte-inbox-inbox:latest \
#       && docker compose up -d inbox

set -euo pipefail

cd "$(dirname "$0")/.."

echo "▶ Pulling latest main..."
git fetch origin main
git reset --hard origin/main

echo "▶ Keeping current image as :prev (rollback point)..."
docker tag tarte-inbox-inbox:latest tarte-inbox-inbox:prev 2>/dev/null || true

echo "▶ Rebuilding inbox image..."
docker compose build inbox

echo "▶ Restarting service..."
docker compose up -d inbox

echo "▶ Waiting for /health..."
for i in $(seq 1 15); do
  sleep 3
  if docker compose exec -T inbox wget -qO- http://localhost:8787/health 2>/dev/null | grep -q '"ok":true'; then
    docker compose ps inbox
    echo "✓ Deployed and healthy."
    exit 0
  fi
done

echo "✗ DEPLOY FAILED HEALTH CHECK — the new container is not answering."
echo "  Recent logs:"
docker compose logs --tail 30 inbox || true
echo ""
echo "  To roll back to the previous working version:"
echo "    docker tag tarte-inbox-inbox:prev tarte-inbox-inbox:latest && docker compose up -d inbox"
exit 1
