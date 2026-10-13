import {
  activeBan,
  activeTurnUsernames,
  actorIdFor,
  actorIdIsValid,
  presenceIdFor,
  recordTurnEvent,
  rememberTurnUsernames,
  requestIsAuthorizedAdmin,
  saveBan,
  verificationIdFor,
} from "./abuse";
import { roomIdSignatureMatches, signedRoomId } from "./crypto";
import type { RuntimeEnv } from "./env";
import { GAME_DIRECTORY_NAME } from "./directory";
import {
  MAX_HTTP_BODY_BYTES,
  ROOM_ID_PATTERN,
  SIGNALING_PROTOCOL_VERSION,
  TOKEN_PATTERN,
  isMultiplayerMap,
  isMultiplayerMode,
  parseBuildId,
  parseCreateRoomInput,
  parseCreateSessionInput,
  parseServerName,
  type CreateRoomResponse,
  type CreateSessionResponse,
  type ListedGame,
  type PublicRoomDescriptor,
  type SessionDescriptor,
} from "./protocol";
import {
  SignalingRoom,
  type CreateRoomResult,
  type CreateSessionResult,
  type HandoffHint,
  type MintedSession,
} from "./room";
import { generateIceServersWithFallback, revokeTurnCredential } from "./turn";
import { enforceTurnBandwidthCaps, turnIsDisabled, turnUsageSummary } from "./turn_cap";
import { requireHumanVerification } from "./turnstile";

export { GameDirectory } from "./directory";
export { SignalingRoom } from "./room";
export { PlayerPresence } from "./presence";
export type {
  ClientMessage,
  CreateRoomResponse,
  CreateSessionResponse,
  IceCandidateSignal,
  IceServerDescriptor,
  PlayerProfile,
  PlayerStyle,
  PublicRoomDescriptor,
  SessionDescriptionSignal,
  SessionDescriptor,
  WebRtcSignal,
} from "./protocol";

const ROOM_ROUTE = /^\/v1\/rooms\/([^/]+)$/u;
const SESSION_ROUTE = /^\/v1\/rooms\/([^/]+)\/sessions$/u;
const WEBSOCKET_ROUTE = /^\/v1\/rooms\/([^/]+)\/ws$/u;
const ADMIN_BAN_ROUTE = /^\/v1\/admin\/bans\/([0-9a-f]{32})$/u;
const MINIMUM_ROOM_CAPACITY = 2;
const MAXIMUM_ROOM_CAPACITY = 128;
const PRESENCE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(value, { headers, status });
}

function errorResponse(error: HttpError, origin: string | null): Response {
  return withCors(
    jsonResponse(
      {
        error: { code: error.code, message: error.message },
        v: SIGNALING_PROTOCOL_VERSION,
      },
      error.status,
    ),
    origin,
  );
}

function parsePositiveInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

function requireRoomIdSecret(env: RuntimeEnv): string {
  if (typeof env.ROOM_ID_SECRET !== "string" || env.ROOM_ID_SECRET.length < 32) {
    throw new Error("ROOM_ID_SECRET must contain at least 32 characters.");
  }
  return env.ROOM_ID_SECRET;
}

async function requireValidRoomId(
  roomId: string,
  env: RuntimeEnv,
): Promise<void> {
  if (
    !ROOM_ID_PATTERN.test(roomId) ||
    !(await roomIdSignatureMatches(roomId, requireRoomIdSecret(env)))
  ) {
    throw new HttpError(404, "ROOM_NOT_FOUND", "Room not found.");
  }
}

function requestActor(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "local-development";
}

async function requireAllowedActor(
  request: Request,
  env: RuntimeEnv,
): Promise<string> {
  const actorId = await actorIdFor(request, env);
  if (await activeBan(env, actorId)) {
    recordTurnEvent(env, "blocked", actorId);
    throw new HttpError(403, "PLAYER_BANNED", "This player is not allowed to create or join rooms.");
  }
  return actorId;
}

