import { DurableObject } from "cloudflare:workers";

import {
  ROOM_ID_PATTERN,
  TOKEN_PATTERN,
  isMultiplayerMap,
  isMultiplayerMode,
  parseBuildId,
  parseCountryCode,
  parseMatchPhase,
  parsePlayerProfile,
  parseServerName,
  type ListedGame,
  type MatchPhase,
  type MultiplayerMap,
  type MultiplayerMode,
} from "./protocol";

export const GAME_DIRECTORY_NAME = "browser";
const MAX_LISTED_GAMES = 200;
const LISTING_STALE_MS = 180_000;

export interface PublishGameInput {
  buildId: string;
  capacity: number;
  country: string | null;
  expiresAt: number;
  hostName: string;
  joinCode: string;
  map: MultiplayerMap;
  mode: MultiplayerMode;
  name: string;
  open: boolean;
  phase: MatchPhase;
  players: number;
  queue: number;
  roomId: string;
  updatedAt: number;
}

export type PublishGameResult =
  | { ok: true }
  | { code: "DIRECTORY_FULL" | "INVALID_GAME"; ok: false };

interface GameRow extends Record<string, SqlStorageValue> {
  build_id: string;
  capacity: number;
  country: string | null;
  expires_at: number;
  host_name: string;
  join_code: string;
  map_name: string;
  mode_name: string;
  name: string;
  open: number;
  phase: string;
  players: number;
  queue_count: number;
  room_id: string;
  updated_at: number;
}

function validPublish(input: PublishGameInput): boolean {
  if (parseBuildId(input.buildId) === null || !ROOM_ID_PATTERN.test(input.roomId)) {
    return false;
  }
  if (!isMultiplayerMap(input.map) || !isMultiplayerMode(input.mode)) return false;
  if (!parseServerName(input.name).ok) return false;
  if (!parsePlayerProfile({ name: input.hostName, style: "sage" }).ok) return false;
  if (input.country !== null && parseCountryCode(input.country) === null) return false;
  const ticket = input.joinCode.slice(input.roomId.length + 1);
  if (
    input.joinCode !== `${input.roomId}.${ticket}` ||
    !TOKEN_PATTERN.test(ticket)
  ) {
    return false;
  }
  return (
    Number.isSafeInteger(input.capacity) &&
    input.capacity >= 2 &&
    input.capacity <= 128 &&
    Number.isSafeInteger(input.players) &&
    input.players >= 1 &&
    input.players <= input.capacity &&
    typeof input.open === "boolean" &&
    parseMatchPhase(input.phase) !== null &&
    Number.isSafeInteger(input.queue) &&
    input.queue >= 0 &&
    input.queue <= 127 &&
    Number.isSafeInteger(input.expiresAt) &&
    Number.isSafeInteger(input.updatedAt) &&
    input.expiresAt > input.updatedAt
  );
}

function listedGame(row: GameRow): ListedGame | null {
  if (!isMultiplayerMap(row.map_name) || !isMultiplayerMode(row.mode_name)) {
    return null;
  }
  return {
    buildId: row.build_id,
    capacity: row.capacity,
    country: parseCountryCode(row.country),
    hostName: row.host_name,
    joinCode: row.join_code,
    map: row.map_name,
    mode: row.mode_name,
    name: row.name,
    open: row.open === 1,
    phase: row.phase === "live" ? "live" : "lobby",
    players: row.players,
    queue: row.queue_count,
    roomId: row.room_id,
  };
}

export class GameDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async publish(input: PublishGameInput): Promise<PublishGameResult> {
    this.initialize();
    if (!validPublish(input)) return { code: "INVALID_GAME", ok: false };
    const now = Date.now();
    this.prune(now);
    const existing = this.ctx.storage.sql
      .exec<{ room_id: string }>(
        "SELECT room_id FROM games WHERE room_id = ?",
        input.roomId,
      )
      .toArray()[0];
    if (existing === undefined && this.count() >= MAX_LISTED_GAMES) {
      return { code: "DIRECTORY_FULL", ok: false };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO games (
        room_id, join_code, name, host_name, map_name, mode_name, country,
        players, capacity, open, phase, queue_count, build_id, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET
        join_code = excluded.join_code,
        name = excluded.name,
        host_name = excluded.host_name,
        map_name = excluded.map_name,
        mode_name = excluded.mode_name,
        country = excluded.country,
        players = excluded.players,
        capacity = excluded.capacity,
        open = excluded.open,
        phase = excluded.phase,
        queue_count = excluded.queue_count,
        build_id = excluded.build_id,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`,
      input.roomId,
      input.joinCode,
      input.name,
      input.hostName,
      input.map,
      input.mode,
      input.country,
      input.players,
      input.capacity,
      input.open ? 1 : 0,
      input.phase,
      input.queue,
      input.buildId,
      input.expiresAt,
      input.updatedAt,
    );
    return { ok: true };
  }

  async remove(roomId: string): Promise<void> {
    this.initialize();
    if (!ROOM_ID_PATTERN.test(roomId)) return;
    this.ctx.storage.sql.exec("DELETE FROM games WHERE room_id = ?", roomId);
  }

  async list(buildId: string): Promise<ListedGame[]> {
    this.initialize();
    if (parseBuildId(buildId) === null) return [];
    this.prune(Date.now());
    return this.ctx.storage.sql
      .exec<GameRow>(
        `SELECT room_id, join_code, name, host_name, map_name, mode_name,
                country, players, capacity, open, phase, queue_count,
                build_id, expires_at, updated_at
           FROM games
          WHERE build_id = ?
          ORDER BY players DESC, updated_at DESC`,
        buildId,
      )
      .toArray()
      .flatMap((row) => {
        const game = listedGame(row);
        return game === null ? [] : [game];
      });
  }

  private initialize(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS games (
        room_id TEXT PRIMARY KEY,
        join_code TEXT NOT NULL,
        name TEXT NOT NULL,
        host_name TEXT NOT NULL,
        map_name TEXT NOT NULL,
        mode_name TEXT NOT NULL,
        country TEXT,
        players INTEGER NOT NULL,
        capacity INTEGER NOT NULL,
        open INTEGER NOT NULL,
        phase TEXT NOT NULL,
        queue_count INTEGER NOT NULL,
        build_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  private count(): number {
    return this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM games")
      .one().count;
  }

  private prune(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM games WHERE expires_at <= ? OR updated_at <= ?",
      now,
      now - LISTING_STALE_MS,
    );
  }
}
