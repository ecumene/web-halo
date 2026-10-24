#!/usr/bin/env python3
"""Make the page of the Docker environment from the readable source page.

patch SOURCE OUTPUT [--hosted-maps]
    Writes a copy of port/web/shell.html (the source page, never the
    minified page the link makes) that:
    - empties the signaling URL (the client then uses http://<loopback>:8787,
      see apiBase() in port/web/online_client.js) and the Turnstile site
      key, and drops the Turnstile script, so the page contacts no
      Cloudflare service;
    - with --hosted-maps, does not run the XISO gate (beginXisoGate), so the
      game reads the maps over HTTP from assets/maps next to the page;
    - records the mode in <meta name="halo-maps" content="xiso|hosted">.
    Each pattern must be found exactly once; otherwise the page changed
    upstream and the script stops, naming the pattern.

verify PAGE [--hosted-maps]
    Checks a built page (minified by the link): made by `patch` for this
    mode, no Cloudflare service, and the XISO gate present or absent as the
    mode says. The attributes of a minified tag are in any order and quoting.
"""

import re
import sys
from pathlib import Path

MODES = {False: "xiso", True: "hosted"}

# What `patch` changes in the source page, one line each.
SOURCE_PATTERNS = {
    "signaling URL": re.compile(
        r'^(?P<indent>[ \t]*)<meta name="halo-signaling-url" content="[^"]*">$', re.M
    ),
    "Turnstile site key": re.compile(
        r'^(?P<indent>[ \t]*)<meta name="halo-turnstile-sitekey" content="[^"]*">$', re.M
    ),
    "Turnstile script": re.compile(
        r'^[ \t]*<script src="https://challenges\.cloudflare\.com/turnstile/[^"]*"[^>]*>'
        r"</script>\n",
        re.M,
    ),
    "XISO gate": re.compile(r"^(?P<indent>[ \t]*)preRun: \[beginXisoGate\],$", re.M),
}
TURNSTILE_SCRIPT = "challenges.cloudflare.com/turnstile"
GATE_PRESENT = re.compile(r"preRun:\s*\[\s*beginXisoGate\s*\]")
GATE_ABSENT = re.compile(r"preRun:\s*\[\s*\]")


def fail(message):
    sys.exit(f"localize_page.py: {message}")


def parse_arguments(argv):
    hosted = "--hosted-maps" in argv
    arguments = [argument for argument in argv if argument != "--hosted-maps"]
    if len(arguments) == 3 and arguments[0] == "patch":
        return "patch", Path(arguments[1]), Path(arguments[2]), hosted
    if len(arguments) == 2 and arguments[0] == "verify":
        return "verify", Path(arguments[1]), None, hosted
    fail("usage: patch SOURCE OUTPUT [--hosted-maps] | verify PAGE [--hosted-maps]")


# --- patch -------------------------------------------------------------------


def patch(source, output, hosted):
    html = source.read_text(encoding="utf-8")
    # The link replaces this placeholder and minifies the page to one line.
    if "{{{ SCRIPT }}}" not in html or html.count("\n") < 100:
        fail(f"{source} is not the readable source page (port/web/shell.html)")

    wrong = []
    for name, pattern in SOURCE_PATTERNS.items():
        count = len(pattern.findall(html))
        if count != 1:
            wrong.append(f"{name} ({count} found)")
    if wrong:
        fail(
            f"{source} changed; not found exactly once: {', '.join(wrong)}. "
            "Update SOURCE_PATTERNS in docker/web/localize_page.py."
        )

    mode = MODES[hosted]
    html = SOURCE_PATTERNS["signaling URL"].sub(
        '\\g<indent><meta name="halo-signaling-url" content="">\n'
        f'\\g<indent><meta name="halo-maps" content="{mode}">',
        html,
    )
    html = SOURCE_PATTERNS["Turnstile site key"].sub(
        '\\g<indent><meta name="halo-turnstile-sitekey" content="">', html
    )
    html = SOURCE_PATTERNS["Turnstile script"].sub("", html)
    if hosted:
        html = SOURCE_PATTERNS["XISO gate"].sub("\\g<indent>preRun: [],", html)

    output.write_text(html, encoding="utf-8")
    print(f"{output}: local signaling, no Turnstile, maps: {mode}")


# --- verify ------------------------------------------------------------------


def meta_content(html, name):
    """The content of the <meta name=NAME> tag, or None without the tag."""
    tags = [
        tag
        for tag in re.findall(r"<meta\b[^>]*>", html)
        if re.search(r'\bname="?%s"?(?=[\s>])' % re.escape(name), tag)
    ]
    if len(tags) != 1:
        fail(f"expected one <meta name={name}>, found {len(tags)}")
    match = re.search(r'\bcontent=(?:"([^"]*)"|([^\s>]*))', tags[0])
    if not match:
        return ""
    return match.group(1) if match.group(1) is not None else match.group(2)


def verify(page, hosted):
    html = page.read_text(encoding="utf-8")
    mode = MODES[hosted]

    tags = [
        tag
        for tag in re.findall(r"<meta\b[^>]*>", html)
        if re.search(r'\bname="?halo-maps"?(?=[\s>])', tag)
    ]
    if not tags:
        fail(f"{page} was not made by ./halo-web.sh build")
    built = meta_content(html, "halo-maps")
    if built != mode:
        if built == "hosted":
            fail(f"{page} was built with --hosted-maps; add --hosted-maps, or run ./halo-web.sh build")
        fail(f"{page} was built without --hosted-maps; drop --hosted-maps, or run ./halo-web.sh build --hosted-maps")

    problems = []
    if meta_content(html, "halo-signaling-url") != "":
        problems.append("the signaling URL is not empty")
    if meta_content(html, "halo-turnstile-sitekey") != "":
        problems.append("the Turnstile site key is not empty")
    if TURNSTILE_SCRIPT in html:
        problems.append("the Turnstile script is still loaded")
    if hosted:
        if GATE_PRESENT.search(html) or not GATE_ABSENT.search(html):
            problems.append("the XISO gate is still in preRun")
    elif not GATE_PRESENT.search(html):
        problems.append("the XISO gate is not in preRun")
    if problems:
        fail(f"{page}: {'; '.join(problems)}")
    print(f"{page}: local signaling, no Turnstile, maps: {mode}")


command, first, second, hosted = parse_arguments(sys.argv[1:])
if command == "patch":
    patch(first, second, hosted)
else:
    verify(first, hosted)
