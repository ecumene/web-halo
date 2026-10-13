import { DurableObject } from "cloudflare:workers";

import {
  hashesMatch,
  randomPeerId,
  randomToken,
  hashToken,
} from "./crypto";
import { GAME_DIRECTORY_NAME, type PublishGameInput } from "./directory";
import {
  MAX_WEBSOCKET_MESSAGE_CHARACTERS,
  IDENTIFIER_PATTERN,
  PEER_ID_PATTERN,
  SIGNALING_PROTOCOL_VERSION,
  TOKEN_PATTERN,
  isMultiplayerMap,
  isMultiplayerMode,
  parseClientMessage,
  parseCountryCode,
  parseMatchPhase,
  parsePlayerProfile,
  parseServerName,
  type MatchPhase,
  type MultiplayerMap,
  type MultiplayerMode,
  type PeerRole,
  type PlayerProfile,
} from "./protocol";

interface RoomRow extends Record<string, SqlStorageValue> {
  build_id: string;
  capacity: number;
  created_at: number;
  expires_at: number;
  guest_ticket_hash: ArrayBuffer;
  host_ticket_hash: ArrayBuffer;
  protocol_version: number;
  room_id: string;
}

interface SessionRow extends Record<string, SqlStorageValue> {
  expires_at: number;
  identifier: string;
  peer_id: string;
  role: PeerRole;
  token_hash: ArrayBuffer;
}

const HOST_AWAY_GRACE_MS = 8_000;

interface StoredListing {
  joinCode: string;
  map: MultiplayerMap;
  mode: MultiplayerMode;
  name: string;
}

export interface HandoffHint {
  listed: boolean;
  map: MultiplayerMap;
  mode: MultiplayerMode;
  name: string;
}

function isStoredListing(value: unknown): value is StoredListing {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    parseServerName(record.name).ok &&
    isMultiplayerMap(record.map) &&
    isMultiplayerMode(record.mode) &&
    typeof record.joinCode === "string" &&
    record.joinCode.length <= 180
  );
}

function requestCountry(request: Request): string | null {
  const code = parseCountryCode(request.headers.get("CF-IPCountry"));
  if (code === null || code === "XX" || code === "T1") return null;
  return code;
}

interface SocketAttachment {
  country?: string;
  departed?: boolean;
  identifier: string;
  joinedAt: number;
  messageCount?: number;
  messageWindowStartedAt?: number;
  peerId: string;
  profile?: PlayerProfile;
  publicListing?: StoredListing;
  role: PeerRole;
}

interface PreparedSession {
  session: MintedSession;
  tokenHash: ArrayBuffer;
}

export interface CreateRoomCommand {
  buildId: string;
  capacity: number;
  identifier: string;
  now: number;
  protocolVersion: number;
  roomId: string;
  roomTtlMs: number;
  sessionTtlMs: number;
}

export type CreateRoomResult =
  | { code: "ROOM_EXISTS"; ok: false }
  | {
      expiresAt: number;
      guestTicket: string;
      hostSession: MintedSession;
      hostTicket: string;
      ok: true;
    };

export interface CreateSessionCommand {
  buildId: string;
  identifier: string;
  now: number;
  protocolVersion: number;
  sessionTtlMs: number;
  ticket: string;
}

export type CreateSessionResult =
  | {
      code:
        | "BUILD_MISMATCH"
        | "HOST_ALREADY_CONNECTED"
        | "IDENTIFIER_IN_USE"
        | "INVALID_TICKET"
        | "PROTOCOL_MISMATCH"
        | "ROOM_EXPIRED"
        | "ROOM_FULL"
        | "ROOM_NOT_FOUND";
      ok: false;
    }
  | {
      buildId: string;
      capacity: number;
      expiresAt: number;
      ok: true;
      protocolVersion: number;
      session: MintedSession;
    };

export type CloseRoomResult =
  | { code: "INVALID_TICKET" | "ROOM_NOT_FOUND"; ok: false }
  | { ok: true };

export interface MintedSession {
  expiresAt: number;
  identifier: string;
  peerId: string;
  role: PeerRole;
  token: string;
}

function isSocketAttachment(value: unknown): value is SocketAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.profile !== undefined && !parsePlayerProfile(record.profile).ok) {
    return false;
  }
  if (record.publicListing !== undefined && !isStoredListing(record.publicListing)) {
    return false;
  }
  if (record.country !== undefined && parseCountryCode(record.country) === null) {
    return false;
  }
  return (
    typeof record.joinedAt === "number" &&
    typeof record.identifier === "string" &&
    IDENTIFIER_PATTERN.test(record.identifier) &&
    typeof record.peerId === "string" &&
    PEER_ID_PATTERN.test(record.peerId) &&
    (record.role === "host" || record.role === "guest")
  );
}

function safeAttachment(socket: WebSocket): SocketAttachment | null {
  const attachment: unknown = socket.deserializeAttachment();
  return isSocketAttachment(attachment) ? attachment : null;
}

function jsonMessage(value: unknown): string {
  return JSON.stringify(value);
}

const MAX_GUEST_WEBSOCKET_MESSAGES_PER_MINUTE = 240;
const MAX_HOST_WEBSOCKET_MESSAGES_PER_MINUTE = 16_384;