function parseBanInput(value: unknown): { actorId: string; reason: string; ttlSeconds?: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "VALIDATION_FAILED", "Body must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.actorId !== "string" || !actorIdIsValid(record.actorId)) {
    throw new HttpError(400, "VALIDATION_FAILED", "actorId must be 32 lowercase hexadecimal characters.");
  }
  if (record.reason !== undefined && typeof record.reason !== "string") {
    throw new HttpError(400, "VALIDATION_FAILED", "reason must be a string.");
  }
  if (
    record.ttlSeconds !== undefined &&
    (!Number.isInteger(record.ttlSeconds) || typeof record.ttlSeconds !== "number" || record.ttlSeconds < 60 || record.ttlSeconds > 31_536_000)
  ) {
    throw new HttpError(400, "VALIDATION_FAILED", "ttlSeconds must be between 60 and 31536000.");
  }
  return {
    actorId: record.actorId,
    reason: typeof record.reason === "string" ? record.reason : "Abusive TURN usage",
    ...(typeof record.ttlSeconds === "number" ? { ttlSeconds: record.ttlSeconds } : {}),
  };
}

function parsePresenceHeartbeat(value: unknown): {
  campaign: boolean;
  sessionId: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "VALIDATION_FAILED", "Body must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    !PRESENCE_SESSION_ID_PATTERN.test(record.sessionId)
  ) {
    throw new HttpError(400, "VALIDATION_FAILED", "sessionId is malformed.");
  }
  if (typeof record.campaign !== "boolean") {
    throw new HttpError(400, "VALIDATION_FAILED", "campaign must be a boolean.");
  }
  return { campaign: record.campaign, sessionId: record.sessionId };
}

async function handleAdminRequest(
  request: Request,
  env: RuntimeEnv,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/admin/")) {
    return null;
  }
  if (!(await requestIsAuthorizedAdmin(request, env))) {
    return jsonResponse({ error: { code: "UNAUTHORIZED", message: "Unauthorized." } }, 401, {
      "WWW-Authenticate": "Bearer",
    });
  }

  if (request.method === "GET" && url.pathname === "/v1/admin/bans") {
    const page = await env.HALO_ABUSE.list({ limit: 1_000, prefix: "ban:" });
    const bans = (await Promise.all(page.keys.map(({ name }) => env.HALO_ABUSE.get(name, "json"))))
      .filter((record) => record !== null);
    return jsonResponse({ bans, cursor: page.list_complete ? null : page.cursor });
  }

  if (url.pathname === "/v1/admin/turn" && request.method === "GET") {
    const hours = Number(url.searchParams.get("hours") ?? "24");
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
      return jsonResponse({ error: { code: "VALIDATION_FAILED", message: "hours must be an integer from 1 to 168." } }, 400);
    }
    const summary = await turnUsageSummary(env, hours);
    return jsonResponse({
      ...summary,
      disabled: await turnIsDisabled(env),
      hours,
    });
  }

  if (url.pathname === "/v1/admin/turn/check" && request.method === "POST") {
    await enforceTurnBandwidthCaps(env);
    return jsonResponse({ checked: true, disabled: await turnIsDisabled(env) });
  }

  if (url.pathname === "/v1/admin/turn/disable" && request.method === "POST") {
    await env.HALO_ABUSE.put("turn:disabled", "manual", { expirationTtl: 86_400 });
    return jsonResponse({ disabled: true });
  }

  if (url.pathname === "/v1/admin/turn/disable" && request.method === "DELETE") {
    await env.HALO_ABUSE.delete("turn:disabled");
    return new Response(null, { status: 204 });
  }

  if (request.method === "POST" && url.pathname === "/v1/admin/bans") {
    const input = parseBanInput(await readJsonBody(request));
    const ban = await saveBan(env, input.actorId, input.reason, input.ttlSeconds);
    const credentials = await activeTurnUsernames(env, input.actorId);
    const revoked = await Promise.all(
      credentials.map(async ({ key, username }) => {
        const ok = await revokeTurnCredential(env, username);
        if (ok) {
          await env.HALO_ABUSE.delete(key);
        }
        return ok;
      }),
    );
    const revokedCount = revoked.filter(Boolean).length;
    recordTurnEvent(env, "banned", input.actorId, revokedCount);
    return jsonResponse({ ban, credentialsFound: credentials.length, revoked: revokedCount }, 201);
  }

  const match = ADMIN_BAN_ROUTE.exec(url.pathname);
  if (request.method === "DELETE" && match?.[1]) {
    await env.HALO_ABUSE.delete(`ban:${match[1]}`);
    recordTurnEvent(env, "unbanned", match[1]);
    return new Response(null, { status: 204 });
  }
  return jsonResponse({ error: { code: "NOT_FOUND", message: "Admin route not found." } }, 404);
}

