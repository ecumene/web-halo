import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { CreateRoomResponse, CreateSessionResponse } from "../src/index";

const API_ORIGIN = "http://signaling.test";
const GAME_ORIGIN = "http://127.0.0.1:8765";
const BUILD_ID = "halo-web-test-1";

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`${API_ORIGIN}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      Origin: GAME_ORIGIN,
    },
    method: "POST",
  });
}

async function createRoom(capacity = 4): Promise<CreateRoomResponse> {
  const response = await exports.default.fetch(
    jsonRequest("/v1/rooms", {
      buildId: BUILD_ID,
      capacity,
      identifier: "001122334455",
      protocolVersion: 1,
    }),
  );
  expect(response.status).toBe(201);
  return response.json<CreateRoomResponse>();
}

async function createGuestSession(
  room: CreateRoomResponse,
  identifier = "66778899aabb",
): Promise<CreateSessionResponse> {
  const separator = room.invite.code.indexOf(".");
  const response = await exports.default.fetch(
    jsonRequest(`/v1/rooms/${room.room.id}/sessions`, {
      buildId: BUILD_ID,
      identifier,
      protocolVersion: 1,
      ticket: room.invite.code.slice(separator + 1),
    }),
  );
  expect(response.status).toBe(201);
  return response.json<CreateSessionResponse>();
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
      if (typeof event.data !== "string") return;
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
  const socket = response.webSocket;
  if (socket === null) throw new Error("Upgrade did not return a WebSocket.");
  const welcomePromise = nextMessage(socket, "welcome");
  socket.accept();
  return { socket, welcome: await welcomePromise };
}

async function gamesFor(
  room: CreateRoomResponse,
  buildId = BUILD_ID,
): Promise<Array<Record<string, unknown>>> {
  return (await listGames(buildId)).filter((game) => game.roomId === room.room.id);
}

async function listGames(buildId = BUILD_ID): Promise<Array<Record<string, unknown>>> {
  const response = await exports.default.fetch(
    new Request(`${API_ORIGIN}/v1/games?buildId=${encodeURIComponent(buildId)}`, {
      headers: { Origin: GAME_ORIGIN },
    }),
  );
  expect(response.status).toBe(200);
  const body = await response.json<{ games: Array<Record<string, unknown>> }>();
  return body.games;
}

function guestTicket(room: CreateRoomResponse): string {
  return room.invite.code.slice(room.invite.code.indexOf(".") + 1);
}

function listPublic(room: CreateRoomResponse, name = "Sidewinder CTF"): string {
  return JSON.stringify({
    listed: true,
    map: "Sidewinder",
    mode: "Capture the Flag",
    name,
    ticket: guestTicket(room),
    type: "listing",
    v: 1,
  });
}

describe("public game browser", () => {
  it("requires a build id", async () => {
    const response = await exports.default.fetch(
      new Request(`${API_ORIGIN}/v1/games`, { headers: { Origin: GAME_ORIGIN } }),
    );
    expect(response.status).toBe(400);
  });

  it("lists a public lobby and never publishes the host ticket", async () => {
    const room = await createRoom();
    const host = await connectSession(room.host.session.websocketUrl);
    const listed = nextMessage(host.socket, "listing");
    host.socket.send(listPublic(room));
    expect(await listed).toMatchObject({ listed: true, type: "listing" });

    const games = await gamesFor(room);
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      hostName: "Spartan",
      joinCode: room.invite.code,
      map: "Sidewinder",
      mode: "Capture the Flag",
      name: "Sidewinder CTF",
      open: true,
      phase: "lobby",
      players: 1,
      queue: 0,
    });
    expect(JSON.stringify(games)).not.toContain(room.host.ticket);
  });

  it("rejects a guest listing and a bad ticket without listing the room", async () => {
    const room = await createRoom();
    const host = await connectSession(room.host.session.websocketUrl);
    const guestBody = await createGuestSession(room);
    const guest = await connectSession(guestBody.session.websocketUrl);

    const forbidden = nextMessage(guest.socket, "error");
    guest.socket.send(listPublic(room, "Nope"));
    expect(await forbidden).toMatchObject({ code: "LISTING_FORBIDDEN" });

    const rejected = nextMessage(host.socket, "error");
    host.socket.send(JSON.stringify({
      listed: true,
      map: "Sidewinder",
      mode: "Slayer",
      name: "Nope",
      ticket: "A".repeat(43),
      type: "listing",
      v: 1,
    }));
    expect(await rejected).toMatchObject({ code: "LISTING_REJECTED" });
    expect(await gamesFor(room)).toEqual([]);
  });

  it("holds newcomers until a live match returns to the lobby", async () => {
    const room = await createRoom();
    const host = await connectSession(room.host.session.websocketUrl);
    host.socket.send(JSON.stringify({ phase: "live", type: "phase", v: 1 }));

    const guestBody = await createGuestSession(room);
    const guest = await connectSession(guestBody.session.websocketUrl);
    expect(guest.welcome).toMatchObject({
      admission: "hold",
      queuePosition: 1,
      queueSize: 1,
      type: "welcome",
    });

    const admitted = nextMessage(guest.socket, "admit");
    host.socket.send(JSON.stringify({ phase: "lobby", type: "phase", v: 1 }));
    expect(await admitted).toMatchObject({ type: "admit" });
  });

  it("ignores a guest trying to change the match phase", async () => {
    const room = await createRoom();
    await connectSession(room.host.session.websocketUrl);
    const guestBody = await createGuestSession(room);
    const guest = await connectSession(guestBody.session.websocketUrl);
    const forbidden = nextMessage(guest.socket, "error");
    guest.socket.send(JSON.stringify({ phase: "live", type: "phase", v: 1 }));
    expect(await forbidden).toMatchObject({ code: "LISTING_FORBIDDEN" });
  });

  it("drops the listing when the host unlists or disconnects", async () => {
    const room = await createRoom();
    const host = await connectSession(room.host.session.websocketUrl);
    const listed = nextMessage(host.socket, "listing");
    host.socket.send(listPublic(room, "Public"));
    expect((await listed).listed).toBe(true);
    expect(await gamesFor(room)).toHaveLength(1);

    const unlisted = nextMessage(host.socket, "listing");
    host.socket.send(JSON.stringify({ listed: false, type: "listing", v: 1 }));
    expect((await unlisted).listed).toBe(false);
    expect(await gamesFor(room)).toEqual([]);

    const listedAgain = nextMessage(host.socket, "listing");
    host.socket.send(listPublic(room, "Public"));
    expect((await listedAgain).listed).toBe(true);
    host.socket.close(1000, "host left");
    let remaining = await gamesFor(room);
    for (let attempt = 0; remaining.length > 0 && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      remaining = await gamesFor(room);
    }
    expect(remaining).toEqual([]);
  });

  it("hands the next lobby to the earliest guest when the host leaves", async () => {
    const room = await createRoom();
    const host = await connectSession(room.host.session.websocketUrl);
    const listed = nextMessage(host.socket, "listing");
    host.socket.send(listPublic(room, "Sidewinder night"));
    expect((await listed).listed).toBe(true);

    const firstBody = await createGuestSession(room, "66778899aabb");
    const first = await connectSession(firstBody.session.websocketUrl);
    const secondBody = await createGuestSession(room, "66778899aabc");
    const second = await connectSession(secondBody.session.websocketUrl);
    const named = nextMessage(first.socket, "roster");
    first.socket.send(JSON.stringify({
      profile: { name: "Cortana", style: "cyan" },
      type: "profile",
      v: 1,
    }));
    await named;

    const live = nextMessage(first.socket, "phase");
    host.socket.send(JSON.stringify({ phase: "live", type: "phase", v: 1 }));
    await live;
    const queuedBody = await createGuestSession(room, "66778899aabd");
    const queued = await connectSession(queuedBody.session.websocketUrl);
    expect(queued.welcome).toMatchObject({ admission: "hold" });

    const successorHandoff = nextMessage(first.socket, "host-handoff");
    const followerHandoff = nextMessage(second.socket, "host-handoff");
    const response = await exports.default.fetch(
      new Request(`${API_ORIGIN}/v1/rooms/${room.room.id}`, {
        body: JSON.stringify({
          listed: true,
          map: "Sidewinder",
          mode: "Capture the Flag",
          name: "Sidewinder night",
          ticket: room.host.ticket,
        }),
        headers: { "Content-Type": "application/json", Origin: GAME_ORIGIN },
        method: "DELETE",
      }),
    );
    expect(response.status).toBe(204);

    const successor = await successorHandoff;
    expect(successor).toMatchObject({
      listed: true,
      map: "Sidewinder",
      mode: "Capture the Flag",
      name: "Sidewinder night",
      type: "host-handoff",
    });
    expect(successor.ticket).toEqual(expect.any(String));
    expect(JSON.stringify(await followerHandoff)).not.toContain(successor.ticket);
    expect(await followerHandoff).toMatchObject({
      hostName: "Cortana",
      hostPeerId: first.welcome.self &&
        (first.welcome.self as { peerId: string }).peerId,
      type: "host-handoff",
    });

    const admitted = nextMessage(queued.socket, "admit");
    first.socket.send(JSON.stringify({ phase: "lobby", type: "phase", v: 1 }));
    expect(await admitted).toMatchObject({ type: "admit" });

    let games = await gamesFor(room);
    for (
      let attempt = 0;
      games[0]?.hostName !== "Cortana" && attempt < 20;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      games = await gamesFor(room);
    }
    expect(games[0]).toMatchObject({ hostName: "Cortana", phase: "lobby" });

    const staleClose = await exports.default.fetch(
      new Request(`${API_ORIGIN}/v1/rooms/${room.room.id}`, {
        body: JSON.stringify({ ticket: room.host.ticket }),
        headers: { "Content-Type": "application/json", Origin: GAME_ORIGIN },
        method: "DELETE",
      }),
    );
    expect(staleClose.status).toBe(404);
    const successorClose = await exports.default.fetch(
      new Request(`${API_ORIGIN}/v1/rooms/${room.room.id}`, {
        body: JSON.stringify({ ticket: successor.ticket }),
        headers: { "Content-Type": "application/json", Origin: GAME_ORIGIN },
        method: "DELETE",
      }),
    );
    expect(successorClose.status).toBe(204);
  });

  it("tells a queued player when the host ends an empty game", async () => {
    const room = await createRoom();
    const host = await connectSession(room.host.session.websocketUrl);
    host.socket.send(JSON.stringify({ phase: "live", type: "phase", v: 1 }));
    const guestBody = await createGuestSession(room);
    const guest = await connectSession(guestBody.session.websocketUrl);
    expect(guest.welcome).toMatchObject({ admission: "hold" });

    const closed = nextMessage(guest.socket, "room-closed");
    const response = await exports.default.fetch(
      new Request(`${API_ORIGIN}/v1/rooms/${room.room.id}`, {
        body: JSON.stringify({ ticket: room.host.ticket }),
        headers: { "Content-Type": "application/json", Origin: GAME_ORIGIN },
        method: "DELETE",
      }),
    );
    expect(response.status).toBe(204);
    expect(await closed).toMatchObject({ reason: "host-ended", type: "room-closed" });
    expect(await gamesFor(room)).toEqual([]);
  });

  it("waits before replacing a host whose connection drops", async () => {
    const room = await createRoom();
    const host = await connectSession(room.host.session.websocketUrl);
    const listed = nextMessage(host.socket, "listing");
    host.socket.send(listPublic(room, "Still here"));
    await listed;
    const guestBody = await createGuestSession(room);
    const guest = await connectSession(guestBody.session.websocketUrl);

    const away = nextMessage(guest.socket, "peer-left");
    host.socket.close(1000, "dropped");
    expect(await away).toMatchObject({ reason: "host-away", type: "peer-left" });

    const returnedResponse = await exports.default.fetch(
      jsonRequest(`/v1/rooms/${room.room.id}/sessions`, {
        buildId: BUILD_ID,
        identifier: "001122334455",
        protocolVersion: 1,
        ticket: room.host.ticket,
      }),
    );
    expect(returnedResponse.status).toBe(201);
    const returned = await returnedResponse.json<{ session: { role: string } }>();
    expect(returned.session.role).toBe("host");
    expect(await gamesFor(room)).toHaveLength(1);
  });

  it("filters the list to the requested build", async () => {
    const room = await createRoom();
    const host = await connectSession(room.host.session.websocketUrl);
    const listed = nextMessage(host.socket, "listing");
    host.socket.send(listPublic(room, "This build"));
    await listed;
    expect(await gamesFor(room, "other-build")).toEqual([]);
    expect(await gamesFor(room)).toHaveLength(1);
  });
});
