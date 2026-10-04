# Halo LAN server (self-host stack)

This fork of [ecumene/web-halo](https://github.com/ecumene/web-halo) adds one
folder, `selfhost/`. That folder is a Docker/Dockge stack that builds the browser
version of Halo: Combat Evolved from this repository and serves it on your LAN,
using maps from your own Xbox disc.

- **No upstream files are changed.** The few source edits a self-hosted copy needs
  are applied at build time by `scripts/patch_selfhost.py`, so merging upstream
  changes into this branch never conflicts.
- **LAN only.** No accounts, no domain, and no ports opened to the internet.
- **Nothing to install on players' PCs.** They open a link in Chrome or Edge.

## Which repository is which

| Repository | What it is |
| --- | --- |
| bnunu/halo-ce-universal (same project as cybersecurity/halo-ce-universal) | The Halo CE engine, rebuilt from the Xbox game, as installable apps for Windows, Linux and Android. It has no browser version. |
| **ecumene/web-halo** (this fork) | Mitchell Hynes's copy of that project, plus the browser build, the lobby page and the room service. It's the source of the public browser site, which credits the two repos above. |

## How it works

| Container | Job |
| --- | --- |
| `web` (Caddy) | Serves `halo.js`, `halo.wasm` and your maps over HTTPS with the cross-origin isolation headers the game needs, and forwards `/v1/*` to signaling. |
| `signaling` | The site's own room service (`services/signaling`, a Cloudflare Worker) run locally with `wrangler dev`. It handles lobbies, invite links and WebRTC offers. |
| `extract` | One-shot. Copies `maps/` out of your disc image into `./data/maps`. |

The game runs in each player's browser. Whoever creates the lobby hosts the match,
and gameplay goes browser to browser over your LAN.

### Why HTTPS, not plain HTTP

The game uses WebAssembly threads, which need `SharedArrayBuffer`. Browsers only
provide that on a secure page: HTTPS, or `localhost`. On `http://192.168.x.x`
it doesn't exist and the game can't start.

So Caddy serves HTTPS with its own self-signed certificate for the server's IP.
The first time each player opens the page, the browser shows a warning:

- In Chrome, click **Advanced → Proceed to 192.168.1.50 (unsafe)**. In Edge, the link says **Continue to 192.168.1.50 (unsafe)**.
- In Firefox, click **Advanced → Accept the Risk and Continue**.

After that the game runs normally. Tested in Chromium: after clicking through, the
page is cross-origin isolated, and threads, map streaming and the lobby WebSocket
all work.

## What you need

- A Docker host with Docker Compose v2 (Dockge works), internet access during the
  build, about 15 GB of free disk and 8 GB of RAM for the one-time compile.
- A fixed LAN IP for that host (a DHCP reservation).
- Your Halo Xbox disc image (`.iso` or `.xiso`). Any region works.
- Players: desktop Chrome or Edge (Firefox works too) and about 3 GB of free RAM
  for the tab.

## 1. Create the stack in Dockge

1. In Dockge, click **+ Compose** and name the stack `halo`.
2. Paste [`selfhost/compose.yaml`](compose.yaml) into the compose editor.
3. Paste [`selfhost/example.env`](example.env) into the `.env` box and set:
   - `HALO_SOURCE=https://github.com/<you>/web-halo.git#selfhost`
   - `HALO_HOST=192.168.1.50` (the server's LAN IP)
4. Click **Save**. Don't deploy yet.

The stack folder is now `/opt/stacks/halo` (Dockge's default). Run the commands below
from that folder.

## 2. Extract the maps

```sh
sudo mkdir -p /opt/stacks/halo/iso
sudo mv /tmp/halo.iso /opt/stacks/halo/iso/halo.iso   # after copying it over with scp
cd /opt/stacks/halo
sudo docker compose run --rm extract
```

This creates `data/maps` with 24 lowercase `.map` files: `ui.map`, 13 multiplayer
maps and 10 campaign missions.

## 3. Build and start

```sh
sudo docker compose build    # 15-25 min the first time; Docker fetches your fork itself
sudo docker compose up -d    # or Start in Dockge
curl -sk https://192.168.1.50:8443/v1/health   # {"ok":true,"v":1}
```

In Dockge, use Start, Restart and Stop for this stack. Skip **Update**: it tries to
pull these images from a registry, and they only exist on your server.

## 4. Play

1. Open `https://192.168.1.50:8443` in Chrome or Edge and click past the warning
   once. If you set `HALO_HTTPS_PORT=443`, leave out the `:8443`.
2. The host clicks **Play online**, picks a map and mode, clicks **Create link**,
   and sends out the link from **Copy link**.
3. Friends open the link, click past the same warning, and press **Join game**.
4. The host starts the match from the in-game lobby.

Campaign works offline from the main menu.

## Updating from upstream

1. On GitHub, open your fork and click **Sync fork**. That updates `main`.
2. Merge `main` into `selfhost`. Open
   `https://github.com/<you>/web-halo/compare/selfhost...main`, create the pull
   request and merge it. Use that URL rather than the New pull request button,
   which points at Mitchell's repository by default.
3. On the server: `sudo docker compose build && sudo docker compose up -d`. Every
   player reloads the page, because lobbies only accept players on the same build.

If the build then stops in `patch_selfhost.py` with "expected exactly 1 match",
upstream changed a line the patch edits. Build the tested version with
`HALO_SOURCE=...web-halo.git#selfhost-v1` until the patch is updated.

Keep GitHub Actions disabled on the fork (the default for forks). Upstream's deploy
workflow targets Mitchell's Cloudflare account and would only fail here.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| The game never starts, or the console mentions SharedArrayBuffer or cross-origin isolation | Use `https://<ip>:<port>`, not `http://`. In the console, `crossOriginIsolated` should print `true`. |
| `ERR_SSL_PROTOCOL_ERROR` instead of the warning | You typed a different address than `HALO_HOST` (for example a hostname). The certificate covers exactly that address. |
| The warning comes back now and then | Browsers forget the decision after a while or after a restart. Click through again. |
| "The private-room service is unreachable" | Read `sudo docker compose logs signaling`; it should end with `Ready on http://0.0.0.0:8787`. |
| A friend stays on "connecting" | Same network with no Wi-Fi client isolation; Windows network profile set to Private. If it still fails, set `chrome://flags/#enable-webrtc-hide-local-ips-with-mdns` to Disabled on both PCs. |
| A map won't load (404) | `ls data/maps` should list 24 lowercase files. Extract again after `sudo rm -f data/maps/*`. |
| Can't join after an update | Every player hard-reloads with Ctrl+Shift+R. |
| Tab crashes or runs out of memory | The game reserves about 2.25 GB. Close other tabs; use a PC with 8 GB of RAM or more. |
| Build killed, or download errors | Rerun `sudo docker compose build`; finished steps are cached. Set `BUILD_JOBS=4` if it ran out of memory. |
| "port is already allocated" | Change `HALO_HTTPS_PORT`. |

## Files

| File | Purpose |
| --- | --- |
| `compose.yaml` | The stack: `web`, `signaling`, and the one-shot `extract` |
| `example.env` | Settings to paste into Dockge's `.env` box |
| `Dockerfile` | Patches a copy of the repo, builds it with Emscripten 6.0.10, packs it with Caddy |
| `Caddyfile` | HTTPS on 8443 with a long-lived self-signed certificate, COOP/COEP headers, `/v1` proxy |
| `scripts/patch_selfhost.py` | Same-origin room service, Turnstile off, `wrangler dev` compatibility |
| `scripts/stamp_build_id.py` | Build id from the build's hash, so lobbies only mix identical builds |
| `scripts/signaling-entrypoint.sh` | Generates and keeps the signaling secrets, runs `wrangler dev` |
| `scripts/extract.sh` | Wraps `tools/xiso_extract.py` |

## Optional artwork

The public site's images (map thumbnails, mode icons, background) aren't in the
source repo, so those spots are blank. To fill them, drop images with these names
into `data/ui/`; no restart is needed:

- `maps/`: battle-creek, sidewinder, damnation, rat-race, prisoner, hang-em-high,
  chill-out, derelict, boarding-action, blood-gulch, wizard, chiron-tl-34, longest
- `modes/`: slayer, team-slayer, capture-the-flag, oddball, king-of-the-hill, race
- `spartan/`: white, black, red, blue, sage, yellow, lime, pink, purple, cyan,
  cornflower, orange, teal, forest, brown, tan, maroon, rose
- `shell/`: halo-ce-ring-menu.jpg, hud-frame.png, xbox-duke-controller.png

Each of `maps/`, `modes/` and `spartan/` takes `.png` files.

## Credits

Browser port and room service: Mitchell Hynes (ecumene/web-halo). It builds on
cybersecurity/halo-ce-universal and bnunu/halo-ce-universal, which come from the
bnunu/halo-1 and punpckhdq/halo decompilation. All of these are CC0.

Halo is Microsoft's. Use your own disc and keep this on your own network.
