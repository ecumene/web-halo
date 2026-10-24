#!/bin/sh
# Loads the bundled Docker images (no Internet access needed), then starts
# the services in the background. Stop them with: docker compose down
set -eu
cd "$(dirname "$0")"
# A bundle with hosted maps (compose.override.yaml) needs the game data.
if [ -f compose.override.yaml ]; then
    maps=$(sed -n 's/^HALO_MAPS=//p' .env)
    maps=${maps:-./maps}
    if [ ! -f "$maps/ui.map" ]; then
        echo "start.sh: no game data in $maps (ui.map missing); set HALO_MAPS in .env" >&2
        exit 1
    fi
fi
echo "==> Loading Docker images"
gunzip -c images.tar.gz | docker load
docker compose up -d
docker compose ps
