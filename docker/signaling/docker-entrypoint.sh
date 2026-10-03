#!/bin/sh
# Writes the local configuration (.dev.vars overrides wrangler.jsonc's vars)
# and starts the Worker. Missing secrets get fresh random values; they only
# sign rooms, which live at most ROOM_TTL_SECONDS.
#
# PUBLIC_ORIGIN (e.g. https://halo.example.lan) is the game's address when a
# reverse proxy serves it and forwards /v1/ here: it becomes the default
# allowed origin and invite URL, and the service answers with wss:// URLs on
# that host. Without it, the game is used at http://127.0.0.1:8765 and calls
# this service directly on port 8787.
set -eu

secret() {
    node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))'
}

origin=${PUBLIC_ORIGIN:-}
origin=${origin%/}
if [ -n "$origin" ]; then
    case "$origin" in
        http://*|https://*) ;;
        *) echo "PUBLIC_ORIGIN must start with http:// or https://" >&2; exit 1 ;;
    esac
    scheme=${origin%%://*}
    set -- --local-upstream "${origin#*://}" --upstream-protocol "$scheme" "$@"
    default_origins=$origin
    default_url=$origin/build/web/halo.html
else
    default_origins=http://127.0.0.1:8765,http://localhost:8765
    default_url=http://127.0.0.1:8765/build/web/halo.html
fi

cat > /app/.dev.vars <<VARS
ENVIRONMENT=development
TURNSTILE_TEST_BYPASS=true
ALLOW_NO_ORIGIN=false
ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-$default_origins}
PUBLIC_GAME_URL=${PUBLIC_GAME_URL:-$default_url}
TURNSTILE_HOSTNAMES=localhost
ROOM_ID_SECRET=${ROOM_ID_SECRET:-$(secret)}
ABUSE_ID_SECRET=${ABUSE_ID_SECRET:-$(secret)}
ADMIN_TOKEN=${ADMIN_TOKEN:-$(secret)}
VARS

exec npx wrangler dev --ip 0.0.0.0 --port 8787 --persist-to /data "$@"
