# Build environment for the browser version (`ninja web`).
#
# The SDL3 port (port/web/halo_sdl3.py) is fetched and compiled by Emscripten
# on the first link; the compose file keeps Emscripten's cache in a volume so
# that only happens once.
ARG EMSDK_VERSION=6.0.10
FROM emscripten/emsdk:${EMSDK_VERSION}

RUN apt-get update \
    && apt-get install -y --no-install-recommends ninja-build \
    && rm -rf /var/lib/apt/lists/*

# The container runs as the host user (see compose.yaml) so build/ and
# assets/ stay owned by that user; the Emscripten cache must be writable.
RUN chmod -R a+rwX /emsdk/upstream/emscripten/cache
ENV HOME=/tmp

WORKDIR /src