async function requireRateLimit(
  limiter: RateLimit,
  request: Request,
  scope: string,
): Promise<void> {
  const result = await limiter.limit({ key: `${scope}:${requestActor(request)}` });
  if (!result.success) {
    throw new HttpError(
      429,
      "RATE_LIMITED",
      "Too many requests. Please wait a minute and try again.",
    );
  }
}

function allowedOrigin(request: Request, env: RuntimeEnv): string | null {
  const origin = request.headers.get("Origin");
  if (origin === null) {
    if (env.ENVIRONMENT !== "production" && env.ALLOW_NO_ORIGIN === "true") {
      return null;
    }
    throw new HttpError(403, "ORIGIN_FORBIDDEN", "Origin is required.");
  }

  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    throw new HttpError(403, "ORIGIN_FORBIDDEN", "Origin is invalid.");
  }

  const configured = env.ALLOWED_ORIGINS.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const developmentWildcard =
    env.ENVIRONMENT !== "production" && configured.includes("*");
  if (!developmentWildcard && !configured.includes(normalized)) {
    throw new HttpError(403, "ORIGIN_FORBIDDEN", "Origin is not allowed.");
  }
  return normalized;
}

function withCors(response: Response, origin: string | null): Response {
  if (origin === null || response.status === 101) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function readJsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
    );
  }

  const declaredLength = request.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    Number(declaredLength) > MAX_HTTP_BODY_BYTES
  ) {
    throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large.");
  }
  if (request.body === null) {
    throw new HttpError(400, "INVALID_JSON", "A JSON body is required.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    total += result.value.byteLength;
    if (total > MAX_HTTP_BODY_BYTES) {
      await reader.cancel("Request body is too large.");
      throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large.");
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Body must be valid UTF-8 JSON.");
  }
}

function websocketUrl(
  requestUrl: URL,
  roomId: string,
  session: MintedSession,
): string {
  const url = new URL(`/v1/rooms/${encodeURIComponent(roomId)}/ws`, requestUrl);
  url.protocol = requestUrl.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("peer", session.peerId);
  url.searchParams.set("token", session.token);
  return url.toString();
}

function sessionDescriptor(
  requestUrl: URL,
  roomId: string,
  session: MintedSession,
): SessionDescriptor {
  return {
    identifier: session.identifier,
    peerId: session.peerId,
    role: session.role,
    token: session.token,
    websocketUrl: websocketUrl(requestUrl, roomId, session),
  };
}

function publicRoom(
  roomId: string,
  buildId: string,
  protocolVersion: number,
  capacity: number,
  expiresAt: number,
): PublicRoomDescriptor {
  if (protocolVersion !== SIGNALING_PROTOCOL_VERSION) {
    throw new Error("Durable Object returned an unsupported protocol version.");
  }
  return {
    buildId,
    capacity,
    expiresAt,
    id: roomId,
    protocolVersion,
  };
}

function inviteUrl(env: RuntimeEnv, inviteCode: string): string {
  const url = new URL(env.PUBLIC_GAME_URL);
  url.hash = `join=${encodeURIComponent(inviteCode)}`;
  return url.toString();
}

async function createRoom(
  request: Request,
  env: RuntimeEnv,
  origin: string | null,
): Promise<Response> {
  const parsed = parseCreateRoomInput(await readJsonBody(request));
  if (!parsed.ok) {
    throw new HttpError(400, "VALIDATION_FAILED", parsed.message);
  }
  const actorId = await requireAllowedActor(request, env);
  const verificationId = await verificationIdFor(request, parsed.value.identifier, env);
  try {
    await requireHumanVerification(request, env, verificationId, parsed.value.turnstileToken, "create_room");
  } catch {
    throw new HttpError(403, "TURNSTILE_REJECTED", "Complete the human verification and try again.");
  }

  const defaultCapacity = parsePositiveInteger(
    env.DEFAULT_ROOM_CAPACITY,
    "DEFAULT_ROOM_CAPACITY",
    MINIMUM_ROOM_CAPACITY,
    MAXIMUM_ROOM_CAPACITY,
  );
  const maximumCapacity = parsePositiveInteger(
    env.MAX_ROOM_CAPACITY,
    "MAX_ROOM_CAPACITY",
    MINIMUM_ROOM_CAPACITY,
    MAXIMUM_ROOM_CAPACITY,
  );
  const capacity = parsed.value.capacity ?? defaultCapacity;
  if (capacity > maximumCapacity) {
    throw new HttpError(
      400,
      "CAPACITY_TOO_LARGE",
      `capacity cannot exceed ${maximumCapacity}.`,
    );
  }

  const roomTtlMs =
    parsePositiveInteger(env.ROOM_TTL_SECONDS, "ROOM_TTL_SECONDS", 300, 86_400) *
    1_000;
  const sessionTtlMs =
    parsePositiveInteger(
      env.SESSION_TTL_SECONDS,
      "SESSION_TTL_SECONDS",
      30,
      600,
    ) * 1_000;
  const now = Date.now();

  let roomId = "";
  let result: CreateRoomResult | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    roomId = await signedRoomId(requireRoomIdSecret(env));
    result = await env.ROOMS.getByName(roomId).createRoom({
      buildId: parsed.value.buildId,
      capacity,
      identifier: parsed.value.identifier,
      now,
      protocolVersion: parsed.value.protocolVersion,
      roomId,
      roomTtlMs,
      sessionTtlMs,
    });
    if (result.ok) {
      break;
    }
  }
  if (result === null || !result.ok) {
    throw new HttpError(
      503,
      "ROOM_ID_COLLISION",
      "Could not allocate a room. Please retry.",
    );
  }

  const requestUrl = new URL(request.url);
  const code = `${roomId}.${result.guestTicket}`;
  const ice = (await turnIsDisabled(env)) ?
    { expiresAt: null, iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }], turnUsernames: [] } :
    await generateIceServersWithFallback(
    env,
    result.expiresAt,
    Date.now(),
    actorId,
  );
  await rememberTurnUsernames(env, actorId, ice.turnUsernames, ice.expiresAt);
  recordTurnEvent(env, ice.turnUsernames.length ? "issued" : "stun-only", actorId, ice.turnUsernames.length);
  const body: CreateRoomResponse = {
    host: {
      session: sessionDescriptor(requestUrl, roomId, result.hostSession),
      ticket: result.hostTicket,
    },
    iceServers: ice.iceServers,
    iceServersExpiresAt: ice.expiresAt,
    invite: { code, url: inviteUrl(env, code) },
    room: publicRoom(
      roomId,
      parsed.value.buildId,
      parsed.value.protocolVersion,
      capacity,
      result.expiresAt,
    ),
    v: SIGNALING_PROTOCOL_VERSION,
  };
  return withCors(jsonResponse(body, 201), origin);
}

