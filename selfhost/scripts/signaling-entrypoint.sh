#!/bin/sh
# Runs the site's room-signaling Cloudflare Worker (services/signaling)
# locally with `wrangler dev`: workerd plus local Durable Objects and KV,
# with all state kept in the /data volume.
set -eu

random_hex() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }

# Signing keys are generated on first start and kept in the volume, so there
# is nothing secret to put in .env. Values set in the environment still win.
secrets=/data/selfhost-secrets.env
if [ ! -s "$secrets" ]; then
  umask 077
  {
    echo "ROOM_ID_SECRET=$(random_hex)"
    echo "ABUSE_ID_SECRET=$(random_hex)"
    echo "ADMIN_TOKEN=$(random_hex)"
  } > "$secrets"
  echo "Generated signaling secrets in $secrets"
fi
# shellcheck disable=SC1090
. "$secrets"
ROOM_ID_SECRET="${HALO_ROOM_ID_SECRET:-$ROOM_ID_SECRET}"
ABUSE_ID_SECRET="${HALO_ABUSE_ID_SECRET:-$ABUSE_ID_SECRET}"

# .dev.vars overrides the "vars" in wrangler.jsonc and supplies the secrets.
# ENVIRONMENT=development is what allows the Turnstile bypass, the "*" origin
# and same-origin GET requests (which browsers send without an Origin header).
cat > /app/.dev.vars <<EOF
ENVIRONMENT=development
ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-*}
ALLOW_NO_ORIGIN=true
PUBLIC_GAME_URL=${PUBLIC_GAME_URL:-https://localhost:8443/}
TURNSTILE_TEST_BYPASS=true
TURNSTILE_SECRET=self-hosted-turnstile-is-disabled
TURNSTILE_HOSTNAMES=self-hosted
ROOM_TTL_SECONDS=${ROOM_TTL_SECONDS:-21600}
ROOM_ID_SECRET=${ROOM_ID_SECRET}
ABUSE_ID_SECRET=${ABUSE_ID_SECRET}
ADMIN_TOKEN=${ADMIN_TOKEN}
EOF

cd /app
# --upstream-protocol https: Caddy terminates TLS, so tell wrangler's dev proxy
# the public scheme is https. Otherwise it rewrites the browser's
# "Origin: https://..." to http://... before the Worker checks it.
exec npx --no-install wrangler dev --ip 0.0.0.0 --port 8787 \
  --upstream-protocol https --persist-to /data
