# Halo Web signaling service

This directory is an isolated Cloudflare Worker that coordinates invite-link
WebRTC connections. Each room is one SQLite-backed, hibernating Durable Object.
Only room membership and SDP/ICE signaling pass through Cloudflare; Halo game
packets travel over browser-to-browser WebRTC data channels (or Cloudflare TURN
when a direct path is impossible).

The service deliberately has no account system or database. A random invite is
the guest capability, and a separate random capability is retained by the host.

## Local development

Use Node.js 22 or 24+.

```sh
cd services/signaling
npm ci
npm run types
npm test
npm run dev
```

The deployed configuration permits these exact browser origins:

- `https://halo-web.otherness-bugs.workers.dev`
- `http://127.0.0.1:8765`
- `http://localhost:8765`

Requests without an `Origin` header are rejected by the safe-by-default
production configuration. The `*` origin is honored only when
`ENVIRONMENT=development`; use it only for isolated development. If the game
moves to another hostname, update both `ALLOWED_ORIGINS` and `PUBLIC_GAME_URL`
before deploying the signaling service.

## Configuration

Non-secret settings live in `wrangler.jsonc`:

| Setting | Meaning |
| --- | --- |
| `ALLOWED_ORIGINS` | Comma-separated, exact browser origins accepted by HTTP and WebSocket routes |
| `PUBLIC_GAME_URL` | URL used to construct the copyable `#join=...` invite |
| `ROOM_TTL_SECONDS` | Absolute room lifetime; default six hours, maximum one day |
| `SESSION_TTL_SECONDS` | Lifetime of a single-use WebSocket credential; default 30 seconds |
| `TURN_TTL_SECONDS` | TURN credential lifetime; default one hour, maximum two hours here |
| `DEFAULT_ROOM_CAPACITY` | Capacity including the host; default 128 |
| `MAX_ROOM_CAPACITY` | Hard capacity ceiling; 128 machines |

`wrangler types` generates `worker-configuration.d.ts` from this file. The only
manual environment augmentation is the required room-signing secret and the two
optional secret-backed TURN values; all normal bindings and variables use the
generated `Env` type.

Create the signing secret once before the first production deploy. Signed room
IDs let the Worker reject forged/nonexistent rooms before allocating a Durable
Object:

```sh
openssl rand -hex 32 | npx wrangler secret put ROOM_ID_SECRET
```

The configured rate-limit bindings cap room creation at 20 per minute and
session creation at 512 per minute for one connecting address in one Cloudflare
location. They are an abuse backstop, not billing or quota accounting.

### Optional TURN

The service always returns Cloudflare STUN. It becomes TURN-enabled only when
both of these values exist:

```sh
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_SECRET
```

For local development, put the required room-signing secret and any optional
TURN values in an ignored `.dev.vars` file instead:

```dotenv
ROOM_ID_SECRET=replace-with-at-least-32-random-characters
TURN_KEY_ID=your-turn-key-id
TURN_KEY_SECRET=your-turn-api-token
```

Deploy the signaling service before the static browser build:

```sh
npm run deploy
```

The Worker creates a different short-lived credential after each successful
room/session authorization. It calls Cloudflare's current
`credentials/generate-ice-servers` endpoint, validates the response, and
removes port 53 URLs because browsers block them. If TURN is unconfigured or
temporarily fails, the response safely falls back to STUN only.

The browser should use:

```js
const peer = new RTCPeerConnection({
  iceServers: response.iceServers,
  iceTransportPolicy: "all",
});
```

`iceTransportPolicy: "all"` is important: it attempts a free direct connection
before TURN relay traffic. `iceServersExpiresAt` is `null` for STUN-only
responses and an epoch-millisecond timestamp when TURN credentials are present.

## HTTP API

All response bodies are JSON, all mutable responses use `Cache-Control:
no-store`, and protocol version 1 is represented as `v: 1`. Browser requests
must carry an allowed `Origin`. Request bodies are limited to 4096 bytes.

### Health

```http
GET /v1/health
```

```json
{ "ok": true, "v": 1 }
```

### List public games

```http
GET /v1/games?buildId=streamhash-2026-09-28
```

