# Halo (browser version)

This bundle is ready to use: you do not compile anything. You need only
Docker with Compose. The Docker images are included (`images.tar.gz`), so
Internet access is not necessary.

```sh
./start.sh            # load the images and start the services
docker compose down   # stop the services
```

All the settings are in `.env`.

The Docker images are for the architecture of the computer that made the
bundle (for example x86-64). A machine with a different architecture (for
example ARM) cannot start them.

To update, copy the new bundle over this folder, but keep this `.env` (for
example `rsync -a --exclude .env`), then run `./start.sh` again.

## Game data

The bundle does not include game data.

By default it does not serve it either. On first use, each player chooses
an Xbox disc image (`.xiso` or `.iso`) made from their own copy of Halo:
Combat Evolved. The browser copies the maps to its own local storage and
reads them from there. The disc image never leaves the player's device.

A bundle with hosted maps (it has `compose.override.yaml`) serves the maps
instead, and the page asks for no disc image. Put the `.map` files in the
folder `HALO_MAPS` of `.env` (`./maps` by default). The folder must be
readable by everyone (`chmod -R a+rX`): the server runs as nobody.
`start.sh` stops when `ui.map` is not there. A browser that already has an
XISO in its local storage keeps using it.

## Services

| Service | Port (`.env`) | Purpose |
| --- | --- | --- |
| `web` | `HALO_WEB_PORT` (8765) | The game files (and the maps, with hosted maps), with the COOP and COEP headers |
| `signaling` | `HALO_SIGNALING_PORT` (8787) | Connects the browsers (online lobbies) |

They listen on `HALO_BIND` (`127.0.0.1` by default).

## On this machine only

Keep `HALO_PUBLIC_ORIGIN` empty and open
<http://127.0.0.1:8765/build/web/halo.html>. Keep the ports 8765 and 8787:
the game then calls the signaling service on port 8787.

## Behind a reverse proxy

Outside `localhost`, browsers require HTTPS: the game needs cross-origin
isolation (WebAssembly threads). Put the public address in
`HALO_PUBLIC_ORIGIN` (for example `https://halo.example.lan`) and restart
(`docker compose up -d`). Then configure the proxy, on one domain:

- send `/v1/*` to the `signaling` service, with WebSockets (`Upgrade`);
- send all other paths to the `web` service;
- keep the original `Host` header;
- keep the `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`
  headers of the `web` service.

The game is then at `HALO_PUBLIC_ORIGIN/build/web/halo.html`.

## Multiplayer

The `signaling` service connects the browsers. The game traffic then goes
directly between them.