export class SignalingRoom extends DurableObject<Env> {
  private expiring = false;
  /** Stops a disconnect and an intentional leave from promoting two hosts. */
  private handoffClaimed = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private initializeStorage(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        room_id TEXT NOT NULL,
        build_id TEXT NOT NULL,
        protocol_version INTEGER NOT NULL,
        capacity INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        host_ticket_hash BLOB NOT NULL,
        guest_ticket_hash BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_sessions (
        peer_id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('host', 'guest')),
        identifier TEXT NOT NULL,
        token_hash BLOB NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_sessions_expiry
        ON pending_sessions(expires_at);
    `);
  }

  async createRoom(command: CreateRoomCommand): Promise<CreateRoomResult> {
    const hostTicket = randomToken();
    const guestTicket = randomToken();
    const hostSessionToken = randomToken();
    const [hostTicketHash, guestTicketHash, hostSessionTokenHash] = await Promise.all([
      hashToken(hostTicket),
      hashToken(guestTicket),
      hashToken(hostSessionToken),
    ]);

    // All operations below are synchronous until the reservation is committed,
    // so concurrent create calls cannot both observe an empty room.
    this.initializeStorage();
    if (this.getRoom() !== null) {
      return { code: "ROOM_EXISTS", ok: false };
    }

    const expiresAt = command.now + command.roomTtlMs;
    const hostSession = this.prepareSession(
      "host",
      command.identifier,
      command.now,
      command.sessionTtlMs,
      hostSessionToken,
      hostSessionTokenHash,
    );

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO room (
          singleton, room_id, build_id, protocol_version, capacity,
          created_at, expires_at, host_ticket_hash, guest_ticket_hash
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        command.roomId,
        command.buildId,
        command.protocolVersion,
        command.capacity,
        command.now,
        expiresAt,
        hostTicketHash,
        guestTicketHash,
      );
      this.insertSession(hostSession);
    });

    await this.ctx.storage.setAlarm(expiresAt);

    return {
      expiresAt,
      guestTicket,
      hostSession: hostSession.session,
      hostTicket,
      ok: true,
    };
  }

  async createSession(
    command: CreateSessionCommand,
  ): Promise<CreateSessionResult> {
    const newSessionToken = randomToken();
    const [providedTicketHash, newSessionTokenHash] = await Promise.all([
      hashToken(command.ticket),
      hashToken(newSessionToken),
    ]);

    // From this point through insertSession(), no operation yields. This makes
    // the capacity check and reservation atomic under a Durable Object's input
    // gate even when many friends click the invite simultaneously.
    const room = this.getRoom();
    if (room === null) {
      await this.expireRoom();
      return { code: "ROOM_NOT_FOUND", ok: false };
    }

    const isHost = hashesMatch(providedTicketHash, room.host_ticket_hash);
    const isGuest = hashesMatch(providedTicketHash, room.guest_ticket_hash);
    if (!isHost && !isGuest) {
      return { code: "INVALID_TICKET", ok: false };
    }
    if (command.now >= room.expires_at) {
      await this.expireRoom();
      return { code: "ROOM_EXPIRED", ok: false };
    }
    if (command.protocolVersion !== room.protocol_version) {
      return { code: "PROTOCOL_MISMATCH", ok: false };
    }
    if (command.buildId !== room.build_id) {
      return { code: "BUILD_MISMATCH", ok: false };
    }

    this.removeExpiredSessions(command.now);
    const role: PeerRole = isHost ? "host" : "guest";
    const activeConnections = this.connections();
    const pendingSessions = this.pendingSessionCount(command.now);

    if (
      role === "host" &&
      (activeConnections.some(({ attachment }) => attachment.role === "host") ||
        this.pendingRoleCount("host", command.now) > 0)
    ) {
      return { code: "HOST_ALREADY_CONNECTED", ok: false };
    }
    if (
      activeConnections.some(
        ({ attachment }) => attachment.identifier === command.identifier,
      ) ||
      this.pendingIdentifierCount(command.identifier, command.now) > 0
    ) {
      return { code: "IDENTIFIER_IN_USE", ok: false };
    }
    if (activeConnections.length + pendingSessions >= room.capacity) {
      return { code: "ROOM_FULL", ok: false };
    }

    const session = this.prepareSession(
      role,
      command.identifier,
      command.now,
      command.sessionTtlMs,
      newSessionToken,
      newSessionTokenHash,
    );
    this.insertSession(session);

    return {
      buildId: room.build_id,
      capacity: room.capacity,
      expiresAt: room.expires_at,
      ok: true,
      protocolVersion: room.protocol_version,
      session: session.session,
    };
  }

  async closeRoom(
    ticket: string,
    hint: HandoffHint | null,
  ): Promise<CloseRoomResult> {
    const room = this.getRoom();
    if (room === null) {
      await this.expireRoom();
      return { code: "ROOM_NOT_FOUND", ok: false };
    }
    if (!hashesMatch(await hashToken(ticket), room.host_ticket_hash)) {
      return { code: "INVALID_TICKET", ok: false };
    }
    this.markHostsYielded();
    await this.handoffOrClose(hint);
    return { ok: true };
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }

    const room = this.getRoom();
    if (room === null) {
      await this.expireRoom();
      return new Response("Room not found.", { status: 404 });
    }
    const now = Date.now();
    if (now >= room.expires_at) {
      await this.expireRoom();
      return new Response("Room expired.", { status: 410 });
    }

    const url = new URL(request.url);
    const peerId = url.searchParams.get("peer");
    const token = url.searchParams.get("token");
    if (
      peerId === null ||
      !PEER_ID_PATTERN.test(peerId) ||
      token === null ||
      !TOKEN_PATTERN.test(token)
    ) {
      return new Response("Malformed session.", { status: 400 });
    }

    const providedTokenHash = await hashToken(token);

    // Re-read after hashing so two upgrades cannot both consume one session.
    this.removeExpiredSessions(now);
    const session = this.getSession(peerId);
    if (
      session === null ||
      session.expires_at <= now ||
      !hashesMatch(providedTokenHash, session.token_hash)
    ) {
      return new Response("Session is invalid or expired.", { status: 401 });
    }

    const existingConnections = this.connections();
    if (
      existingConnections.some(
        ({ attachment }) => attachment.peerId === session.peer_id,
      )
    ) {
      return new Response("Peer is already connected.", { status: 409 });
    }
    if (
      session.role === "host" &&
      existingConnections.some(({ attachment }) => attachment.role === "host")
    ) {
      return new Response("Host is already connected.", { status: 409 });
    }
    if (existingConnections.length >= room.capacity) {
      return new Response("Room is full.", { status: 409 });
    }

    this.ctx.storage.sql.exec(
      "DELETE FROM pending_sessions WHERE peer_id = ?",
      peerId,
    );

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const country = requestCountry(request);
    const attachment: SocketAttachment = {
      ...(country === null ? {} : { country }),
      identifier: session.identifier,
      joinedAt: now,
      messageCount: 0,
      messageWindowStartedAt: now,
      peerId: session.peer_id,
      role: session.role,
    };
    if (attachment.role === "host") {
      const listing = this.readListing();
      if (listing !== null) attachment.publicListing = listing;
      this.clearDeparture();
      this.ctx.waitUntil(this.ctx.storage.setAlarm(room.expires_at));
    }
    const held = attachment.role === "guest" && this.matchPhase() === "live"
      ? this.enqueueGuest(attachment.peerId, now)
      : null;

    this.ctx.acceptWebSocket(server, [
      `peer:${attachment.peerId}`,
      `role:${attachment.role}`,
    ]);
    server.serializeAttachment(attachment);
    this.updatePresence(room.room_id, attachment.peerId, true);
    server.send(
      jsonMessage({
        ...(held === null
          ? {}
          : {
              admission: "hold",
              queuePosition: held.queuePosition,
              queueSize: held.queueSize,
            }),
        peers: existingConnections
          .filter(({ attachment: peer }) => peer.role !== attachment.role)
          .map(({ attachment: peer }) => ({
            identifier: peer.identifier,
            peerId: peer.peerId,
            role: peer.role,
          })),
        room: {
          buildId: room.build_id,
          capacity: room.capacity,
          expiresAt: room.expires_at,
          id: room.room_id,
          protocolVersion: room.protocol_version,
        },
        self: {
          identifier: attachment.identifier,
          peerId: attachment.peerId,
          role: attachment.role,
        },
        type: "welcome",
        v: SIGNALING_PROTOCOL_VERSION,
      }),
    );

    this.broadcastToRole(
      {
        peer: {
          identifier: attachment.identifier,
          peerId: attachment.peerId,
          role: attachment.role,
        },
        type: "peer-joined",
        v: SIGNALING_PROTOCOL_VERSION,
      },
      attachment.role === "host" ? "guest" : "host",
      server,
    );
    this.broadcastRoster();

    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(
    socket: WebSocket,
    rawMessage: string | ArrayBuffer,
  ): void {
    const sender = safeAttachment(socket);
    if (sender === null || sender.departed === true) {
      socket.close(1008, "Missing connection state.");
      return;
    }

    const now = Date.now();
    if (
      typeof sender.messageWindowStartedAt !== "number" ||
      now - sender.messageWindowStartedAt >= 60_000
    ) {
      sender.messageWindowStartedAt = now;
      sender.messageCount = 0;
    }
    sender.messageCount =
      (typeof sender.messageCount === "number" ? sender.messageCount : 0) + 1;
    try {
      socket.serializeAttachment(sender);
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          message: "failed to persist room WebSocket rate state",
          peerId: sender.peerId,
        }),
      );
      this.retireSocket(socket, 1011, "Connection state failed.");
      return;
    }
    const messageLimit =
      sender.role === "host"
        ? MAX_HOST_WEBSOCKET_MESSAGES_PER_MINUTE
        : MAX_GUEST_WEBSOCKET_MESSAGES_PER_MINUTE;
    if (sender.messageCount > messageLimit) {
      this.retireSocket(socket, 1008, "Signaling rate exceeded.");
      return;
    }

    if (
      typeof rawMessage !== "string" ||
      rawMessage.length > MAX_WEBSOCKET_MESSAGE_CHARACTERS
    ) {
      this.retireSocket(socket, 1009, "Signaling message is too large.");
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(rawMessage);
    } catch {
      this.sendError(socket, "INVALID_MESSAGE", "Message must be valid JSON.");
      return;
    }

    const parsed = parseClientMessage(decoded);
    if (!parsed.ok) {
      this.sendError(socket, "INVALID_MESSAGE", parsed.message);
      return;
    }

    const message = parsed.value;
    if (message.type === "ping") {
      const room = this.getRoom();
      if (room !== null) {
        this.updatePresence(room.room_id, sender.peerId, true);
      }
      try {
        socket.send(
          jsonMessage({
            ...(message.nonce === undefined
              ? {}
              : { nonce: message.nonce }),
            type: "pong",
            v: SIGNALING_PROTOCOL_VERSION,
          }),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            message: "failed to send room WebSocket pong",
            peerId: sender.peerId,
          }),
        );
        this.retireSocket(socket, 1011, "Signaling delivery failed.");
      }
      if (sender.role === "host" && sender.publicListing !== undefined) {
        this.scheduleListingSync();
      }
      return;
    }

    if (message.type === "phase") {
      this.applyPhase(socket, sender, message.phase);
      return;
    }

    if (message.type === "listing") {
      this.ctx.waitUntil(this.applyListing(socket, sender, message));
      return;
    }

    if (message.type === "profile") {
      sender.profile = message.profile;
      try {
        socket.serializeAttachment(sender);
      } catch (error) {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            message: "failed to persist player profile",
            peerId: sender.peerId,
          }),
        );
        this.retireSocket(socket, 1011, "Connection state failed.");
        return;
      }
      this.broadcastRoster();
      return;
    }

    const target = this.connectionForPeer(message.to);
    if (target === undefined) {
      this.sendError(socket, "PEER_NOT_FOUND", "Target peer is not connected.");
      return;
    }
    if (
      sender.role === target.attachment.role ||
      (sender.role === "guest" && target.attachment.role !== "host")
    ) {
      this.sendError(
        socket,
        "SIGNAL_ROUTE_FORBIDDEN",
        "Signals must travel between the host and a guest.",
      );
      return;
    }
    if (
      "description" in message.signal &&
      ((sender.role === "host" && message.signal.description.type !== "offer") ||
        (sender.role === "guest" && message.signal.description.type !== "answer"))
    ) {
      this.sendError(
        socket,
        "SIGNAL_DIRECTION_INVALID",
        "The session description direction is invalid for this peer.",
      );
      return;
    }

    try {
      target.socket.send(
        jsonMessage({
          from: sender.peerId,
          signal: message.signal,
          type: "signal",
          v: SIGNALING_PROTOCOL_VERSION,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          message: "failed to relay room WebSocket message",
          peerId: target.attachment.peerId,
        }),
      );
      this.retireSocket(target.socket, 1011, "Signaling delivery failed.");
      this.sendError(socket, "PEER_NOT_FOUND", "Target peer is not connected.");
    }
  }

  override webSocketClose(socket: WebSocket): void {
    this.announceDeparture(socket);
  }

  override webSocketError(socket: WebSocket, error: unknown): void {
    const attachment = safeAttachment(socket);
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        message: "room WebSocket error",
        peerId: attachment?.peerId ?? "unknown",
      }),
    );
    this.retireSocket(socket, 1011, "WebSocket error.");
  }

  override async alarm(): Promise<void> {
    const room = this.getRoom();
    if (room === null) return;
    const due = this.departureDue();
    if (
      due !== null &&
      Date.now() + 1_000 >= due &&
      Date.now() < room.expires_at
    ) {
      this.clearDeparture();
      if (!this.expiring && this.connections("host").length === 0) {
        await this.handoffOrClose(null);
      }
      const surviving = this.getRoom();
      if (surviving !== null && !this.expiring) {
        await this.ctx.storage.setAlarm(surviving.expires_at);
      }
      return;
    }
    if (Date.now() >= room.expires_at) {
      await this.expireRoom();
    }
  }

  private announceDeparture(socket: WebSocket): void {
    const attachment = safeAttachment(socket);
    if (attachment === null || attachment.departed === true) {
      return;
    }
    attachment.departed = true;
    const room = this.getRoom();
    if (room !== null) {
      this.updatePresence(room.room_id, attachment.peerId, false);
    }
    try {
      socket.serializeAttachment(attachment);
    } catch {
      // The socket may already be fully closed; readyState filtering still
      // prevents it from participating in room membership.
    }
    if (attachment.role === "guest") {
      this.dequeueGuest(attachment.peerId);
      this.notifyQueue();
    }
    const hostLeft = attachment.role === "host";
    const yielded = hostLeft && this.hasYielded(attachment.peerId);
    if (hostLeft && !yielded) {
      if (this.connections("guest").length > 0) {
        const at = Date.now() + HOST_AWAY_GRACE_MS;
        this.writeDeparture(at);
        this.ctx.waitUntil(this.ctx.storage.setAlarm(at));
      } else {
        this.ctx.waitUntil(this.handoffOrClose(null));
      }
    }
    this.broadcastToRole(
      {
        identifier: attachment.identifier,
        peerId: attachment.peerId,
        reason: hostLeft && !yielded ? "host-away" : "disconnected",
        type: "peer-left",
        v: SIGNALING_PROTOCOL_VERSION,
      },
      hostLeft ? "guest" : "host",
      socket,
    );
    this.broadcastRoster();
  }

  private broadcastRoster(): void {
    const connections = this.connections();
    const encoded = jsonMessage({
      players: connections.map(({ attachment }) => ({
        peerId: attachment.peerId,
        profile: attachment.profile ?? null,
        role: attachment.role,
      })),
      type: "roster",
      v: SIGNALING_PROTOCOL_VERSION,
    });
    for (const { socket } of connections) {
      try {
        socket.send(encoded);
      } catch (error) {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            message: "failed to send room roster",
          }),
        );
        this.retireSocket(socket, 1011, "Signaling delivery failed.");
      }
    }
    this.scheduleListingSync();
  }

  private broadcastToRole(
    message: unknown,
    role: PeerRole,
    excluded?: WebSocket,
  ): void {
    const encoded = jsonMessage(message);
    for (const { socket } of this.connections(role)) {
      if (socket === excluded) {
        continue;
      }
      try {
        socket.send(encoded);
      } catch (error) {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            message: "failed to send room WebSocket message",
          }),
        );
        this.retireSocket(socket, 1011, "Signaling delivery failed.");
      }
    }
  }

  private retireSocket(socket: WebSocket, code: number, reason: string): void {
    this.announceDeparture(socket);
    try {
      socket.close(code, reason);
    } catch {
      // An errored socket can already be closed by the runtime.
    }
  }

  private connections(): Array<{
    attachment: SocketAttachment;
    socket: WebSocket;
  }>;
  private connections(role: PeerRole): Array<{
    attachment: SocketAttachment;
    socket: WebSocket;
  }>;
  private connections(role?: PeerRole): Array<{
    attachment: SocketAttachment;
    socket: WebSocket;
  }> {
    const result: Array<{
      attachment: SocketAttachment;
      socket: WebSocket;
    }> = [];
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      const attachment = safeAttachment(socket);
      if (
        attachment !== null &&
        attachment.departed !== true &&
        (role === undefined || attachment.role === role)
      ) {
        result.push({ attachment, socket });
      }
    }
    return result;
  }

  private connectionForPeer(peerId: string):
    | { attachment: SocketAttachment; socket: WebSocket }
    | undefined {
    for (const socket of this.ctx.getWebSockets(`peer:${peerId}`)) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      const attachment = safeAttachment(socket);
      if (
        attachment !== null &&
        attachment.departed !== true &&
        attachment.peerId === peerId
      ) {
        return { attachment, socket };
      }
    }
    return undefined;
  }

  private markHostsYielded(): void {
    for (const host of this.connections("host")) {
      this.rememberYielded(host.attachment.peerId);
      host.attachment.departed = true;
      try {
        host.socket.serializeAttachment(host.attachment);
      } catch {
        // The leaving host is already on the way out.
      }
    }
  }

  private rememberYielded(peerId: string): void {
    this.ensureMatchTables();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO yielded_host (peer_id) VALUES (?)",
      peerId,
    );
  }

  private hasYielded(peerId: string): boolean {
    this.ensureMatchTables();
    return (
      this.ctx.storage.sql
        .exec<{ peer_id: string }>(
          "SELECT peer_id FROM yielded_host WHERE peer_id = ?",
          peerId,
        )
        .toArray()[0] !== undefined
    );
  }

  private writeDeparture(at: number): void {
    this.ensureMatchTables();
    this.ctx.storage.sql.exec(
      `INSERT INTO host_departure (singleton, handoff_at) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET handoff_at = excluded.handoff_at`,
      at,
    );
  }

  private clearDeparture(): void {
    this.ensureMatchTables();
    this.ctx.storage.sql.exec("DELETE FROM host_departure");
  }

  private departureDue(): number | null {
    this.ensureMatchTables();
    return (
      this.ctx.storage.sql
        .exec<{ handoff_at: number }>(
          "SELECT handoff_at FROM host_departure WHERE singleton = 1",
        )
        .toArray()[0]?.handoff_at ?? null
    );
  }

  private readListing(): StoredListing | null {
    this.ensureMatchTables();
    const row = this.ctx.storage.sql
      .exec<{
        join_code: string;
        map_name: string;
        mode_name: string;
        name: string;
      }>(
        `SELECT join_code, name, map_name, mode_name
           FROM public_listing WHERE singleton = 1`,
      )
      .toArray()[0];
    if (row === undefined) return null;
    if (!isMultiplayerMap(row.map_name) || !isMultiplayerMode(row.mode_name)) {
      return null;
    }
    const name = parseServerName(row.name);
    if (!name.ok) return null;
    return {
      joinCode: row.join_code,
      map: row.map_name,
      mode: row.mode_name,
      name: name.value,
    };
  }

  private pickSuccessor():
    | { attachment: SocketAttachment; socket: WebSocket }
    | undefined {
    const queued = new Set(this.queueIds());
    return this.connections("guest")
      .filter(({ attachment }) => !queued.has(attachment.peerId))
      .sort((left, right) =>
        left.attachment.joinedAt - right.attachment.joinedAt ||
        left.attachment.peerId.localeCompare(right.attachment.peerId))[0];
  }

  private async handoffOrClose(hint: HandoffHint | null): Promise<void> {
    if (this.expiring || this.handoffClaimed) return;
    this.handoffClaimed = true;
    try {
      const listing = this.readListing();
      const map = listing?.map ?? hint?.map;
      const mode = listing?.mode ?? hint?.mode;
      const successor =
        map === undefined || mode === undefined ? undefined : this.pickSuccessor();
      if (successor === undefined || map === undefined || mode === undefined) {
        await this.closeGracefully();
        return;
      }
      await this.promote(successor, {
        listed: listing !== null,
        map,
        mode,
        name: listing?.name ?? hint?.name ?? map,
      });
      this.handoffClaimed = false;
    } catch (error) {
      this.handoffClaimed = false;
      throw error;
    }
  }

  private async promote(
    successor: { attachment: SocketAttachment; socket: WebSocket },
    settings: HandoffHint,
  ): Promise<void> {
    const room = this.getRoom();
    if (room === null || this.expiring) return;
    const ticket = randomToken();
    const ticketHash = await hashToken(ticket);
    this.ctx.storage.sql.exec(
      "UPDATE room SET host_ticket_hash = ? WHERE singleton = 1",
      ticketHash,
    );
    const others = this.connections("guest").filter(
      ({ attachment }) => attachment.peerId !== successor.attachment.peerId,
    );
    const listing = this.readListing();
    successor.attachment.role = "host";
    if (listing !== null) successor.attachment.publicListing = listing;
    try {
      successor.socket.serializeAttachment(successor.attachment);
    } catch {
      successor.attachment.role = "guest";
      await this.closeGracefully();
      return;
    }
    this.ensureMatchTables();
    this.ctx.storage.sql.exec(
      `INSERT INTO match_state (singleton, phase) VALUES (1, 'lobby')
       ON CONFLICT(singleton) DO UPDATE SET phase = 'lobby'`,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO handoff_admit (singleton) VALUES (1) ON CONFLICT(singleton) DO NOTHING",
    );
    this.clearDeparture();
    const hostName = successor.attachment.profile?.name ?? "Spartan";
    try {
      successor.socket.send(
        jsonMessage({
          listed: settings.listed,
          map: settings.map,
          mode: settings.mode,
          name: settings.name,
          peers: others.map(({ attachment }) => ({
            identifier: attachment.identifier,
            peerId: attachment.peerId,
            role: attachment.role,
          })),
          ticket,
          type: "host-handoff",
          v: SIGNALING_PROTOCOL_VERSION,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          message: "failed to offer the room to the next host",
        }),
      );
      await this.closeGracefully();
      return;
    }
    this.broadcastToRole(
      {
        hostName,
        hostPeerId: successor.attachment.peerId,
        identifier: successor.attachment.identifier,
        map: settings.map,
        mode: settings.mode,
        name: settings.name,
        type: "host-handoff",
        v: SIGNALING_PROTOCOL_VERSION,
      },
      "guest",
    );
    this.broadcastRoster();
    const surviving = this.getRoom();
    if (surviving !== null) {
      await this.ctx.storage.setAlarm(surviving.expires_at);
    }
  }

  private consumeHandoffAdmit(): boolean {
    this.ensureMatchTables();
    const pending =
      this.ctx.storage.sql
        .exec<{ singleton: number }>(
          "SELECT singleton FROM handoff_admit WHERE singleton = 1",
        )
        .toArray()[0] !== undefined;
    if (!pending) return false;
    this.ctx.storage.sql.exec("DELETE FROM handoff_admit");
    return true;
  }

  private closeGracefully(): Promise<void> {
    this.markHostsYielded();
    for (const { socket } of this.connections()) {
      try {
        socket.send(
          jsonMessage({
            reason: "host-ended",
            type: "room-closed",
            v: SIGNALING_PROTOCOL_VERSION,
          }),
        );
      } catch {
        // Closing the socket still ends the room.
      }
    }
    return this.expireRoom();
  }

  private async expireRoom(): Promise<void> {
    this.expiring = true;
    const room = this.getRoom();
    if (room !== null) {
      for (const { attachment } of this.connections()) {
        this.updatePresence(room.room_id, attachment.peerId, false);
      }
      try {
        await this.env.GAMES.getByName(GAME_DIRECTORY_NAME).remove(room.room_id);
      } catch (error) {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            message: "failed to remove public game listing",
          }),
        );
      }
    }
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(4001, "Room expired.");
      } catch {
        // The socket may already have closed between enumeration and close().
      }
    }
    await this.ctx.storage.deleteAll();
  }

  private updatePresence(
    roomId: string,
    peerId: string,
    connected: boolean,
  ): void {
    const connectionKey = `${roomId}:${peerId}`;
    const presence = this.env.PRESENCE.getByName("global");
    const operation = connected
      ? presence.connected(connectionKey, Date.now())
      : presence.disconnected(connectionKey);
    this.ctx.waitUntil(operation.catch((error: unknown) => {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          message: "failed to update global player presence",
        }),
      );
    }));
  }

  private getRoom(): RoomRow | null {
    try {
      return (
        this.ctx.storage.sql
          .exec<RoomRow>(
            `SELECT room_id, build_id, protocol_version, capacity, created_at,
                    expires_at, host_ticket_hash, guest_ticket_hash
               FROM room WHERE singleton = 1`,
          )
          .toArray()[0] ?? null
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("no such table")) {
        return null;
      }
      throw error;
    }
  }

  private getSession(peerId: string): SessionRow | null {
    return (
      this.ctx.storage.sql
        .exec<SessionRow>(
          `SELECT peer_id, role, identifier, token_hash, expires_at
             FROM pending_sessions WHERE peer_id = ?`,
          peerId,
        )
        .toArray()[0] ?? null
    );
  }

  private insertSession(prepared: PreparedSession): void {
    const { session, tokenHash } = prepared;
    this.ctx.storage.sql.exec(
      `INSERT INTO pending_sessions
         (peer_id, role, identifier, token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      session.peerId,
      session.role,
      session.identifier,
      tokenHash,
      session.expiresAt,
    );
  }