Returns `{ "v": 1, "games": [...] }`. Each game includes `name`, `hostName`,
`map`, `mode`, `players`, `capacity`, `open`, `phase` (`lobby` or `live`),
`queue`, `country`, and `joinCode`. `joinCode` is the public guest invite, never
the host ticket. Listings older than three minutes are omitted. Joining still
uses `POST /v1/rooms/:roomId/sessions` and Turnstile. A guest who connects while
`phase` is `live` receives `admission: "hold"` on `welcome` and an `admit`
message when the host reports `phase: "lobby"`. If the host leaves while
someone else is in the match, that player receives `host-handoff` and starts
the next lobby with the same map and mode. A brief connection drop waits eight
seconds before that handoff, so a host can reconnect. When nobody else is in
the game, everyone receives `room-closed` with `reason: "host-ended"` and
returns to the server list. The live match itself cannot move to another
machine.

### Create a room

```http
POST /v1/rooms
Content-Type: application/json
Origin: https://play.example.com
```

```json
{
  "protocolVersion": 1,
  "buildId": "streamhash-2026-09-28",
  "identifier": "001122334455",
  "capacity": 128
}
```

`identifier` is the lowercase 12-hex identifier used by the web transport's
XNADDR mapping. Capacity includes the host.

The response is:

```json
{
  "v": 1,
  "room": {
    "id": "7VQS-D96P-8WHA-Q3TC",
    "buildId": "streamhash-2026-09-28",
    "protocolVersion": 1,
    "capacity": 128,
    "expiresAt": 1790630000000
  },
  "host": {
    "ticket": "host-capability-kept-by-the-host",
    "session": {
      "peerId": "h_NjczMDAzNjQxYjAw",
      "identifier": "001122334455",
      "role": "host",
      "token": "single-use-websocket-token",
      "websocketUrl": "wss://signal.example/v1/rooms/7VQS-D96P-8WHA-Q3TC/ws?peer=...&token=..."
    }
  },
  "invite": {
    "code": "7VQS-D96P-8WHA-Q3TC.guest-capability",
    "url": "https://play.example.com/halo.html#join=7VQS-D96P-8WHA-Q3TC.guest-capability"
  },
  "iceServers": [{ "urls": ["stun:stun.cloudflare.com:3478"] }],
  "iceServersExpiresAt": null
}
```

The UI should show one primary action: **Copy invite link**. The same guest link
can be shared with up to 127 friends. Keep `host.ticket` only in memory and never
put it in the shared URL. The invite is in the URL
fragment, so browsers do not send it in the initial HTTP request or the
`Referer` header.

### Exchange a room capability for a WebSocket session

```http
POST /v1/rooms/:roomId/sessions
Content-Type: application/json
Origin: https://play.example.com
```

```json
{
  "protocolVersion": 1,
  "buildId": "streamhash-2026-09-28",
  "identifier": "66778899aabb",
  "ticket": "guest-capability-from-the-fragment"
}
```

Each friend splits `invite.code` at the first period, using the first part as
`:roomId` and the second as `ticket`. A host can use the same endpoint with its
private host ticket to reconnect after its prior socket has closed.

Success returns:

```json
{
  "v": 1,
  "room": {
    "id": "7VQS-D96P-8WHA-Q3TC",
    "buildId": "streamhash-2026-09-28",
    "protocolVersion": 1,
    "capacity": 128,
    "expiresAt": 1790630000000
  },
  "session": {
    "peerId": "g_NjY3Nzg4OTlhYWJi",
    "identifier": "66778899aabb",
    "role": "guest",
    "token": "single-use-websocket-token",
    "websocketUrl": "wss://signal.example/v1/rooms/7VQS-D96P-8WHA-Q3TC/ws?peer=...&token=..."
  },
  "iceServers": [{ "urls": ["stun:stun.cloudflare.com:3478"] }],
  "iceServersExpiresAt": null
}
```

The WebSocket token expires after 30 seconds and is deleted atomically during
the first successful upgrade. Invalid room IDs and invalid tickets intentionally
share a 404 response. Important 409 codes are `BUILD_MISMATCH`,
`PROTOCOL_MISMATCH`, `IDENTIFIER_IN_USE`, `ROOM_FULL`, and
`HOST_ALREADY_CONNECTED`.

### Open the signaling socket

Open the returned URL directly with the browser's `WebSocket` constructor:

```http
GET /v1/rooms/:roomId/ws?peer=:peerId&token=:singleUseToken
Upgrade: websocket
Origin: https://play.example.com
```

The Worker validates the origin before forwarding the upgrade to the room
Durable Object. The query credential is deliberately short-lived and
single-use. Application logs record only the URL path, never its query string.

## WebSocket protocol

Messages are UTF-8 JSON text. Binary frames and text frames above 65,536
characters are closed. The topology is a star: guests can signal only the host,
and the host can signal any guest. Halo gameplay data must use WebRTC data
channels, not these WebSockets. Guest welcome and membership messages expose
only the host; the host receives membership updates for every guest.

