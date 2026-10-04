import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { signedRoomId } from "../src/crypto";
import { PLAYER_STYLES, parsePlayerProfile } from "../src/protocol";
import type {
  CreateRoomResponse,
  CreateSessionResponse,
} from "../src/index";

const API_ORIGIN = "http://signaling.test";
const GAME_ORIGIN = "http://127.0.0.1:8765";
const BUILD_ID = "halo-web-test-1";
const ROOM_ID_SECRET = "test-only-room-id-secret-32-bytes-minimum";

function jsonRequest(path: string, body: unknown, origin = GAME_ORIGIN): Request {
  return new Request(`${API_ORIGIN}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    method: "POST",
  });
}

async function createRoom(
  identifier = "001122334455",
  capacity = 2,
): Promise<CreateRoomResponse> {
  const response = await exports.default.fetch(
    jsonRequest("/v1/rooms", {
      buildId: BUILD_ID,
      capacity,
      identifier,
      protocolVersion: 1,
    }),
  );
  expect(response.status).toBe(201);
  return response.json<CreateRoomResponse>();
}

async function createGuestSession(
  room: CreateRoomResponse,
  identifier = "66778899aabb",
  buildId = BUILD_ID,
): Promise<Response> {
  const separator = room.invite.code.indexOf(".");
  const guestTicket = room.invite.code.slice(separator + 1);
  return exports.default.fetch(
    jsonRequest(`/v1/rooms/${room.room.id}/sessions`, {
      buildId,
      identifier,
      protocolVersion: 1,
      ticket: guestTicket,
    }),
  );
}

async function closeRoom(room: CreateRoomResponse): Promise<Response> {
  return exports.default.fetch(
    new Request(`${API_ORIGIN}/v1/rooms/${room.room.id}`, {
      body: JSON.stringify({ ticket: room.host.ticket }),
      headers: { "Content-Type": "application/json", Origin: GAME_ORIGIN },
      method: "DELETE",
    }),
  );
}

function nextMessage(
  socket: WebSocket,
  expectedType: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${expectedType}.`)),
      2_000,
    );
    const listener = (event: MessageEvent): void => {
      if (typeof event.data !== "string") {
        return;
      }
      const value: unknown = JSON.parse(event.data);
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).type === expectedType
      ) {
        clearTimeout(timeout);
        socket.removeEventListener("message", listener);
        resolve(value as Record<string, unknown>);
      }
    };
    socket.addEventListener("message", listener);
  });
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("close", listener);
      reject(new Error("Timed out waiting for WebSocket close."));
    }, 2_000);
    const listener = (event: CloseEvent): void => {
      clearTimeout(timeout);
      socket.removeEventListener("close", listener);
      resolve(event);
    };
    socket.addEventListener("close", listener);
  });
}

async function roomStorageState(roomId: string): Promise<{
  alarm: number | null;
  tables: string[];
}> {
  const stub = env.ROOMS.getByName(roomId);
  return runInDurableObject(stub, async (_instance, state) => ({
    alarm: await state.storage.getAlarm(),
    tables: state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('room', 'pending_sessions')",
      )
      .toArray()
      .map(({ name }) => name),
  }));
}

async function connectSession(
  websocketUrl: string,
): Promise<{ socket: WebSocket; welcome: Record<string, unknown> }> {
  const requestUrl = new URL(websocketUrl);
  requestUrl.protocol = requestUrl.protocol === "wss:" ? "https:" : "http:";
  const response = await exports.default.fetch(
    new Request(requestUrl, {
      headers: { Origin: GAME_ORIGIN, Upgrade: "websocket" },
    }),
  );
  expect(response.status).toBe(101);
  expect(response.webSocket).not.toBeNull();
  const socket = response.webSocket;
  if (socket === null) {
    throw new Error("Upgrade did not return a WebSocket.");
  }
  const welcomePromise = nextMessage(socket, "welcome");
  socket.accept();
  return { socket, welcome: await welcomePromise };
}

interface PresenceSummary {
  campaign: number;
  online: number;
  today: number;
}

