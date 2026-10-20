#!/bin/sh
# Copy maps/ out of your Halo Xbox disc image into /data/maps (./data/maps on
# the host). Uses the port's own extractor (tools/xiso_extract.py).
set -eu

iso="${1:?usage: extract /iso/<your disc image>}"
out=/data/maps
staging=/data/.maps-new

if [ ! -f "$iso" ]; then
  echo "Disc image not found: $iso" >&2
  echo "Put it in ./iso and set HALO_ISO in .env to its file name." >&2
  exit 1
fi
if [ -d "$out" ] && [ -n "$(ls -A "$out")" ]; then
  echo "./data/maps already has files. Delete what's in it first to extract again." >&2
  exit 1
fi

# Extract next to the target, then move the files into ./data/maps itself.
# Keeping the same directory means a running web container sees them at once.
rm -rf "$staging"
python3 /usr/local/bin/xiso_extract.py "$iso" --output "$staging"
mkdir -p "$out"
for f in "$staging"/*; do
  name=$(basename "$f")
  # The web server is case-sensitive and the game asks for lowercase names.
  lower=$(printf '%s' "$name" | tr 'A-Z' 'a-z')
  mv "$f" "$out/$lower"
done
rmdir "$staging"
chmod -R a+rX "$out"

echo
ls -l "$out"
for required in ui.map bloodgulch.map a10.map; do
  [ -f "$out/$required" ] || echo "WARNING: $required is missing" >&2
done
