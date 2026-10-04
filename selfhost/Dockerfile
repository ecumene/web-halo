# syntax=docker/dockerfile:1
#
# LAN self-host build of this repository's browser port.
# Build context: the repository root (a local clone, or the fork's git URL as
# in selfhost/compose.yaml). No game data goes into any image.
#
# Targets:
#   web        Caddy serving the WebAssembly build over HTTPS (self-signed)
#   signaling  the room/invite Worker (services/signaling) under wrangler dev
#   extract    one-shot tool that copies maps/ out of your Xbox disc image

ARG EMSDK_VERSION=6.0.10

# ---------------------------------------------------------------- source ----
# A copy of the repository with the self-host edits applied. The selfhost/
# folder is removed afterwards so editing it (README, Caddyfile) doesn't
# trigger a full WebAssembly rebuild.
FROM python:3.12-slim AS source
WORKDIR /src
COPY . /src
RUN python3 selfhost/scripts/patch_selfhost.py /src \
 && cp selfhost/scripts/stamp_build_id.py /stamp_build_id.py \
 && rm -rf /src/selfhost

# ----------------------------------------------------------------- build ----
FROM emscripten/emsdk:${EMSDK_VERSION} AS build
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ninja-build git \
 && rm -rf /var/lib/apt/lists/*
COPY --from=source /src /src
WORKDIR /src
# BUILD_JOBS=0 lets ninja use every core.
ARG BUILD_JOBS=0
RUN python3 configure.py --release --pgo=off --lto=off \
 && if [ "$BUILD_JOBS" -gt 0 ]; then ninja -j "$BUILD_JOBS" web; else ninja web; fi
# Stamp a build id from the build's own hash (as upstream's deploy script
# does), so a stale browser tab can't join a lobby running a different build.
COPY --from=source /stamp_build_id.py /usr/local/bin/stamp_build_id.py
RUN mkdir -p /out/www/assets/maps /out/www/assets/ui \
 && cp build/web/halo.html build/web/halo.js build/web/halo.wasm /out/www/ \
 && cp build/web/halo.html /out/www/index.html \
 && cp port/web/coi-serviceworker.js /out/www/ \
 && python3 /usr/local/bin/stamp_build_id.py build/web /out/www/halo.html /out/www/index.html \
 && ls -la /out/www

# ------------------------------------------------------------------- web ----
FROM caddy:2-alpine AS web
COPY --from=build /out/www /srv/www
COPY selfhost/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8443

# ------------------------------------------------------------- signaling ----
FROM node:22-bookworm-slim AS signaling
ENV WRANGLER_SEND_METRICS=false \
    CI=true
WORKDIR /app
COPY --from=source /src/services/signaling/ /app/
RUN npm ci --no-audit --no-fund \
 && rm -f /app/.dev.vars
# Strip Windows line endings in case the script was edited on a PC.
COPY selfhost/scripts/signaling-entrypoint.sh /usr/local/bin/signaling-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/signaling-entrypoint.sh \
 && chmod 0755 /usr/local/bin/signaling-entrypoint.sh
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/signaling-entrypoint.sh"]

# --------------------------------------------------------------- extract ----
FROM python:3.12-slim AS extract
COPY --from=source /src/tools/xiso_extract.py /usr/local/bin/xiso_extract.py
COPY selfhost/scripts/extract.sh /usr/local/bin/extract.sh
RUN sed -i 's/\r$//' /usr/local/bin/extract.sh && chmod 0755 /usr/local/bin/extract.sh
ENTRYPOINT ["/usr/local/bin/extract.sh"]