### Server to client

Immediately after connection:

```json
{
  "v": 1,
  "type": "welcome",
  "self": {
    "peerId": "g_...",
    "role": "guest",
    "identifier": "66778899aabb"
  },
  "room": {
    "id": "7VQS-D96P-8WHA-Q3TC",
    "buildId": "streamhash-2026-09-28",
    "protocolVersion": 1,
    "capacity": 128,
    "expiresAt": 1790630000000
  },
  "peers": [
    {
      "peerId": "h_...",
      "role": "host",
      "identifier": "001122334455"
    }
  ]
}
```

Membership events:

```json
{
  "v": 1,
  "type": "peer-joined",
  "peer": {
    "peerId": "g_...",
    "role": "guest",
    "identifier": "66778899aabb"
  }
}
```

```json
{
  "v": 1,
  "type": "peer-left",
  "peerId": "g_...",
  "identifier": "66778899aabb",
  "reason": "disconnected"
}
```

Relayed SDP/ICE messages add the authenticated sender:

```json
{
  "v": 1,
  "type": "signal",
  "from": "h_...",
  "signal": {
    "kind": "description",
    "description": { "type": "offer", "sdp": "v=0..." }
  }
}
```

Other server messages are `{ "v":1, "type":"pong", "nonce":"..." }` and
`{ "v":1, "type":"error", "code":"...", "message":"..." }`.

The room also broadcasts a presentation-only roster to every connected player.
It is independent of the host/guest WebRTC star topology:

```json
{
  "v": 1,
  "type": "roster",
  "players": [
    {
      "peerId": "g_...",
      "role": "guest",
      "profile": { "name": "Spartan 117", "style": "sage" }
    }
  ]
}
```

### Client to server

Optional application heartbeat:

```json
{ "v": 1, "type": "ping", "nonce": "optional-opaque-value" }
```

Each client sends its display profile after opening or reopening the socket.
Names are limited to Halo's 11-character ASCII profile field, and `style` is
one of the 18 stock armor colors validated by the service:

```json
{
  "v": 1,
  "type": "profile",
  "profile": { "name": "Spartan 117", "style": "sage" }
}
```

Session descriptions:

```json
{
  "v": 1,
  "type": "signal",
  "to": "g_...",
  "signal": {
    "kind": "description",
    "description": { "type": "offer", "sdp": "v=0..." }
  }
}
```

Trickle ICE candidates (send `candidate: null` for end-of-candidates):

```json
{
  "v": 1,
  "type": "signal",
  "to": "h_...",
  "signal": {
    "kind": "candidate",
    "candidate": {
      "candidate": "candidate:...",
      "sdpMid": "0",
      "sdpMLineIndex": 0,
      "usernameFragment": "optional"
    }
  }
}
```

The transport must process `welcome.peers` and `peer-joined.peer` first, pass
each peer's 12-hex `identifier` to `addPeer`, and only then apply SDP or ICE
signals for that `peerId`.

## Lifecycle and security properties

- Room IDs contain 80 random bits; host, invite, and session capabilities each
  contain 256 random bits. Only SHA-256 hashes are stored in SQLite.
- Guest capabilities are reusable until room expiry. Session tokens are
  30-second, single-use credentials suitable for a browser WebSocket URL.
- One alarm deletes the room at its absolute TTL and closes connected sockets
  with code 4001.
- WebSocket attachments store peer ID, role, identifier, join time, and the
  small validated display profile, so membership and the roster survive
  Durable Object hibernation.
- Capacity includes connected sockets and unexpired pending sessions, preventing
  click races from overbooking a room.
- A 12-hex network identifier can appear only once among active or pending peers.
- The signaling object validates and relays SDP/ICE only; it cannot relay game
  traffic or arbitrary guest-to-guest messages.
- Cloudflare Rate Limiting bindings cap room creation and session exchange
  before a request reaches a room Durable Object. Capability entropy prevents
  guessing but does not by itself prevent an attacker from creating many empty
  rooms.

## Verification

```sh
npm run check
```

This checks generated bindings, runs strict TypeScript compilation, executes
the Worker/Durable Object/WebSocket tests, mocks the Cloudflare TURN credential
request, and performs a Wrangler dry-run bundle. It does not deploy.

Useful individual commands:

```sh
npm run types:check
npm test
npm run deploy:dry
```

The tests cover room creation, origin rejection, build and identifier matching,
capacity, single-use WebSocket credentials, peer membership, room revocation,
signed-room rejection, SDP relay, STUN fallback, TURN TTL clipping, and browser
port-53 filtering.
