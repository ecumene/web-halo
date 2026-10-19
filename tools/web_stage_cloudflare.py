#!/usr/bin/env python3
"""Stage Combat Lab without game data or the former site's artwork.

Players select an XISO made from their own disc. The browser validates it
and keeps the required maps in origin-private local storage; no map files are
copied into the deployable asset tree.
"""

from __future__ import annotations

import hashlib
import re
import shutil
import sys
from pathlib import Path


MAX_ASSET_BYTES = 25 * 1024 * 1024
HEADERS = """/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Cache-Control: public, max-age=0, must-revalidate
"""

BUILD_META_PATTERN = re.compile(
    rb'<meta\b(?=[^>]*\bname=(?:["\']halo-build-id["\']|halo-build-id)(?=[\s>]))[^>]*>'
)


def checked_copy(source: Path, destination: Path) -> int:
    if not source.is_file():
        raise FileNotFoundError(f"required web asset is missing: {source}")
    size = source.stat().st_size
    if size > MAX_ASSET_BYTES:
        raise ValueError(
            f"{source.name} is {size:,} bytes; Cloudflare Assets allows "
            f"at most {MAX_ASSET_BYTES:,} bytes per file"
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    return size


def asset_build_id(web_build: Path) -> str:
    digest = hashlib.sha256()
    for name in ("halo.html", "halo.js", "halo.wasm"):
        source = web_build / name
        if not source.is_file():
            raise FileNotFoundError(f"required web asset is missing: {source}")
        digest.update(name.encode("ascii"))
        with source.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
    return f"web-{digest.hexdigest()[:24]}"


def stamp_build_id(path: Path, build_id: str) -> None:
    contents = path.read_bytes()
    replacement = f'<meta name="halo-build-id" content="{build_id}">'.encode("ascii")
    updated, count = BUILD_META_PATTERN.subn(replacement, contents, count=1)
    if count != 1:
        raise ValueError(f"halo build metadata is missing from {path}")
    path.write_bytes(updated)


def main() -> int:
    repository = Path(__file__).resolve().parents[1]
    web_build = repository / "build" / "web"
    output = repository / "build" / "cloudflare-web"

    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    build_id = asset_build_id(web_build)

    total = 0
    total += checked_copy(web_build / "halo.html", output / "index.html")
    total += checked_copy(web_build / "halo.js", output / "engine.js")
    total += checked_copy(web_build / "halo.wasm", output / "engine.wasm")

    # Keep the compiler's internal names while publishing neutral asset URLs.
    page = output / "index.html"
    html, count = re.subn(r'\bsrc=(?:"halo\.js"|\'halo\.js\'|halo\.js)(?=[\s>])',
                          'src="engine.js"', page.read_text(encoding="utf-8"))
    if count != 1:
        raise ValueError("expected exactly one engine script in the built page")
    page.write_text(html, encoding="utf-8")
    engine = output / "engine.js"
    javascript = engine.read_text(encoding="utf-8")
    if javascript.count('"halo.wasm"') != 1:
        raise ValueError("expected exactly one WebAssembly asset in the built engine")
    engine.write_text(javascript.replace('"halo.wasm"', '"engine.wasm"'), encoding="utf-8")

    total += checked_copy(
        repository / "port" / "web" / "coi-serviceworker.js",
        output / "coi-serviceworker.js",
    )

    stamp_build_id(output / "index.html", build_id)

    # Only original Combat Lab artwork is deployable. Do not recursively copy
    # the old UI tree: it contains game screenshots and branded controller art.
    ui_assets = repository / "port" / "web" / "assets" / "ui" / "combat-lab"
    for source in sorted(path for path in ui_assets.rglob("*") if path.is_file()):
        total += checked_copy(
            source,
            output / "assets" / "ui" / "combat-lab" / source.relative_to(ui_assets),
        )

    (output / "_headers").write_text(HEADERS, encoding="utf-8")
    print(
        f"Staged {total / (1024 * 1024):.1f} MiB of browser assets in {output} ({build_id})",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (FileNotFoundError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
