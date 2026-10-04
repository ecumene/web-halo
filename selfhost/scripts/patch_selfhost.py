#!/usr/bin/env python3
"""Adapt ecumene/web-halo (the source of mitchellhynes.com/halo) for a LAN server.

The public site runs on Cloudflare: a Worker for room signaling, Turnstile
(the "are you human" check) and Analytics Engine for telemetry. This script
makes the small changes needed to run the same code on your own box:

  1. shell.html   - talk to the room service on the page's own origin
                    (Caddy forwards /v1/* to the signaling container) and
                    turn off Turnstile.
  2. online_client.js - always open the signaling WebSocket on the page's
                    own origin, so the reverse proxy's http->https hop can't
                    produce a ws:// vs wss:// mismatch.
  3. signaling    - tolerate missing Analytics Engine / rate-limit bindings
                    when running under `wrangler dev` instead of Cloudflare.

Every edit must match exactly once. If upstream changed the code, the build
stops here with a clear message instead of producing a broken site.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


class PatchError(RuntimeError):
    pass


def edit(path: Path, pattern: str, replacement: str, *, regex: bool = False, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    if regex:
        updated, count = re.subn(pattern, replacement, text, flags=re.DOTALL)
    else:
        count = text.count(pattern)
        updated = text.replace(pattern, replacement)
    if count != 1:
        raise PatchError(
            f"{label}: expected exactly 1 match in {path}, found {count}. "
            "Upstream probably changed: build the #selfhost-v1 version, or ask for an updated patch."
        )
    path.write_text(updated, encoding="utf-8")
    print(f"patched: {label}")


MAP_LOADING_NAME_DEFINITION = r"""
#ifdef HALO_WEB
/* Self-host build: the browser platform layer asks which map is loading
(port/web/src/web_platform.c, for the loading screen and its telemetry).
Upstream's definition of this function is not in the public repository.
It answers with the cache name of the map being copied in, e.g. "a10". */
const char *game_map_loading_name(
	void)
{
	if (cache_file_globals.copying_to_map_file_index != NONE &&
		cache_file_globals.copying_to_map_file_name[0])
	{
		return cache_file_globals.copying_to_map_file_name;
	}

	return "";
}
#endif
"""


def define_missing_map_loading_name(root: Path) -> None:
    definition = re.compile(r"\bgame_map_loading_name\s*\(\s*void\s*\)\s*\{")
    for source in [*root.glob("source/**/*.c"), *root.glob("port/**/*.c")]:
        if definition.search(source.read_text(encoding="utf-8", errors="replace")):
            print(f"skipped: game_map_loading_name is already defined in {source.relative_to(root)}")
            return
    target = root / "source/cache/cache_files_windows.c"
    text = target.read_text(encoding="utf-8")
    if "static struct cache_file_runtime_globals cache_file_globals;" not in text:
        raise PatchError(
            f"game_map_loading_name: cache_file_globals not found in {target}. "
            "Upstream probably changed: build the #selfhost-v1 version, or ask for an updated patch."
        )
    target.write_text(text.rstrip("\n") + "\n" + MAP_LOADING_NAME_DEFINITION, encoding="utf-8")
    print("patched: define missing game_map_loading_name()")


def main(root: Path) -> None:
    shell = root / "port/web/shell.html"
    client = root / "port/web/online_client.js"
    abuse = root / "services/signaling/src/abuse.ts"
    index = root / "services/signaling/src/index.ts"
    wrangler = root / "services/signaling/wrangler.jsonc"

    # 1. Same-origin room service, no Turnstile.
    # "/" resolves to the page's own origin (also when opened via localhost).
    edit(shell, r'(<meta name="halo-signaling-url" content=")[^"]*(">)', r"\1/\2",
         regex=True, label="shell: same-origin signaling URL")
    edit(shell, r'(<meta name="halo-turnstile-sitekey" content=")[^"]*(">)', r"\1\2",
         regex=True, label="shell: disable Turnstile site key")
    edit(shell, r'\s*<script src="https://challenges\.cloudflare\.com/turnstile/[^"]*"[^>]*></script>', "",
         regex=True, label="shell: drop Turnstile script")
    edit(shell, r'(<meta name="halo-build-id" content=")[^"]*(">)', r"\1selfhost-web-v1\2",
         regex=True, label="shell: self-host build id")

    # 2. WebSocket always on the page's origin (path + query from the server).
    edit(
        client,
        '    var url = new URL(value, service);\n'
        '    if (url.protocol === "http:") url.protocol = "ws:";',
        '    var returned = new URL(value, service);\n'
        '    var url = new URL(returned.pathname + returned.search, service);\n'
        '    if (url.protocol === "http:") url.protocol = "ws:";',
        label="client: same-origin signaling WebSocket",
    )

    # 3. Signaling Worker under wrangler dev.
    edit(abuse, "env.TURN_EVENTS.writeDataPoint({", "env.TURN_EVENTS?.writeDataPoint({",
         label="signaling: optional Analytics Engine")
    edit(
        index,
        "  const result = await limiter.limit({ key: `${scope}:${requestActor(request)}` });",
        "  if (!limiter) return;\n"
        "  const result = await limiter.limit({ key: `${scope}:${requestActor(request)}` });",
        label="signaling: optional rate limiter",
    )
    edit(wrangler, r'\s*"analytics_engine_datasets":\s*\[[^\]]*\],', "",
         regex=True, label="signaling: no Analytics Engine binding")

    # 4. Missing upstream function. port/web/src/web_platform.c (since commit
    #    434581c, "Instrument web startup and map loading") calls
    #    game_map_loading_name(), but its definition was never committed, so
    #    the public repository fails to link. Supply one, unless upstream adds
    #    its own later.
    define_missing_map_loading_name(root)

    # The build expects this folder (the site's images are not in the repo).
    (root / "port/web/assets/ui").mkdir(parents=True, exist_ok=True)
    print("self-host patches applied")


if __name__ == "__main__":
    try:
        main(Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve())
    except PatchError as error:
        sys.exit(f"patch_selfhost.py: {error}")