function sessionError(result: Extract<CreateSessionResult, { ok: false }>): HttpError {
  switch (result.code) {
    case "BUILD_MISMATCH":
      return new HttpError(
        409,
        result.code,
        "The host and guest game builds do not match.",
      );
    case "PROTOCOL_MISMATCH":
      return new HttpError(
        409,
        result.code,
        "The host and guest signaling protocols do not match.",
      );
    case "ROOM_FULL":
      return new HttpError(409, result.code, "The room is full.");
    case "HOST_ALREADY_CONNECTED":
      return new HttpError(409, result.code, "The host is already connected.");
    case "IDENTIFIER_IN_USE":
      return new HttpError(
        409,
        result.code,
        "That network identifier is already in use in this room.",
      );
    case "ROOM_EXPIRED":
      return new HttpError(410, result.code, "The room has expired.");
    case "INVALID_TICKET":
    case "ROOM_NOT_FOUND":
      return new HttpError(
        404,
        "ROOM_NOT_FOUND_OR_TICKET_INVALID",
        "The room or invite is invalid.",
      );
  }
}

async function createSession(
  request: Request,
  env: RuntimeEnv,
  origin: string | null,
  roomId: string,
): Promise<Response> {
  await requireValidRoomId(roomId, env);
  const parsed = parseCreateSessionInput(await readJsonBody(request));
  if (!parsed.ok) {
    throw new HttpError(400, "VALIDATION_FAILED", parsed.message);
  }
  const actorId = await requireAllowedActor(request, env);
  const verificationId = await verificationIdFor(request, parsed.value.identifier, env);
  try {
    await requireHumanVerification(request, env, verificationId, parsed.value.turnstileToken, "join_room");
  } catch {
    throw new HttpError(403, "TURNSTILE_REJECTED", "Complete the human verification and try again.");
  }

  const sessionTtlMs =
    parsePositiveInteger(
      env.SESSION_TTL_SECONDS,
      "SESSION_TTL_SECONDS",
      30,
      600,
    ) * 1_000;
  const result = await env.ROOMS.getByName(roomId).createSession({
    buildId: parsed.value.buildId,
    identifier: parsed.value.identifier,
    now: Date.now(),
    protocolVersion: parsed.value.protocolVersion,
    sessionTtlMs,
    ticket: parsed.value.ticket,
  });
  if (!result.ok) {
    throw sessionError(result);
  }

  const ice = (await turnIsDisabled(env)) ?
    { expiresAt: null, iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }], turnUsernames: [] } :
    await generateIceServersWithFallback(
    env,
    result.expiresAt,
    Date.now(),
    actorId,
  );
  await rememberTurnUsernames(env, actorId, ice.turnUsernames, ice.expiresAt);
  recordTurnEvent(env, ice.turnUsernames.length ? "issued" : "stun-only", actorId, ice.turnUsernames.length);
  const body: CreateSessionResponse = {
    iceServers: ice.iceServers,
    iceServersExpiresAt: ice.expiresAt,
    room: publicRoom(
      roomId,
      result.buildId,
      result.protocolVersion,
      result.capacity,
      result.expiresAt,
    ),
    session: sessionDescriptor(new URL(request.url), roomId, result.session),
    v: SIGNALING_PROTOCOL_VERSION,
  };
  return withCors(jsonResponse(body, 201), origin);
}

