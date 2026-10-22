#!/bin/sh
# Deploy the committed HEAD: clean tree, copy server/ AND web/, bake the sha, build, test in the image, start, check both landed.
# Run from the repo root. The sw.js version (yeg-vNN) must already be bumped and committed.
set -e
# Where it goes: DEPLOY_HOST (user@host, ssh) and DEPLOY_DIR (the compose stack there), from scripts/deploy.conf if present (gitignored).
[ -f scripts/deploy.conf ] && . ./scripts/deploy.conf
H=${DEPLOY_HOST:?set DEPLOY_HOST=user@host in scripts/deploy.conf}
D=${DEPLOY_DIR:?set DEPLOY_DIR=/path/to/stack in scripts/deploy.conf}
SITE=${SITE:-https://yegbus.com}
# A shared box can run the build under a RAM lock (DEPLOY_WRAP="ramlock run yeg-transit-deploy 2 --"); empty runs it directly.
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean; commit first" >&2; exit 1; }
V=$(grep -oE 'yeg-v[0-9]+' web/sw.js | head -1)
# Every ?v= cache-buster must match the service worker's version, or phones keep the old files.
stale=$(grep -rnoE '\?v=[0-9]+' web | grep -v "?v=${V#yeg-v}\$" || true)
[ -z "$stale" ] || { echo "version mismatch with $V:" >&2; echo "$stale" >&2; exit 1; }
SHA=$(git rev-parse HEAD)
echo "deploying $SHA ($V)"
rsync -a server/ "$H:$D/server/"
echo "$SHA" | ssh "$H" "cat > $D/server/VERSION"
rsync -a web/ "$H:$D/web/"
rsync -a --exclude __pycache__ tests/ "$H:/tmp/yeg-tests/"
${DEPLOY_WRAP:-} ssh -n "$H" "cd $D && docker compose build -q && \
  docker run --rm --network none -v /tmp/yeg-tests:/app/tests:ro yeg-transit:latest python -m unittest discover -s /app/tests && \
  docker compose up -d; s=\$?; rm -f /tmp/yeg-tests/*.py; rmdir /tmp/yeg-tests; exit \$s"
for i in 1 2 3 4 5 6 7 8 9 10; do
  [ "$(curl -s -m 10 $SITE/sw.js | grep -oE 'yeg-v[0-9]+' | head -1)" = "$V" ] &&
    [ "$(curl -s -m 10 $SITE/api/version | grep -oE '[0-9a-f]{40}')" = "$SHA" ] && { echo "landed: $SHA ($V)"; exit 0; }
  sleep 3
done
echo "NOT landed: live sw.js is not $V or /api/version is not $SHA" >&2
exit 1
