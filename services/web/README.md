# Combat Lab browser hosting

This package publishes the browser build with Cloudflare Workers Static Assets
and records Analytics Engine telemetry. It does not serve Halo map data.
Players choose an XISO made from their own Xbox disc; the browser validates the
image and stores only the required maps in origin-private local storage.

The public deployment is
[mitchellhynes.com/combat-lab/](https://mitchellhynes.com/combat-lab/), served by
S3 and CloudFront through the `ecumene/ecumene` repository's upload and publish
workflows. The Cloudflare Worker here is a separate hosting target.

Staging publishes `index.html`, `engine.js`, `engine.wasm`, the isolation worker,
and only the original artwork in `port/web/assets/ui/combat-lab`. The old
screenshots, controller photographs, and character renders are not deployed.
Legacy URLs are redirected by the AWS publication workflow, which also removes
the former runtime and artwork under the old prefixes.
Do not add proprietary Halo game data to Static Assets, R2, or this repository.

Build and validate from the repository root:

```sh
ninja web
cd services/web
npm ci
npm run check
```

Deploy with:

```sh
npm run deploy
```

`tools/web_stage_cloudflare.py` creates the ignored
`build/cloudflare-web/` directory and fails if a required runtime asset is
missing or larger than Cloudflare's per-file limit. It deliberately never
copies files from `assets/maps`. The generated `_headers` file enables the
cross-origin isolation required by WebAssembly threads.
