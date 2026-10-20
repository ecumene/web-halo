#!/usr/bin/env python3
"""Give the web build a build id derived from its own bytes.

Players can only share a lobby when their pages carry the same build id, so a
stale browser tab from before a rebuild gets a clear "build mismatch" instead
of joining and desyncing. Same idea as upstream's tools/web_stage_cloudflare.py.
Emscripten minifies halo.html in release builds (attribute quotes removed,
attributes reordered), so match the meta tag in either form.

usage: stamp_build_id.py <build/web dir> <page.html> [<page.html> ...]
"""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

PATTERN = re.compile(
    rb'<meta\b(?=[^>]*\bname=(?:["\']halo-build-id["\']|halo-build-id)(?=[\s>/]))[^>]*>'
)


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        sys.exit(__doc__)
    web = Path(argv[1])
    digest = hashlib.sha256()
    for name in ("halo.html", "halo.js", "halo.wasm"):
        digest.update(name.encode("ascii"))
        digest.update((web / name).read_bytes())
    build_id = f"selfhost-{digest.hexdigest()[:24]}"
    tag = f'<meta name="halo-build-id" content="{build_id}">'.encode("ascii")
    for page in map(Path, argv[2:]):
        data = page.read_bytes()
        updated, count = PATTERN.subn(tag, data, count=1)
        if count != 1:
            sys.exit(f"stamp_build_id.py: no halo-build-id meta tag in {page}")
        page.write_bytes(updated)
    print(f"build id: {build_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