async function livePresence(): Promise<PresenceSummary> {
  const response = await exports.default.fetch(
    new Request(`${API_ORIGIN}/v1/presence`, {
      headers: { Origin: GAME_ORIGIN },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(GAME_ORIGIN);
  return response.json<PresenceSummary>();
}

async function presenceHeartbeat(
  sessionId: string,
  campaign: boolean,
  address: string,
  userAgent: string,
): Promise<PresenceSummary> {
  const response = await exports.default.fetch(
    new Request(`${API_ORIGIN}/v1/presence`, {
      body: JSON.stringify({ campaign, sessionId }),
      headers: {
        "CF-Connecting-IP": address,
        "Content-Type": "application/json",
        Origin: GAME_ORIGIN,
        "User-Agent": userAgent,
      },
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  return response.json<PresenceSummary>();
}

describe("signaling API", () => {
  it("reports anonymous online, campaign, and daily player counts", async () => {
    expect(await livePresence()).toMatchObject({ campaign: 0, online: 0, today: 0 });

    const firstSession = "11111111-1111-4111-8111-111111111111";
    const secondSession = "22222222-2222-4222-8222-222222222222";
    expect(await presenceHeartbeat(
      firstSession, true, "192.0.2.10", "Test Browser A",
    )).toMatchObject({ campaign: 1, online: 0, today: 1 });
    expect(await presenceHeartbeat(
      secondSession, true, "192.0.2.10", "Test Browser A",
    )).toMatchObject({ campaign: 1, online: 0, today: 1 });
    expect(await presenceHeartbeat(
      "33333333-3333-4333-8333-333333333333",
      false,
      "192.0.2.11",
      "Test Browser B",
    )).toMatchObject({ campaign: 1, online: 0, today: 2 });

    const room = await createRoom("001122334455", 3);
    const host = await connectSession(room.host.session.websocketUrl);
    expect(await livePresence()).toMatchObject({ campaign: 1, online: 1, today: 2 });

    const guestResponse = await createGuestSession(room);
    const guestBody = await guestResponse.json<CreateSessionResponse>();
    const guest = await connectSession(guestBody.session.websocketUrl);
    expect(await livePresence()).toMatchObject({ campaign: 1, online: 2, today: 2 });

    expect(await presenceHeartbeat(
      firstSession, false, "192.0.2.10", "Test Browser A",
    )).toMatchObject({ campaign: 1, online: 2, today: 2 });
    expect(await presenceHeartbeat(
      secondSession, false, "192.0.2.10", "Test Browser A",
    )).toMatchObject({ campaign: 0, online: 2, today: 2 });

    guest.socket.close(1000, "test complete");
    host.socket.close(1000, "test complete");
  });

  it("creates a capability-protected room and STUN-only host session", async () => {
    const body = await createRoom();

    expect(body.v).toBe(1);
    expect(body.room.capacity).toBe(2);
    expect(body.room.id).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}_[A-Za-z0-9_-]{43}$/u,
    );
    expect(body.host.ticket).toMatch(/^[A-Za-z0-9_-]{32,64}$/u);
    expect(body.host.session.identifier).toBe("001122334455");
    expect(body.host.session.role).toBe("host");
    expect(body.invite.url).toContain("#join=");
    expect(body.iceServers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
    ]);
    expect(body.iceServersExpiresAt).toBeNull();
  });

  it("rejects disallowed browser origins", async () => {
    const response = await exports.default.fetch(
      jsonRequest(
        "/v1/rooms",
        {
          buildId: BUILD_ID,
          identifier: "001122334455",
          protocolVersion: 1,
        },
        "https://evil.example",
      ),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects forged room identifiers before opening a Durable Object", async () => {
    const forgedRoom =
      "ABCD-EFGH-JKLM-NPQR_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const response = await exports.default.fetch(
      jsonRequest(`/v1/rooms/${forgedRoom}/sessions`, {
        buildId: BUILD_ID,
        identifier: "66778899aabb",
        protocolVersion: 1,
        ticket: "A".repeat(43),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "ROOM_NOT_FOUND" },
    });
  });

  it("enforces build compatibility, unique identifiers, and capacity", async () => {
    const room = await createRoom();

    const wrongBuild = await createGuestSession(
      room,
      "66778899aabb",
      "different-build",
    );
    expect(wrongBuild.status).toBe(409);

    const duplicate = await createGuestSession(room, "001122334455");
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      error: { code: "IDENTIFIER_IN_USE" },
    });

    const guest = await createGuestSession(room);
    expect(guest.status).toBe(201);
    const guestBody = await guest.json<CreateSessionResponse>();
    expect(guestBody.session.identifier).toBe("66778899aabb");
    expect(guestBody.session.role).toBe("guest");

    const full = await createGuestSession(room, "abcdef123456");
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: { code: "ROOM_FULL" } });
  });

  it("lets the host revoke a room", async () => {
    const room = await createRoom();
    const response = await closeRoom(room);
    expect(response.status).toBe(204);
    expect((await createGuestSession(room)).status).toBe(404);
  });

  it("keeps signed nonexistent and replayed deleted rooms storage-empty", async () => {
    const neverCreatedRoomId = await signedRoomId(ROOM_ID_SECRET);
    const neverCreated = await exports.default.fetch(
      jsonRequest(`/v1/rooms/${neverCreatedRoomId}/sessions`, {
        buildId: BUILD_ID,
        identifier: "66778899aabb",
        protocolVersion: 1,
        ticket: "A".repeat(43),
      }),
    );
    expect(neverCreated.status).toBe(404);
    expect(await roomStorageState(neverCreatedRoomId)).toEqual({
      alarm: null,
      tables: [],
    });

    const room = await createRoom();
    const stub = env.ROOMS.getByName(room.room.id);
    expect((await closeRoom(room)).status).toBe(204);
    await evictDurableObject(stub);

    expect((await createGuestSession(room)).status).toBe(404);
    expect(await roomStorageState(room.room.id)).toEqual({
      alarm: null,
      tables: [],
    });
  });

  it("uses one-time WebSocket sessions and relays WebRTC signals", async () => {
    const room = await createRoom();
    const host = await connectSession(room.host.session.websocketUrl);
    expect(host.welcome.self).toEqual({
      identifier: "001122334455",
      peerId: room.host.session.peerId,
      role: "host",
    });

    const replayUrl = new URL(room.host.session.websocketUrl);
    replayUrl.protocol = replayUrl.protocol === "wss:" ? "https:" : "http:";
    const replay = await exports.default.fetch(
      new Request(replayUrl, {
        headers: { Origin: GAME_ORIGIN, Upgrade: "websocket" },
      }),
    );
    expect(replay.status).toBe(401);

    const guestResponse = await createGuestSession(room);
    const guestBody = await guestResponse.json<CreateSessionResponse>();
    const joinedPromise = nextMessage(host.socket, "peer-joined");
    const guest = await connectSession(guestBody.session.websocketUrl);
    const joined = await joinedPromise;
    expect(joined.peer).toEqual({
      identifier: "66778899aabb",
      peerId: guestBody.session.peerId,
      role: "guest",
    });
    expect(guest.welcome.peers).toEqual([
      {
        identifier: "001122334455",
        peerId: room.host.session.peerId,
        role: "host",
      },
    ]);

    const signalPromise = nextMessage(host.socket, "signal");
    guest.socket.send(
      JSON.stringify({
        signal: {
          description: { sdp: "v=0\r\n", type: "answer" },
          kind: "description",
        },
        to: room.host.session.peerId,
        type: "signal",
        v: 1,
      }),
    );
    expect(await signalPromise).toMatchObject({
      from: guestBody.session.peerId,
      signal: {
        description: { sdp: "v=0\r\n", type: "answer" },
        kind: "description",
      },
      type: "signal",
      v: 1,
    });

    guest.socket.close(1000, "test complete");
    host.socket.close(1000, "test complete");
  });

  it("validates stock player profiles and broadcasts an all-player roster", async () => {
    expect(PLAYER_STYLES).toHaveLength(18);
    expect(parsePlayerProfile({ name: "TestSpartan", style: "rose" })).toEqual({
      ok: true,
      value: { name: "TestSpartan", style: "rose" },
    });
    expect(parsePlayerProfile({ name: "TwelveChars!", style: "sage" })).toMatchObject({
      ok: false,
    });
    expect(parsePlayerProfile({ name: "Player", style: "invisible" })).toMatchObject({
      ok: false,
    });

    const room = await createRoom("001122334455", 3);
    const host = await connectSession(room.host.session.websocketUrl);
    const guestResponse = await createGuestSession(room);
    const guestBody = await guestResponse.json<CreateSessionResponse>();
    const guest = await connectSession(guestBody.session.websocketUrl);

    const hostRosterAfterHostProfile = nextMessage(host.socket, "roster");
    const guestRosterAfterHostProfile = nextMessage(guest.socket, "roster");
    host.socket.send(JSON.stringify({
      profile: { name: "TestSpartan", style: "rose" },
      type: "profile",
      v: 1,
    }));
    await Promise.all([hostRosterAfterHostProfile, guestRosterAfterHostProfile]);

    const hostRosterPromise = nextMessage(host.socket, "roster");
    const guestRosterPromise = nextMessage(guest.socket, "roster");
    guest.socket.send(JSON.stringify({
      profile: { name: "Blue Guest", style: "blue" },
      type: "profile",
      v: 1,
    }));
    const [hostRoster, guestRoster] = await Promise.all([
      hostRosterPromise,
      guestRosterPromise,
    ]);
    const expectedPlayers = expect.arrayContaining([
      {
        peerId: room.host.session.peerId,
        profile: { name: "TestSpartan", style: "rose" },
        role: "host",
      },
      {
        peerId: guestBody.session.peerId,
        profile: { name: "Blue Guest", style: "blue" },
        role: "guest",
      },
    ]);
    expect(hostRoster.players).toEqual(expectedPlayers);
    expect(guestRoster.players).toEqual(expectedPlayers);

    const invalidProfileError = nextMessage(guest.socket, "error");
    guest.socket.send(JSON.stringify({
      profile: { name: "TwelveChars!", style: "sage" },
      type: "profile",
      v: 1,
    }));
    expect(await invalidProfileError).toMatchObject({
      code: "INVALID_MESSAGE",
      type: "error",
    });

    guest.socket.close(1000, "test complete");
    host.socket.close(1000, "test complete");
  });

  it("rate limits WebSocket upgrade attempts before forwarding to a room", async () => {
    const room = await createRoom();
    const requestUrl = new URL(room.host.session.websocketUrl);
    requestUrl.protocol = requestUrl.protocol === "wss:" ? "https:" : "http:";
    requestUrl.searchParams.set("token", "A".repeat(43));

    const attemptUpgrade = (): Promise<Response> =>
      exports.default.fetch(
        new Request(requestUrl, {
          headers: {
            "CF-Connecting-IP": "203.0.113.250",
            Origin: GAME_ORIGIN,
            Upgrade: "websocket",
          },
        }),
      );

    let response: Response | null = null;
    let acceptedAttempts = 0;
    for (let attempt = 0; attempt < 1_024; attempt += 1) {
      response = await attemptUpgrade();
      if (response.status === 429) break;
      expect(response.status).toBe(401);
      acceptedAttempts += 1;
    }
    expect(acceptedAttempts).toBeGreaterThan(0);
    expect(response?.status).toBe(429);
  }, 30_000);

  it("counts malformed frames and pings toward the WebSocket rate limit", async () => {
    const room = await createRoom();
    const host = await connectSession(room.host.session.websocketUrl);
    const guestResponse = await createGuestSession(room);
    const guestBody = await guestResponse.json<CreateSessionResponse>();
    const guest = await connectSession(guestBody.session.websocketUrl);

    for (let index = 0; index < 239; index += 1) {
      guest.socket.send("{");
    }
    const pongPromise = nextMessage(guest.socket, "pong");
    guest.socket.send(JSON.stringify({ nonce: "last-allowed", type: "ping", v: 1 }));
    expect(await pongPromise).toMatchObject({
      nonce: "last-allowed",
      type: "pong",
      v: 1,
    });

    const closePromise = nextClose(guest.socket);
    guest.socket.send("{");
    const close = await closePromise;
    expect(close.code).toBe(1008);
    expect(close.reason).toBe("Signaling rate exceeded.");
    host.socket.close(1000, "test complete");
  });

  it("retires errored sockets before calculating room capacity", async () => {
    const room = await createRoom();
    const host = await connectSession(room.host.session.websocketUrl);
    const guestResponse = await createGuestSession(room);
    const guestBody = await guestResponse.json<CreateSessionResponse>();
    const joinedPromise = nextMessage(host.socket, "peer-joined");
    const guest = await connectSession(guestBody.session.websocketUrl);
    await joinedPromise;

    const guestClosePromise = nextClose(guest.socket);
    const leftPromise = nextMessage(host.socket, "peer-left");
    const stub = env.ROOMS.getByName(room.room.id);
    await runInDurableObject(stub, (instance, state) => {
      const serverSocket = state.getWebSockets(`peer:${guestBody.session.peerId}`)[0];
      expect(serverSocket).toBeDefined();
      if (serverSocket !== undefined) {
        instance.webSocketError(serverSocket, new Error("injected test error"));
      }
    });

    expect((await guestClosePromise).code).toBe(1011);
    expect(await leftPromise).toMatchObject({
      peerId: guestBody.session.peerId,
      type: "peer-left",
    });
    const replacement = await createGuestSession(room, "abcdef123456");
    expect(replacement.status).toBe(201);

    host.socket.close(1000, "test complete");
  });
});