  private prepareSession(
    role: PeerRole,
    identifier: string,
    now: number,
    ttlMs: number,
    token: string,
    tokenHash: ArrayBuffer,
  ): PreparedSession {
    return {
      session: {
        expiresAt: now + ttlMs,
        identifier,
        peerId: randomPeerId(role),
        role,
        token,
      },
      tokenHash,
    };
  }

  private pendingRoleCount(role: PeerRole, now: number): number {
    return this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM pending_sessions
          WHERE role = ? AND expires_at > ?`,
        role,
        now,
      )
      .one().count;
  }

  private pendingIdentifierCount(identifier: string, now: number): number {
    return this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM pending_sessions
          WHERE identifier = ? AND expires_at > ?`,
        identifier,
        now,
      )
      .one().count;
  }

  private pendingSessionCount(now: number): number {
    return this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM pending_sessions WHERE expires_at > ?",
        now,
      )
      .one().count;
  }

  private removeExpiredSessions(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM pending_sessions WHERE expires_at <= ?",
      now,
    );
  }

  private ensureMatchTables(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS match_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        phase TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS join_queue (
        peer_id TEXT PRIMARY KEY,
        joined_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS public_listing (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        join_code TEXT NOT NULL,
        name TEXT NOT NULL,
        map_name TEXT NOT NULL,
        mode_name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS host_departure (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        handoff_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS yielded_host (
        peer_id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS handoff_admit (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
      );
    `);
  }

  private matchPhase(): MatchPhase {
    this.ensureMatchTables();
    const row = this.ctx.storage.sql
      .exec<{ phase: string }>("SELECT phase FROM match_state WHERE singleton = 1")
      .toArray()[0];
    return parseMatchPhase(row?.phase) ?? "lobby";
  }

  private setMatchPhase(phase: MatchPhase): void {
    this.ensureMatchTables();
    this.ctx.storage.sql.exec(
      `INSERT INTO match_state (singleton, phase) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET phase = excluded.phase`,
      phase,
    );
  }

  private queueIds(): string[] {
    this.ensureMatchTables();
    return this.ctx.storage.sql
      .exec<{ peer_id: string }>(
        "SELECT peer_id FROM join_queue ORDER BY joined_at, peer_id",
      )
      .toArray()
      .map(({ peer_id }) => peer_id);
  }

  private enqueueGuest(
    peerId: string,
    now: number,
  ): { queuePosition: number; queueSize: number } {
    this.ensureMatchTables();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO join_queue (peer_id, joined_at) VALUES (?, ?)",
      peerId,
      now,
    );
    const ids = this.queueIds();
    const index = ids.indexOf(peerId);
    return {
      queuePosition: index < 0 ? ids.length : index + 1,
      queueSize: ids.length,
    };
  }

  private dequeueGuest(peerId: string): void {
    this.ensureMatchTables();
    this.ctx.storage.sql.exec("DELETE FROM join_queue WHERE peer_id = ?", peerId);
  }

  private clearQueue(): void {
    this.ensureMatchTables();
    this.ctx.storage.sql.exec("DELETE FROM join_queue");
  }

  private listingStored(): boolean {
    this.ensureMatchTables();
    return (
      this.ctx.storage.sql
        .exec<{ singleton: number }>(
          "SELECT singleton FROM public_listing WHERE singleton = 1",
        )
        .toArray()[0] !== undefined
    );
  }

  private writeListing(listing: StoredListing): void {
    this.ensureMatchTables();
    this.ctx.storage.sql.exec(
      `INSERT INTO public_listing (singleton, join_code, name, map_name, mode_name)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         join_code = excluded.join_code,
         name = excluded.name,
         map_name = excluded.map_name,
         mode_name = excluded.mode_name`,
      listing.joinCode,
      listing.name,
      listing.map,
      listing.mode,
    );
  }

  private clearListing(): void {
    this.ensureMatchTables();
    this.ctx.storage.sql.exec("DELETE FROM public_listing");
  }

  private notifyQueue(): void {
    const ids = this.queueIds();
    ids.forEach((peerId, index) => {
      const target = this.connectionForPeer(peerId);
      if (target === undefined) return;
      try {
        target.socket.send(
          jsonMessage({
            position: index + 1,
            size: ids.length,
            type: "hold",
            v: SIGNALING_PROTOCOL_VERSION,
          }),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            message: "failed to update join queue",
          }),
        );
      }
    });
  }

  private admitQueuedGuests(): void {
    const ids = this.queueIds();
    this.clearQueue();
    for (const peerId of ids) {
      const target = this.connectionForPeer(peerId);
      if (target === undefined) continue;
      try {
        target.socket.send(
          jsonMessage({ type: "admit", v: SIGNALING_PROTOCOL_VERSION }),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            message: "failed to admit queued player",
          }),
        );
      }
    }
  }

  private applyPhase(
    socket: WebSocket,
    sender: SocketAttachment,
    phase: MatchPhase,
  ): void {
    if (this.expiring) return;
    if (sender.role !== "host") {
      this.sendError(socket, "LISTING_FORBIDDEN", "Only the host can change the match.");
      return;
    }
    const previous = this.matchPhase();
    this.setMatchPhase(phase);
    this.broadcastToRole(
      { phase, type: "phase", v: SIGNALING_PROTOCOL_VERSION },
      "guest",
    );
    if (
      (previous === "live" && phase === "lobby") ||
      (phase === "lobby" && this.consumeHandoffAdmit())
    ) {
      this.admitQueuedGuests();
    }
    this.scheduleListingSync();
  }

  private scheduleListingSync(): void {
    if (this.expiring) return;
    this.ctx.waitUntil(this.syncPublicListing());
  }

  private listingPayload(
    room: RoomRow,
    host: SocketAttachment,
    listing: StoredListing,
  ): PublishGameInput {
    const queued = this.queueIds().length;
    const connected = this.connections().length;
    const pending = this.pendingSessionCount(Date.now());
    const hostName = host.profile?.name ?? "Spartan";
    return {
      buildId: room.build_id,
      capacity: room.capacity,
      country: host.country ?? null,
      expiresAt: room.expires_at,
      hostName: parsePlayerProfile({ name: hostName, style: "sage" }).ok ? hostName : "Spartan",
      joinCode: listing.joinCode,
      map: listing.map,
      mode: listing.mode,
      name: listing.name,
      open: connected + pending < room.capacity,
      phase: this.matchPhase(),
      players: Math.max(1, connected - queued),
      queue: queued,
      roomId: room.room_id,
      updatedAt: Date.now(),
    };
  }

  private async syncPublicListing(): Promise<void> {
    if (this.expiring) return;
    const room = this.getRoom();
    if (room === null || !this.listingStored()) return;
    const host = this.connections("host")[0];
    const listing = host?.attachment.publicListing;
    if (host === undefined || listing === undefined) {
      if (this.departureDue() !== null) return;
      this.clearListing();
      try {
        await this.env.GAMES.getByName(GAME_DIRECTORY_NAME).remove(room.room_id);
      } catch (error) {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            message: "failed to remove public game listing",
          }),
        );
      }
      return;
    }
    try {
      const published = await this.env.GAMES.getByName(GAME_DIRECTORY_NAME).publish(
        this.listingPayload(room, host.attachment, listing),
      );
      if (!published.ok) {
        console.error(
          JSON.stringify({
            code: published.code,
            message: "public game listing was rejected",
          }),
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          message: "failed to publish public game listing",
        }),
      );
    }
  }

  private async applyListing(
    socket: WebSocket,
    sender: SocketAttachment,
    message: Extract<ReturnType<typeof parseClientMessage>, { ok: true }>["value"],
  ): Promise<void> {
    if (message.type !== "listing" || this.expiring) return;
    const current = safeAttachment(socket);
    if (current === null || current.departed === true || current.peerId !== sender.peerId) {
      return;
    }
    if (current.role !== "host") {
      this.sendError(socket, "LISTING_FORBIDDEN", "Only the host can list a game.");
      return;
    }
    const room = this.getRoom();
    if (room === null) {
      this.sendError(socket, "LISTING_REJECTED", "This game is no longer available to list.");
      return;
    }
    if (!message.listed) {
      delete current.publicListing;
      try {
        socket.serializeAttachment(current);
      } catch {
        this.sendError(socket, "LISTING_REJECTED", "Halo could not update this listing.");
        return;
      }
      this.clearListing();
      try {
        await this.env.GAMES.getByName(GAME_DIRECTORY_NAME).remove(room.room_id);
      } catch (error) {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            message: "failed to remove public game listing",
          }),
        );
      }
      this.sendListingAck(socket, false);
      return;
    }
    if (!hashesMatch(await hashToken(message.ticket), room.guest_ticket_hash)) {
      this.sendError(socket, "LISTING_REJECTED", "Halo could not list this game.");
      return;
    }
    const listing: StoredListing = {
      joinCode: `${room.room_id}.${message.ticket}`,
      map: message.map,
      mode: message.mode,
      name: message.name,
    };
    const published = await this.env.GAMES.getByName(GAME_DIRECTORY_NAME).publish(
      this.listingPayload(room, current, listing),
    );
    if (!published.ok) {
      this.sendError(
        socket,
        published.code === "DIRECTORY_FULL" ? "DIRECTORY_FULL" : "LISTING_REJECTED",
        published.code === "DIRECTORY_FULL"
          ? "The server list is full right now. Your private invite still works."
          : "Halo could not list this game.",
      );
      return;
    }
    current.publicListing = listing;
    try {
      socket.serializeAttachment(current);
    } catch {
      try {
        await this.env.GAMES.getByName(GAME_DIRECTORY_NAME).remove(room.room_id);
      } catch {
        // The listing expires on its own if this cleanup also fails.
      }
      this.sendError(socket, "LISTING_REJECTED", "Halo could not update this listing.");
      return;
    }
    this.writeListing(listing);
    this.sendListingAck(socket, true);
  }

  private sendListingAck(socket: WebSocket, listed: boolean): void {
    try {
      socket.send(
        jsonMessage({
          listed,
          type: "listing",
          v: SIGNALING_PROTOCOL_VERSION,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          message: "failed to acknowledge game listing",
        }),
      );
    }
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    try {
      socket.send(
        jsonMessage({
          code,
          message,
          type: "error",
          v: SIGNALING_PROTOCOL_VERSION,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          message: "failed to send room WebSocket error",
        }),
      );
      this.retireSocket(socket, 1011, "Signaling delivery failed.");
    }
  }
}