function handoffHint(body: Record<string, unknown>): HandoffHint | null {
  if (!isMultiplayerMap(body.map) || !isMultiplayerMode(body.mode)) return null;
  const name = parseServerName(body.name);
  return {
    listed: body.listed === true && name.ok,
    map: body.map,
    mode: body.mode,
    name: name.ok ? name.value : body.map,
  };
}

async function closeRoom(
  request: Request,
  env: RuntimeEnv,
  origin: string | null,
  roomId: string,
): Promise<Response> {
  await requireValidRoomId(roomId, env);
  const body = await readJsonBody(request);
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as Record<string, unknown>).ticket !== "string" ||
    !TOKEN_PATTERN.test((body as Record<string, unknown>).ticket as string)
  ) {
    throw new HttpError(400, "VALIDATION_FAILED", "ticket is malformed.");
  }
  const result = await env.ROOMS.getByName(roomId).closeRoom(
    (body as { ticket: string }).ticket,
    handoffHint(body as Record<string, unknown>),
  );
  if (!result.ok) {
    throw new HttpError(
      404,
      "ROOM_NOT_FOUND_OR_TICKET_INVALID",
      "The room or host ticket is invalid.",
    );
  }
  return withCors(new Response(null, { status: 204 }), origin);
}

async function listGames(
  url: URL,
  env: RuntimeEnv,
  origin: string | null,
): Promise<Response> {
  const buildId = parseBuildId(url.searchParams.get("buildId"));
  if (buildId === null) {
    throw new HttpError(400, "VALIDATION_FAILED", "buildId is required.");
  }
  const games: ListedGame[] = await env.GAMES.getByName(GAME_DIRECTORY_NAME).list(buildId);
  return withCors(
    jsonResponse({ games, v: SIGNALING_PROTOCOL_VERSION }),
    origin,
  );
}

