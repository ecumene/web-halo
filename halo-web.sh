#!/usr/bin/env bash
# Browser version of Halo, entirely through Docker: build, local hosting with
# the local signaling service, and a bundle to run on another machine
# (see README_WEB.md).

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: ./halo-web.sh [command] [options]

Commands:
  all                   build, then serve (the default)
  build                 build the browser version
  serve                 serve the game and the signaling service locally
                        (http://127.0.0.1:8765/build/web/halo.html)
  stop                  stop the local services
  package [--url ORIGIN] [--output DIR]
                        make a bundle to run on another machine without
                        rebuilding (default output: dist/halo-web)
                        --url ORIGIN: public address given by your reverse
                        proxy (e.g. https://halo.example.lan), written to
                        the bundle's .env; without it, the game is used at
                        http://127.0.0.1:8765 on the target itself

Options:
  --hosted-maps         the server serves the maps and the page asks for no
                        XISO (for all, build, serve and package; the build,
                        the local server and the bundle must all use it)
  --iso IMAGE           with --hosted-maps: Xbox disc image to extract
                        assets/maps from when it is absent (default: the
                        only .iso or .xiso in the repository root)
  -h, --help            show this help

By default no game data is built in or served: on first use, each player
chooses an XISO of their own copy of Halo in the browser, which keeps the
maps locally. With --hosted-maps, the maps come from the server instead.
EOF
}

repository=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$repository"

# The containers run as the host user, so that this user owns build/. With
# rootless Docker, root in a container is the host user.
if docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
    export HOST_UID=${HOST_UID:-0}
    export HOST_GID=${HOST_GID:-0}
else
    export HOST_UID=${HOST_UID:-$(id -u)}
    export HOST_GID=${HOST_GID:-$(id -g)}
fi

# The bundle's files (compose.yaml, env.example, start.sh, README.md).
BUNDLE_DIR=docker/bundle
# Images the bundle's compose.yaml uses, saved into the bundle.
BUNDLE_IMAGES=(halo-signaling python:3.12-slim)
# The page of the Docker environment, made from port/web/shell.html by
# docker/web/localize_page.py. The link reads it in place of the source
# page, which is never changed (see build).
SHELL_COPY=build/docker/shell.html
# Where the page reads the maps over HTTP (hosted maps): assets/maps next to
# the page, see port/web/src/web_platform.c. Locally, a link to assets/maps.
BUILD_MAPS=build/web/assets/maps

# --hosted-maps: 1 when the server serves the maps.
hosted=0
# Options of localize_page.py for the mode.
mode_flags=()

compose() {
    docker compose "$@"
}

fail() {
    echo "halo-web.sh: $*" >&2
    exit 1
}

localize_page() {
    compose run --rm web python3 docker/web/localize_page.py "$@" "${mode_flags[@]}"
}

# --- build -------------------------------------------------------------------

extract_maps() {
    local iso=$1 iso_path container_iso
    local -a mount=()

    [ -f assets/maps/ui.map ] && return
    if [ -z "$iso" ]; then
        shopt -s nullglob
        local -a images=(*.iso *.xiso)
        shopt -u nullglob
        [ ${#images[@]} -eq 1 ] || fail "assets/maps is missing; pass --iso /path/to/Halo.iso"
        iso=${images[0]}
    fi
    [ -f "$iso" ] || fail "disc image does not exist: $iso"

    # The repository is mounted at /src; an image outside it is mounted apart.
    iso_path=$(realpath "$iso")
    case "$iso_path" in
        "$repository"/*) container_iso="/src/${iso_path#"$repository"/}" ;;
        *)
            container_iso="/iso/$(basename "$iso_path")"
            mount=(-v "$iso_path:$container_iso:ro")
            ;;
    esac
    echo "==> Extracting assets/maps from $iso"
    compose run --rm "${mount[@]}" web \
        python3 tools/xiso_extract.py "$container_iso" --output assets/maps
}

# Makes $SHELL_COPY from port/web/shell.html for the mode. The file only
# changes when its content changes: ninja relinks the page when the shell is
# newer than the page, and not otherwise.
prepare_page() {
    mkdir -p "$(dirname "$SHELL_COPY")"
    localize_page patch port/web/shell.html "$SHELL_COPY.new"
    if cmp -s "$SHELL_COPY.new" "$SHELL_COPY"; then
        rm "$SHELL_COPY.new"
    else
        mv "$SHELL_COPY.new" "$SHELL_COPY"
    fi
    # A page that is not for this mode but newer than the shell (for example
    # linked by hand from the source page) must be relinked too.
    if [ -f build/web/halo.html ] && ! localize_page verify build/web/halo.html >/dev/null 2>&1; then
        touch "$SHELL_COPY"
    fi
}

build() {
    local iso=$1

    echo "==> Build image"
    compose build web
    [ "$hosted" = 1 ] && extract_maps "$iso"

    # The web UI images (port/web/assets) are not published with the
    # sources, but the build needs the folder: without them the menu shows
    # broken images only.
    if [ ! -d port/web/assets ]; then
        echo "==> port/web/assets is missing; creating it empty (no UI images)"
        mkdir -p port/web/assets
    fi

    # Same configuration as tools/web_run.py.
    if ! { grep -q "build web: phony" build.ninja \
            && grep -q -- "-DHALO_RELEASE" build.ninja \
            && grep -q -- "-sASSERTIONS=0" build.ninja; } 2>/dev/null; then
        echo "==> Configuring"
        compose run --rm web python3 configure.py --release --pgo=off --lto=off
    fi

    # The page talks to the local signaling service instead of the author's
    # Cloudflare services, loads no Turnstile script and, with hosted maps,
    # asks for no XISO. The changes are made on the source page, before the
    # link minifies it. The copy is mounted over port/web/shell.html in the
    # container only: the source page stays as it is in the repository.
    echo "==> Preparing the page (local signaling, maps: $([ "$hosted" = 1 ] && echo hosted || echo XISO))"
    prepare_page
    echo "==> Building"
    compose run --rm -v "$repository/$SHELL_COPY:/src/port/web/shell.html:ro" web ninja web
    echo "==> Checking the page"
    localize_page verify build/web/halo.html

    # The page loads this script from its own folder (port/web/shell.html).
    cp port/web/coi-serviceworker.js build/web/

    # Hosted maps: the local server serves the repository, so the maps are
    # reached through a link. Without the option nothing serves them.
    if [ "$hosted" = 1 ]; then
        mkdir -p "$(dirname "$BUILD_MAPS")"
        ln -sfn ../../../assets/maps "$BUILD_MAPS"
    elif [ -L "$BUILD_MAPS" ]; then
        rm "$BUILD_MAPS"
    fi
}

require_build() {
    local output
    for output in halo.html halo.js halo.wasm coi-serviceworker.js; do
        [ -f "build/web/$output" ] || fail "no browser build (build/web/$output); run ./halo-web.sh build"
    done
    # The page must be for the same mode as this command.
    localize_page verify build/web/halo.html >/dev/null
    if [ "$hosted" = 1 ]; then
        [ -f "$BUILD_MAPS/ui.map" ] || fail "no game data ($BUILD_MAPS/ui.map); run ./halo-web.sh build --hosted-maps"
    fi
}

# --- local hosting -----------------------------------------------------------

serve() {
    require_build
    echo "==> Serving on http://127.0.0.1:8765/build/web/halo.html (Ctrl-C to stop)"
    compose up --build serve signaling
}

# --- bundle for another machine ----------------------------------------------

package() {
    local url=$1 output=$2
    local www="$output/www"

    require_build
    case "$url" in
        ""|http://*|https://*) ;;
        *) fail "--url must start with https:// (or http://)" ;;
    esac
    if [ -e "$output" ]; then
        [ -f "$output/compose.yaml" ] || fail "$output exists and is not a bundle"
        echo "==> Replacing $output"
        rm -rf "$output"
    fi
    mkdir -p "$www/build/web"

    echo "==> Game files"
    cp -a build/web/halo.html build/web/halo.js build/web/halo.wasm \
        build/web/coi-serviceworker.js "$www/build/web/"
    [ -d build/web/assets ] && cp -a build/web/assets "$www/build/web/"
    # Not the link to the local maps (hosted maps).
    rm -f "$www/$BUILD_MAPS"
    if [ "$hosted" = 1 ]; then
        # The maps (1.7 GiB) are not copied: the target mounts them as a
        # volume (HALO_MAPS in .env), at this empty mount point.
        mkdir -p "$www/$BUILD_MAPS"
    fi
    cp -a tools/web_serve.py "$output/"
    # The bundle's server runs as nobody.
    chmod -R a+rX "$www" "$output/web_serve.py"

    echo "==> Docker images (${BUNDLE_IMAGES[*]})"
    compose build signaling
    local image
    for image in "${BUNDLE_IMAGES[@]}"; do
        docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
    done
    docker save "${BUNDLE_IMAGES[@]}" | gzip > "$output/images.tar.gz"

    echo "==> Configuration"
    cp -a "$BUNDLE_DIR/compose.yaml" "$BUNDLE_DIR/start.sh" "$BUNDLE_DIR/README.md" "$output/"
    sed "s|^HALO_PUBLIC_ORIGIN=.*|HALO_PUBLIC_ORIGIN=$url|" "$BUNDLE_DIR/env.example" > "$output/.env"
    if [ "$hosted" = 1 ]; then
        # Compose loads compose.override.yaml with compose.yaml: it mounts
        # the maps, and start.sh then requires them.
        cp -a "$BUNDLE_DIR/compose.hosted-maps.yaml" "$output/compose.override.yaml"
        cat >> "$output/.env" <<'EOF'

# Folder of the game data (the .map files) on this machine, mounted
# read-only. It must be readable by everyone (chmod -R a+rX): the server
# runs as nobody.
HALO_MAPS=./maps
EOF
    fi

    echo "==> Bundle ready: $output ($(du -sh "$output" | cut -f1))"
    echo "    Copy it to the target machine (e.g. rsync -a $output/ target:halo-web/),"
    if [ "$hosted" = 1 ]; then
        echo "    set HALO_MAPS in its .env, then run ./start.sh there."
    else
        echo "    then run ./start.sh there."
    fi
}

# --- command line ------------------------------------------------------------

command=all
case "${1:-}" in
    all|build|serve|stop|package) command=$1; shift ;;
    -h|--help) usage; exit 0 ;;
esac

iso=""
url=""
output="dist/halo-web"
while [ $# -gt 0 ]; do
    case "$1" in
        --hosted-maps) hosted=1; mode_flags=(--hosted-maps); shift ;;
        --iso) iso=${2:?--iso needs a path}; shift 2 ;;
        --url) url=${2:?--url needs an address}; shift 2 ;;
        --output) output=${2:?--output needs a directory}; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "halo-web.sh: unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

case "$command" in
    all) build "$iso"; serve ;;
    build) build "$iso" ;;
    serve) serve ;;
    stop) compose down ;;
    package) package "$url" "$output" ;;
esac
