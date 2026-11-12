#!/usr/bin/env bash
# Deploy the viewer code to the Hetzner box (pm2 app `ecourts-viewer`, port 5051).
# Data files (ecourts/*.json, lawsuits.db) and .env live only on the server.
set -euo pipefail
cd "$(dirname "$0")"
HOST=${HOST:-myserver}
DIR=/var/www/ecourts-viewer

node --check app.js
for f in ecourtsApi.js lawsuitsApi.js utils/logger.js; do node --check "$f"; done

ssh "$HOST" "mkdir -p $DIR/services $DIR/utils $DIR/ecourts"
scp -q app.js package.json "$HOST:$DIR/"
scp -q utils/logger.js "$HOST:$DIR/utils/"
scp -q ecourtsApi.js lawsuitsApi.js "$HOST:$DIR/services/"
scp -q index.html lawsuits.html "$HOST:$DIR/ecourts/"
ssh "$HOST" "cd $DIR && npm install --omit=dev --no-audit --no-fund --silent && npm prune --omit=dev --silent && \
  (pm2 describe ecourts-viewer >/dev/null 2>&1 && pm2 restart ecourts-viewer --update-env || \
   pm2 start app.js --name ecourts-viewer --cwd $DIR) && pm2 save >/dev/null"
echo "deployed: http://167.235.252.184:5051/"