async function route(request: Request, env: RuntimeEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/v1/health") {
    return jsonResponse({ ok: true, v: SIGNALING_PROTOCOL_VERSION });
  }
  const adminResponse = await handleAdminRequest(request, env, url);
  if (adminResponse !== null) {
    return adminResponse;
  }

  const origin = allowedOrigin(request, env);
  if (request.method === "GET" && url.pathname === "/v1/presence") {
    const summary = await env.PRESENCE.getByName("global").summary(Date.now());
    return withCors(jsonResponse({
      ...summary,
      players: summary.online,
      v: SIGNALING_PROTOCOL_VERSION,
    }), origin);
  }
  if (request.method === "OPTIONS") {
    const response = new Response(null, {
      headers: {
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Max-Age": "86400",
      },
      status: 204,
    });
    return withCors(response, origin);
  }
  if (request.method === "GET" && url.pathname === "/v1/games") {
    await requireRateLimit(env.GAME_LIST_LIMITER, request, "game-list");
    return listGames(url, env, origin);
  }
  if (request.method === "POST" && url.pathname === "/v1/rooms") {
    await requireRateLimit(env.ROOM_CREATE_LIMITER, request, "room-create");
    await requireRateLimit(env.TURN_ISSUE_LIMITER, request, "turn-issue");
    return createRoom(request, env, origin);
  }
  if (request.method === "POST" && url.pathname === "/v1/presence") {
    await requireRateLimit(env.SESSION_CREATE_LIMITER, request, "presence-heartbeat");
    const input = parsePresenceHeartbeat(await readJsonBody(request));
    const playerId = await presenceIdFor(request, env);
    const summary = await env.PRESENCE.getByName("global").heartbeat(
      input.sessionId,
      playerId,
      input.campaign,
      Date.now(),
    );
    return withCors(jsonResponse({ ...summary, v: SIGNALING_PROTOCOL_VERSION }), origin);
  }

  const sessionMatch = SESSION_ROUTE.exec(url.pathname);
  if (request.method === "POST" && sessionMatch?.[1] !== undefined) {
    await requireRateLimit(env.SESSION_CREATE_LIMITER, request, "session-create");
    await requireRateLimit(env.TURN_ISSUE_LIMITER, request, "turn-issue");
    return createSession(request, env, origin, sessionMatch[1]);
  }

  const websocketMatch = WEBSOCKET_ROUTE.exec(url.pathname);
  if (request.method === "GET" && websocketMatch?.[1] !== undefined) {
    await requireRateLimit(
      env.SESSION_CREATE_LIMITER,
      request,
      "websocket-upgrade",
    );
    const roomId = websocketMatch[1];
    await requireValidRoomId(roomId, env);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      throw new HttpError(
        426,
        "UPGRADE_REQUIRED",
        "Expected a WebSocket upgrade.",
      );
    }
    return env.ROOMS.getByName(roomId).fetch(request);
  }

  const roomMatch = ROOM_ROUTE.exec(url.pathname);
  if (request.method === "DELETE" && roomMatch?.[1] !== undefined) {
    await requireRateLimit(env.SESSION_CREATE_LIMITER, request, "room-close");
    return closeRoom(request, env, origin, roomMatch[1]);
  }
  if (roomMatch !== null) {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    const path = new URL(request.url).pathname;
    try {
      const response = await route(request, env);
      console.log(
        JSON.stringify({
          durationMs: Date.now() - startedAt,
          message: "request complete",
          method: request.method,
          path,
          requestId,
          status: response.status,
        }),
      );
      return response;
    } catch (error) {
      if (error instanceof HttpError) {
        let origin: string | null = null;
        try {
          origin = allowedOrigin(request, env);
        } catch {
          // Preserve the original error and omit CORS for a forbidden origin.
        }
        console.warn(
          JSON.stringify({
            code: error.code,
            durationMs: Date.now() - startedAt,
            message: "request rejected",
            method: request.method,
            path,
            requestId,
            status: error.status,
          }),
        );
        return errorResponse(error, origin);
      }

      console.error(
        JSON.stringify({
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          message: "unhandled request error",
          method: request.method,
          path,
          requestId,
        }),
      );
      return errorResponse(
        new HttpError(500, "INTERNAL_ERROR", "Internal server error."),
        null,
      );
    }
  },
  async scheduled(_controller: ScheduledController, env: RuntimeEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(enforceTurnBandwidthCaps(env));
  },
} satisfies ExportedHandler<RuntimeEnv>;
